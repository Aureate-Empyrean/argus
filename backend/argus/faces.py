"""Face recognition: everything except the model work (ADR 0028).

Argus owns photographs, detections, embeddings and results; Meridian owns identities and is never
written to. Embeddings never leave this module: no API, projection or reference carries them.

A face's identity has one of these states, and only the user can leave `auto`:
- auto: a prediction. It may carry a suggested person; it is never treated as a fact.
- confirmed: the user said who this is, on the face itself or by naming a cluster.
- unknown: the user said it cannot be named. excluded: the user took it out of recognition.
Nothing automatic ever changes a face that is not `auto`. Corrections are reversible, and only
this data changes: originals are never touched.
"""

import logging
import os
import re
import threading

from . import imaging, nexus
from .storage import MediaStore
from .util import iso_now, uuid7

log = logging.getLogger("argus.faces")
PERSON = re.compile(r"^nexus:v1:meridian:person:[0-9a-f-]{36}$")
RELATION = "argus.depicts"
MIN_MEMORY_MB = 600
# Naming a cluster confirms only faces this close to it; the rest stay suggestions.
CONFIRM_FROM_CLUSTER = 0.5
THUMB = 128


class Invalid(ValueError):
    pass


def confidence(match):
    if match is None:
        return None
    return "high" if match >= 0.6 else "medium" if match >= 0.48 else "low"


def memory_limit_mb():
    try:
        with open("/sys/fs/cgroup/memory.max") as f:
            value = f.read().strip()
        return None if value == "max" else int(value) // (1024 * 1024)
    except (OSError, ValueError):
        return None


def enabled(conn):
    row = conn.execute("SELECT value FROM settings WHERE key='faces_enabled'").fetchone()
    return bool(row and row[0] == "1")


def status(conn):
    limit = memory_limit_mb()
    supported = limit is None or limit >= MIN_MEMORY_MB
    active = conn.execute("SELECT count(*) FROM photos WHERE state='active'").fetchone()[0]
    scanned = conn.execute(
        "SELECT count(*) FROM face_scans s JOIN photos p ON p.id=s.photo_id WHERE p.state='active'"
    ).fetchone()[0]
    count = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "enabled": enabled(conn), "supported": supported, "memory_limit_mb": limit, "photos": active, "scanned": scanned,
        "faces": count("SELECT count(*) FROM faces"), "confirmed": count("SELECT count(*) FROM faces WHERE status='confirmed'"),
        "clusters": count("SELECT count(*) FROM face_clusters"),
        "model": "YuNet 2023mar + SFace 2021dec (local)",
    }  # fmt: skip


def set_enabled(conn, value: bool):
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('faces_enabled', ?)", ("1" if value else "0",))


def delete_all(conn):
    """Remove every detection, embedding, cluster and scan, and switch recognition off. Photos stay."""
    conn.execute("DELETE FROM photo_people")
    conn.execute("DELETE FROM faces")
    conn.execute("DELETE FROM face_clusters")
    conn.execute("DELETE FROM face_scans")
    set_enabled(conn, False)


def _crop(photo, face):
    """A square around the face, with a margin, as fractions of the oriented picture."""
    W, H = photo["width"], photo["height"]
    side = min(max(face["w"] * W, face["h"] * H) * 1.5, W, H)
    cx, cy = (face["x"] + face["w"] / 2) * W, (face["y"] + face["h"] / 2) * H
    x = max(0, min(W - side, cx - side / 2))
    y = max(0, min(H - side, cy - side / 2))
    return {"x": x / W, "y": y / H, "w": side / W, "h": side / H}


def thumbnail(store: MediaStore, photo, face):
    from .library import data_url

    key = f"face-{face['id'][-12:]}"
    cached = store.read_derivative(photo["id"], key)
    if cached:
        return data_url(cached)
    try:
        data, _, _ = imaging.render(store.original_path(photo["blob"]), dict(photo), THUMB, _crop(photo, face))
    except (OSError, ValueError, SyntaxError):
        return None
    store.write_derivative(photo["id"], key, data)
    return data_url(data)


