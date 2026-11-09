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

## 9. Visual identity — Emerald (approved 2026-11-07)

Argus owns an Emerald accent family, distinct from Meridian copper and Janus teal:

| Role | Value |
| --- | --- |
| Primary / `--accent` | `#4DAD72` |
| Light / `--accent-hi`, focus, accent text | `#B0E4A0` |
| Deep / `--accent-deep`, secondary atmosphere | `#246747` |
| Icon and primary-button foreground | `#101B13` |
| Canonical icon gradient | `145deg, #B0E4A0 0%, #4DAD72 48%, #246747 100%` |

The local stylesheet derives hover, selection, borders and ambient light from Emerald.
Cool graphite surfaces replace the inherited warm tint without changing layout, spacing,
typography or glass composition. Shared tokens and foundation remain vendored unchanged.
Argus currently supports the shared dark theme only, including when the operating system
prefers light; there is no separate light theme or theme switch.

**One application icon:** `frontend/icon.svg` is the canonical 48×48, full-bleed square asset.
It preserves the outline eye motif, uses a single dark symbol, and contains no rounded corners,
shadow or additional sheen. The server embeds its exact bytes as a base64 data image into the
header, compatible with the Nexus sandbox. The header wrapper supplies its own corner radius.
There is no second eye drawing in JavaScript.

**Nexus integration:** the manifest declares `/icon-emerald.svg`, served from this same file.
The previous `/icon.svg` route remains a compatibility alias to the same bytes. Changing the
manifest icon path invokes Nexus's existing cache-key refresh when the updated module is enabled
and its updated manifest is installed. Failed refreshes retain the previous valid copy until a
successful retry. No Nexus source changes or query-string cache overrides are required.
A release must include both the changed asset/server and manifest; editing local source alone
cannot update an installed Nexus cache. Regenerate the ignored `manifest.local.json` from the
newly built image with the existing manifest script; the current pinned manifest describes the
previous build and is left unchanged. Released as **Argus 0.1.2**: validated on aetest, where the real
Nexus switcher shows the Emerald icon ([validation](../../VALIDATION_ARGUS_EMERALD_AETEST_2026-11-08.md)), and deployed to production on 2026-11-07 ([record](../../DEPLOYMENT_PHASE2_EXODUS_2026-11-07.md)).

### Local verification (2026-11-07)

- All 23 Argus tests pass in a disposable Linux container using the existing Argus runtime image
  and a read-only source mount, including exact header/manifest SVG byte equality.
- JavaScript syntax, Python lint and whitespace checks pass.
- Chromium checks cover library, trash and settings at 1440×1000 and 390×844, with both dark and
  light system preferences. The dark theme remains active; there is no horizontal page overflow.
  Settings saving, visible focus and sandbox-compatible icon loading pass.
- The icon is readable at 16, 24, 32 and 48 px. Its symbol has a minimum measured contrast of
  4.67:1 against the gradient beneath the solid stroke pixels. Primary accent contrast against
  shared layer 1 is 6.73:1; muted text against the brightest local solid surface is 6.30:1.
- Nexus's actual SVG validator and icon-cache route pass an isolated test that starts with a
  previous-path cached icon, refreshes on `/icon-emerald.svg`, revalidates its ETag and retains
  the new icon while disabled. The installed switcher was checked on aetest on 2026-11-08 with 0.1.2
  (`tests/e2e/emerald_aetest.cjs`, 26/26).
- Native Windows full-suite uploads hit the existing read-only-handle `os.fsync` limitation in
  storage. No storage code was changed; the full suite passes in the supported Linux runtime.

## 10. Roadmap Phase 5 (0.2.0)

Decisions: [D13 / ADR 0026](../../architecture/decisions/0026-argus-quick-and-full-library-backups.md), [D14 / ADR 0027](../../architecture/decisions/0027-argus-bulk-import.md), [D15 / ADR 0028](../../architecture/decisions/0028-argus-local-face-recognition.md).

**Import.** A folder chosen on the device is uploaded file by file. A server-side import reads `/data/import` inside Argus's volume, only that folder, and never follows a symbolic link. SHA-256 alone finds exact duplicates, which are skipped and recorded in `photo_sources`. Sources are read and never changed. Server-side jobs persist their progress and resume after a restart.

**Backups.** Nexus 0.1.14 asks for `quick` or `full`. Quick carries the database only and is labelled incomplete. Full carries the database and a manifest, and Nexus stores each original once as a content-addressed object. Restore returns only what is missing. A Quick restore never removes an original.

**Face identity.** A face is `auto`, `confirmed`, `unknown` or `excluded`, and only the user can leave `auto`. Automation writes only to `auto` faces. Naming a cluster confirms faces at or above a match of 0.5; the rest stay suggestions. A correction on one face is independent of its cluster, and Undo restores what automation had. Confirmed faces build each person's reference used for later suggestions. Embeddings are stored only in Argus's database, are included in its backups, and never leave through any API.

**Runtime.** Measured with the models loaded: about 150 MB, up to about 235 MB with a 1024 px image, around 0.1 to 0.2 s per image on one core. This does not fit beside the web server in the default 256 MiB, so the manifest asks for 768 MB, reviewed by the owner, and Argus refuses to enable recognition below 600 MB. Models are in `models/` with their licences (YuNet MIT, SFace Apache-2.0).
