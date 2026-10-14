# Archive reliability and optimization plan

This plan addresses the October 13, 2026 audit in independently reviewable stages. Data preservation comes first, followed by mutation correctness, security, playback, deployment hygiene, and performance. Production storage must be backed up before rollout. Tests use temporary storage and never the real archive.

## Stage 1 Protect persisted archive data

Status: Complete locally; not deployed.

- Replace direct metadata truncation with atomic JSON replacement so interrupted writes leave the previous file intact.
- Make library GET read-only; temporarily missing audio must not erase stored metadata.
- Re-read current metadata after asynchronous uploads and waveform generation, then synchronously merge only the new recording or generated waveform.
- Re-check parent/record existence at commit time so deleted records are not resurrected.
- Add isolated regression tests for concurrent comments, simultaneous uploads, deletion during generation, missing audio, and failed persistence.
- Preserve the documented single-process deployment constraint. This stage does not introduce multi-process transactions or fix stale browser whole-record edits.

Acceptance: regression suite, lint, and production build pass; no production data migration is required.

Implemented atomic replacement for archive, account, password, settings, inbox, and throttle JSON writes. Library reads no longer persist normalization or prune missing-file metadata. Legacy comment IDs remain stable and editable, and legacy notes survive comment mutations. Uploads and waveform generation commit against the latest metadata; missing parents/records abort their commits. Stems buffering now finishes before reading the metadata snapshot.

Validation: `npm test` passes 10 focused regression cases (11 reported tests including the parent group); `npm run lint` and `npm run build` pass. The existing broad file-tracing warning remains for Stage 5. Tests exercise route handlers directly with deferred generation and injected disk failures, using disposable storage. Atomic replacement protects against partial writes but is not a multi-file transaction or a guarantee against filesystem/power-loss failures. Stale browser edits and attachment cleanup ordering remain Stage 2 work.

## Stage 2 Make edits and attachment changes safe

Status: Planned.

- Replace browser whole-record PUTs with validated field-specific operations across library, management, and focused player screens.
- Preserve unrelated comments, ratings, collections, waveform data, and server-owned identifiers when an older browser edits metadata.
- Define explicit operations for waveform removal and member-rating reset.
- Save new stems before replacing references; remove old attachments only after metadata commits successfully. Apply the same commit-before-cleanup rule to deletion.
- Correct member comment deletion authorization and the focused player's legacy comment submission.

Acceptance: two stale clients can edit unrelated fields without losing changes; failed attachment replacement preserves the original; route authorization tests pass.

## Stage 3 Harden authentication and audio processing

Status: Planned.

- Fail closed on unreadable credentials; separate initial administrator setup from normal login.
- Migrate password hashes to a salted password KDF with an explicit compatibility strategy.
- Revoke sessions on password reset and retire indefinitely valid legacy tokens.
- Establish trusted proxy address handling and store rate-limit state under the configured storage root.
- Validate WAV headers, frame sizes, and data bounds; handle stream callback failures without crashing the process.
- Bound FFmpeg duration/concurrency and capture bounded diagnostics.

Acceptance: corruption never enables a default password, reset invalidates old sessions, untrusted headers cannot bypass configured throttling, and malformed audio fails safely.

## Stage 4 Repair waveform and playback synchronization

Status: Planned.

- Never persist mobile placeholder peaks as decoded audio.
- Establish a consistent timeline for waveform drawing, seeking, comments, mini-player, and Media Session; reconcile cached and actual media duration.
- Invalidate affected waveform caches without discarding legitimate silent recordings.
- Correct HTTP suffix and unsatisfiable range handling.
- Handle playback failures and player lifecycle transitions visibly and consistently.

Acceptance: fixtures cover uncached mobile audio, existing bad caches, differing durations, seeking, version switching, and range responses; verify representative desktop and mobile browser playback.

## Stage 5 Update dependencies and isolate deployment artifacts

Status: Planned.

- Upgrade vulnerable production and development dependencies after checking current advisories and installed Next.js guidance.
- Remove unused Multer and review the PostCSS override.
- Prevent output tracing from including archive recordings or credential metadata; preserve externally configured storage.
- Add an artifact check for private files and document the supported runtime.

Acceptance: review remaining npm audit findings for actual applicability, build without the broad tracing warning, and verify traces exclude private storage and secrets.

## Stage 6 Reduce memory network and disk costs

Status: Planned.

- Separate waveform payloads from metadata and fetch peaks on demand.
- Remove full-library parsing from audio range requests; evaluate indexed storage or SQLite using measured library sizes.
- Stream uploads with limits enforced while reading, bound processing queues, and deduplicate mobile transcodes.
- Measure and reduce unnecessary audio preloading, client computation, and retained players as the library grows.
- Add recoverable loading/error states, operational diagnostics, and backup/restore validation.

Acceptance: compare 100, 1000, and larger synthetic libraries; report response size, server latency, memory, browser responsiveness, and concurrent playback/upload behavior against the audit baseline (1000 records: roughly 30 MB uncompressed response and 251 ms route execution on the audit machine).

## Delivery rules

Commit the plan before implementation. Keep each stage in a separate implementation commit, update its status with evidence, and run focused tests plus lint/build. Do not deploy, migrate the real archive, or rebuild production waveforms as part of local implementation. Carry unresolved deployment assumptions and known later-stage issues forward explicitly.
