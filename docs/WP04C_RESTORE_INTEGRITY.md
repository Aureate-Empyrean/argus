# WP04c: Full Restore integrity verification

Implementation candidate, 2026-11-10. Branch: `codex/wp04c-argus-restore-integrity`.
Base: `39115abeab9e5b6e66558b1b94982ad9530ef4ec`, Claude's committed Argus gallery 0.4.0.
No application schema migration, backup format bump or frontend changes.

## Cause and correction

Three restore decisions used path presence: the missing-object response, installation of a
returned object and Full acceptance before replacing the database. A same-size wrong file
passed all three. Three new real-file tests reproduced these failures against the base.

Restore now streams SHA-256 and checks byte size against the snapshot database. Format-2
manifests must contain the same unique digest/size mapping, declare SHA-256 and agree with
completeness headers. Invalid, missing, truncated, wrong-image and nonregular files cannot
satisfy Full restore. Missing-object selection requests damaged files again. Hash-valid
returned data is flushed, checked in a unique sibling staging file and atomically installed;
valid existing originals retain their inode and modification time. Replaced bytes are kept
privately in recovery storage. Full export and backup-object reads reject corrupt originals.

Affected endpoints, all retaining existing resolver authorization:

- `POST /empyrean/v1/backup/objects/missing`
- `POST /empyrean/v1/backup/object/{sha}`
- `GET /empyrean/v1/backup/object/{sha}`
- `POST /empyrean/v1/backup/export`
- `POST /empyrean/v1/backup/validate`
- `POST /empyrean/v1/backup/restore`
- `POST /empyrean/v1/backup/finalize`

Normal gallery/media paths and normal upload deduplication do not gain integrity scans.
Backup validation checks SQLite integrity, supported schema and foreign-key consistency,
rejects duplicate archive entries and validates original identity/size metadata.

## Compatibility and recovery

Format 2 remains database + manifest + separate objects. Format 1 remains supported with
embedded originals and valid SHA-256 identities/sizes in its database; these are independently
checked against the actual bytes. Missing or untrustworthy checksums/sizes produce an explicit
422 response rather than a fabricated verification guarantee. Quick remains explicitly
incomplete and never prunes media. Success response shapes and format/schema versions remain
unchanged. This is corruption detection using the authenticated backup protocol's expected
identities, not a new backup signature or authenticity scheme.

Restore serializes application/finalization and excludes worker startup while applying data.
Active import/recognition jobs produce 409. Nexus's existing restore maintenance gate must
continue excluding interactive writes during the protocol.

Before changing metadata, a real SQLite backup is retained in
`restore-recovery/<attempt>/before.sqlite3`. The private, atomically replaced and flushed
`restore-state.json` records applying, ready, failed or finalized. Full data is reverified
before replacement, before readiness and before finalize cleanup. A caught application
failure attempts SQLite rollback and returns 503. Failed rollback still retains the recovery
copy and a nonready marker. Abrupt process exit cannot mark readiness: finalize returns 409,
including after restart, until verified restore is repeated. Prevalidation failures leave
metadata unchanged. Repairs and repeated successful restores are idempotent for valid bytes.

Before Full cleanup removes an unreferenced original from its active location, its bytes are
retained under `restore-recovery/originals/`, as are originals replaced during repair.
Recovery copies have private permissions and an `.unverified` suffix without an integrity
claim. They are retained deliberately, with no automatic expiry. Operators need space for
snapshots, staging and retained originals. Repeat restore with verified objects to recover;
if storage/rollback itself fails, stop and inspect the retained database/media rather than
manually clearing the completion marker. No existing development or production database was
migrated or opened by this task; all test databases were disposable.

## Validation

The Linux test container uses the existing `argus:0.4.0` runtime, mounts only this worktree
read-only, has no network and stores synthetic fixtures in its disposable container layer.
Offline pytest/HTTP test tooling was supplied from ignored local artifacts.

- Complete pytest suite: **81 passed** (46 existing + 35 new restore cases).
- Existing shared P1 navigation suite: **12 passed**, using
  `node --test ../empyrean-nexus/tests/navigation.test.mjs` (read-only test execution).
- Ruff checks: **passed** for all backend and test code.
- New helper/storage/test formatting checks: **passed**.
- `git diff --check`: **passed**.

New tests exercise actual generated image bytes and SQLite backups/transactions: matching
original reuse, same-size corruption, truncation, missing/wrong-image originals, symlinks,
directories and FIFO rejection; validated repair and preservation; invalid incoming data;
legacy embedded backups and absent/untrustworthy metadata; manifest mismatches and header
downgrade attempts; staging failures; failure after database replacement with rollback;
process exit during a real API restore after database replacement but before readiness;
restart refusal and successful retry; repeated restore/finalize; corruption between restore
and finalize; recovery copies; active jobs; ordinary gallery/upload paths avoiding new hashes.
Existing suites cover CRUD, projections, original/rendition handling, import, Quick/Full
backups, manual faces and synthetic recognition behavior.

The original Windows-native suite fails at the pre-existing read-only-descriptor upload
`fsync`; repository instructions require Linux testing. That upload path was preserved.
The Linux suite has one existing Starlette/httpx deprecation warning.

## Integration status and limits

Ready for code review and isolated Nexus integration. The full gallery/browser journey and
multi-module Nexus restore orchestration were not rerun; no shared Nexus, aetest or Exodus
instance was used. Frontend, navigation adapter, vendored SDK, gallery/viewer/People assets,
existing tests and database migrations are unchanged from the gallery base. Shared navigation
protocol regression tests passed. No merge, push or deployment was performed.

The state protocol assumes the existing single Argus process/container and Nexus maintenance
gate. It does not add distributed locking or protect against arbitrary external processes
modifying the volume after verification. An abrupt exit retains evidence and blocks finalize;
it does not automatically roll back the database at startup. Disk exhaustion can prevent
rollback or repair; it must not be worked around by bypassing verification. Recovery storage
requires explicit operator review/cleanup after acceptance.
