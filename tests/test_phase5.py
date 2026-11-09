"""Argus 0.2.0 (roadmap Phase 5): bulk import (D14), Quick and Full backups (D13), face recognition (D15)."""

import hashlib
import io
import json
import os
import sqlite3
import tarfile
import time

import numpy as np
import pytest
from argus import faces, nexus, recognition
from argus.app import create_app
from fastapi.testclient import TestClient
from PIL import Image

KEY = "k" * 40
GW = {"x-nexus-gateway-key": KEY}
RES = {"x-nexus-resolver-key": KEY}
PETER = "nexus:v1:meridian:person:0190f0e4-0000-7000-8000-000000000001"
JANA = "nexus:v1:meridian:person:0190f0e4-0000-7000-8000-000000000002"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    monkeypatch.delenv("NEXUS_URL", raising=False)
    monkeypatch.setattr(faces.Worker, "kick", lambda self: False)
    with TestClient(create_app(tmp_path)) as c:
        c.headers.update(GW)
        yield c


def png(color, size=(60, 40)):
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "PNG")
    return out.getvalue()


def wait_job(client, jid, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        job = next(j for j in client.get("/api/import/jobs").json()["items"] if j["id"] == jid)
        if job["state"] not in ("scanning", "running", "cancelling"):
            return job
        time.sleep(0.05)
    raise AssertionError("import did not finish")


def upload(client, data, name="p.png"):
    start = client.post("/api/uploads", json={"filename": name, "size": len(data)}).json()
    import base64

    client.put(f"/api/uploads/{start['id']}/0", json={"data": base64.b64encode(data).decode()})
    return client.post(f"/api/uploads/{start['id']}/finish").json()


# ── Import ─────────────────────────────────────────────────────────────


def test_server_import_finds_duplicates_by_content_and_never_touches_sources(client, tmp_path):
    root = tmp_path / "import" / "trip"
    (root / "day2").mkdir(parents=True)
    a, b = png((255, 0, 0)), png((0, 255, 0))
    (root / "a.png").write_bytes(a)
    (root / "day2" / "renamed.PNG").write_bytes(a)  # the same bytes under another name
    (root / "day2" / "b.png").write_bytes(b)
    (root / "bad.png").write_bytes(b"not an image")
    (root / "notes.txt").write_text("ignored")
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    listed = client.get("/api/import/folders").json()
    assert [f["path"] for f in listed["folders"]] == ["trip"]
    jid = client.post("/api/import/jobs", json={"path": "trip"}).json()["id"]
    job = wait_job(client, jid)
    assert (job["state"], job["total"], job["imported"], job["duplicates"], job["failed"]) == ("done", 4, 2, 1, 1)
    assert {p: p.read_bytes() for p in root.rglob("*") if p.is_file()} == before  # sources unchanged
    errors = client.get(f"/api/import/jobs/{jid}/errors").json()["items"]
    assert errors[0]["path"] == "trip/bad.png" and "not a JPEG" in errors[0]["error"]
    with sqlite3.connect(tmp_path / "argus.sqlite3") as db:
        sources = {r[0] for r in db.execute("SELECT path FROM photo_sources")}
    assert sources == {"trip/a.png", "trip/day2/renamed.PNG", "trip/day2/b.png"}
    # Importing again adds nothing.
    again = wait_job(client, client.post("/api/import/jobs", json={"path": "trip"}).json()["id"])
    assert (again["imported"], again["duplicates"]) == (0, 3)


@pytest.mark.parametrize("path", ["../..", "trip/../..", "/etc", "..\\..", "missing"])
def test_server_import_cannot_leave_its_folder(client, tmp_path, path):
    (tmp_path / "import" / "trip").mkdir(parents=True, exist_ok=True)
    assert client.get("/api/import/folders", params={"path": path}).status_code == 422
    assert client.post("/api/import/jobs", json={"path": path}).status_code == 422


def test_symbolic_links_are_not_followed(client, tmp_path):
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "x.png").write_bytes(png((1, 2, 3)))
    root = tmp_path / "import"
    try:
        os.symlink(outside, root / "link")
        os.symlink(outside / "x.png", root / "y.png")
    except OSError:
        pytest.skip("symlinks unavailable")
    assert client.get("/api/import/folders", params={"path": "link"}).status_code == 422
    job = wait_job(client, client.post("/api/import/jobs", json={"path": ""}).json()["id"])
    assert (job["total"], job["imported"]) == (0, 0)


