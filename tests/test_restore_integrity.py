"""Restore integrity uses real files/databases and generated pixels only."""

import hashlib
import io
import json
import sqlite3
import tarfile

import pytest
from argus.restore import RestoreState
from test_phase5 import backup_headers, export, png, upload

pytest_plugins = ["test_phase5"]

RES = {"x-nexus-resolver-key": "k" * 40}


def damaged_original(client, data):
    sha = hashlib.sha256(data).hexdigest()
    path = client.app.state.store.original_path(sha)
    wrong = bytes([data[0] ^ 255]) + data[1:]
    path.chmod(0o640)
    path.write_bytes(wrong)
    return sha, path, wrong


def test_existing_corrupt_original_is_requested_again(client):
    data = png((40, 50, 60))
    upload(client, data)
    sha, _, _ = damaged_original(client, data)
    response = client.post(
        "/empyrean/v1/backup/objects/missing",
        headers=RES,
        json={"objects": [{"sha256": sha, "size": len(data)}]},
    )
    assert response.json() == {"missing": [sha]}


def test_verified_return_repairs_corrupt_original(client):
    data = png((50, 60, 70))
    upload(client, data)
    sha, path, _ = damaged_original(client, data)
    response = client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data)
    assert response.status_code == 200
    assert path.read_bytes() == data


def test_full_restore_rejects_corrupt_original_before_metadata_replacement(client):
    data = png((60, 70, 80))
    photo = upload(client, data)["photo"]
    saved = export(client, "full")
    client.patch(f"/api/photos/{photo['id']}", json={"title": "Synthetic current title"})
    damaged_original(client, data)
    response = client.post(
        "/empyrean/v1/backup/restore",
        headers={**RES, **backup_headers(saved)},
        content=saved.content,
    )
    assert response.status_code == 422
    assert client.get(f"/api/photos/{photo['id']}").json()["title"] == "Synthetic current title"


def restore(client, saved, content=None, headers=None):
    return client.post(
        "/empyrean/v1/backup/restore",
        headers={**RES, **backup_headers(saved), **(headers or {})},
        content=saved.content if content is None else content,
    )


def rewrite_archive(saved, mutate):
    out = io.BytesIO()
    with (
        tarfile.open(fileobj=io.BytesIO(saved.content)) as src,
        tarfile.open(fileobj=out, mode="w") as dst,
    ):
        for member in src:
            content = mutate(member.name, src.extractfile(member).read())
            member.size = len(content)
            dst.addfile(member, io.BytesIO(content))
    return out.getvalue()


@pytest.mark.parametrize("damage", ["same-size", "truncated", "missing", "wrong-image"])
def test_full_requires_verified_bytes_and_recovers(client, damage):
    data = png((90, 80, 70))
    photo = upload(client, data)["photo"]
    saved = export(client, "full")
    sha, path, wrong = damaged_original(client, data)
    if damage == "truncated":
        path.write_bytes(data[:10])
    elif damage == "missing":
        path.unlink()
    elif damage == "wrong-image":
        path.write_bytes(png((0, 0, 0)))
    old = path.read_bytes() if path.exists() else None
    assert restore(client, saved).status_code == 422
    assert client.post(
        "/empyrean/v1/backup/objects/missing",
        headers=RES,
        json={"objects": [{"sha256": sha, "size": len(data)}]},
    ).json() == {"missing": [sha]}
    assert (
        client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).status_code
        == 200
    )
    assert path.read_bytes() == data
    if old is not None:
        recovered = list(
            (client.app.state.store.root / "restore-recovery/originals").glob("*.unverified")
        )
        assert any(p.read_bytes() == old for p in recovered)
    assert restore(client, saved).json() == {"restored": True}
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).json() == {"finalized": True}
    assert client.get(f"/api/photos/{photo['id']}").json()["original_available"]


def test_matching_original_and_repeated_restore_do_not_rewrite_bytes(client):
    data = png((11, 22, 33))
    upload(client, data)
    sha = hashlib.sha256(data).hexdigest()
    path = client.app.state.store.original_path(sha)
    before = path.stat()
    saved = export(client, "full")
    for _ in range(2):
        assert client.post(
            "/empyrean/v1/backup/objects/missing",
            headers=RES,
            json={"objects": [{"sha256": sha, "size": len(data)}]},
        ).json() == {"missing": []}
        assert (
            client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).status_code
            == 200
        )
        assert restore(client, saved).status_code == 200
        assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200
        assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200
    assert path.stat().st_mtime_ns == before.st_mtime_ns
    assert path.stat().st_ino == before.st_ino


def test_wrong_return_never_clobbers_valid_original(client):
    data = png((20, 30, 40))
    upload(client, data)
    sha = hashlib.sha256(data).hexdigest()
    assert (
        client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=b"wrong").status_code
        == 422
    )
    assert client.app.state.store.original_path(sha).read_bytes() == data


