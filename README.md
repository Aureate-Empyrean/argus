# Argus

The Aureate Empyrean module for the user's own photographs: private upload and storage, intact
originals, thumbnails, and bounded image renditions for other modules the owner allows. Argus is
a native implementation, not a frontend to another media application
([ADR 0005](../architecture/decisions/0005-official-modules-own-product-implementations.md)).

**Status: 0.2.0 in production since 2026-11-09** ([record](../DEPLOYMENT_PHASE4_5_EXODUS_2026-11-09.md); 0.1.1 first deployed 2026-11-07 as a new installation; [record](../DEPLOYMENT_MERIDIAN_ARGUS_2026-11-07.md)).
**0.1.2** (Emerald visual identity, [design](docs/ARGUS.md#9-visual-identity--emerald-approved-2026-11-07)) was validated on aetest
([validation](../VALIDATION_ARGUS_EMERALD_AETEST_2026-11-08.md)) and deployed to production on 2026-11-07 ([record](../DEPLOYMENT_PHASE2_EXODUS_2026-11-07.md)).
**0.2.0** (needs Nexus 0.1.14) adds bulk import, Quick and Full Library backups, and local face recognition with per-photo corrections ([record](../VALIDATION_PHASE5_AETEST_2026-11-09.md), [design](docs/ARGUS.md)). 0.1.3 renamed "Used by" to the standard [Linked from other modules](../architecture/concepts/backlinks.md) and shows unresolved items ([record](../VALIDATION_PHASE4_AETEST_2026-11-09.md)). Meridian uses Argus for profile pictures. Current state, verification and limits are in
[docs/STATUS.md](docs/STATUS.md). Design and
security are in [docs/ARGUS.md](docs/ARGUS.md).

## Module facts

| | |
| --- | --- |
| Module ID, version | `argus`, 0.2.0 in source (schema 2); 0.1.2 in production (schema 1) |
| Port | 18333 |
| Nexus range | `>=0.1.8,<0.2.0` (tested on 0.1.9) |
| Capabilities | `ui.application`, `storage.data`, `references.read`, `references.resolve` |
| Resources | `photo` (resolvable), Entity References v2, resolve scope `meridian`/`person` |
| Projections provided | `photo-library`, `photo-renditions` (version 1) |
| Backup | Backup v1, format `argus-archive` (a tar of the database and all originals, at most 256 MiB) |
| Runtime | Python 3.13, FastAPI, SQLite, Pillow 12.3.0; no external services |

## Configuration

Nexus's manifest cannot set custom environment variables, so limits live in Argus's database.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `MODULE_PORT` | Nexus broker | Listen port (default 18333) |
| `NEXUS_RESOLVER_KEY` | Nexus broker | Authenticates the gateway (`X-Nexus-Gateway-Key`) and protocol calls (`X-Nexus-Resolver-Key`). Without it, all `/api/` and protocol routes refuse access |
| `NEXUS_URL`, `NEXUS_TOKEN` | Nexus broker | Argus's calls to Nexus (who uses a photo). Without them, use is reported as "could not be checked" |
| `ARGUS_DATA` | Development only | Data directory (default `/data`) |

| Setting | Default | Allowed | Change it with |
| --- | --- | --- | --- |
| `max_upload_mb` | 40 | 1–200 | `PUT /api/settings` (the Settings screen's Save is currently broken; see STATUS) |
| `max_megapixels` | 32 | 1–40 | as above |

## Develop and test

Tests run in Linux containers; Windows-native pytest is not supported in this workspace. This
command needs no prepared image and was verified on 2026-11-05 (22 passed):

```bash
docker run --rm -v G:/AureateEmpyrean/argus:/src -v G:/AureateEmpyrean/meridian/requirements-dev.lock:/dev.lock:ro -w /src python:3.13-slim sh -c "pip install -q --root-user-action=ignore -r /dev.lock pillow==12.3.0 && python -m pytest -q -p no:cacheprovider && ruff check backend tests"
```

Argus has no `requirements-dev.lock` of its own yet, so it borrows Meridian's tool versions.

Inside the real aetest Nexus (read-only; application switcher icon, Emerald header, library, switching):

```bash
cd argus && PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/emerald_aetest.cjs
```

## Build and install on the local test installation

The disposable Nexus `aetest` runs at `http://localhost:12334`; start it from `empyrean-nexus`
as described in that repository. Locally built images are pinned by their Docker image ID:

```bash
cd G:/AureateEmpyrean/argus
docker compose build -q
python scripts/manifest.py    # writes manifest.local.json; re-run after every rebuild
```

`manifest.local.json` then goes through the normal Nexus install or update review (owner API, or
`python -m nexus.manage` inside the gateway container; see `empyrean-nexus/docs/lifecycle-and-recovery.md`).
Production updates need the owner's explicit authorization.

## Licence

AGPL-3.0-or-later.
