"""Argus-owned media storage adapter.

Nexus shared blob storage exists (0.1.2) but cannot hold a photo library yet: files are capped
at 1 MiB, a blob can be read only by the module that uploaded it, and blob usage is neither
reported nor garbage-collected. Until it can, Argus keeps media in its own data volume behind
this narrow interface. Photo identity (a UUID) is never derived from where or how bytes are
stored, so a later move to shared storage changes this module and nothing that references a
photo.

Layout under the data volume (never exposed through any API):

  media/originals/<aa>/<bb>/<sha256>          original bytes, content-addressed, write-once
  media/derivatives/<id[:2]>/<photo-id>/<key> thumbnails and renditions, rebuildable
  uploads/<upload-id>.part                     chunks being received

Every path is built from validated hex digests, UUIDs and fixed keys, never from user input, so
there is no traversal. Writes go to a temporary file in the same directory, are flushed to disk
and then renamed into place. Normal uploads never overwrite an existing original. Restore alone
may repair a verified-invalid original after preserving its old bytes in restore-recovery.
"""

import hashlib
import os
import re
import shutil
import stat
import uuid
from pathlib import Path

HEX = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KEY = re.compile(r"^[a-z0-9][a-z0-9.-]{0,79}$")


class StorageError(Exception):
    pass


class IntegrityError(StorageError):
    """Bytes cannot be authenticated against their expected content identity."""


class MediaStore:
    def __init__(self, root):
        self.root = Path(root)
        self.originals = self.root / "media" / "originals"
        self.derived = self.root / "media" / "derivatives"
        self.incoming = self.root / "uploads"
        self.scratch = self.root / "tmp"
        for d in (self.originals, self.derived, self.incoming, self.scratch):
            d.mkdir(parents=True, exist_ok=True)

    # ── originals ───────────────────────────────────────────────────

    def original_path(self, sha):
        if not HEX.fullmatch(sha or ""):
            raise StorageError("Invalid blob key")
        return self.originals / sha[:2] / sha[2:4] / sha

    def has_original(self, sha):
        return self.original_path(sha).is_file()

    def put_original(self, source: Path, sha: str):
        """Move a fully received, verified file into place under its digest. Idempotent: the
        same bytes already stored are kept and the new copy is discarded."""
        target = self.original_path(sha)
        if target.exists():
            source.unlink(missing_ok=True)
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / f".{sha}.incoming"
        shutil.move(str(source), staging)
        with open(staging, "rb") as f:
            os.fsync(f.fileno())
        os.chmod(staging, 0o440)  # originals are never modified in place
        os.replace(staging, target)
        return target

    def verify_original(self, sha, size=None):
        return verify_file(self.original_path(sha), sha, size)

    def restore_original(self, source: Path, sha: str, size=None):
        """Restore-only verified installation. Never alter ordinary upload dedup behavior.

        Valid destinations are reused unchanged. An invalid regular destination is
        copied to private quarantine before an atomic replacement with verified bytes.
        No caller may use presence as a substitute for verification.
        """
        target = self.original_path(sha)
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise StorageError(
                "An original storage path is not a regular file; repair storage and retry."
            )
        if self.verify_original(sha, size):
            # Still validate the incoming object, even when no replacement is needed.
            if not verify_file(source, sha, size):
                raise IntegrityError(
                    "The returned object does not match its digest or expected size."
                )
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        staged = target.parent / f".restore-{uuid.uuid4().hex}.part"
        try:
            with source.open("rb") as incoming, staged.open("xb") as out:
                shutil.copyfileobj(incoming, out, 1 << 20)
                out.flush()
                os.fsync(out.fileno())
            if not verify_file(staged, sha, size):
                raise IntegrityError(
                    "The returned object does not match its digest or expected size."
                )
            if target.exists():
                self.preserve_original(sha)
                # A concurrent repair may already have supplied the correct content.
                if self.verify_original(sha, size):
                    return target
                if os.name == "nt":
                    os.chmod(target, 0o640)
            os.chmod(staged, 0o440)
            os.replace(staged, target)
            sync_directory(target.parent)
            if not self.verify_original(sha, size):
                raise IntegrityError(
                    "The installed original failed verification; restore is incomplete."
                )
            return target
        finally:
            if staged.exists():
                os.chmod(staged, 0o600)
                staged.unlink()

    def preserve_original(self, sha):
        """Keep bytes before restore repair or finalize removes their active path."""
        target = self.original_path(sha)
        quarantine = self.root / "restore-recovery" / "originals"
        quarantine.mkdir(parents=True, exist_ok=True, mode=0o700)
        saved = quarantine / f"{sha}-{uuid.uuid4().hex}.unverified"
        with target.open("rb") as old, saved.open("xb") as out:
            os.chmod(saved, 0o600)
            shutil.copyfileobj(old, out, 1 << 20)
            out.flush()
            os.fsync(out.fileno())
        sync_directory(quarantine)
        return saved

    def delete_original(self, sha):
        """Remove an original. Callers must first ensure that no photo uses it."""
        path = self.original_path(sha)
        if path.exists():
            os.chmod(path, 0o640)
            path.unlink()

    # ── derivatives ─────────────────────────────────────────────────

    def derivative_path(self, photo_id, key):
        if not UUID.fullmatch(photo_id or "") or not KEY.fullmatch(key or ""):
            raise StorageError("Invalid derivative key")
        return self.derived / photo_id[:2] / photo_id / key

    def write_derivative(self, photo_id, key, data: bytes):
        path = self.derivative_path(photo_id, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.parent / f".{key}.tmp"
        with open(temp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        return path

    def read_derivative(self, photo_id, key):
        path = self.derivative_path(photo_id, key)
        try:
            return path.read_bytes()
        except OSError:
            return None

    def drop_derivatives(self, photo_id):
        if not UUID.fullmatch(photo_id or ""):
            raise StorageError("Invalid photo id")
        shutil.rmtree(self.derived / photo_id[:2] / photo_id, ignore_errors=True)

    # ── uploads ─────────────────────────────────────────────────────

    def upload_path(self, upload_id):
        if not UUID.fullmatch(upload_id or ""):
            raise StorageError("Invalid upload id")
        return self.incoming / f"{upload_id}.part"

    def scratch_path(self, name):
        if not KEY.fullmatch(name):
            raise StorageError("Invalid scratch name")
        return self.scratch / name

    def usage(self):
        """Bytes used by originals and derivatives (for the library summary)."""

        def size(d):
            return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())

        return {"originals": size(self.originals), "derivatives": size(self.derived)}


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def verify_file(path, sha, size=None):
    """Streaming content verification, used only by restore/integrity workflows."""
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            return False
        with path.open("rb") as original:
            before = os.fstat(original.fileno())
            if not stat.S_ISREG(before.st_mode) or (size is not None and before.st_size != size):
                return False
            digest, count = hashlib.sha256(), 0
            while block := original.read(1 << 20):
                digest.update(block)
                count += len(block)
            after = os.fstat(original.fileno())
        current = path.lstat()
        return (
            stat.S_ISREG(current.st_mode)
            and (current.st_dev, current.st_ino) == (after.st_dev, after.st_ino)
            and digest.hexdigest() == sha
            and (size is None or count == size)
            and (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
        )
    except OSError:
        return False


def sync_directory(path):
    # The deployed Linux runtime supports directory fsync. Windows does not expose
    # the same operation; file flushes and atomic replacement are still performed.
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