def test_cancel_stops_and_a_restart_resumes(client, tmp_path):
    root = tmp_path / "import" / "many"
    root.mkdir(parents=True)
    for i in range(3):
        (root / f"{i}.png").write_bytes(png((i, 9, 9)))
    db = client.app.state.db
    now = "2026-11-09T00:00:00Z"
    with db.connect() as conn:
        conn.execute("INSERT INTO import_jobs(id,source,root,state,total,created_at,updated_at) VALUES('j','server','many','running',3,?,?)", (now, now))
        for i in range(3):
            state = "imported" if i == 0 else "pending"
            conn.execute("INSERT INTO import_items(job_id,seq,path,state) VALUES('j',?,?,?)", (i, f"many/{i}.png", state))
    client.app.state.importer.kick()  # what a restart does
    job = wait_job(client, "j")
    assert (job["state"], job["imported"]) == ("done", 2)
    cancelled = client.post("/api/import/jobs/j/cancel")
    assert cancelled.status_code == 200
    assert next(j for j in client.get("/api/import/jobs").json()["items"] if j["id"] == "j")["state"] == "done"


# ── Backups ────────────────────────────────────────────────────────────


def export(client, mode):
    return client.post("/empyrean/v1/backup/export", headers={**RES, "X-Empyrean-Backup-Mode": mode})


def backup_headers(response):
    return {k: v for k, v in response.headers.items() if k.lower().startswith("x-empyrean-backup-")}


def test_quick_backup_says_it_is_incomplete_and_holds_no_media(client):
    upload(client, png((10, 20, 30)))
    out = export(client, "quick")
    assert out.headers["x-empyrean-backup-completeness"] == "quick"
    assert "x-empyrean-backup-objects" not in out.headers
    with tarfile.open(fileobj=io.BytesIO(out.content)) as tar:
        assert sorted(tar.getnames()) == ["argus.sqlite3", "manifest.json"]


def test_full_backup_lists_objects_and_restores_a_usable_library(client, tmp_path):
    data = png((40, 50, 60))
    sha = hashlib.sha256(data).hexdigest()
    photo = upload(client, data)["photo"]
    out = export(client, "full")
    headers = backup_headers(out)
    assert out.headers["x-empyrean-backup-completeness"] == "full"
    token = out.headers["x-empyrean-backup-objects"]
    listing = client.get("/empyrean/v1/backup/objects", params={"export": token}, headers=RES).json()
    assert listing == {"objects": [{"sha256": sha, "size": len(data)}]}
    assert client.get(f"/empyrean/v1/backup/object/{sha}", headers=RES).content == data
    assert client.get("/empyrean/v1/backup/objects", params={"export": token}).status_code == 403
    assert client.post("/empyrean/v1/backup/validate", headers={**RES, **headers}, content=out.content).json() == {"valid": True}

    # The library is lost: the photo purged and its original gone.
    client.delete(f"/api/photos/{photo['id']}")
    client.delete(f"/api/photos/{photo['id']}/purge?confirm=true")
    assert client.post("/empyrean/v1/backup/objects/missing", headers=RES, json={"objects": listing["objects"]}).json() == {"missing": [sha]}
    # A restore is refused until the originals are back: nothing is half restored.
    refused = client.post("/empyrean/v1/backup/restore", headers={**RES, **headers}, content=out.content)
    assert refused.status_code == 422 and "not been returned" in refused.text
    assert client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=b"wrong").status_code == 422
    assert client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).json() == {"stored": True}
    assert client.post("/empyrean/v1/backup/restore", headers={**RES, **headers}, content=out.content).json() == {"restored": True}
    client.post("/empyrean/v1/backup/finalize", headers=RES)
    back = client.get(f"/api/photos/{photo['id']}").json()
    assert back["original_available"] is True


def test_a_full_backup_is_refused_when_an_original_is_missing(client, tmp_path):
    data = png((70, 80, 90))
    upload(client, data)
    sha = hashlib.sha256(data).hexdigest()
    path = tmp_path / "media/originals" / sha[:2] / sha[2:4] / sha
    path.chmod(0o640)
    path.unlink()
    assert export(client, "full").status_code == 507
    assert export(client, "quick").status_code == 200


def test_quick_restore_never_removes_an_original(client, tmp_path):
    old = upload(client, png((1, 1, 1)))["photo"]
    out = export(client, "quick")
    data = png((2, 2, 2))
    upload(client, data)  # added after the backup
    sha = hashlib.sha256(data).hexdigest()
    headers = backup_headers(out)
    assert client.post("/empyrean/v1/backup/restore", headers={**RES, **headers}, content=out.content).json() == {"restored": True}
    client.post("/empyrean/v1/backup/finalize", headers=RES)
    assert (tmp_path / "media/originals" / sha[:2] / sha[2:4] / sha).is_file()
    assert client.get(f"/api/photos/{old['id']}").status_code == 200


