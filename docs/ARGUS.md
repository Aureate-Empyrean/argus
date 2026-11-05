# Argus 0.1.0: design

This describes what the code does. For what has been verified and what is still missing, see
[STATUS.md](STATUS.md). Ecosystem scope is in
[`architecture/modules/argus.md`](../../architecture/modules/argus.md).

## 1. Boundaries

- Argus owns photo resources, their metadata and media behaviour.
- Other modules hold references (`nexus:v1:argus:photo:<uuid>`), never Argus's files or database.
- Selecting a photo as a profile image is not a statement that it depicts someone. Argus creates no
  `depicts` relation.
- Out of scope for 0.1.0: albums, video, face recognition, bulk import, folder synchronisation.

## 2. Storage

Why not Nexus shared blobs: as implemented they cap files at 1 MiB, only the uploading module can
read a blob, and usage is neither reported nor garbage-collected. The owner's brief called for an
isolated, documented adapter in that case; the reasoning is recorded in
[ADR 0019](../../architecture/decisions/0019-argus-interim-media-storage.md).

`backend/argus/storage.py` (`MediaStore`) is the only code that touches media files. Layout under
the data volume:

```
argus.sqlite3                                 database
media/originals/<aa>/<bb>/<sha256>            original bytes, content-addressed, mode 0440
media/derivatives/<id[:2]>/<photo-id>/<key>   thumbnails and renditions, rebuildable
uploads/<upload-id>.part                      uploads in progress (abandoned ones expire after 24 h)
tmp/                                          backup work files
```

- **Identity:** a photo's ID is a UUIDv7, never derived from its bytes or location. A move to
  shared storage would replace this module, not any reference.
- **Originals are write-once:** moved into place by atomic rename, never modified. Cropping does not
  touch them.
- **One copy per content:** identical bytes share a blob. Uploading bytes already held by an active
  photo returns that photo (`duplicate: true`).
- **Paths:** built only from validated hex digests, UUIDs and fixed keys, and never returned by an API.

## 3. Data model (`backend/argus/db.py`, schema 1)

| Table | Holds |
| --- | --- |
| `blobs` | SHA-256, size, MIME type |
| `photos` | UUID, blob, filename, title, format, oriented and stored dimensions, EXIF orientation, bytes, taken-at, camera, has-location flag, metadata JSON (mode, frames, ICC and EXIF presence), `active` or `trashed` |
| `derivatives` | Cache index for rendered files |
| `uploads` | Chunked upload sessions |
| `tombstones` | Purged photo IDs, so references resolve as deleted |
| `settings` | Limits (and a restore-in-progress marker) |

GPS coordinates are not stored in the database: only whether the original has them. They remain in
the untouched original file.

## 4. Image handling (`backend/argus/imaging.py`)

- **Accepted:** JPEG, PNG, WebP and GIF (first frame for derivatives). The type comes from the file
  signature and decoder, never the name or the declared type.
- **Bounds:** size is checked from the header before decoding (at most 20,000 px per side and the
  `max_megapixels` setting, hard cap 40 MP). A trial decode rejects damaged files.
- **Memory:** Nexus gives modules 256 MiB. Decoding is serialised by a lock, and JPEGs are decoded at
  reduced scale when the output needs fewer pixels.
- **Derivatives:** always WebP, always rendered from the original, EXIF orientation applied, colour
  converted to sRGB when the original embeds a profile, no EXIF or other metadata written.
- **Sizes:** fitted renditions 320 (the thumbnail, made at upload), 1024 and 1600; square crops 64,
  128, 256 and 512. At most 24 cached crops per photo; older ones are evicted.
- **Self-healing:** a missing or damaged cached file is rebuilt from the original. A missing original
  gives status `unavailable` and `damaged: true`, not a failure.

### Crop model

`{x, y, w, h}`, each 0–1, normalised to the **oriented** picture (after EXIF orientation), so it does
not depend on the size of the image a client displayed. The crop must be square in pixels:
`|w·W − h·H| ≤ max(2 px, 1%)`, and at least 8 px on a side. Re-cropping never degrades, because each
crop starts from the original.

