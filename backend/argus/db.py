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
    # 0.2.0 (schema 2, roadmap Phase 5): bulk import (ADR 0027) and face recognition (ADR 0028).
    # Additive: no existing row or original changes.
    """
CREATE TABLE photo_sources(photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
 source TEXT NOT NULL, path TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY(photo_id, source, path));
CREATE TABLE import_jobs(id TEXT PRIMARY KEY, source TEXT NOT NULL, root TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('scanning','running','cancelling','cancelled','done','failed')),
 total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
 duplicates INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE import_items(job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
 path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','imported','duplicate','failed')),
 sha256 TEXT, photo_id TEXT, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(job_id, seq));
CREATE INDEX import_items_pending ON import_items(job_id, state, seq);
-- A cluster groups faces that look alike. person_ref is set only when the user names it.
CREATE TABLE face_clusters(id TEXT PRIMARY KEY, person_ref TEXT, person_label TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- status: auto (a prediction), confirmed (the user's), unknown, excluded. confirmed_by: face or cluster.
-- auto_cluster_id keeps what automation chose, so any correction can be undone. Biometric data.
CREATE TABLE faces(id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
 cluster_id TEXT REFERENCES face_clusters(id) ON DELETE SET NULL,
 auto_cluster_id TEXT REFERENCES face_clusters(id) ON DELETE SET NULL,
 x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, score REAL, embedding BLOB,
 embed_tried INTEGER NOT NULL DEFAULT 0, match REAL,
 status TEXT NOT NULL DEFAULT 'auto' CHECK(status IN ('auto','confirmed','unknown','excluded')),
 origin TEXT NOT NULL DEFAULT 'detected' CHECK(origin IN ('detected','manual')),
 confirmed_by TEXT CHECK(confirmed_by IS NULL OR confirmed_by IN ('face','cluster')),
 person_ref TEXT, person_label TEXT NOT NULL DEFAULT '',
 suggested_ref TEXT, suggested_label TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX faces_photo ON faces(photo_id);
CREATE INDEX faces_cluster ON faces(cluster_id);
CREATE TABLE face_scans(photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('done','failed')), faces INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT '', scanned_at TEXT NOT NULL);
-- Confirmed people in a photo, registered with Nexus as argus.depicts, shared with Meridian.
CREATE TABLE photo_people(photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, person_ref TEXT NOT NULL,
 nexus_reference_id TEXT, nexus_state TEXT NOT NULL DEFAULT 'pending' CHECK(nexus_state IN ('pending','registered')),
 PRIMARY KEY(photo_id, person_ref));
CREATE TABLE reference_cleanup(reference_id TEXT PRIMARY KEY, queued_at TEXT NOT NULL);
CREATE TRIGGER photo_people_cleanup AFTER DELETE ON photo_people WHEN OLD.nexus_reference_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO reference_cleanup(reference_id, queued_at)
 VALUES(OLD.nexus_reference_id, strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
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