def test_a_v1_nexus_still_gets_a_complete_archive(client):
    upload(client, png((3, 3, 3)))
    out = client.post("/empyrean/v1/backup/export", headers=RES)
    assert out.headers["x-empyrean-backup-completeness"] == "full"
    assert out.headers["x-empyrean-backup-format-version"] == "1"
    with tarfile.open(fileobj=io.BytesIO(out.content)) as tar:
        assert any(n.startswith("originals/") for n in tar.getnames())


# ── Faces: identity rules, with a stand-in for the models ──────────────


def unit(*values):
    v = np.zeros(128, dtype=np.float32)
    v[: len(values)] = values
    return v / np.linalg.norm(v)


class FakeEngine:
    def __init__(self):
        self.faces = {}
        self.region = None

    def detect(self, path, photo):
        return self.faces.get(photo["filename"], [])

    def embed_region(self, path, photo, box):
        return self.region


A, A2, A3, B, FAR = unit(1, 0), unit(1, 0.25), unit(1, 2.6), unit(0, 1), unit(0.2, -1)


def face(vector, x=0.1):
    return (x, 0.1, 0.2, 0.3, 0.95, vector)


@pytest.fixture
def scanned(client):
    client.app.state.faces_worker.kick = lambda: False
    with client.app.state.db.connect() as conn:
        faces.set_enabled(conn, True)
    engine = FakeEngine()

    def add(name, color, *found):
        upload(client, png(color), name)
        engine.faces[name] = list(found)

    def run():
        recognition.run(client.app.state.db, client.app.state.store, engine)

    return client, engine, add, run


def photos(client):
    with client.app.state.db.connect() as conn:
        return {r["filename"]: r["id"] for r in conn.execute("SELECT id, filename FROM photos")}


def faces_of(client, name):
    return client.get(f"/api/photos/{photos(client)[name]}/faces").json()["items"]


def test_recognition_is_off_until_enabled_and_never_contacts_meridian(client, monkeypatch):
    assert client.get("/api/faces/status").json()["enabled"] is False
    calls = []
    monkeypatch.setattr(nexus, "_call", lambda *a, **k: calls.append(a) or {})
    upload(client, png((5, 5, 5)))
    assert recognition.run(client.app.state.db, client.app.state.store, FakeEngine()) == 0
    assert calls == []


def test_low_memory_refuses_to_enable(client, monkeypatch):
    monkeypatch.setattr(faces, "memory_limit_mb", lambda: 256)
    response = client.put("/api/faces/settings", json={"enabled": True})
    assert response.status_code == 409 and "memory" in response.text


def test_similar_faces_group_and_stay_predictions(scanned):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A), face(B, 0.6))
    add("2.png", (2, 2, 2), face(A2))
    run()
    clusters = client.get("/api/faces/clusters").json()["items"]
    assert sorted(c["count"] for c in clusters) == [1, 2]
    assert all(f["status"] == "auto" and f["person"] is None for f in faces_of(client, "1.png"))
    assert len(faces_of(client, "1.png")) == 2  # several people in one photograph
    body = json.dumps(client.get("/api/faces/clusters").json())
    assert "embedding" not in body


def test_naming_a_cluster_confirms_only_confident_faces(scanned):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A))
    add("2.png", (2, 2, 2), face(A2))
    add("3.png", (3, 3, 3), face(A3))  # same group, but an uncertain match
    run()
    cluster = max(client.get("/api/faces/clusters").json()["items"], key=lambda c: c["count"])
    assert cluster["count"] == 3
    client.post(f"/api/faces/clusters/{cluster['id']}/assign", json={"resource": PETER, "label": "Peter"})
    assert faces_of(client, "1.png")[0]["status"] == "confirmed"
    uncertain = faces_of(client, "3.png")[0]
    assert uncertain["status"] == "auto" and uncertain["person"] is None
    assert (uncertain["suggested"], uncertain["suggested_label"]) == (PETER, "Peter")


def test_manual_assignment_outranks_a_cluster_and_survives_scans(scanned):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A))
    add("2.png", (2, 2, 2), face(A2))
    run()
    mine = faces_of(client, "2.png")[0]
    client.post(f"/api/faces/{mine['id']}/assign", json={"resource": JANA, "label": "Jana"})
    cluster = client.get("/api/faces/clusters").json()["items"][0]
    client.post(f"/api/faces/clusters/{cluster['id']}/assign", json={"resource": PETER, "label": "Peter"})
    assert faces_of(client, "2.png")[0]["person"] == JANA  # the cluster did not touch it
    # Later scans and refreshes leave it alone, and removing the cluster's name too.
    add("3.png", (3, 3, 3), face(A))
    run()
    assert faces_of(client, "2.png")[0]["person"] == JANA
    client.post(f"/api/faces/clusters/{cluster['id']}/unassign")
    assert faces_of(client, "2.png")[0]["person"] == JANA
    assert faces_of(client, "1.png")[0]["status"] == "auto"


