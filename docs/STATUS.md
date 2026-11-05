# Argus 0.1.0 + Meridian profile images: status

Last verified 2026-11-05. This replaces the earlier working notes. Design is in
[ARGUS.md](ARGUS.md). The goal of the owner's brief: upload a photograph, crop it precisely, assign
it to a Person, Organization or Group, and see it throughout Meridian, with the original intact.

**That goal is not met yet.** Argus works on its own; nothing in Meridian uses it.

## Implemented and tested

Automated (`tests/test_argus.py`, 22 tests, passing; `ruff check` clean):

- upload validation by content, size and pixel limits, damaged and disguised files, chunk order and retries;
- metadata and EXIF orientation, originals preserved byte for byte, thumbnails without metadata;
- crop geometry on rotated and unrotated originals, invalid crops refused, recropping does not degrade;
- rebuilding missing or damaged derivatives, reporting a missing original;
- identical bytes stored once, and the blob kept until its last photo is purged;
- Trash, restore, purge confirmation (using a mocked Nexus), and resolver states;
- gateway and resolver authentication, no path leaks;
- both projections, called directly;
- backup round trip and refusal of tampered archives, in the test client only;
- the page being self-contained.

Browser, real Nexus iframe on aetest, 1440 px and 390 px: uploading 3 synthetic photos, the library
grid, a rotated photo shown upright, the photo view, and "Used by" reaching the real Nexus.

## Implemented but unverified

- Picker mode and "Use this photo". Nexus currently ignores the path (see below), so it would land
  on the other module's start page.
- In the browser: Trash, restore, purge, title editing, "Show more", drag-and-drop, and "Download
  original" (the sandbox allows downloads, but it has not been tried).
- Layouts at 2560×1440 and 820×1180.
- Backup and restore **through Nexus** on a real installation.
- Projection calls through Nexus, and "Used by" with real references. No module registers a
  reference to a photo yet.
- Performance with a large library, and decoding near the 40 MP cap inside the 256 MiB limit.

## Known defects

- **Settings cannot be saved in the browser.** The screen submits a `<form>`, and the Nexus sandbox
  has no `allow-forms`: confirmed on 2026-11-05 (`Blocked form submission`). Nothing is saved or
  reported. `PUT /api/settings` works. Fix: use a button handler, as Zeus does.
- `ruff format --check` wants to reformat 4 files; `ruff check` is clean.
- No `requirements-dev.lock`.

## Work in progress: remaining steps, in order

Decisions already taken are marked; nothing below exists yet.

1. **Nexus: `navigate` with a path.** The bridge action takes only a module ID, while the router
   already supports `/app/modules/<id>?path=/…`. Add an optional `path`, validated like the router
   (`^/[a-zA-Z0-9/_-]*$`, no `//`). Needed so Meridian can send the owner to Argus to upload and get
   the photo back. **Check first:** `empyrean-nexus/frontend/app.js` is being changed by the separately
   owned navigation-history work, so coordinate with it, including the Nexus version number.
2. **Meridian 0.4.0, backend.** Make a verified backup of its database first. Then:
   - migration 5, a table of representative images (entity, photo reference, crop, modification time);
   - `PUT` and `DELETE /api/entities/{id}/image`;
   - a batched avatar endpoint calling the Argus projections with Meridian's token, with a short
     in-memory cache only (no image files or EXIF stored in Meridian);
   - manifest: `projections.read` for both Argus projections, `references.create`, resources
     `organization` and `group`, reference enumeration;
   - resolver support for organizations and groups;
   - registering a `meridian.representative-image` relation with `readers: ["argus"]`, so Argus can
     warn before deleting a photo in use. Never a `depicts` relation.
3. **Argus manifest:** add resolve scopes `meridian`/`organization` and `meridian`/`group`.
4. **Meridian interface.** Photos wherever avatars appear (circle for people, softly rounded square
   for organizations and groups); a crop editor with drag, zoom, reset, final-shape preview, mouse,
   touch and keyboard; fallback to initials when Argus is down or a photo is missing, deleted or
   trashed. The graph keeps its shapes; the Timeline is not redesigned.
5. **Fix the known defects above.**
6. **Verification.** Failure modes from the brief (Argus down, missing and deleted photo, permission
   denied, damaged derivative, missing thumbnail); browser checks at 2560×1440, 1440×900, 820×1180
   and 390×844 of drag, zoom, preview, save, reload and recrop; screenshots.
7. **Documentation and aetest deployment,** then stop for the owner's visual review.

## Planned later (out of scope now)

Albums, video, large-scale import, folder sync, face recognition, geographic browsing, Chronos
links, and moving media to Nexus shared storage once it can hold them.

## Local state worth knowing

- aetest's Argus holds 3 synthetic test photos and nothing else.
- The browser QA scripts used so far lived in a temporary session folder and are not part of this
  repository. They drove the real Nexus iframe with Playwright from
  `G:/AureateEmpyrean/mnemosyne/node_modules/playwright`, and will need rewriting.
