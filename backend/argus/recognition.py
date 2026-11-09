"""The model side of face recognition (ADR 0028). Runs only in the worker process.

Automation may detect, embed, group and suggest. It may never confirm an identity, and it only
ever writes to faces in the `auto` state, so a user's decision is never overwritten.
"""

import io
import logging
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .faces import enabled
from .storage import MediaStore
from .util import iso_now, uuid7

log = logging.getLogger("argus.recognition")
ROOT = Path(__file__).resolve().parents[2]
MAX_SIDE = 1280
MIN_FACE_PX = 36
# SFace's published cosine threshold for "same identity" is 0.363; groups use a stricter value.
SAME_CLUSTER = 0.42
SUGGEST_PERSON = 0.42
BATCH = 16


class Engine:
    """YuNet detection and SFace embeddings through OpenCV, on the CPU."""

    def __init__(self):
        import cv2

        cv2.setNumThreads(1)
        self.cv2 = cv2
        models = Path(os.environ.get("ARGUS_MODELS", ROOT / "models"))
        self.detector = cv2.FaceDetectorYN.create(str(models / "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.8, 0.3, 50)
        self.recognizer = cv2.FaceRecognizerSF.create(str(models / "face_recognition_sface_2021dec.onnx"), "")

    def _load(self, path, photo):
        with Image.open(path) as im:
            if photo["format"] == "JPEG":
                im.draft("RGB", (MAX_SIDE * 2, MAX_SIDE * 2))
            im.seek(0)
            im.load()
            out = ImageOps.exif_transpose(im).convert("RGB")
        out.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.BILINEAR)
        return np.asarray(out)[:, :, ::-1].copy()

    def _embed(self, image, detection):
        aligned = self.recognizer.alignCrop(image, detection)
        vector = self.recognizer.feature(aligned).flatten().astype(np.float32)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm else None

    def detect(self, path, photo):
        """[(x, y, w, h as fractions of the oriented picture, score, unit vector)]."""
        image = self._load(path, photo)
        h, w = image.shape[:2]
        self.detector.setInputSize((w, h))
        _, found = self.detector.detect(image)
        out = []
        for row in [] if found is None else found:
            x, y, fw, fh = row[:4]
            if fw < MIN_FACE_PX or fh < MIN_FACE_PX:
                continue
            vector = self._embed(image, row)
            if vector is not None:
                x0, y0 = max(0.0, x / w), max(0.0, y / h)
                out.append((float(x0), float(y0), float(min(fw / w, 1 - x0)), float(min(fh / h, 1 - y0)), float(row[14]), vector))
        return out

    def embed_region(self, path, photo, box):
        """A unit vector for a face marked by hand, if a face can be found in that area."""
        image = self._load(path, photo)
        H, W = image.shape[:2]
        mx, my = box["w"] * W * 0.6, box["h"] * H * 0.6
        x0, y0 = max(0, int(box["x"] * W - mx)), max(0, int(box["y"] * H - my))
        x1, y1 = min(W, int((box["x"] + box["w"]) * W + mx)), min(H, int((box["y"] + box["h"]) * H + my))
        region = image[y0:y1, x0:x1].copy()
        if region.size == 0:
            return None
        self.detector.setInputSize((region.shape[1], region.shape[0]))
        self.detector.setScoreThreshold(0.5)
        _, found = self.detector.detect(region)
        self.detector.setScoreThreshold(0.8)
        if found is None or not len(found):
            return None
        return self._embed(region, max(found, key=lambda r: r[14]))


def _vec(blob):
    return np.frombuffer(blob, dtype=np.float32)


def _unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n else v


class Index:
    """Cluster centroids and, from confirmed faces only, what each person looks like."""

    def __init__(self, conn):
        self.clusters = {}
        for r in conn.execute("SELECT id, person_ref, person_label FROM face_clusters"):
            self.clusters[r["id"]] = {"sum": None, "n": 0, "ref": r["person_ref"], "label": r["person_label"]}
        self.people = {}
        for f in conn.execute("SELECT cluster_id, status, person_ref, person_label, embedding FROM faces WHERE embedding IS NOT NULL AND status IN ('auto','confirmed')"):
            v = _vec(f["embedding"])
            c = self.clusters.get(f["cluster_id"])
            if c:
                c["sum"] = v.copy() if c["sum"] is None else c["sum"] + v
                c["n"] += 1
            if f["status"] == "confirmed" and f["person_ref"]:
                p = self.people.setdefault(f["person_ref"], {"sum": v * 0, "n": 0, "label": f["person_label"]})
                p["sum"] = p["sum"] + v
                p["n"] += 1

    @staticmethod
    def _best(table, vector):
        best, score = None, -1.0
        for key, e in table.items():
            if e["n"] and e["sum"] is not None:
                s = float(_unit(e["sum"]) @ vector)
                if s > score:
                    best, score = key, s
        return best, score

    def cluster_for(self, conn, vector, now):
        best, score = self._best(self.clusters, vector)
        if best is None or score < SAME_CLUSTER:
            best, score = uuid7(), 1.0
            conn.execute("INSERT INTO face_clusters(id, created_at, updated_at) VALUES(?,?,?)", (best, now, now))
            self.clusters[best] = {"sum": None, "n": 0, "ref": None, "label": ""}
        c = self.clusters[best]
        c["sum"] = vector.copy() if c["sum"] is None else c["sum"] + vector
        c["n"] += 1
        return best, score

    def suggestion(self, vector):
        ref, score = self._best(self.people, vector)
        if ref is None or score < SUGGEST_PERSON:
            return None, "", None
        return ref, self.people[ref]["label"], score


def scan_one(conn, store: MediaStore, engine, photo, index):
    now = iso_now()
    try:
        found = engine.detect(store.original_path(photo["blob"]), photo)
    except Exception as exc:  # an unreadable picture is recorded, and does not stop the queue
        log.warning("Scan failed: %s", type(exc).__name__)
        conn.execute("INSERT OR REPLACE INTO face_scans(photo_id, state, faces, error, scanned_at) VALUES(?,?,0,?,?)", (photo["id"], "failed", type(exc).__name__, now))
        return 0
    for x, y, w, h, score, vector in found:
        cluster, match = index.cluster_for(conn, vector, now)
        ref, label, person_score = index.suggestion(vector)
        if ref is None and index.clusters[cluster]["ref"]:
            ref, label = index.clusters[cluster]["ref"], index.clusters[cluster]["label"]
        conn.execute(
            "INSERT INTO faces(id, photo_id, cluster_id, auto_cluster_id, x, y, w, h, score, embedding, match, status, origin, suggested_ref, suggested_label, created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,'auto','detected',?,?,?,?)",
            (uuid7(), photo["id"], cluster, cluster, x, y, w, h, score, vector.astype(np.float32).tobytes(),
             person_score if person_score is not None else match, ref, label, now, now),
        )  # fmt: skip
    conn.execute("INSERT OR REPLACE INTO face_scans(photo_id, state, faces, error, scanned_at) VALUES(?,?,?,'',?)", (photo["id"], "done", len(found), now))
    return len(found)


def embed_manual(conn, store: MediaStore, engine):
    """Faces marked by hand: try to make them matchable. Their identity is never touched."""
    rows = conn.execute(
        "SELECT f.id, f.x, f.y, f.w, f.h, p.* FROM faces f JOIN photos p ON p.id=f.photo_id "
        "WHERE f.origin='manual' AND f.embedding IS NULL AND f.embed_tried=0 AND p.state='active' LIMIT 8"
    ).fetchall()
    for r in rows:
        face_id = r[0]
        box = {"x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]}
        try:
            vector = engine.embed_region(store.original_path(r["blob"]), r, box)
        except Exception:
            vector = None
        conn.execute(
            "UPDATE faces SET embedding=?, embed_tried=1 WHERE id=?",
            (vector.astype(np.float32).tobytes() if vector is not None else None, face_id),
        )
    return len(rows)


def refresh_suggestions(conn):
    """After corrections: new suggestions from confirmed faces, for unconfirmed faces only."""
    index = Index(conn)
    now = iso_now()
    for f in conn.execute("SELECT id, cluster_id, embedding FROM faces WHERE status='auto' AND embedding IS NOT NULL").fetchall():
        vector = _vec(f["embedding"])
        ref, label, score = index.suggestion(vector)
        if ref is None:
            c = index.clusters.get(f["cluster_id"])
            ref, label = (c["ref"], c["label"]) if c and c["ref"] else (None, "")
            conn.execute("UPDATE faces SET suggested_ref=?, suggested_label=?, updated_at=? WHERE id=? AND status='auto'", (ref, label, now, f["id"]))
        else:
            conn.execute("UPDATE faces SET suggested_ref=?, suggested_label=?, match=?, updated_at=? WHERE id=? AND status='auto'", (ref, label, score, now, f["id"]))
    conn.execute("DELETE FROM settings WHERE key='faces_refresh'")


def run(db, store: MediaStore, engine, limit=None):
    """Process the queue until it is empty, recognition is switched off, or the limit is reached."""
    done = 0
    while limit is None or done < limit:
        with db.connect() as conn:
            if not enabled(conn):
                return done
            photos = conn.execute(
                "SELECT p.* FROM photos p LEFT JOIN face_scans s ON s.photo_id=p.id WHERE p.state='active' AND s.photo_id IS NULL ORDER BY p.created_at LIMIT ?",
                (BATCH,),
            ).fetchall()
            if photos:
                index = Index(conn)
                for photo in photos:
                    scan_one(conn, store, engine, photo, index)
                    done += 1
            manual = embed_manual(conn, store, engine)
            refresh = conn.execute("SELECT 1 FROM settings WHERE key='faces_refresh'").fetchone()
            if refresh or manual:
                refresh_suggestions(conn)
            if not photos and not manual:
                return done
    return done


# Kept importable for tests that build images in memory.
__all__ = ["Engine", "Index", "run", "io"]