def face_view(face, thumb=None):
    return {
        "id": face["id"], "photo_id": face["photo_id"], "cluster_id": face["cluster_id"],
        "box": {k: face[k] for k in ("x", "y", "w", "h")}, "status": face["status"], "origin": face["origin"],
        "person": face["person_ref"], "person_label": face["person_label"],
        "suggested": face["suggested_ref"], "suggested_label": face["suggested_label"],
        "match": round(face["match"], 3) if face["match"] is not None else None, "confidence": confidence(face["match"]),
        "matchable": face["has_embedding"] == 1, "thumb": thumb,
    }  # fmt: skip


FIELDS = "f.id,f.photo_id,f.cluster_id,f.x,f.y,f.w,f.h,f.status,f.origin,f.person_ref,f.person_label,f.suggested_ref,f.suggested_label,f.match,f.confirmed_by,(f.embedding IS NOT NULL) AS has_embedding"


def _face(conn, fid):
    row = conn.execute(f"SELECT {FIELDS} FROM faces f WHERE f.id=?", (fid,)).fetchone()
    if not row:
        raise LookupError
    return row


def photo_faces(conn, store, photo):
    rows = conn.execute(f"SELECT {FIELDS} FROM faces f WHERE f.photo_id=? ORDER BY f.x", (photo["id"],)).fetchall()
    return [face_view(r, thumbnail(store, photo, r)) for r in rows]


def clusters(conn, store, get_photo):
    out = []
    for c in conn.execute(
        "SELECT c.*, (SELECT count(*) FROM faces f JOIN photos p ON p.id=f.photo_id WHERE f.cluster_id=c.id AND p.state='active') n "
        "FROM face_clusters c ORDER BY c.person_ref IS NOT NULL, n DESC, c.created_at"
    ).fetchall():
        if not c["n"]:
            continue
        sample = conn.execute(
            f"SELECT {FIELDS} FROM faces f JOIN photos p ON p.id=f.photo_id WHERE f.cluster_id=? AND p.state='active' ORDER BY f.match DESC LIMIT 4",
            (c["id"],),
        ).fetchall()
        out.append({"id": c["id"], "person": c["person_ref"], "person_label": c["person_label"], "count": c["n"],
                    "faces": [face_view(s, thumbnail(store, get_photo(conn, s["photo_id"]), s)) for s in sample]})  # fmt: skip
    return out


def cluster_detail(conn, store, get_photo, cid, limit=120):
    c = conn.execute("SELECT * FROM face_clusters WHERE id=?", (cid,)).fetchone()
    if not c:
        raise LookupError
    rows = conn.execute(
        f"SELECT {FIELDS} FROM faces f JOIN photos p ON p.id=f.photo_id WHERE f.cluster_id=? AND p.state='active' ORDER BY f.match DESC LIMIT ?",
        (cid, limit),
    ).fetchall()
    return {"id": c["id"], "person": c["person_ref"], "person_label": c["person_label"],
            "faces": [face_view(r, thumbnail(store, get_photo(conn, r["photo_id"]), r)) for r in rows]}  # fmt: skip


def _check_person(resource):
    if not PERSON.fullmatch(resource or ""):
        raise Invalid("Choose a person from Meridian.")


def _people_changed(conn, photo_id):
    """photo_people follows the confirmed faces of a photo, and nothing else."""
    wanted = {r[0]: r[1] for r in conn.execute(
        "SELECT person_ref, person_label FROM faces WHERE photo_id=? AND status='confirmed' AND person_ref IS NOT NULL", (photo_id,))}  # fmt: skip
    have = {r[0] for r in conn.execute("SELECT person_ref FROM photo_people WHERE photo_id=?", (photo_id,))}
    for ref in have - set(wanted):
        conn.execute("DELETE FROM photo_people WHERE photo_id=? AND person_ref=?", (photo_id, ref))
    for ref in set(wanted) - have:
        conn.execute("INSERT INTO photo_people(photo_id, person_ref) VALUES(?,?)", (photo_id, ref))


def _refresh_needed(conn):
    """Confirmed identities improve later suggestions: the worker recomputes them."""
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('faces_refresh', '1')")


def assign_face(conn, fid, resource, label):
    """The user says who this face is. It always wins over automation."""
    _check_person(resource)
    face = _face(conn, fid)
    conn.execute(
        "UPDATE faces SET status='confirmed', confirmed_by='face', person_ref=?, person_label=?, updated_at=? WHERE id=?",
        (resource, (label or "")[:200], iso_now(), fid),
    )
    _people_changed(conn, face["photo_id"])
    _refresh_needed(conn)


