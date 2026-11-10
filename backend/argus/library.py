"""The photo library: uploads, photos, renditions and their lifecycle."""

import base64
import binascii
import hashlib
import json
import os
import time

from . import imaging
from .storage import UUID, MediaStore, sha256_file
from .util import iso_now, uuid7

DEFAULTS = {"max_upload_mb": 40, "max_megapixels": 32}
LIMITS = {"max_upload_mb": (1, 200), "max_megapixels": (1, imaging.HARD_MAX_PIXELS // 1_000_000)}
CHUNK = 768 * 1024  # raw bytes per upload chunk: ~1 MiB base64, inside the 2 MiB bridge limit
THUMB = 320
PREVIEW = 640  # gallery tiles on large or high-density screens; not one of the shared FIT_SIZES
FIT_SIZES = (320, 1024, 1600)
CROP_SIZES = (64, 128, 256, 512)
MAX_CROP_DERIVATIVES = 24  # per photo; older crop renditions are evicted (they are caches)
STALE_UPLOAD = 24 * 3600


class Invalid(ValueError):
    """A request that cannot be done as asked; the message is shown to the user."""


class Unavailable(Exception):
    """The photo exists but its original cannot be read (missing or damaged storage)."""


def settings(conn):
    stored = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    return {k: int(stored.get(k, v)) for k, v in DEFAULTS.items()}


def save_settings(conn, values):
    out = settings(conn)
    for key, value in values.items():
        lo, hi = LIMITS[key]
        if not isinstance(value, int) or not lo <= value <= hi:
            raise Invalid(f"{key.replace('_', ' ').capitalize()} must be between {lo} and {hi}")
        conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, str(value)))
        out[key] = value
    return out


def reference(pid):
    return f"nexus:v1:argus:photo:{pid}"


def photo_view(row):
    meta = json.loads(row["metadata"] or "{}")
    return {
        "id": row["id"], "reference": reference(row["id"]), "filename": row["filename"],
        "title": row["title"], "format": row["format"], "mime": row["mime"],
        "width": row["width"], "height": row["height"], "bytes": row["bytes"],
        "taken_at": row["taken_at"], "camera": row["camera"],
        "has_location": bool(row["has_location"]), "animated": bool(meta.get("animated")),
        "state": row["state"], "created_at": row["created_at"], "updated_at": row["updated_at"],
        "trashed_at": row["trashed_at"],
    }  # fmt: skip


def get_photo(conn, pid):
    if not UUID.fullmatch(pid or ""):
        return None
    return conn.execute("SELECT * FROM photos WHERE id=?", (pid,)).fetchone()


# ── Uploads ────────────────────────────────────────────────────────────


def _clean_name(name):
    name = os.path.basename(str(name or "").replace("\\", "/"))
    return "".join(c for c in name if c.isprintable())[:200]


def start_upload(conn, store: MediaStore, filename, size):
    limit = settings(conn)["max_upload_mb"] * 1024 * 1024
    if not isinstance(size, int) or size < 1:
        raise Invalid("The file is empty.")
    if size > limit:
        raise Invalid(f"Photos can be at most {limit // (1024 * 1024)} MB.")
    _expire_uploads(conn, store)
    uid = uuid7()
    now = iso_now()
    store.upload_path(uid).write_bytes(b"")
    conn.execute(
        "INSERT INTO uploads(id, filename, size, received, chunk, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
        (uid, _clean_name(filename), size, 0, CHUNK, now, now),
    )
    return {"id": uid, "chunk_size": CHUNK, "chunks": -(-size // CHUNK)}


def put_chunk(conn, store: MediaStore, uid, index, data):
    row = conn.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
    if not row:
        raise LookupError
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise Invalid("The upload was corrupted in transit; try again.") from exc
    start = index * row["chunk"]
    if start < row["received"]:  # a retried chunk that already arrived
        return {"received": row["received"]}
    if start != row["received"]:
        raise Invalid("Upload chunks must arrive in order.")
    if len(raw) > row["chunk"] or start + len(raw) > row["size"] or not raw:
        raise Invalid("The upload chunk has the wrong size.")
    with open(store.upload_path(uid), "ab") as f:
        f.write(raw)
    received = start + len(raw)
    conn.execute("UPDATE uploads SET received=?, updated_at=? WHERE id=?", (received, iso_now(), uid))
    return {"received": received}


def abort_upload(conn, store, uid):
    conn.execute("DELETE FROM uploads WHERE id=?", (uid,))
    store.upload_path(uid).unlink(missing_ok=True)


def _expire_uploads(conn, store):
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - STALE_UPLOAD))
    for r in conn.execute("SELECT id FROM uploads WHERE updated_at < ?", (cutoff,)).fetchall():
        abort_upload(conn, store, r["id"])


def finish_upload(conn, store: MediaStore, uid):
    """Validate the received file, keep it as an original and create the photo."""
    row = conn.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
    if not row:
        raise LookupError
    part = store.upload_path(uid)
    if row["received"] != row["size"] or part.stat().st_size != row["size"]:
        raise Invalid("The upload is incomplete.")
    try:
        info = imaging.inspect(part, settings(conn)["max_megapixels"] * 1_000_000)
    except imaging.ImageRejected:
        abort_upload(conn, store, uid)
        raise
    conn.execute("DELETE FROM uploads WHERE id=?", (uid,))
    return ingest(conn, store, part, row["filename"], row["size"], info)


