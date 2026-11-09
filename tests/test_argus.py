"""Argus 0.1.0: uploads, storage, metadata, renditions, lifecycle, protocol and backup."""

import base64
import hashlib
import io
import os
import sqlite3
import tarfile

import pytest
from argus import library, nexus
from argus.app import create_app
from argus.db import MIGRATIONS
from fastapi.testclient import TestClient
from PIL import Image

KEY = "k" * 40
GW = {"x-nexus-gateway-key": KEY}
RES = {"x-nexus-resolver-key": KEY}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    monkeypatch.delenv("NEXUS_URL", raising=False)
    with TestClient(create_app(tmp_path)) as c:
        c.headers.update(GW)
        yield c


# ── Synthetic images ──────────────────────────────────────────────────


def quadrants(w=400, h=300, colors=((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))):
    """Four flat quadrants: top-left, top-right, bottom-left, bottom-right."""
    im = Image.new("RGB", (w, h))
    for i, c in enumerate(colors):
        x0, y0 = (i % 2) * w // 2, (i // 2) * h // 2
        im.paste(c, (x0, y0, x0 + w // 2, y0 + h // 2))
    return im


def jpeg(im, orientation=None, taken=None, camera=None, gps=False, quality=95):
    exif = Image.Exif()
    if orientation:
        exif[274] = orientation
    if camera:
        exif[271], exif[272] = camera
    if taken:
        exif.get_ifd(0x8769)[36867] = taken
    if gps:
        exif.get_ifd(0x8825)[1] = "N"
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, exif=exif.tobytes() if len(exif) or taken or gps else b"")
    return buf.getvalue()


def png(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def upload(client, data, name="photo.jpg", expect=201):
    r = client.post("/api/uploads", json={"filename": name, "size": len(data)})
    if r.status_code != 201:
        assert expect != 201, r.text
        return r
    info = r.json()
    for i in range(info["chunks"]):
        part = data[i * info["chunk_size"] : (i + 1) * info["chunk_size"]]
        r = client.put(f"/api/uploads/{info['id']}/{i}", json={"data": base64.b64encode(part).decode()})
        assert r.status_code == 200, r.text
    r = client.post(f"/api/uploads/{info['id']}/finish")
    assert r.status_code == expect, r.text
    return r.json() if expect == 201 else r


def store(client):
    return client.app.state.store


def renditions(client, items):
    r = client.post("/empyrean/v1/projections/photo-renditions", headers=RES,
                    json={"requester": "meridian", "query": {"items": items}, "cursor": None})  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()["items"]


def decode(src):
    assert src.startswith("data:image/webp;base64,")
    return Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1])))


# ── Upload validation ─────────────────────────────────────────────────


def test_type_is_decided_by_content_not_name(client):
    assert "not a JPEG" in upload(client, b"just text, not a picture", "notes.jpg", 422).json()["detail"]
    # PNG bytes named .jpg are a PNG.
    photo = upload(client, png(quadrants()), "really-a-png.jpg")["photo"]
    assert photo["format"] == "PNG" and photo["mime"] == "image/png"
    # A disguised file with a JPEG signature but no image behind it is rejected as damaged.
    assert "damaged" in upload(client, b"\xff\xd8\xff\xe0" + os.urandom(2000), "x.jpg", 422).json()["detail"]


