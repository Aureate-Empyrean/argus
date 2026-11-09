"""Bulk import from a server-side folder (ADR 0027).

A module container sees only its own volume, so the source is the fixed root `import/` inside
Argus's data volume. Paths are resolved and must stay inside it, and symbolic links are never
followed. Files are hashed and copied as streams, one at a time, so a large batch never has to fit
in memory. Exact duplicates are found by SHA-256, never by name. A source file is only ever read:
Argus never deletes or changes it. Progress lives in the database, so a job resumes after a restart.
"""

import logging
import os
import shutil
import stat
import threading
from pathlib import Path

from . import imaging, library
from .storage import MediaStore, sha256_file
from .util import iso_now, uuid7

log = logging.getLogger("argus.imports")
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
ACTIVE = ("scanning", "running", "cancelling")


class BadPath(ValueError):
    """The path is outside the import folder, or is not a folder."""


def resolve(root: Path, relative: str) -> Path:
    """A real folder inside the import root, or BadPath. Nothing outside the root is reachable."""
    parts = [p for p in str(relative or "").replace("\\", "/").split("/") if p and p != "."]
    if any(p == ".." or "\x00" in p for p in parts):
        raise BadPath("That folder is not inside the import folder.")
    current = root
    for part in parts:
        current = current / part
        try:
            mode = os.lstat(current).st_mode
        except OSError as exc:
            raise BadPath("That folder does not exist.") from exc
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            raise BadPath("That folder is not inside the import folder.")
    return current


def folders(root: Path, relative: str) -> dict:
    target = resolve(root, relative)
    names, files = [], 0
    with os.scandir(target) as entries:
        for e in entries:
            if e.is_symlink():
                continue
            if e.is_dir(follow_symlinks=False):
                names.append(e.name)
            elif e.is_file(follow_symlinks=False) and Path(e.name).suffix.lower() in EXTENSIONS:
                files += 1
    base = target.relative_to(root).as_posix()
    base = "" if base == "." else base
    return {"path": base, "files": files,
            "folders": [{"name": n, "path": f"{base}/{n}".lstrip("/")} for n in sorted(names)]}  # fmt: skip


def view(row) -> dict:
    return {k: row[k] for k in ("id", "root", "state", "total", "processed", "imported", "duplicates", "failed",
                                "error", "created_at", "updated_at")}  # fmt: skip


