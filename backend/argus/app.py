import base64
import os
import re
import secrets
import shutil
import sqlite3
import tarfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import VERSION, imaging, library, nexus
from .db import MIGRATIONS, Database
from .storage import HEX, UUID, MediaStore, sha256_file
from .util import REF, iso_now, uuid7

ROOT = Path(__file__).resolve().parents[2]
BACKUP_HEADER = "X-Empyrean-Backup-"
BACKUP_FORMAT = "argus-archive"
BACKUP_FORMAT_VERSION = 1
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
    def upload_finish(uid: str):
        if not UUID.fullmatch(uid):
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            result = errors(lambda: library.finish_upload(conn, store, uid))
            row = library.get_photo(conn, result["photo"]["id"])
            return {**result, "photo": {**result["photo"], "thumbnail": thumb(conn, row)}}

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

    @app.post("/empyrean/v1/backup/export")
    def backup_export(request: Request):
        require_resolver(request)
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
            headers={BACKUP_HEADER + "Module": "argus", BACKUP_HEADER + "Module-Version": VERSION,
                     BACKUP_HEADER + "Format": BACKUP_FORMAT, BACKUP_HEADER + "Format-Version": str(BACKUP_FORMAT_VERSION),
                     BACKUP_HEADER + "Created-At": iso_now(), BACKUP_HEADER + "Restorable-By": f">={VERSION},<1"},
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
        if headers.get("format-version") != str(BACKUP_FORMAT_VERSION):
            raise ValueError("Unsupported backup format version")
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
                    elif name.startswith("originals/") and HEX.fullmatch(name[10:]):
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
            if needed - originals:
                raise ValueError("Backup is missing original files")
            for sha in originals:
                if sha256_file(work / "originals" / sha) != sha:
                    raise ValueError("An original file in the backup is damaged")
            return work
        except (tarfile.TarError, OSError) as exc:
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
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('restore_pending', '1')")
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
            if conn.execute("SELECT value FROM settings WHERE key='restore_pending'").fetchone():
                keep = {r[0] for r in conn.execute("SELECT sha256 FROM blobs")}
                for f in store.originals.rglob("*"):
                    if f.is_file() and HEX.fullmatch(f.name) and f.name not in keep:
                        store.delete_original(f.name)
                conn.execute("DELETE FROM settings WHERE key='restore_pending'")
        return {"finalized": True}

    # ── Interface ────────────────────────────────────────────────────

    @app.get("/icon.svg", include_in_schema=False)
    def app_icon():
        return FileResponse(ROOT / "frontend/icon.svg", media_type="image/svg+xml")

    @app.get("/{path:path}", response_class=HTMLResponse)
    def ui(path: str):
        html = (ROOT / "frontend/index.html").read_text(encoding="utf-8")
        script = (ROOT / "frontend/app.js").read_text(encoding="utf-8")
        return html.replace("/*STYLE*/", style).replace("/*SCRIPT*/", script)

    return app