## 5. Interfaces

### Browser API (`/api/`, through the Nexus gateway only)

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Version, counts, bytes, settings, limits |
| `GET /api/photos?state=active\|trashed&cursor=&limit=` | Page of up to 30, newest first, with thumbnails |
| `GET /api/photos/{id}` | Metadata and a 1600 px display image |
| `GET /api/photos/{id}/usage` | Who uses this photo, as far as Argus may know |
| `PATCH /api/photos/{id}` | Set the title |
| `GET /api/photos/{id}/original?offset=` | The original in 768 KiB pieces |
| `DELETE /api/photos/{id}`, `POST /api/photos/{id}/restore` | Trash and restore |
| `DELETE /api/photos/{id}/purge?confirm=` | Permanent deletion of a trashed photo |
| `POST /api/uploads`, `PUT /api/uploads/{id}/{index}`, `POST /api/uploads/{id}/finish`, `DELETE /api/uploads/{id}` | Chunked upload |
| `GET`, `PUT /api/settings` | Limits |

Uploads are chunked because module requests are limited to 2 MiB: 768 KiB of raw data per chunk, sent
as base64, in order; a retried chunk is harmless.

### Protocol (`X-Nexus-Resolver-Key`, private network)

- `POST /empyrean/v1/resources/resolve`: a neutral label (title or "Photo"), dimensions and open path;
  no filename, camera, dates or location. Trashed or unknown 404, purged 410.
- `POST /empyrean/v1/projections/photo-library` and `photo-renditions`: contracts are in
  [`architecture/concepts/projections.md`](../../architecture/concepts/projections.md).
- `POST /empyrean/v1/backup/export`, `validate`, `restore`, `finalize`: below.

### Screens

Photos (drop zone, upload progress, grid), a photo view (picture, facts, "Used by", download, title,
Trash), Trash, Settings, and picker mode at `/pick/<module>/<return path>`, which adds "Use this
photo" and then asks Nexus to navigate to `<return path>/<photo-id>` in that module.

## 6. Lifecycle and deletion safety

1. **Trash** hides a photo; references then see it as trashed. It can be restored. Nothing purges
   automatically.
2. **Purge** works only from Trash. It asks Nexus which references point at the photo (only
   relations whose creators shared them with `argus` are visible). If any exist, or the check fails,
   the call answers 409 until `confirm=true`.
3. The photo row and its derivatives go, and a tombstone stays. **The original is deleted only when
   no other photo uses the same bytes.**

## 7. Security

- `/api/` needs the gateway key and protocol routes the resolver key; each is compared in constant
  time and neither replaces the other.
- There are no public media URLs. Images reach the browser as `data:` URLs inside JSON, because the
  sandboxed iframe's policy allows only those.
- Filenames are reduced to a printable base name. No filesystem path appears in a response.
- Projections never expose originals, EXIF, filenames or location.
- Access by other modules rests on the owner's review of the requester's projection scope in Nexus.
  Argus does not add per-photo sharing rules of its own.

## 8. Backup and recovery

- **Module backup:** Nexus's backup v1 calls `export`, which produces an uncompressed tar with a
  database snapshot and `originals/<sha256>` for every blob. Derivatives are left out and rebuilt on
  demand. A library over 256 MiB refuses to export (HTTP 507), so module backup does not yet suit
  a large library.
- **Validate and restore:** only expected member names are accepted, the database must pass
  `integrity_check` at a supported schema, and every original must exist and match its digest.
  Restore then adds originals, replaces the database and clears caches. Originals no restored photo
  uses are removed only at `finalize`.
- **Offline copy:** back up the whole `/data` volume with the module stopped. The database and media
  must be copied together: a database without its originals shows damaged photos, and originals
  without the database lose all identity and metadata.
- Nexus does not encrypt backups, and they contain the originals, including any location data
  inside them. Protect them accordingly.