def test_a_new_face_is_only_suggested_and_corrections_improve_later_matching(scanned):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A))
    run()
    client.post(f"/api/faces/{faces_of(client, '1.png')[0]['id']}/assign", json={"resource": PETER, "label": "Peter"})
    add("2.png", (2, 2, 2), face(A2))
    run()
    later = faces_of(client, "2.png")[0]
    assert (later["status"], later["person"], later["suggested"]) == ("auto", None, PETER)
    assert later["confidence"] in ("high", "medium", "low")
    assert client.post(f"/api/faces/{later['id']}/confirm").status_code == 200
    assert faces_of(client, "2.png")[0]["status"] == "confirmed"


def test_unknown_excluded_and_undo(scanned):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A))
    run()
    fid = faces_of(client, "1.png")[0]["id"]
    original = client.get("/api/faces/clusters").json()["items"][0]["id"]
    for state in ("unknown", "excluded"):
        client.post(f"/api/faces/{fid}/state", json={"state": state})
        current = faces_of(client, "1.png")[0]
        assert current["status"] == state and current["cluster_id"] is None and current["suggested"] is None
    assert client.post(f"/api/faces/{fid}/state", json={"state": "nonsense"}).status_code == 422
    assert client.post(f"/api/faces/{fid}/reset").status_code == 200
    back = faces_of(client, "1.png")[0]
    assert (back["status"], back["cluster_id"]) == ("auto", original)


def test_marking_a_missed_face_and_removing_it(scanned):
    client, engine, add, run = scanned
    add("1.png", (1, 1, 1))
    run()
    pid = photos(client)["1.png"]
    assert client.post(f"/api/photos/{pid}/faces", json={"x": 2, "y": 0, "w": 0.2, "h": 0.2}).status_code == 422
    engine.region = A
    fid = client.post(f"/api/photos/{pid}/faces", json={"x": 0.4, "y": 0.2, "w": 0.2, "h": 0.3}).json()["id"]
    run()
    marked = faces_of(client, "1.png")[0]
    assert (marked["origin"], marked["status"], marked["matchable"]) == ("manual", "auto", True)
    client.post(f"/api/faces/{fid}/assign", json={"resource": PETER, "label": "Peter"})
    assert faces_of(client, "1.png")[0]["status"] == "confirmed"
    assert client.delete(f"/api/faces/{fid}").status_code == 200
    assert faces_of(client, "1.png") == []
    add("2.png", (2, 2, 2), face(A))
    run()
    detected = faces_of(client, "2.png")[0]["id"]
    assert client.delete(f"/api/faces/{detected}").status_code == 422  # detected faces are excluded, not removed


def test_confirmed_people_are_edges_shared_with_meridian_and_follow_corrections(scanned, monkeypatch):
    client, _, add, run = scanned
    made, gone = [], []
    monkeypatch.setattr(nexus, "create_reference", lambda s, t, r, readers: made.append((s, t, r, readers)) or f"ref{len(made)}")
    monkeypatch.setattr(nexus, "delete_reference", lambda ref: gone.append(ref))
    add("1.png", (1, 1, 1), face(A))
    run()
    fid = faces_of(client, "1.png")[0]["id"]
    client.post(f"/api/faces/{fid}/assign", json={"resource": PETER, "label": "Peter"})
    db = client.app.state.db
    faces.sync_references(db)
    source = f"nexus:v1:argus:photo:{photos(client)['1.png']}"
    assert (source, PETER, "argus.depicts", ["meridian"]) in made
    page = client.get("/empyrean/v1/references/outgoing", headers=RES).json()
    assert [(r["source"], r["target"], r["readers"]) for r in page["references"]] == [(source, PETER, ["meridian"])]
    client.post(f"/api/faces/{fid}/reset")
    faces.sync_references(db)
    assert gone and client.get("/empyrean/v1/references/outgoing", headers=RES).json()["references"] == []


def test_deleting_recognition_data_keeps_every_photo(scanned, tmp_path):
    client, _, add, run = scanned
    add("1.png", (1, 1, 1), face(A))
    run()
    assert client.delete("/api/faces/data").status_code == 422
    assert client.delete("/api/faces/data", params={"confirm": True}).status_code == 200
    status = client.get("/api/faces/status").json()
    assert (status["enabled"], status["faces"], status["clusters"], status["photos"]) == (False, 0, 0, 1)
    assert client.get("/api/faces/clusters").json()["items"] == []
