"""Argus's own SQLite database (never shared with another module).

Model (docs/ARGUS.md):
- blobs: original files, content-addressed by SHA-256. One blob may back several photos (the
  same bytes uploaded twice); a blob is deleted only when no photo uses it.
- photos: the referenceable resource (`nexus:v1:argus:photo:<uuid>`). A stable UUIDv7 identity
  that never changes when the bytes move to another storage backend. Metadata is extracted at
  upload; dimensions are *oriented* (after EXIF orientation), as people see the picture.
- derivatives: rebuildable caches (thumbnails, display images, crop renditions). Losing them
  loses nothing.
- uploads: chunked upload sessions; their bytes live in /data/uploads until finished.
- tombstones: purged photo IDs, so references resolve as "deleted" (410), never as unknown.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

MIGRATIONS = [
    """
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE blobs(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), size INTEGER NOT NULL,
 mime TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE photos(id TEXT PRIMARY KEY,
 blob TEXT NOT NULL REFERENCES blobs(sha256),
 filename TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
 format TEXT NOT NULL, mime TEXT NOT NULL,
 width INTEGER NOT NULL, height INTEGER NOT NULL,
 stored_width INTEGER NOT NULL, stored_height INTEGER NOT NULL,
 orientation INTEGER NOT NULL DEFAULT 1, bytes INTEGER NOT NULL,
 taken_at TEXT, camera TEXT NOT NULL DEFAULT '', has_location INTEGER NOT NULL DEFAULT 0,
 metadata TEXT NOT NULL DEFAULT '{}',
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','trashed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT);
CREATE INDEX photos_state ON photos(state, created_at);
CREATE INDEX photos_blob ON photos(blob);
CREATE TABLE derivatives(photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
 key TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
 bytes INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(photo_id, key));
CREATE TABLE uploads(id TEXT PRIMARY KEY, filename TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, chunk INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tombstones(id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
""",
]


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def migrate(self):
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise RuntimeError("Database is newer than this application")
            for i in range(version, len(MIGRATIONS)):
                db.executescript(
                    "BEGIN IMMEDIATE;\n" + MIGRATIONS[i] + f"\nPRAGMA user_version={i + 1}; COMMIT;"
                )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()