def active_twin(conn, sha):
    return conn.execute(
        "SELECT * FROM photos WHERE blob=? AND state='active' ORDER BY created_at LIMIT 1", (sha,)
    ).fetchone()


def record_source(conn, photo_id, source, path):
    """A further place these exact bytes were found, without touching the photo."""
    conn.execute(
        "INSERT OR IGNORE INTO photo_sources(photo_id, source, path, seen_at) VALUES(?,?,?,?)",
        (photo_id, source, str(path)[:1000], iso_now()),
    )


def ingest(conn, store: MediaStore, part, filename, size, info=None):
    """Keep a validated file as an original and create its photo, or report the exact twin."""
    if info is None:
        info = imaging.inspect(part, settings(conn)["max_megapixels"] * 1_000_000)
    sha = sha256_file(part)
    twin = active_twin(conn, sha)
    if twin:
        part.unlink(missing_ok=True)
        return {"photo": photo_view(twin), "duplicate": True}
    store.put_original(part, sha)
    now = iso_now()
    conn.execute(
        "INSERT OR IGNORE INTO blobs(sha256, size, mime, created_at) VALUES(?,?,?,?)",
        (sha, size, info["mime"], now),
    )
    pid = uuid7()
    conn.execute(
        "INSERT INTO photos(id, blob, filename, format, mime, width, height, stored_width, stored_height,"
        " orientation, bytes, taken_at, camera, has_location, metadata, created_at, updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, sha, _clean_name(filename), info["format"], info["mime"], info["width"], info["height"],
         info["stored_width"], info["stored_height"], info["orientation"], size,
         info["taken_at"], info["camera"], 1 if info["has_location"] else 0,
         json.dumps(info["metadata"]), now, now),
    )  # fmt: skip
    photo = get_photo(conn, pid)
    rendition(conn, store, photo, THUMB)  # the thumbnail exists from the start
    return {"photo": photo_view(photo), "duplicate": False}


# ── Renditions ─────────────────────────────────────────────────────────


def _key(size, crop):
    if not crop:
        return f"fit-{size}"
    digest = hashlib.sha1(
        json.dumps([round(crop[k], 6) for k in ("x", "y", "w", "h")]).encode()
    ).hexdigest()[:16]
    return f"crop-{size}-{digest}"


def rendition(conn, store: MediaStore, photo, size, crop=None):
    """WebP bytes for a photo at a supported size, from cache or rebuilt from the original.
    A missing or damaged cached file is rebuilt; a missing original raises Unavailable."""
    key = _key(size, crop)
    cached = conn.execute(
        "SELECT * FROM derivatives WHERE photo_id=? AND key=?", (photo["id"], key)
    ).fetchone()
    if cached:
        data = store.read_derivative(photo["id"], key)
        if data and len(data) == cached["bytes"] and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return data, cached["width"], cached["height"]
    original = store.original_path(photo["blob"])
    if not original.is_file():
        raise Unavailable("The original file is missing")
    try:
        data, w, h = imaging.render(original, dict(photo), size, crop)
    except (OSError, ValueError, SyntaxError) as exc:
        raise Unavailable("The original file cannot be read") from exc
    store.write_derivative(photo["id"], key, data)
    conn.execute(
        "INSERT OR REPLACE INTO derivatives(photo_id, key, mime, width, height, bytes, created_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (photo["id"], key, "image/webp", w, h, len(data), iso_now()),
    )
    if crop:
        extra = conn.execute(
            "SELECT key FROM derivatives WHERE photo_id=? AND key LIKE 'crop-%' ORDER BY created_at DESC"
            " LIMIT -1 OFFSET ?",
            (photo["id"], MAX_CROP_DERIVATIVES),
        ).fetchall()
        for r in extra:
            conn.execute("DELETE FROM derivatives WHERE photo_id=? AND key=?", (photo["id"], r["key"]))
            store.derivative_path(photo["id"], r["key"]).unlink(missing_ok=True)
    return data, w, h


def data_url(data):
    return "data:image/webp;base64," + base64.b64encode(data).decode()


# ── Lifecycle ──────────────────────────────────────────────────────────


def trash(conn, pid):
    now = iso_now()
    return conn.execute(
        "UPDATE photos SET state='trashed', trashed_at=?, updated_at=? WHERE id=? AND state='active'",
        (now, now, pid),
    ).rowcount


def restore(conn, pid):
    return conn.execute(
        "UPDATE photos SET state='active', trashed_at=NULL, updated_at=? WHERE id=? AND state='trashed'",
        (iso_now(), pid),
    ).rowcount


def purge(conn, store: MediaStore, pid):
    """Delete a trashed photo for good. Its original is deleted only if no other photo uses
    the same bytes; its identity is remembered as deleted."""
    photo = get_photo(conn, pid)
    if not photo:
        raise LookupError
    if photo["state"] != "trashed":
        raise Invalid("Move the photo to Trash first.")
    conn.execute("DELETE FROM photos WHERE id=?", (pid,))
    conn.execute("INSERT OR REPLACE INTO tombstones(id, deleted_at) VALUES(?,?)", (pid, iso_now()))
    store.drop_derivatives(pid)
    still_used = conn.execute("SELECT 1 FROM photos WHERE blob=? LIMIT 1", (photo["blob"],)).fetchone()
    if not still_used:
        conn.execute("DELETE FROM blobs WHERE sha256=?", (photo["blob"],))
        store.delete_original(photo["blob"])
    return {"deleted": True, "blob_kept": bool(still_used)}