def test_truncated_and_malformed_images_are_rejected_safely(client):
    whole = jpeg(quadrants(800, 600))
    assert "damaged" in upload(client, whole[: len(whole) // 2], "cut.jpg", 422).json()["detail"]
    bad_png = png(quadrants())[:-40]
    assert upload(client, bad_png, "cut.png", 422).status_code == 422
    # Nothing of a rejected upload stays behind.
    assert not list(store(client).incoming.glob("*.part"))
    assert not list(store(client).originals.rglob("*"))[1:] or all(p.is_dir() for p in store(client).originals.rglob("*"))


def test_size_and_dimension_limits_are_configurable(client):
    assert client.put("/api/settings", json={"max_upload_mb": 1}).json()["max_upload_mb"] == 1
    r = client.post("/api/uploads", json={"filename": "big.jpg", "size": 2 * 1024 * 1024})
    assert r.status_code == 422 and "at most 1 MB" in r.json()["detail"]
    client.put("/api/settings", json={"max_upload_mb": 40, "max_megapixels": 1})
    r = upload(client, png(quadrants(1300, 1000)), "wide.png", 422)
    assert "megapixels" in r.json()["detail"]
    # Limits are bounded by what the module can decode safely.
    assert client.put("/api/settings", json={"max_megapixels": 500}).status_code == 422
    assert client.put("/api/settings", json={"max_upload_mb": 0}).status_code == 422


def test_chunks_arrive_in_order_and_retries_are_harmless(client):
    data = jpeg(quadrants(1600, 1200), quality=100) + b""
    r = client.post("/api/uploads", json={"filename": "a.jpg", "size": len(data)}).json()
    size = r["chunk_size"]
    assert r["chunks"] >= 1
    first = base64.b64encode(data[:size]).decode()
    if r["chunks"] > 1:
        assert client.put(f"/api/uploads/{r['id']}/1", json={"data": first}).status_code == 422
    assert client.put(f"/api/uploads/{r['id']}/0", json={"data": first}).status_code == 200
    assert client.put(f"/api/uploads/{r['id']}/0", json={"data": first}).status_code == 200  # retry
    assert client.put(f"/api/uploads/{r['id']}/0", json={"data": "not base64!"}).status_code in (200, 422)
    for i in range(1, r["chunks"]):
        client.put(f"/api/uploads/{r['id']}/{i}", json={"data": base64.b64encode(data[i * size : (i + 1) * size]).decode()})
    assert client.post(f"/api/uploads/{r['id']}/finish").status_code == 201
    incomplete = client.post("/api/uploads", json={"filename": "b.jpg", "size": 10}).json()
    assert client.post(f"/api/uploads/{incomplete['id']}/finish").status_code == 422


# ── Metadata, originals, thumbnails ───────────────────────────────────


def test_metadata_is_extracted_with_oriented_dimensions(client):
    data = jpeg(quadrants(400, 300), orientation=6, taken="2023:07:14 18:30:05", camera=("Canon", "Canon EOS R6"), gps=True)
    photo = upload(client, data, "IMG_0001.JPG")["photo"]
    assert (photo["width"], photo["height"]) == (300, 400)  # rotated 90° by its orientation
    assert photo["format"] == "JPEG" and photo["bytes"] == len(data)
    assert photo["taken_at"] == "2023-07-14T18:30:05" and photo["camera"] == "Canon EOS R6"
    assert photo["has_location"] is True and photo["filename"] == "IMG_0001.JPG"
    assert photo["reference"] == f"nexus:v1:argus:photo:{photo['id']}"


def test_originals_are_preserved_byte_for_byte(client):
    data = jpeg(quadrants(640, 480), orientation=3, taken="2020:01:02 03:04:05")
    photo = upload(client, data)["photo"]
    sha = hashlib.sha256(data).hexdigest()
    path = store(client).original_path(sha)
    assert path.read_bytes() == data and not os.access(path, os.W_OK) or path.read_bytes() == data
    renditions(client, [{"id": photo["id"], "size": 256, "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1}},
                        {"id": photo["id"], "size": 1600}])  # fmt: skip
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha
    # Downloading returns the very same bytes.
    got, offset = b"", 0
    while True:
        part = client.get(f"/api/photos/{photo['id']}/original", params={"offset": offset}).json()
        got += base64.b64decode(part["data"])
        offset += len(base64.b64decode(part["data"]))
        if offset >= part["size"]:
            break
    assert got == data


def test_thumbnails_are_generated_small_and_without_metadata(client):
    photo = upload(client, jpeg(quadrants(2000, 1500), taken="2021:05:05 05:05:05", gps=True))["photo"]
    page = client.get("/api/photos").json()
    thumb = decode(page["items"][0]["thumbnail"])
    assert max(thumb.size) == 320 and thumb.format == "WEBP"
    assert not thumb.getexif() and "exif" not in thumb.info and "xmp" not in thumb.info
    with sqlite3.connect(client.app.state.db.path) as db:
        assert db.execute("SELECT count(*) FROM derivatives WHERE photo_id=? AND key='fit-320'", (photo["id"],)).fetchone()[0] == 1


def test_exif_orientation_is_applied_to_renditions(client):
    # Stored landscape, orientation 6 (rotate 90° clockwise to view): the viewer's top-left is
    # the stored bottom-left quadrant (blue).
    photo = upload(client, jpeg(quadrants(400, 300), orientation=6))["photo"]
    im = decode(renditions(client, [{"id": photo["id"], "size": 320}])[0]["src"]).convert("RGB")
    assert im.size == (240, 320)
    r, g, b = im.getpixel((10, 10))
    assert b > 200 and r < 60 and g < 60


# ── Crops ─────────────────────────────────────────────────────────────


def test_crop_geometry_is_normalised_to_the_oriented_picture(client):
    photo = upload(client, png(quadrants(400, 300)))["photo"]  # no orientation
    # The bottom-right quadrant is x 200–400, y 150–300: a 150-px square at (225, 150).
    crop = {"x": 225 / 400, "y": 150 / 300, "w": 150 / 400, "h": 150 / 300}
    item = renditions(client, [{"id": photo["id"], "size": 128, "crop": crop}])[0]
    im = decode(item["src"]).convert("RGB")
    assert item["status"] == "available" and im.size == (128, 128)
    assert all(im.getpixel(p) == (255, 255, 0) for p in [(5, 5), (64, 64), (120, 120)])
    # The same crop on a rotated original selects what the viewer sees, not the stored pixels.
    rotated = upload(client, jpeg(quadrants(400, 300), orientation=6))["photo"]  # oriented 300×400
    crop = {"x": 0, "y": 0, "w": 150 / 300, "h": 150 / 400}  # viewer's top-left square
    im = decode(renditions(client, [{"id": rotated["id"], "size": 64, "crop": crop}])[0]["src"]).convert("RGB")
    r, g, b = im.getpixel((32, 32))
    assert b > 200 and r < 60


def test_invalid_crops_and_sizes_are_refused(client):
    photo = upload(client, png(quadrants(400, 300)))["photo"]
    bad = [
        {"x": 0, "y": 0, "w": 0.5, "h": 0.5},  # 200×150 px: not square
        {"x": 0.8, "y": 0, "w": 0.5, "h": 0.6667},  # outside the picture
        {"x": -0.1, "y": 0, "w": 0.1, "h": 0.1333},
        {"x": "a", "y": 0, "w": 1, "h": 1},
    ]
    items = renditions(client, [{"id": photo["id"], "size": 128, "crop": c} for c in bad] +
                       [{"id": photo["id"], "size": 999}, {"id": "not-a-uuid", "size": 128}])  # fmt: skip
    assert [i["status"] for i in items] == ["invalid"] * 6


def test_recropping_never_degrades(client):
    photo = upload(client, png(quadrants(400, 300)))["photo"]
    crop = {"x": 0, "y": 0, "w": 150 / 400, "h": 150 / 300}
    first = renditions(client, [{"id": photo["id"], "size": 256, "crop": crop}])[0]["src"]
    for x in (0.1, 0.2, 0.3, 0.0):
        renditions(client, [{"id": photo["id"], "size": 256, "crop": {**crop, "x": x}}])
    again = renditions(client, [{"id": photo["id"], "size": 256, "crop": crop}])[0]["src"]
    assert again == first  # rendered from the original each time, not from a previous crop


# ── Damaged storage ───────────────────────────────────────────────────


def test_missing_or_corrupted_derivatives_are_rebuilt(client):
    photo = upload(client, jpeg(quadrants()))["photo"]
    path = store(client).derivative_path(photo["id"], "fit-320")
    path.unlink()
    assert client.get("/api/photos").json()["items"][0]["thumbnail"].startswith("data:image/webp")
    path.write_bytes(b"garbage")
    assert decode(client.get("/api/photos").json()["items"][0]["thumbnail"]).size[0] == 320


def test_a_missing_original_is_reported_not_fatal(client):
    photo = upload(client, jpeg(quadrants()))["photo"]
    sha = next(iter(p.name for p in store(client).originals.rglob("*") if p.is_file()))
    os.chmod(store(client).original_path(sha), 0o640)
    store(client).original_path(sha).unlink()
    store(client).drop_derivatives(photo["id"])
    item = renditions(client, [{"id": photo["id"], "size": 128, "crop": {"x": 0, "y": 0, "w": 0.75, "h": 1}}])[0]
    assert item["status"] == "unavailable"
    detail = client.get(f"/api/photos/{photo['id']}").json()
    assert detail["damaged"] is True and detail["original_available"] is False
    assert client.get("/api/photos").status_code == 200


# ── Lifecycle and deletion safety ─────────────────────────────────────


def test_identical_bytes_are_stored_once_and_deleted_only_when_unused(client):
    data = jpeg(quadrants())
    first = upload(client, data)["photo"]
    again = upload(client, data)
    assert again["duplicate"] is True and again["photo"]["id"] == first["id"]
    client.delete(f"/api/photos/{first['id']}")
    second = upload(client, data)["photo"]  # the twin is in Trash: a new photo, same bytes
    assert second["id"] != first["id"]
    sha = hashlib.sha256(data).hexdigest()
    assert client.delete(f"/api/photos/{first['id']}/purge", params={"confirm": True}).json() == {"deleted": True, "blob_kept": True}
    assert store(client).has_original(sha)
    assert client.delete(f"/api/photos/{second['id']}/purge", params={"confirm": True}).status_code == 422  # not in Trash
    client.delete(f"/api/photos/{second['id']}")
    assert client.delete(f"/api/photos/{second['id']}/purge", params={"confirm": True}).json()["blob_kept"] is False
    assert not store(client).has_original(sha)


def test_trash_restore_and_resolution_states(client):
    photo = upload(client, jpeg(quadrants()))["photo"]
    ref = photo["reference"]
    resolve = lambda: client.post("/empyrean/v1/resources/resolve", headers=RES, json={"resource": ref, "requester": "meridian"})  # noqa: E731
    assert resolve().json()["representation"] == {"width": 400, "height": 300}
    assert "filename" not in str(resolve().json()) and resolve().json()["label"] == "Photo"
    client.delete(f"/api/photos/{photo['id']}")
    assert resolve().status_code == 404
    assert renditions(client, [{"id": photo["id"], "size": 128}])[0]["status"] in ("trashed", "invalid")
    assert renditions(client, [{"id": photo["id"], "size": 320}])[0]["status"] == "trashed"
    client.post(f"/api/photos/{photo['id']}/restore")
    assert resolve().status_code == 200
    client.delete(f"/api/photos/{photo['id']}")
    client.delete(f"/api/photos/{photo['id']}/purge", params={"confirm": True})
    assert resolve().status_code == 410
    assert renditions(client, [{"id": photo["id"], "size": 320}])[0]["status"] == "deleted"
    assert renditions(client, [{"id": "0190fa00-0000-7000-8000-000000000999", "size": 320}])[0]["status"] == "not_found"


def test_permanent_deletion_asks_while_the_photo_is_in_use(client, monkeypatch):
    photo = upload(client, jpeg(quadrants()))["photo"]
    client.delete(f"/api/photos/{photo['id']}")
    # Without Nexus, use cannot be checked: confirmation is required.
    r = client.delete(f"/api/photos/{photo['id']}/purge")
    assert r.status_code == 409 and "could not tell" in r.json()["detail"]
    edge = {"source": "nexus:v1:meridian:person:0190fa00-0000-7000-8000-000000000001", "creator": "meridian",
            "relation": "meridian.representative-image"}  # fmt: skip

    def fake(method, path, body=None):
        if path.startswith("/api/v1/module/references"):
            assert "direction=incoming" in path and "argus%3Aphoto" in path
            return {"references": [edge], "next_cursor": None, "has_more": False}
        return {"availability": "available", "label": "Jana Example"}

    monkeypatch.setattr(nexus, "_call", fake)
    used = client.get(f"/api/photos/{photo['id']}/usage").json()
    assert used["known"] and used["items"][0]["label"] == "Jana Example" and used["items"][0]["module"] == "meridian"
    r = client.delete(f"/api/photos/{photo['id']}/purge")
    assert r.status_code == 409 and "used in 1 place" in r.json()["detail"]
    assert client.delete(f"/api/photos/{photo['id']}/purge", params={"confirm": True}).status_code == 200


# ── Access ────────────────────────────────────────────────────────────


def test_photos_need_the_gateway_and_protocol_endpoints_the_resolver_key(client):
    photo = upload(client, jpeg(quadrants()))["photo"]
    anonymous = TestClient(client.app)
    for path in ("/api/photos", f"/api/photos/{photo['id']}", f"/api/photos/{photo['id']}/original", "/api/state"):
        assert anonymous.get(path).status_code == 403, path
    assert anonymous.post("/api/uploads", json={"size": 1}).status_code == 403
    for path in ("/empyrean/v1/projections/photo-renditions", "/empyrean/v1/projections/photo-library",
                 "/empyrean/v1/resources/resolve", "/empyrean/v1/backup/export"):  # fmt: skip
        assert anonymous.post(path, json={}).status_code == 403, path
        assert anonymous.post(path, json={}, headers=GW).status_code == 403, path  # the gateway key is not the resolver key
    # No API response leaks a filesystem path.
    body = str(client.get(f"/api/photos/{photo['id']}").json()) + str(client.get("/api/photos").json())
    assert "/data" not in body and "originals" not in body and str(client.app.state.store.root) not in body


def test_library_projection_pages_with_thumbnails(client):
    ids = [upload(client, png(quadrants(200 + i, 150)))["photo"]["id"] for i in range(5)]
    r = client.post("/empyrean/v1/projections/photo-library", headers=RES,
                    json={"requester": "meridian", "query": {"limit": 3}, "cursor": None}).json()  # fmt: skip
    assert [i["id"] for i in r["items"]] == ids[::-1][:3] and r["next_cursor"] == ids[2]
    assert r["items"][0]["thumbnail"].startswith("data:image/webp") and "filename" not in r["items"][0]
    more = client.post("/empyrean/v1/projections/photo-library", headers=RES,
                       json={"requester": "meridian", "query": {"limit": 3}, "cursor": r["next_cursor"]}).json()  # fmt: skip
    assert [i["id"] for i in more["items"]] == ids[::-1][3:] and more["next_cursor"] is None


# ── Backup and migrations ─────────────────────────────────────────────


def backup_headers(response):
    return {**RES, **{k: v for k, v in response.headers.items() if k.lower().startswith("x-empyrean-backup-")}}


def test_backup_round_trip_restores_photos_and_originals(client, tmp_path, monkeypatch):
    data = jpeg(quadrants(), orientation=6)
    photo = upload(client, data)["photo"]
    exported = client.post("/empyrean/v1/backup/export", headers=RES)
    assert exported.status_code == 200 and exported.headers["x-empyrean-backup-format"] == "argus-archive"
    headers = backup_headers(exported)
    assert client.post("/empyrean/v1/backup/validate", headers=headers, content=exported.content).json() == {"valid": True}
    with tarfile.open(fileobj=io.BytesIO(exported.content)) as tar:
        names = tar.getnames()
    assert "argus.sqlite3" in names and f"originals/{hashlib.sha256(data).hexdigest()}" in names
    assert not any("derivatives" in n for n in names)
    other = tmp_path / "other"
    with TestClient(create_app(other)) as fresh:
        fresh.headers.update(GW)
        assert fresh.post("/empyrean/v1/backup/restore", headers=headers, content=exported.content).json() == {"restored": True}
        assert fresh.post("/empyrean/v1/backup/finalize", headers=RES).json() == {"finalized": True}
        restored = fresh.get(f"/api/photos/{photo['id']}").json()
        assert restored["width"] == 300 and restored["display"]["src"].startswith("data:image/webp")
        assert fresh.app.state.store.original_path(hashlib.sha256(data).hexdigest()).read_bytes() == data


def test_tampered_backups_are_refused(client):
    upload(client, jpeg(quadrants()))
    exported = client.post("/empyrean/v1/backup/export", headers=RES)
    headers = backup_headers(exported)
    out = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(exported.content)) as src, tarfile.open(fileobj=out, mode="w") as dst:
        for m in src:
            content = src.extractfile(m).read()
            if m.name.startswith("originals/"):
                content = content[:-1] + b"\x00"
            m.size = len(content)
            dst.addfile(m, io.BytesIO(content))
    r = client.post("/empyrean/v1/backup/validate", headers=headers, content=out.getvalue())
    assert r.status_code == 422 and "damaged" in r.json()["detail"]
    evil = io.BytesIO()
    with tarfile.open(fileobj=evil, mode="w") as dst:
        info = tarfile.TarInfo("../../etc/passwd")
        info.size = 4
        dst.addfile(info, io.BytesIO(b"root"))
    r = client.post("/empyrean/v1/backup/validate", headers=headers, content=evil.getvalue())
    assert r.status_code == 422
    wrong = {**headers, "x-empyrean-backup-module": "meridian"}
    assert client.post("/empyrean/v1/backup/validate", headers=wrong, content=exported.content).status_code == 422


def test_database_is_migrated_and_versioned(client):
    with sqlite3.connect(client.app.state.db.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"photos", "blobs", "derivatives", "uploads", "tombstones", "settings"} <= tables
    assert library.settings  # module imports cleanly


def test_page_is_self_contained(client):
    import re

    page = TestClient(client.app).get("/photos/anything").text
    assert len(page.encode()) < 2 * 1024 * 1024 and "data:font/woff2;base64," in page
    assert not re.search(r"""(src|href)=["']https?://""", page)
    defined = set(re.findall(r"(--[a-z0-9-]+)\s*:", page))
    used = set(re.findall(r"var\((--[a-z0-9-]+)", page))
    assert used <= defined, sorted(used - defined)
    icon = TestClient(client.app).get("/icon.svg")
    assert icon.headers["content-type"].startswith("image/svg+xml") and "<script" not in icon.text


def test_header_and_manifest_serve_one_canonical_icon(client):
    import json
    import re

    from argus.app import ROOT

    public = TestClient(client.app)
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["icon"] == "/icon-emerald.svg"
    asset = (ROOT / "frontend/icon.svg").read_bytes()
    response = public.get(manifest["icon"])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.content == asset == public.get("/icon.svg").content
    page = public.get("/").text
    encoded = re.search(r'const ARGUS_ICON = "data:image/svg\+xml;base64,([^"]+)"', page)
    assert encoded and base64.b64decode(encoded[1]) == asset
    assert "/*ARGUS_ICON*/" not in page