def confirm_face(conn, fid):
    """Accept the suggestion shown on this face (from a person match or its named cluster)."""
    face = _face(conn, fid)
    ref, name = face["suggested_ref"], face["suggested_label"]
    if not ref and face["cluster_id"]:
        c = conn.execute("SELECT person_ref, person_label FROM face_clusters WHERE id=?", (face["cluster_id"],)).fetchone()
        ref, name = c["person_ref"], c["person_label"]
    if not ref:
        raise Invalid("This face has no suggestion to confirm. Choose a person.")
    assign_face(conn, fid, ref, name)


def mark_face(conn, fid, state):
    """unknown or excluded: the face is taken out of matching and stays that way."""
    if state not in ("unknown", "excluded"):
        raise Invalid("Unknown state.")
    face = _face(conn, fid)
    conn.execute(
        "UPDATE faces SET status=?, confirmed_by='face', person_ref=NULL, person_label='', suggested_ref=NULL, suggested_label='', cluster_id=NULL, updated_at=? WHERE id=?",
        (state, iso_now(), fid),
    )
    _people_changed(conn, face["photo_id"])
    _refresh_needed(conn)


def reset_face(conn, fid):
    """Undo any correction on this face: back to what automation had, as an unconfirmed result."""
    face = _face(conn, fid)
    conn.execute(
        "UPDATE faces SET status='auto', confirmed_by=NULL, person_ref=NULL, person_label='', cluster_id=auto_cluster_id, updated_at=? WHERE id=?",
        (iso_now(), fid),
    )
    _people_changed(conn, face["photo_id"])
    _refresh_needed(conn)


