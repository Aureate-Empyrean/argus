import base64
import json
import os
import re
import secrets
import shutil
import sqlite3
import tarfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import VERSION, faces, imaging, imports, library, nexus
from .db import MIGRATIONS, Database
from .storage import HEX, UUID, MediaStore, sha256_file
from .util import REF, iso_now, uuid7

ROOT = Path(__file__).resolve().parents[2]
BACKUP_HEADER = "X-Empyrean-Backup-"
BACKUP_FORMAT = "argus-archive"
BACKUP_FORMAT_VERSION = 1
BACKUP_SET_VERSION = 2  # database and manifest in the artifact; originals held as objects (ADR 0026)
MAX_OBJECT = 2 * 1024 * 1024 * 1024
MAX_ARTIFACT = 256 * 1024 * 1024
PAGE = 30
DOWNLOAD_CHUNK = 768 * 1024
PROJECTION_BUDGET = 900 * 1024  # stay well inside Nexus's 1 MiB projection response limit
MAX_RENDITIONS = 40


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class UploadStart(Strict):
    filename: str = Field(default="", max_length=255)
    size: int = Field(ge=1)


class Chunk(Strict):
    data: str = Field(min_length=1, max_length=1_100_000)


class PhotoEdit(Strict):
    title: str = Field(default="", max_length=200)


class SettingsIn(Strict):
    max_upload_mb: int | None = None
    max_megapixels: int | None = None


def page_assets():
    font = base64.b64encode((ROOT / "frontend/fonts/Roboto.woff2").read_bytes()).decode()
    face = (
        '@font-face{font-family:"Roboto";src:url(data:font/woff2;base64,' + font + ') format("woff2");'
        "font-weight:100 900;font-stretch:75% 100%;font-display:swap}"
    )
    style = "\n".join(
        [
            (ROOT / "frontend/aureate-tokens.css").read_text(encoding="utf-8"),
            (ROOT / "frontend/aureate-foundation.css").read_text(encoding="utf-8"),
            face,
            (ROOT / "frontend/style.css").read_text(encoding="utf-8"),
        ]
    )
    return style