def test_finalize_rechecks_and_preserves_extra_media_on_failure(client):
    data = png((31, 32, 33))
    upload(client, data)
    saved = export(client, "full")
    extra = png((41, 42, 43))
    upload(client, extra)
    extra_path = client.app.state.store.original_path(hashlib.sha256(extra).hexdigest())
    assert restore(client, saved).status_code == 200
    sha, path, _ = damaged_original(client, data)
    failed = client.post("/empyrean/v1/backup/finalize", headers=RES)
    assert failed.status_code == 409 and "verification" in failed.text
    assert extra_path.read_bytes() == extra
    assert (
        client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).status_code
        == 200
    )
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200
    assert path.read_bytes() == data


@pytest.mark.parametrize("phase", ["applying", "failed"])
def test_interrupted_restore_survives_restart_and_requires_retry(client, phase):
    from argus.app import create_app
    from fastapi.testclient import TestClient

    data = png((44, 45, 46))
    upload(client, data)
    saved = export(client, "full")
    root = client.app.state.store.root
    state = RestoreState(root)
    state.write(
        {
            "mode": "full",
            "objects": [{"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}],
        },
        phase,
    )
    # A new app/database connection observes durable state, not in-memory mocks.
    with TestClient(create_app(root)) as restarted:
        assert restarted.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 409
        assert restore(restarted, saved).status_code == 200
        assert restarted.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200


def test_failure_after_database_replacement_rolls_back_and_retry_recovers(client, monkeypatch):
    data = png((55, 56, 57))
    photo = upload(client, data)["photo"]
    saved = export(client, "full")
    client.patch(f"/api/photos/{photo['id']}", json={"title": "Synthetic unsaved-in-backup title"})
    real_write = RestoreState.write

    def fail_ready(self, record, phase):
        if phase == "ready":
            raise OSError("synthetic interrupted journal write")
        return real_write(self, record, phase)

    with monkeypatch.context() as m:
        m.setattr(RestoreState, "write", fail_ready)
        failed = restore(client, saved)
    assert failed.status_code == 503 and "incomplete" in failed.text
    assert (
        client.get(f"/api/photos/{photo['id']}").json()["title"]
        == "Synthetic unsaved-in-backup title"
    )
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 409
    backups = list((client.app.state.store.root / "restore-recovery").glob("*/before.sqlite3"))
    assert backups
    with sqlite3.connect(backups[-1]) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert restore(client, saved).status_code == 200
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200


@pytest.mark.parametrize(
    "change", ["no-algorithm", "no-sha", "no-size", "wrong-size", "duplicate", "wrong-sha"]
)
def test_untrustworthy_manifest_is_rejected(client, change):
    upload(client, png((65, 66, 67)))
    saved = export(client, "full")

    def mutate(name, content):
        if name != "manifest.json":
            return content
        manifest = json.loads(content)
        item = manifest["objects"][0]
        if change == "no-algorithm":
            manifest.pop("algorithm")
        elif change == "no-sha":
            item.pop("sha256")
        elif change == "no-size":
            item.pop("size")
        elif change == "wrong-size":
            item["size"] += 1
        elif change == "duplicate":
            manifest["objects"].append(item)
        else:
            item["sha256"] = "0" * 64
        return json.dumps(manifest).encode()

    assert restore(client, saved, rewrite_archive(saved, mutate)).status_code == 422


def test_header_cannot_downgrade_full_to_quick(client):
    data = png((75, 76, 77))
    upload(client, data)
    saved = export(client, "full")
    damaged_original(client, data)
    assert (
        restore(client, saved, headers={"x-empyrean-backup-completeness": "quick"}).status_code
        == 422
    )


def test_legacy_archive_repairs_destination_using_database_checksums(client):
    data = png((85, 86, 87))
    upload(client, data)
    saved = client.post("/empyrean/v1/backup/export", headers=RES)
    sha, path, _ = damaged_original(client, data)
    assert restore(client, saved).status_code == 200
    assert path.read_bytes() == data
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200


@pytest.mark.parametrize("state", ["[]", "{bad json", '{"phase":"applying"}'])
def test_unreadable_journal_fails_closed(client, state):
    (client.app.state.store.root / "restore-state.json").write_text(state)
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 409


def test_old_unverified_full_completion_is_not_trusted(client):
    with client.app.state.db.connect() as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES('restore_pending','1')")
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 409


@pytest.mark.parametrize("kind", ["symlink", "directory"])
def test_nonregular_destination_is_not_accepted_or_overwritten(client, tmp_path, kind):
    data = png((95, 96, 97))
    upload(client, data)
    sha = hashlib.sha256(data).hexdigest()
    path = client.app.state.store.original_path(sha)
    path.chmod(0o640)
    path.unlink()
    if kind == "directory":
        path.mkdir()
    else:
        other = tmp_path / "synthetic-outside.png"
        other.write_bytes(data)
        path.symlink_to(other)
    assert client.post(
        "/empyrean/v1/backup/objects/missing",
        headers=RES,
        json={"objects": [{"sha256": sha, "size": len(data)}]},
    ).json() == {"missing": [sha]}
    assert (
        client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).status_code
        == 503
    )
    assert path.is_dir() if kind == "directory" else path.is_symlink()


def test_interrupted_staging_preserves_original(client, monkeypatch):
    import argus.storage as storage

    data = png((101, 102, 103))
    upload(client, data)
    sha, path, wrong = damaged_original(client, data)

    def fail_copy(*args, **kwargs):
        raise OSError("synthetic disk failure")

    monkeypatch.setattr(storage.shutil, "copyfileobj", fail_copy)
    assert (
        client.post(f"/empyrean/v1/backup/object/{sha}", headers=RES, content=data).status_code
        == 503
    )
    assert path.read_bytes() == wrong
    assert not list(path.parent.glob(".restore-*.part"))


def test_backup_export_refuses_corruption_but_quick_and_gallery_remain_usable(client):
    data = png((111, 112, 113))
    upload(client, data)
    sha, _, _ = damaged_original(client, data)
    assert export(client, "full").status_code == 507
    assert client.post("/empyrean/v1/backup/export", headers=RES).status_code == 507
    assert client.get(f"/empyrean/v1/backup/object/{sha}", headers=RES).status_code == 507
    assert export(client, "quick").status_code == 200
    assert client.get("/api/photos").status_code == 200


def test_real_process_exit_leaves_restore_unfinalizable_until_retry(client):
    import os
    import subprocess
    import sys
    from pathlib import Path

    data = png((121, 122, 123))
    upload(client, data)
    saved = export(client, "full")
    root = client.app.state.store.root
    artifact = root / "synthetic-restore.tar"
    artifact.write_bytes(saved.content)
    header_file = root / "synthetic-headers.json"
    header_file.write_text(json.dumps({**RES, **backup_headers(saved)}))
    code = """import os,sys,json
from pathlib import Path
from fastapi.testclient import TestClient
from argus import faces
from argus.app import create_app
from argus.restore import RestoreState
root=Path(sys.argv[1])
faces.Worker.kick=lambda self: False
write=RestoreState.write
def interrupted(self,record,phase):
    if phase=='ready': os._exit(86)
    return write(self,record,phase)
RestoreState.write=interrupted
with TestClient(create_app(root)) as client:
    client.post('/empyrean/v1/backup/restore',headers=json.loads((root/'synthetic-headers.json').read_text()),content=(root/'synthetic-restore.tar').read_bytes())
"""
    child = subprocess.run(
        [sys.executable, "-c", code, str(root)],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "backend")},
        timeout=20,
    )
    assert child.returncode == 86
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 409
    assert restore(client, saved).status_code == 200
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200


