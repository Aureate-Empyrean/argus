# Argus 0.1.1 + Meridian 0.4.0 profile pictures: status

Latest: **Argus 0.2.0** on aetest ([record](../../VALIDATION_PHASE5_AETEST_2026-11-09.md)). 2026-11-07: **Argus 0.1.2** (Emerald visual identity only, no data or permission change)
was validated on aetest ([validation](../../VALIDATION_ARGUS_EMERALD_AETEST_2026-11-08.md)) and deployed to production
([record](../../DEPLOYMENT_PHASE2_EXODUS_2026-11-07.md)). Design is in [ARGUS.md](ARGUS.md). The goal of the owner's brief: upload a
photograph, crop it precisely, assign it to a Person, Organization or Group, and see it throughout
Meridian, with the original intact.

| Stage | State |
|---|---|
| Implemented | Yes (Argus 0.1.1, Meridian 0.4.0) |
| Tested | Yes: unit suites and a 12-step browser journey on aetest |
| Deployed | Yes, 2026-11-07 ([record](../../DEPLOYMENT_MERIDIAN_ARGUS_2026-11-07.md)) |
| Verified in production | Partly: health, data preservation, projection, reference lookup and enumeration paths at service level. Upload → choose → crop → display and "Used by" await the owner's browser check |

## How it works

- The owner uploads photos in Argus. In Meridian, the profile picture control (the large avatar)
  opens a picker that lists the Argus library through the `photo-library` projection, and an
  editor that crops a square with drag, zoom (slider, wheel, pinch), arrow keys, +/−, 0 to reset,
  and live previews in the entity's own shape (Person rounded square, Organization small corners,
  Group circle, as Meridian's design language already defines them).
- Meridian stores only the photo ID and the normalised crop (schema 5, `representative_images`).
  Rendered images come from `photo-renditions` and are cached in Meridian's memory for two minutes.
- Meridian registers `meridian.representative-image` edges shared with `argus`, so Argus's
  "Used by" and purge warning see them; it enumerates them at `GET /empyrean/v1/references/outgoing`.
  Organizations and Groups are now resolvable resources, and Argus may resolve their labels.
- Anything other than an available picture (no picture, Argus stopped or uninstalled, photo
  trashed, deleted or unreadable) shows initials. Meridian's own data never changes because of it.

Decision taken while building it: the picker lives **inside Meridian** (the `photo-library`
contract exists for exactly that), so no Nexus `navigate`-with-path change was needed. "Upload in
Argus" switches to Argus with the existing bridge action; the owner comes back by switching to
Meridian.

## Verified

- Argus: 22 tests (`tests/test_argus.py`); `ruff check` clean. The settings form defect is fixed
  (button handler; the sandbox has no `allow-forms`).
- Meridian: 108 tests, 9 of them for pictures (library, crop validation, set/replace/recrop,
  groups and organizations, fallback statuses, Argus off, late registration, removal and purge
  cleanup, enumeration paging, backup); `ruff check` and `ruff format --check` clean.
- Browser, real Nexus iframe on aetest (`meridian/tests/e2e/pictures_e2e.py`, 12/12): picker lists
  Argus photos, crop by drag/slider/keys and save, picture in profile and People list after a
  reload, group circle shape, recrop, Argus stopped → initials and an explanation, 390 px, remove →
  initials and the Nexus edge removed, no page errors. Argus "Used by" lists the Meridian group with
  its resolved label. Screenshots in `meridian/docs/screenshots/pictures/`.

## Not verified / limits

- Layouts at 2560×1440 and 820×1180; WebKit and Firefox.
- Argus in-browser Trash, purge, title edit, drag-and-drop and download (unchanged from 0.1.0).
- Backup and restore through Nexus on a real installation (both modules; tested in the test client).
- Large libraries, and decoding near the 40 MP cap within 256 MiB.
- Argus picker mode (`/pick/...`) is no longer needed by Meridian and remains unverified.
- A module backup over 256 MiB is refused by Argus (HTTP 507); large libraries need an offline copy.

## Planned later (out of scope now)

Albums, video, large-scale import, folder sync, face recognition, geographic browsing, Chronos
links, and moving media to Nexus shared storage once it can hold them.