def create_app(data_dir=None):
    data = Path(data_dir or os.getenv("ARGUS_DATA", "/data"))
    db = Database(data / "argus.sqlite3")
    store = MediaStore(data)
    style = page_assets()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.store = store

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        msg = re.sub(r"^Value error, ", "", errors[0].get("msg", "Invalid request")) if errors else "Invalid request"
        return JSONResponse({"detail": msg}, 422)

    @app.middleware("http")
    async def trusted_gateway(request: Request, call_next):
        # Photos are reachable only through the owner-authenticated Nexus gateway.
        if request.url.path.startswith("/api/"):
            key = os.getenv("NEXUS_RESOLVER_KEY", "")
            if not key or not secrets.compare_digest(request.headers.get("x-nexus-gateway-key", ""), key):
                return JSONResponse({"detail": "Nexus gateway required"}, status_code=403)
        return await call_next(request)

    importer = imports.Importer(db, store, after=lambda: recognition.kick())
    recognition = faces.Worker(db, data)
    app.state.importer, app.state.faces_worker = importer, recognition
    importer.kick()
    recognition.kick()
    threading.Thread(target=faces.sync_references, args=(db,), daemon=True).start()

    def sync_people():
        threading.Thread(target=faces.sync_references, args=(db,), daemon=True).start()

    def photo_or_404(conn, pid):
        row = library.get_photo(conn, pid)
        if not row:
            raise HTTPException(404, "Photo not found")
        return row

    def errors(fn):
        try:
            return fn()
        except library.Invalid as exc:
            raise HTTPException(422, str(exc)) from exc
        except imaging.ImageRejected as exc:
            raise HTTPException(422, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, "Not found") from exc

    # ── Bulk import (ADR 0027) ───────────────────────────────────────

    def job_errors(fn):
        try:
            return fn()
        except imports.BadPath as exc:
            raise HTTPException(422, str(exc)) from exc
        except library.Invalid as exc:
            raise HTTPException(409, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, "Not found") from exc

    @app.get("/api/import/folders")
    def import_folders(path: str = ""):
        return job_errors(lambda: imports.folders(importer.root, path))

    class ImportBody(BaseModel):
        model_config = ConfigDict(extra="forbid")
        path: str = Field(default="", max_length=1000)

    @app.post("/api/import/jobs", status_code=201)
    def import_start(body: ImportBody):
        return {"id": job_errors(lambda: importer.create(body.path))}

    @app.get("/api/import/jobs")
    def import_jobs():
        with db.connect() as conn:
            rows = conn.execute("SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 20").fetchall()
            return {"items": [imports.view(r) for r in rows]}

    @app.get("/api/import/jobs/{jid}/errors")
    def import_errors(jid: str):
        with db.connect() as conn:
            rows = conn.execute("SELECT path, error FROM import_items WHERE job_id=? AND state='failed' ORDER BY seq LIMIT 200", (jid,)).fetchall()
            return {"items": [dict(r) for r in rows]}

    @app.post("/api/import/jobs/{jid}/cancel")
    def import_cancel(jid: str):
        job_errors(lambda: importer.cancel(jid))
        return {"cancelling": True}

    # ── Face recognition (ADR 0028) ──────────────────────────────────

    def face_errors(fn):
        try:
            return fn()
        except faces.Invalid as exc:
            raise HTTPException(422, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(404, "Not found") from exc

    class FaceSettings(BaseModel):
        model_config = ConfigDict(extra="forbid")
        enabled: bool

    class PersonChoice(BaseModel):
        model_config = ConfigDict(extra="forbid")
        resource: str = Field(max_length=200)
        label: str = Field(default="", max_length=200)

    class MarkState(BaseModel):
        model_config = ConfigDict(extra="forbid")
        state: str = Field(max_length=20)

    class Merge(BaseModel):
        model_config = ConfigDict(extra="forbid")
        into: str = Field(max_length=64)

    class Box(BaseModel):
        model_config = ConfigDict(extra="forbid")
        x: float
        y: float
        w: float
        h: float

    @app.get("/api/faces/status")
    def faces_status():
        with db.connect() as conn:
            out = faces.status(conn)
        recognition.kick()
        return out

    @app.put("/api/faces/settings")
    def faces_settings(body: FaceSettings):
        with db.connect() as conn:
            if body.enabled and not faces.status(conn)["supported"]:
                raise HTTPException(409, "Face recognition needs more memory than Nexus has granted Argus.")
            faces.set_enabled(conn, body.enabled)
            out = faces.status(conn)
        recognition.kick()
        return out

    @app.delete("/api/faces/data")
    def faces_delete(confirm: bool = False):
        if not confirm:
            raise HTTPException(422, "Confirmation is required")
        with db.connect() as conn:
            faces.delete_all(conn)
        for path in store.derived.rglob("face-*"):
            path.unlink(missing_ok=True)
        sync_people()
        return {"deleted": True}

    @app.get("/api/people")
    def choose_person(q: str = ""):
        return nexus.people(q)

    @app.get("/api/faces/clusters")
    def faces_clusters():
        with db.connect() as conn:
            return {"items": faces.clusters(conn, store, library.get_photo)}

    @app.get("/api/faces/clusters/{cid}")
    def faces_cluster(cid: str):
        with db.connect() as conn:
            return face_errors(lambda: faces.cluster_detail(conn, store, library.get_photo, cid))

    @app.post("/api/faces/clusters/{cid}/assign")
    def faces_assign_cluster(cid: str, body: PersonChoice):
        with db.connect() as conn:
            face_errors(lambda: faces.assign_cluster(conn, cid, body.resource, body.label))
            out = face_errors(lambda: faces.cluster_detail(conn, store, library.get_photo, cid))
        recognition.kick()
        sync_people()
        return out

    @app.post("/api/faces/clusters/{cid}/unassign")
    def faces_unassign_cluster(cid: str):
        with db.connect() as conn:
            face_errors(lambda: faces.unassign_cluster(conn, cid))
            out = face_errors(lambda: faces.cluster_detail(conn, store, library.get_photo, cid))
        recognition.kick()
        sync_people()
        return out

    @app.post("/api/faces/clusters/{cid}/merge")
    def faces_merge(cid: str, body: Merge):
        with db.connect() as conn:
            face_errors(lambda: faces.merge_clusters(conn, cid, body.into))
        recognition.kick()
        return {"merged": True}

    @app.get("/api/photos/{pid}/faces")
    def photo_faces(pid: str):
        with db.connect() as conn:
            return {"items": faces.photo_faces(conn, store, photo_or_404(conn, pid))}

    @app.post("/api/photos/{pid}/faces", status_code=201)
    def photo_mark_face(pid: str, body: Box):
        with db.connect() as conn:
            fid = face_errors(lambda: faces.add_manual(conn, photo_or_404(conn, pid), body.model_dump()))
        recognition.kick()
        return {"id": fid}

    def after_face():
        recognition.kick()
        sync_people()

    @app.post("/api/faces/{fid}/assign")
    def face_assign(fid: str, body: PersonChoice):
        with db.connect() as conn:
            face_errors(lambda: faces.assign_face(conn, fid, body.resource, body.label))
        after_face()
        return {"saved": True}

    @app.post("/api/faces/{fid}/confirm")
    def face_confirm(fid: str):
        with db.connect() as conn:
            face_errors(lambda: faces.confirm_face(conn, fid))
        after_face()
        return {"saved": True}

    @app.post("/api/faces/{fid}/state")
    def face_state(fid: str, body: MarkState):
        with db.connect() as conn:
            face_errors(lambda: faces.mark_face(conn, fid, body.state))
        after_face()
        return {"saved": True}

    @app.post("/api/faces/{fid}/reset")
    def face_reset(fid: str):
        with db.connect() as conn:
            face_errors(lambda: faces.reset_face(conn, fid))
        after_face()
        return {"saved": True}

    @app.delete("/api/faces/{fid}")
    def face_delete(fid: str):
        with db.connect() as conn:
            face_errors(lambda: faces.delete_manual(conn, fid))
        after_face()
        return {"deleted": True}

    @app.get("/empyrean/v1/references/outgoing")
    def protocol_outgoing(request: Request, limit: int = 100, cursor: str | None = None):
        """Entity References v2: the confirmed people in photos, so Nexus can rebuild its index."""
        require_resolver(request)
        if cursor is not None and not cursor.isdigit():
            raise HTTPException(422, "Invalid cursor")
        with db.connect() as conn:
            return faces.outgoing(conn, max(1, min(limit, 200)), cursor)

    @app.get("/health")
    def health():
        with db.connect() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok", "version": VERSION}

    # ── Library ──────────────────────────────────────────────────────

    @app.get("/api/state")
    def state():
        with db.connect() as conn:
            counts = {r["state"]: r["n"] for r in conn.execute("SELECT state, count(*) n FROM photos GROUP BY state")}
            size = conn.execute("SELECT coalesce(sum(size),0) FROM blobs").fetchone()[0]
            return {"version": VERSION, "counts": {"active": counts.get("active", 0), "trashed": counts.get("trashed", 0)},
                    "bytes": size, "settings": library.settings(conn), "limits": library.LIMITS}  # fmt: skip

    def thumb(conn, row):
        try:
            data, _, _ = library.rendition(conn, store, row, library.THUMB)
            return library.data_url(data)
        except library.Unavailable:
            return None

    @app.get("/api/photos")
    def photos(state: str = "active", cursor: str = "", limit: int = PAGE):
        if state not in ("active", "trashed") or (cursor and not UUID.fullmatch(cursor)):
            raise HTTPException(422, "Invalid query")
        limit = max(1, min(limit, PAGE))
        with db.connect() as conn:
            if state == "active":  # a timeline: when it was taken, or else when it was uploaded
                rows = conn.execute(
                    "SELECT * FROM photos WHERE state=? AND (?='' OR (COALESCE(taken_at, created_at), id) <"
                    " (SELECT COALESCE(taken_at, created_at), id FROM photos WHERE id=?))"
                    " ORDER BY COALESCE(taken_at, created_at) DESC, id DESC LIMIT ?",
                    (state, cursor, cursor, limit + 1),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM photos WHERE state=? AND (?='' OR id<?) ORDER BY id DESC LIMIT ?",
                    (state, cursor, cursor, limit + 1),
                ).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            items = [{**library.photo_view(r), "thumbnail": thumb(conn, r)} for r in rows]
            return {"items": items, "next_cursor": rows[-1]["id"] if more else None}

    @app.get("/api/photos/{pid}")
    def photo(pid: str):
        with db.connect() as conn:
            row = photo_or_404(conn, pid)
            view = library.photo_view(row)
            try:
                data, w, h = library.rendition(conn, store, row, 1600)
                view["display"] = {"src": library.data_url(data), "width": w, "height": h}
            except library.Unavailable:
                view["display"] = None
                view["damaged"] = True
            view["original_available"] = store.has_original(row["blob"])
            return view

    @app.get("/api/photos/{pid}/preview")
    def photo_preview(pid: str):
        """A sharper tile for the gallery, asked for only when a tile is on screen and large."""
        with db.connect() as conn:
            row = photo_or_404(conn, pid)
            try:
                data, w, h = library.rendition(conn, store, row, library.PREVIEW)
            except library.Unavailable as exc:
                raise HTTPException(404, "Not found") from exc
            return {"src": library.data_url(data), "width": w, "height": h}

    @app.get("/api/photos/{pid}/usage")
    def photo_usage(pid: str):
        with db.connect() as conn:
            photo_or_404(conn, pid)
        return nexus.usage(library.reference(pid))

    @app.patch("/api/photos/{pid}")
    def edit_photo(pid: str, body: PhotoEdit):
        with db.connect() as conn:
            photo_or_404(conn, pid)
            conn.execute("UPDATE photos SET title=?, updated_at=? WHERE id=?", (body.title, iso_now(), pid))
            return library.photo_view(library.get_photo(conn, pid))

    @app.get("/api/photos/{pid}/original")
    def original(pid: str, offset: int = 0):
        """The original file in pieces, for download through the bridge (2 MiB responses)."""
        with db.connect() as conn:
            row = photo_or_404(conn, pid)
        path = store.original_path(row["blob"])
        if not path.is_file():
            raise HTTPException(409, "The original file is missing from storage")
        size = path.stat().st_size
        if offset < 0 or offset >= size:
            raise HTTPException(422, "Invalid offset")
        with open(path, "rb") as f:
            f.seek(offset)
            chunk = f.read(DOWNLOAD_CHUNK)
        ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}[row["format"]]
        name = row["filename"] or f"photo-{pid}.{ext}"
        return {"data": base64.b64encode(chunk).decode(), "offset": offset, "size": size,
                "mime": row["mime"], "filename": name}  # fmt: skip

    @app.delete("/api/photos/{pid}")
    def trash_photo(pid: str):
        with db.connect() as conn:
            photo_or_404(conn, pid)
            library.trash(conn, pid)
            return library.photo_view(library.get_photo(conn, pid))

    @app.post("/api/photos/{pid}/restore")
    def restore_photo(pid: str):
        with db.connect() as conn:
            photo_or_404(conn, pid)
            library.restore(conn, pid)
            return library.photo_view(library.get_photo(conn, pid))

    @app.delete("/api/photos/{pid}/purge")
    def purge_photo(pid: str, confirm: bool = False):
        """Delete a trashed photo permanently. While another module may still use it (or its
        use cannot be checked), this needs explicit confirmation."""
        with db.connect() as conn:
            photo_or_404(conn, pid)
        if not confirm:
            used = nexus.usage(library.reference(pid))
            if not used["known"]:
                raise HTTPException(409, "Nexus could not tell whether this photo is still in use. Confirm to delete it anyway.")
            if used["items"]:
                raise HTTPException(409, f"This photo is used in {len(used['items'])} place(s). Confirm to delete it anyway.")
        with db.connect() as conn:
            return errors(lambda: library.purge(conn, store, pid))

    # ── Uploads (chunked: module requests are limited to 2 MiB) ─────

    @app.post("/api/uploads", status_code=201)
    def upload_start(body: UploadStart):
        with db.connect() as conn:
            return errors(lambda: library.start_upload(conn, store, body.filename, body.size))

    @app.put("/api/uploads/{uid}/{index}")
    def upload_chunk(uid: str, index: int, body: Chunk):
        if not UUID.fullmatch(uid) or index < 0:
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            return errors(lambda: library.put_chunk(conn, store, uid, index, body.data))

    @app.post("/api/uploads/{uid}/finish", status_code=201)
    def upload_finish(uid: str, source: str = ""):
        if not UUID.fullmatch(uid):
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            result = errors(lambda: library.finish_upload(conn, store, uid))
            if source:
                library.record_source(conn, result["photo"]["id"], "local", source)
            row = library.get_photo(conn, result["photo"]["id"])
            out = {**result, "photo": {**result["photo"], "thumbnail": thumb(conn, row)}}
        recognition.kick()
        return out

    @app.delete("/api/uploads/{uid}")
    def upload_abort(uid: str):
        if not UUID.fullmatch(uid):
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            library.abort_upload(conn, store, uid)
            return {"aborted": True}

    @app.get("/api/settings")
    def get_settings():
        with db.connect() as conn:
            return library.settings(conn)

    @app.put("/api/settings")
    def put_settings(body: SettingsIn):
        with db.connect() as conn:
            return errors(lambda: library.save_settings(conn, {k: v for k, v in body.model_dump().items() if v is not None}))

    # ── Module protocol (Nexus private network) ──────────────────────

    def require_resolver(request):
        key = os.getenv("NEXUS_RESOLVER_KEY", "")
        if not key or not secrets.compare_digest(request.headers.get("x-nexus-resolver-key", ""), key):
            raise HTTPException(403, "Resolver authentication required")

    @app.post("/empyrean/v1/resources/resolve")
    def protocol_resolve(body: dict, request: Request):
        """Minimal, deliberate disclosure: a neutral label and the picture's size; no filename,
        camera, dates of capture or location."""
        require_resolver(request)
        match = REF.fullmatch(str(body.get("resource", "")))
        if not match or match[1] != "argus" or match[2] != "photo" or not UUID.fullmatch(match[3]):
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            row = library.get_photo(conn, match[3])
            if not row:
                gone = conn.execute("SELECT 1 FROM tombstones WHERE id=?", (match[3],)).fetchone()
                raise HTTPException(410 if gone else 404, "Unavailable")
            if row["state"] != "active":
                raise HTTPException(404, "Unavailable")
            return {"resource": body["resource"], "label": (row["title"] or "Photo")[:200],
                    "open_path": f"/photos/{row['id']}",
                    "representation": {"width": row["width"], "height": row["height"]}}  # fmt: skip

    def projection_body(body):
        query = body.get("query") if isinstance(body.get("query"), dict) else {}
        cursor = body.get("cursor")
        return query, cursor if isinstance(cursor, str) else None

    @app.post("/empyrean/v1/projections/photo-library")
    def projection_library(body: dict, request: Request):
        """Active photos, newest first, with small thumbnails: what another module needs to let
        the owner choose a photo. Grants come from the owner's review of the requester's
        projection scope; nothing here reveals originals, EXIF or location."""
        require_resolver(request)
        query, cursor = projection_body(body)
        limit = max(1, min(int(query.get("limit") or 24) if str(query.get("limit") or 24).isdigit() else 24, 40))
        if cursor and not UUID.fullmatch(cursor):
            cursor = None
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM photos WHERE state='active' AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?",
                (cursor, cursor, limit + 1),
            ).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            items, budget = [], PROJECTION_BUDGET
            for r in rows:
                src = thumb(conn, r)
                budget -= len(src or "") + 300
                if budget < 0:
                    more = True
                    break
                items.append({"id": r["id"], "reference": library.reference(r["id"]), "title": r["title"],
                              "width": r["width"], "height": r["height"], "taken_at": r["taken_at"],
                              "created_at": r["created_at"], "thumbnail": src})  # fmt: skip
            return {"items": items, "next_cursor": items[-1]["id"] if more and items else None}

    @app.post("/empyrean/v1/projections/photo-renditions")
    def projection_renditions(body: dict, request: Request):
        """Rendered images of given photos: the whole picture fitted in a square, or a square
        crop (normalised to the oriented picture), rendered from the original. One status per
        requested item, in order."""
        require_resolver(request)
        query, _ = projection_body(body)
        wanted = query.get("items") if isinstance(query.get("items"), list) else []
        out, budget = [], PROJECTION_BUDGET
        with db.connect() as conn:
            for item in wanted[:MAX_RENDITIONS]:
                if not isinstance(item, dict):
                    out.append({"id": None, "status": "invalid"})
                    continue
                pid, size, crop = item.get("id"), item.get("size"), item.get("crop")
                if not isinstance(pid, str) or not UUID.fullmatch(pid):
                    out.append({"id": pid if isinstance(pid, str) else None, "status": "invalid"})
                    continue
                row = library.get_photo(conn, pid)
                if not row:
                    gone = conn.execute("SELECT 1 FROM tombstones WHERE id=?", (pid,)).fetchone()
                    out.append({"id": pid, "status": "deleted" if gone else "not_found"})
                    continue
                base = {"id": pid, "width": row["width"], "height": row["height"]}
                if row["state"] != "active":
                    out.append({**base, "status": "trashed"})
                    continue
                sizes = library.CROP_SIZES if crop else library.FIT_SIZES
                if size not in sizes:
                    out.append({**base, "status": "invalid"})
                    continue
                if crop is not None:
                    crop = imaging.valid_crop(crop, row["width"], row["height"])
                    if not crop:
                        out.append({**base, "status": "invalid"})
                        continue
                if budget < 64 * 1024:
                    out.append({**base, "status": "deferred"})  # ask again: the page is full
                    continue
                try:
                    data, w, h = library.rendition(conn, store, row, size, crop)
                except library.Unavailable:
                    out.append({**base, "status": "unavailable"})
                    continue
                src = library.data_url(data)
                budget -= len(src) + 200
                out.append({**base, "status": "available", "size": size, "rendered": [w, h], "src": src})
        return {"items": out, "next_cursor": None}

    # ── Backup v1: the database and every original file ─────────────

    def snapshot(target):
        dest = sqlite3.connect(target)
        with db.connect() as conn:
            conn.backup(dest)
        dest.execute("PRAGMA journal_mode=DELETE")
        dest.close()

    def backup_headers(version, completeness):
        return {
            BACKUP_HEADER + "Module": "argus", BACKUP_HEADER + "Module-Version": VERSION,
            BACKUP_HEADER + "Format": BACKUP_FORMAT, BACKUP_HEADER + "Format-Version": str(version),
            BACKUP_HEADER + "Created-At": iso_now(), BACKUP_HEADER + "Restorable-By": f">={VERSION},<1",
            BACKUP_HEADER + "Completeness": completeness,
        }  # fmt: skip

    def export_set(mode):
        """Quick: database only, and labelled incomplete. Full: database plus a manifest of every
        original; Nexus then fetches the originals it does not already hold, as objects."""
        work = store.scratch / f"export-{uuid7()}"
        work.mkdir()
        artifact = store.scratch / f"export-{uuid7()}.tar"
        try:
            snapshot(work / "argus.sqlite3")
            snap = sqlite3.connect(f"file:{work / 'argus.sqlite3'}?mode=ro", uri=True)
            try:
                objects = [{"sha256": r[0], "size": r[1]} for r in snap.execute("SELECT sha256, size FROM blobs ORDER BY sha256")]
            finally:
                snap.close()
            if mode == "full":
                missing = [o["sha256"] for o in objects if not store.has_original(o["sha256"])]
                if missing:
                    raise HTTPException(507, f"{len(missing)} original file(s) are missing, so a full backup is not possible")
            (work / "manifest.json").write_text(json.dumps({"mode": mode, "algorithm": "sha256", "objects": objects}))
            with tarfile.open(artifact, "w", format=tarfile.PAX_FORMAT) as tar:
                tar.add(work / "argus.sqlite3", arcname="argus.sqlite3")
                tar.add(work / "manifest.json", arcname="manifest.json")
            headers = backup_headers(BACKUP_SET_VERSION, mode)
            if mode == "full":
                token = uuid7()
                for old in store.scratch.glob("objects-*.json"):
                    old.unlink(missing_ok=True)
                (store.scratch / f"objects-{token}.json").write_text(json.dumps(objects))
                headers[BACKUP_HEADER + "Objects"] = token
        except BaseException:
            artifact.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return FileResponse(artifact, media_type="application/x-tar", background=BackgroundTask(artifact.unlink, missing_ok=True), headers=headers)

    @app.get("/empyrean/v1/backup/objects")
    def backup_objects(export: str, request: Request):
        require_resolver(request)
        if not UUID.fullmatch(export):
            raise HTTPException(404, "Unknown export")
        path = store.scratch / f"objects-{export}.json"
        if not path.is_file():
            raise HTTPException(404, "Unknown export")
        return {"objects": json.loads(path.read_text())}

    @app.get("/empyrean/v1/backup/object/{sha}")
    def backup_object(sha: str, request: Request):
        require_resolver(request)
        if not HEX.fullmatch(sha) or not store.has_original(sha):
            raise HTTPException(404, "Unknown object")
        return FileResponse(store.original_path(sha), media_type="application/octet-stream")

    @app.post("/empyrean/v1/backup/objects/missing")
    def backup_objects_missing(body: dict, request: Request):
        require_resolver(request)
        wanted = [o.get("sha256", "") for o in body.get("objects", []) if isinstance(o, dict)]
        return {"missing": [s for s in wanted if HEX.fullmatch(s) and not store.has_original(s)]}

    @app.post("/empyrean/v1/backup/object/{sha}")
    async def backup_receive_object(sha: str, request: Request):
        """An original returned during a restore: added under its digest, never replacing one."""
        require_resolver(request)
        if not HEX.fullmatch(sha):
            raise HTTPException(404, "Unknown object")
        path = store.scratch / f"object-{uuid7()}"
        size = 0
        try:
            with open(path, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_OBJECT:
                        raise HTTPException(413, "Object is too large")
                    out.write(chunk)
            if await run_in_threadpool(sha256_file, path) != sha:
                raise HTTPException(422, "The object does not match its digest")
            await run_in_threadpool(store.put_original, path, sha)
        finally:
            path.unlink(missing_ok=True)
        return {"stored": True}

    @app.post("/empyrean/v1/backup/export")
    def backup_export(request: Request):
        require_resolver(request)
        mode = request.headers.get(BACKUP_HEADER + "Mode")
        if mode in ("quick", "full"):
            return export_set(mode)
        # Backup v1, for a Nexus without objects: everything in one archive, or refused.
        work = store.scratch / f"export-{uuid7()}"
        work.mkdir()
        artifact = store.scratch / f"export-{uuid7()}.tar"
        try:
            snapshot(work / "argus.sqlite3")
            with db.connect() as conn:
                blobs = [r["sha256"] for r in conn.execute("SELECT sha256 FROM blobs ORDER BY sha256")]
            total = sum(store.original_path(b).stat().st_size for b in blobs if store.has_original(b))
            if total > MAX_ARTIFACT:
                raise HTTPException(507, "The library is larger than one module backup can hold (256 MiB)")
            with tarfile.open(artifact, "w", format=tarfile.PAX_FORMAT) as tar:
                tar.add(work / "argus.sqlite3", arcname="argus.sqlite3")
                for b in blobs:
                    if store.has_original(b):
                        tar.add(store.original_path(b), arcname=f"originals/{b}")
        except BaseException:
            artifact.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return FileResponse(
            artifact, media_type="application/x-tar", background=BackgroundTask(artifact.unlink, missing_ok=True),
            headers=backup_headers(BACKUP_FORMAT_VERSION, "full"),
        )  # fmt: skip

    async def receive_artifact(request):
        path = store.scratch / f"restore-{uuid7()}.tar"
        size = 0
        try:
            with open(path, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_ARTIFACT:
                        raise HTTPException(413, "Backup artifact exceeds 256 MiB")
                    out.write(chunk)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def check_archive(request, path, extract_to=None):
        """Validate an archive completely before anything is replaced: only the expected
        members, an intact database at a supported schema, and every original present with the
        digest it is stored under. With extract_to, also unpack it there (validated names only)."""
        headers = {k[len(BACKUP_HEADER):].lower(): v for k, v in request.headers.items()
                   if k.lower().startswith(BACKUP_HEADER.lower())}  # fmt: skip
        if headers.get("module") != "argus" or headers.get("format") != BACKUP_FORMAT:
            raise ValueError("Not an Argus backup")
        if headers.get("format-version") not in (str(BACKUP_FORMAT_VERSION), str(BACKUP_SET_VERSION)):
            raise ValueError("Unsupported backup format version")
        as_set = headers.get("format-version") == str(BACKUP_SET_VERSION)
        completeness = headers.get("completeness", "quick" if as_set else "full")
        work = Path(extract_to) if extract_to else store.scratch / f"check-{uuid7()}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            originals = set()
            with tarfile.open(path, "r:") as tar:
                for m in tar:
                    name = m.name
                    if not m.isfile():
                        raise ValueError("Backup contains an unexpected entry")
                    if name == "argus.sqlite3":
                        dest = work / "argus.sqlite3"
                    elif as_set and name == "manifest.json":
                        dest = work / "manifest.json"
                    elif not as_set and name.startswith("originals/") and HEX.fullmatch(name[10:]):
                        dest = work / "originals" / name[10:]
                        originals.add(name[10:])
                    else:
                        raise ValueError("Backup contains an unexpected file")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(m) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
            dbfile = work / "argus.sqlite3"
            if not dbfile.is_file():
                raise ValueError("Backup is missing the Argus database")
            snap = sqlite3.connect(f"file:{dbfile}?mode=ro", uri=True)
            try:
                if snap.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Backup database is damaged")
                if not 1 <= snap.execute("PRAGMA user_version").fetchone()[0] <= len(MIGRATIONS):
                    raise ValueError("Backup schema is not supported by this version")
                needed = {r[0] for r in snap.execute("SELECT sha256 FROM blobs")}
            except sqlite3.Error as exc:
                raise ValueError("Backup is not a readable Argus database") from exc
            finally:
                snap.close()
            if as_set:
                manifest = json.loads((work / "manifest.json").read_text())
                listed = {o["sha256"] for o in manifest["objects"]}
                if completeness == "full" and needed - listed:
                    raise ValueError("The backup's manifest does not cover every original")
                if extract_to and completeness == "full":
                    absent = [s for s in needed if not store.has_original(s)]
                    if absent:
                        raise ValueError(f"{len(absent)} original file(s) of this backup have not been returned")
                if extract_to:
                    (work / "completeness").write_text(completeness)
            elif needed - originals:
                raise ValueError("Backup is missing original files")
            for sha in originals:
                if sha256_file(work / "originals" / sha) != sha:
                    raise ValueError("An original file in the backup is damaged")
            return work
        except (tarfile.TarError, OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Backup is not a readable archive") from exc
        finally:
            if not extract_to:
                shutil.rmtree(work, ignore_errors=True)

    @app.post("/empyrean/v1/backup/validate")
    async def backup_validate(request: Request):
        require_resolver(request)
        path = await receive_artifact(request)
        try:
            await run_in_threadpool(check_archive, request, path)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            path.unlink(missing_ok=True)
        return {"valid": True}

    def replace_data(work):
        # Originals are content-addressed: adding the backup's files never clobbers anything.
        for f in (work / "originals").glob("*"):
            target = store.original_path(f.name)
            if not target.exists():
                store.put_original(f, f.name)
        snap = sqlite3.connect(f"file:{work / 'argus.sqlite3'}?mode=ro", uri=True)
        try:
            with db.connect() as conn:
                snap.backup(conn)
        finally:
            snap.close()
        db.migrate()
        with db.connect() as conn:
            # Caches describe the old data; they are rebuilt on demand.
            conn.execute("DELETE FROM derivatives")
            conn.execute("DELETE FROM uploads")
            # A Quick restore says nothing about media, so it can never remove an original.
            quick = (work / "completeness").is_file() and (work / "completeness").read_text() == "quick"
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('restore_pending', ?)", ("quick" if quick else "1",))
        shutil.rmtree(store.derived, ignore_errors=True)
        store.derived.mkdir(parents=True, exist_ok=True)

    @app.post("/empyrean/v1/backup/restore")
    async def backup_restore(request: Request):
        require_resolver(request)
        path = await receive_artifact(request)
        work = store.scratch / f"restore-{uuid7()}"
        try:
            try:
                await run_in_threadpool(check_archive, request, path, work)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            await run_in_threadpool(replace_data, work)
        finally:
            path.unlink(missing_ok=True)
            shutil.rmtree(work, ignore_errors=True)
        return {"restored": True}

    @app.post("/empyrean/v1/backup/finalize")
    def backup_finalize(request: Request):
        """After a restore: only now remove originals no restored photo uses (destructive
        clean-up waits until Nexus finalizes)."""
        require_resolver(request)
        with db.connect() as conn:
            pending = conn.execute("SELECT value FROM settings WHERE key='restore_pending'").fetchone()
            if pending and pending[0] == "quick":
                conn.execute("DELETE FROM settings WHERE key='restore_pending'")
            elif pending:
                keep = {r[0] for r in conn.execute("SELECT sha256 FROM blobs")}
                for f in store.originals.rglob("*"):
                    if f.is_file() and HEX.fullmatch(f.name) and f.name not in keep:
                        store.delete_original(f.name)
                conn.execute("DELETE FROM settings WHERE key='restore_pending'")
        return {"finalized": True}

    # ── Interface ────────────────────────────────────────────────────

    @app.get("/icon-emerald.svg", include_in_schema=False)
    @app.get("/icon.svg", include_in_schema=False)
    def app_icon():
        return FileResponse(ROOT / "frontend/icon.svg", media_type="image/svg+xml")

    @app.get("/{path:path}", response_class=HTMLResponse)
    def ui(path: str):
        html = (ROOT / "frontend/index.html").read_text(encoding="utf-8")
        icon = base64.b64encode((ROOT / "frontend/icon.svg").read_bytes()).decode()
        script = (ROOT / "frontend/app.js").read_text(encoding="utf-8").replace(
            "/*ARGUS_ICON*/", "data:image/svg+xml;base64," + icon
        )
        # Nexus navigation contract: the shared SDK, then Argus's adapter.
        script = "\n".join(
            [
                script,
                (ROOT / "frontend/vendor/nexus-navigation.js").read_text(encoding="utf-8"),
                (ROOT / "frontend/navigation.js").read_text(encoding="utf-8"),
                (ROOT / "frontend/viewer.js").read_text(encoding="utf-8"),
            ]
        )
        return html.replace("/*STYLE*/", style).replace("/*SCRIPT*/", script)

    return app