class Importer:
    def __init__(self, db, store: MediaStore, after=None):
        self.db, self.store = db, store
        self.root = store.root / "import"
        self.root.mkdir(parents=True, exist_ok=True)
        self.after = after
        self.lock = threading.Lock()
        self.thread = None

    def create(self, relative: str) -> str:
        resolve(self.root, relative)
        jid, now = uuid7(), iso_now()
        with self.db.connect() as conn:
            if conn.execute("SELECT 1 FROM import_jobs WHERE state IN ('scanning','running','cancelling')").fetchone():
                raise library.Invalid("Another import is still running.")
            conn.execute(
                "INSERT INTO import_jobs(id, source, root, state, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                (jid, "server", relative or "", "scanning", now, now),
            )
        self.kick()
        return jid

    def cancel(self, jid) -> None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT state FROM import_jobs WHERE id=?", (jid,)).fetchone()
            if not row:
                raise LookupError
            if row["state"] in ACTIVE:
                conn.execute("UPDATE import_jobs SET state='cancelling', updated_at=? WHERE id=?", (iso_now(), jid))

    def kick(self) -> None:
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.thread = threading.Thread(target=self._run, daemon=True, name="argus-import")
            self.thread.start()

    def _run(self):
        try:
            while True:
                with self.db.connect() as conn:
                    job = conn.execute(
                        "SELECT * FROM import_jobs WHERE state IN ('scanning','running','cancelling') ORDER BY created_at LIMIT 1"
                    ).fetchone()
                if not job:
                    return
                try:
                    if job["state"] == "scanning":
                        self._scan(job)
                    else:
                        self._process(job["id"])
                except Exception as exc:  # a job must end in a stated result, never hang
                    log.exception("Import failed")
                    self._finish(job["id"], "failed", type(exc).__name__)
        finally:
            if self.after:
                self.after()

    def _finish(self, jid, state, error=""):
        with self.db.connect() as conn:
            conn.execute("UPDATE import_jobs SET state=?, error=?, updated_at=? WHERE id=?", (state, error, iso_now(), jid))

    def _scan(self, job):
        base = resolve(self.root, job["root"])
        seq = 0
        with self.db.connect() as conn:
            conn.execute("DELETE FROM import_items WHERE job_id=?", (job["id"],))  # a resumed scan starts over
            for folder, dirs, files in os.walk(base, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(folder, d)))
                for name in sorted(files):
                    path = Path(folder) / name
                    if path.suffix.lower() not in EXTENSIONS or path.is_symlink():
                        continue
                    conn.execute(
                        "INSERT INTO import_items(job_id, seq, path) VALUES(?,?,?)",
                        (job["id"], seq, path.relative_to(self.root).as_posix()),
                    )
                    seq += 1
            conn.execute(
                "UPDATE import_jobs SET state=CASE state WHEN 'scanning' THEN 'running' ELSE state END, total=?, updated_at=? WHERE id=?",
                (seq, iso_now(), job["id"]),
            )

    def _process(self, jid):
        while True:
            with self.db.connect() as conn:
                state = conn.execute("SELECT state FROM import_jobs WHERE id=?", (jid,)).fetchone()["state"]
                if state == "cancelling":
                    self._finish(jid, "cancelled")
                    return
                item = conn.execute(
                    "SELECT * FROM import_items WHERE job_id=? AND state='pending' ORDER BY seq LIMIT 1", (jid,)
                ).fetchone()
            if not item:
                self._finish(jid, "done")
                return
            outcome, sha, photo, error = self._one(item["path"])
            column = {"imported": "imported", "duplicate": "duplicates", "failed": "failed"}[outcome]
            with self.db.connect() as conn:
                conn.execute(
                    "UPDATE import_items SET state=?, sha256=?, photo_id=?, error=? WHERE job_id=? AND seq=?",
                    (outcome, sha, photo, error, jid, item["seq"]),
                )
                conn.execute(
                    f"UPDATE import_jobs SET processed=processed+1, {column}={column}+1, updated_at=? WHERE id=?",
                    (iso_now(), jid),
                )

    def _one(self, relative):
        """(outcome, sha256, photo id, error) for one file. Reads the source and nothing else."""
        path = self.root / relative
        scratch = self.store.scratch / f"import-{uuid7()}"
        try:
            parent = path.parent.relative_to(self.root).as_posix()
            resolve(self.root, "" if parent == "." else parent)
            if os.lstat(path).st_mode & stat.S_IFMT(os.lstat(path).st_mode) != stat.S_IFREG:
                return "failed", None, None, "Not a regular file."
            with self.db.connect() as conn:
                limit = library.settings(conn)["max_upload_mb"] * 1024 * 1024
            size = path.stat().st_size
            if size < 1 or size > limit:
                return "failed", None, None, f"The file is empty or larger than {limit // (1024 * 1024)} MB."
            sha = sha256_file(path)
            with self.db.connect() as conn:
                twin = library.active_twin(conn, sha)
                if twin:
                    library.record_source(conn, twin["id"], "server", relative)
                    return "duplicate", sha, twin["id"], ""
            shutil.copyfile(path, scratch)
            if sha256_file(scratch) != sha:
                return "failed", sha, None, "The file changed while it was being read."
            with self.db.connect() as conn:
                result = library.ingest(conn, self.store, scratch, path.name, size)
                library.record_source(conn, result["photo"]["id"], "server", relative)
            return ("duplicate" if result["duplicate"] else "imported"), sha, result["photo"]["id"], ""
        except imaging.ImageRejected as exc:
            return "failed", None, None, str(exc)[:300]
        except (OSError, BadPath, ValueError) as exc:
            log.warning("Import of a file failed: %s", type(exc).__name__)
            return "failed", None, None, "The file could not be read."
        finally:
            scratch.unlink(missing_ok=True)