def test_legacy_archive_without_reliable_sizes_is_explicitly_rejected(client, tmp_path):
    upload(client, png((131, 132, 133)))
    saved = client.post("/empyrean/v1/backup/export", headers=RES)

    def mutate(name, content):
        if name != "argus.sqlite3":
            return content
        path = tmp_path / "synthetic-legacy.sqlite3"
        path.write_bytes(content)
        with sqlite3.connect(path) as conn:
            conn.execute("UPDATE blobs SET size=0")
        return path.read_bytes()

    failed = restore(client, saved, rewrite_archive(saved, mutate))
    assert failed.status_code == 422 and "Trustworthy SHA-256 and size" in failed.text


def test_fifo_is_rejected_without_waiting_for_a_writer(client):
    import os

    data = png((141, 142, 143))
    upload(client, data)
    sha = hashlib.sha256(data).hexdigest()
    path = client.app.state.store.original_path(sha)
    path.chmod(0o640)
    path.unlink()
    os.mkfifo(path)
    assert not client.app.state.store.verify_original(sha, len(data))


def test_finalize_retains_removed_extra_original_in_recovery(client):
    upload(client, png((151, 152, 153)))
    saved = export(client, "full")
    extra = png((161, 162, 163))
    upload(client, extra)
    sha = hashlib.sha256(extra).hexdigest()
    assert restore(client, saved).status_code == 200
    assert client.post("/empyrean/v1/backup/finalize", headers=RES).status_code == 200
    recovered = list(
        (client.app.state.store.root / "restore-recovery/originals").glob(f"{sha}-*.unverified")
    )
    assert any(path.read_bytes() == extra for path in recovered)


def test_restore_waits_for_active_import_without_replacing_metadata(client):
    data = png((171, 172, 173))
    photo = upload(client, data)["photo"]
    saved = export(client, "full")
    with client.app.state.db.connect() as conn:
        conn.execute(
            "INSERT INTO import_jobs(id,source,root,state,created_at,updated_at) VALUES('synthetic-job','server','','running','2026-11-10','2026-11-10')"
        )
    assert restore(client, saved).status_code == 409
    assert client.get(f"/api/photos/{photo['id']}").status_code == 200
    assert not (client.app.state.store.root / "restore-state.json").exists()


def test_normal_gallery_and_upload_do_not_hash_existing_originals(client, monkeypatch):
    upload(client, png((181, 182, 183)))

    def unexpected_verification(*args, **kwargs):
        raise AssertionError("restore-only verification leaked into normal media workflow")

    monkeypatch.setattr(client.app.state.store, "verify_original", unexpected_verification)
    assert client.get("/api/photos").status_code == 200
    assert client.get("/api/state").status_code == 200
    assert upload(client, png((191, 192, 193)))["photo"]["id"]
