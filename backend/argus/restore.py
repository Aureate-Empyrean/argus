"""Restore validation and durable fail-closed state; no gallery-path hashing."""

import json
import os
import sqlite3
import uuid
from contextlib import closing

from .storage import HEX, sync_directory


def object_specs(items):
    if not isinstance(items, list):
        raise ValueError("Backup objects must include trustworthy SHA-256 identities and sizes.")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Backup object metadata is invalid.")
        sha, size = item.get("sha256"), item.get("size")
        if not isinstance(sha, str) or not HEX.fullmatch(sha) or type(size) is not int or size <= 0:
            raise ValueError(
                "Trustworthy SHA-256 and size information is required; use a verified Full backup."
            )
        if sha in result:
            raise ValueError("Backup lists an original more than once.")
        result[sha] = size
    return result


def database_objects(conn):
    return object_specs(
        [
            {"sha256": row[0], "size": row[1]}
            for row in conn.execute("SELECT sha256,size FROM blobs")
        ]
    )


def verify_originals(store, expected):
    bad = [sha for sha, size in expected.items() if not store.verify_original(sha, size)]
    if bad:
        raise ValueError(
            f"{len(bad)} original file(s) are missing or failed SHA-256/size verification "
            "and have not been returned intact. Return verified backup objects and retry; "
            "Full restore cannot complete."
        )


class RestoreState:
    def __init__(self, root):
        self.root = root
        self.path = root / "restore-state.json"

    def read(self):
        if not self.path.exists():
            return None
        try:
            record = json.loads(self.path.read_text())
            if (
                not isinstance(record, dict)
                or record.get("phase") not in {"applying", "ready", "failed", "finalized"}
                or record.get("mode") not in {"full", "quick"}
            ):
                raise ValueError("Invalid state")
            object_specs(record["objects"])
            return record
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError(
                "Restore state is unreadable. Repeat restore from a verified backup before finalizing."
            ) from exc

    def write(self, record, phase):
        record = {**record, "phase": phase}
        temp = self.root / f".restore-state-{uuid.uuid4().hex}.part"
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as out:
                json.dump(record, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, self.path)
            sync_directory(self.root)
        finally:
            temp.unlink(missing_ok=True)
        return record

    def begin(self, db, mode, expected):
        attempt = uuid.uuid4().hex
        folder = self.root / "restore-recovery" / attempt
        folder.mkdir(parents=True, mode=0o700)
        backup = folder / "before.sqlite3"
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(backup)) as saved, db.connect() as current:
            current.backup(saved)
            if saved.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("The pre-restore database could not be backed up safely.")
        sync_directory(folder)
        sync_directory(folder.parent)
        return self.write(
            {
                "attempt": attempt,
                "mode": mode,
                "objects": [{"sha256": sha, "size": size} for sha, size in expected.items()],
            },
            "applying",
        )

    def rollback(self, db, record):
        backup = self.root / "restore-recovery" / record["attempt"] / "before.sqlite3"
        with (
            closing(sqlite3.connect(f"file:{backup}?mode=ro", uri=True)) as saved,
            db.connect() as current,
        ):
            saved.backup(current)