def add_manual(conn, photo, box):
    """A face detection missed, marked by hand. The worker tries to make it matchable."""
    x, y, w, h = (float(box[k]) for k in ("x", "y", "w", "h"))
    if not (0 <= x < 1 and 0 <= y < 1 and 0.005 <= w <= 1 and 0.005 <= h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise Invalid("Mark the face inside the picture.")
    fid, now = uuid7(), iso_now()
    conn.execute(
        "INSERT INTO faces(id, photo_id, x, y, w, h, score, status, origin, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (fid, photo["id"], x, y, min(w, 1 - x), min(h, 1 - y), None, "auto", "manual", now, now),
    )
    return fid


def delete_manual(conn, fid):
    face = _face(conn, fid)
    if face["origin"] != "manual":
        raise Invalid("Only a face you marked by hand can be removed. Mark this one as excluded instead.")
    conn.execute("DELETE FROM faces WHERE id=?", (fid,))
    _people_changed(conn, face["photo_id"])
    _refresh_needed(conn)


def _cluster(conn, cid):
    row = conn.execute("SELECT * FROM face_clusters WHERE id=?", (cid,)).fetchone()
    if not row:
        raise LookupError
    return row


def assign_cluster(conn, cid, resource, label):
    """Name a cluster. Only confident, unconfirmed faces are confirmed; uncertain ones stay
    suggestions, and anything the user decided on a single face is left alone."""
    _check_person(resource)
    _cluster(conn, cid)
    now = iso_now()
    name = (label or "")[:200]
    conn.execute("UPDATE face_clusters SET person_ref=?, person_label=?, updated_at=? WHERE id=?", (resource, name, now, cid))
    conn.execute(
        "UPDATE faces SET status='confirmed', confirmed_by='cluster', person_ref=?, person_label=?, updated_at=? "
        "WHERE cluster_id=? AND status='auto' AND match>=?",
        (resource, name, now, cid, CONFIRM_FROM_CLUSTER),
    )
    conn.execute(
        "UPDATE faces SET suggested_ref=?, suggested_label=?, updated_at=? WHERE cluster_id=? AND status='auto'",
        (resource, name, now, cid),
    )
    for r in conn.execute("SELECT DISTINCT photo_id FROM faces WHERE cluster_id=?", (cid,)).fetchall():
        _people_changed(conn, r[0])
    _refresh_needed(conn)


def unassign_cluster(conn, cid):
    """Undo naming a cluster. Identities the user set on a single face stay."""
    c = _cluster(conn, cid)
    now = iso_now()
    photos = [r[0] for r in conn.execute("SELECT DISTINCT photo_id FROM faces WHERE cluster_id=?", (cid,))]
    conn.execute(
        "UPDATE faces SET status='auto', confirmed_by=NULL, person_ref=NULL, person_label='', updated_at=? WHERE cluster_id=? AND confirmed_by='cluster'",
        (now, cid),
    )
    conn.execute(
        "UPDATE faces SET suggested_ref=NULL, suggested_label='', updated_at=? WHERE cluster_id=? AND status='auto' AND suggested_ref=?",
        (now, cid, c["person_ref"]),
    )
    conn.execute("UPDATE face_clusters SET person_ref=NULL, person_label='', updated_at=? WHERE id=?", (now, cid))
    for photo in photos:
        _people_changed(conn, photo)
    _refresh_needed(conn)


def merge_clusters(conn, source, into):
    if source == into:
        raise Invalid("Choose another group.")
    a, b = _cluster(conn, source), _cluster(conn, into)
    if a["person_ref"] and b["person_ref"] and a["person_ref"] != b["person_ref"]:
        raise Invalid("These groups are named as different people. Unassign one first.")
    now = iso_now()
    conn.execute("UPDATE faces SET cluster_id=?, auto_cluster_id=?, updated_at=? WHERE cluster_id=?", (into, into, now, source))
    conn.execute("UPDATE faces SET auto_cluster_id=? WHERE auto_cluster_id=?", (into, source))
    if a["person_ref"] and not b["person_ref"]:
        conn.execute("UPDATE face_clusters SET person_ref=?, person_label=?, updated_at=? WHERE id=?", (a["person_ref"], a["person_label"], now, into))
    conn.execute("DELETE FROM face_clusters WHERE id=?", (source,))
    _refresh_needed(conn)


# ── Nexus edges: a confirmed person in a photo, shared with Meridian ────────


def photo_ref(photo_id):
    return f"nexus:v1:argus:photo:{photo_id}"


def sync_references(db):
    with db.connect() as conn:
        cleanup = [r[0] for r in conn.execute("SELECT reference_id FROM reference_cleanup")]
        rows = conn.execute("SELECT photo_id, person_ref FROM photo_people WHERE nexus_state<>'registered'").fetchall()
    for ref_id in cleanup:
        try:
            nexus.delete_reference(ref_id)
        except nexus.NexusUnavailable:
            continue
        with db.connect() as conn:
            conn.execute("DELETE FROM reference_cleanup WHERE reference_id=?", (ref_id,))
    for row in rows:
        try:
            ref_id = nexus.create_reference(photo_ref(row["photo_id"]), row["person_ref"], RELATION, ["meridian"])
        except nexus.NexusUnavailable as exc:
            log.warning("Reference not registered: %s", exc)
            continue
        with db.connect() as conn:
            conn.execute(
                "UPDATE photo_people SET nexus_state='registered', nexus_reference_id=? WHERE photo_id=? AND person_ref=?",
                (ref_id, row["photo_id"], row["person_ref"]),
            )


def outgoing(conn, limit, cursor):
    rows = conn.execute(
        "SELECT rowid AS n, photo_id, person_ref FROM photo_people WHERE rowid > ? ORDER BY rowid LIMIT ?",
        (int(cursor or 0), limit + 1),
    ).fetchall()
    page = rows[:limit]
    return {
        "references": [{"source": photo_ref(r["photo_id"]), "target": r["person_ref"], "relation": RELATION,
                        "metadata": {}, "readers": ["meridian"]} for r in page],
        "next_cursor": str(page[-1]["n"]) if len(rows) > limit else None,
    }  # fmt: skip


class Worker:
    """Runs the recognition worker as a separate process, so the models' memory is returned as
    soon as the queue is empty."""

    def __init__(self, db, data):
        self.db, self.data = db, data
        self.lock = threading.Lock()
        self.process = None

    def kick(self):
        import subprocess
        import sys

        with self.db.connect() as conn:
            if not enabled(conn) or not status(conn)["supported"]:
                return False
        with self.lock:
            if self.process and self.process.poll() is None:
                return True
            self.process = subprocess.Popen(
                [sys.executable, "-m", "argus.face_worker", str(self.data)],
                env={**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"},
                stdin=subprocess.DEVNULL,
            )
        return True
