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

Status: Complete locally; not deployed.

- Replace browser whole-record PUTs with validated field-specific operations across library, management, and focused player screens.
- Preserve unrelated comments, ratings, collections, waveform data, and server-owned identifiers when an older browser edits metadata.
- Define explicit operations for waveform removal and member-rating reset.
- Save new stems before replacing references; remove old attachments only after metadata commits successfully. Apply the same commit-before-cleanup rule to deletion.
- Correct member comment deletion authorization and the focused player's legacy comment submission.

Acceptance: two stale clients can edit unrelated fields without losing changes; failed attachment replacement preserves the original; route authorization tests pass.

Implemented explicit PATCH operations for metadata, waveform replacement/removal, and member-rating reset. All three screens send only their intended changes and merge committed fields into current state; server waveform regeneration no longer triggers a redundant whole-record save. The retired whole-record PUT returns 409 so previously open clients cannot overwrite current records. Reload open pages after rollout. Separate edits to the same field remain last-write-wins; unrelated fields are preserved.

Stems replacement writes the new ZIP first, commits its metadata, then removes the old ZIP. Failed writes/commits preserve the original and attempt to remove the uncommitted new file. Stems and project deletion commit metadata before disk cleanup. Cleanup failures are logged and may leave orphan files; they do not invalidate live references or report an already-committed operation as failed. Member comment deletion now reaches the ownership check, and the focused player submits attributed comments through the comments endpoint.

Validation: `npm test` passes 24 focused cases (26 reported tests including two parent groups), including stale edits, protected-field validation, authorization, legacy ratings, variant deletion, and attachment write/commit/cleanup failures. Lint and production build pass; the existing tracing warning remains Stage 5 work. Tests use isolated storage; no production migration or deployment was performed.

## Stage 3 Harden authentication and audio processing

Status: Complete locally; not deployed.

- Fail closed on unreadable credentials; separate initial administrator setup from normal login.
- Migrate password hashes to a salted password KDF with an explicit compatibility strategy.
- Revoke sessions on password reset and retire indefinitely valid legacy tokens.
- Establish trusted proxy address handling and store rate-limit state under the configured storage root.
- Validate WAV headers, frame sizes, and data bounds; handle stream callback failures without crashing the process.
- Bound FFmpeg duration/concurrency and capture bounded diagnostics.

Acceptance: corruption never enables a default password, reset invalidates old sessions, untrusted headers cannot bypass configured throttling, and malformed audio fails safely.

Implemented salted scrypt credentials with login-time upgrades of stored legacy hashes, credential-bound v3 sessions, reset revocation, explicit initial account configuration, and strict credential-file validation. Public built-in passwords and older session formats are retired. Existing stored passwords remain usable; users must sign in again. A persistent initialization marker detects missing primary credentials after initialization. Keep backups of credentials and the original signing secret; older code cannot read upgraded hashes. See `SECURITY.md` for rollout and rollback details.

Login attempts are reserved before asynchronous verification and stored under the configured root. Forwarding headers are ignored by default; explicit trusted-proxy configuration accepts only one valid IP. Password work is serialized and audio work shares a bounded queue. ffmpeg has time/output/diagnostic limits; the WAV fallback validates formats, frame alignment, chunk bounds, and duration, and converts stream callback exceptions into rejected jobs.

Validation: `npm test` passes 37 focused cases (42 reported tests including parent groups), covering migration preservation/failure, corrupt or missing credentials, session revocation, concurrent duplicate passwords/logins, proxy spoofing, bounded queue/process failures, malformed WAV data, and injected sample exceptions, plus all earlier-stage cases. Lint and production build pass. The build required network access for Google Fonts; the existing broad tracing warning remains Stage 5 work. All runtime tests use disposable storage. No production data was changed or deployed. Waveform timeline correction remains Stage 4.

## Stage 4 Repair waveform and playback synchronization

Status: Complete locally; not deployed.

- Never persist mobile placeholder peaks as decoded audio.
- Establish a consistent timeline for waveform drawing, seeking, comments, mini-player, and Media Session; reconcile cached and actual media duration.
- Invalidate affected waveform caches without discarding legitimate silent recordings.
- Correct HTTP suffix and unsatisfiable range handling.
- Handle playback failures and player lifecycle transitions visibly and consistently.

Acceptance: fixtures cover uncached mobile audio, existing bad caches, differing durations, seeking, version switching, and range responses; verify representative desktop and mobile browser playback.

Implemented a shared media-duration-first timeline for main/focused players, seeking, comment jumps, mini-player progress, and Media Session. Removed manual progress rendering that competed with WaveSurfer's media clock. Mobile display placeholders and supplied cached peaks are never re-exported as decoded audio. Automatic cache saves no longer remount the active main player; focused-player comments and ratings no longer recreate its player. Rejected playback promises surface visible errors, and destroyed focused players are cleared from the global active-player reference.

Cache version 6 invalidates earlier caches, including saved mobile placeholders, without deleting archive data. Silent and naturally quantized recordings remain valid. After deployment, reload old pages and run **Manage → Regenerate All Waveforms**; no preliminary cull is needed. Bulk regeneration now reports successes/failures, keeps retry controls available after completion, and preserves old saved waveforms on failure. This turn regenerated only disposable test fixtures. Original files, metadata, ratings, likes, and comments are preserved by the existing targeted waveform update.

Audio suffix ranges now return the requested final bytes; satisfiable ranges are clamped to EOF, and valid unsatisfiable ranges return 416 with `Content-Range: bytes */size`. Unsupported range syntax is ignored and returns the full resource.

Validation: 47 reported tests pass, including timeline disagreement/seeking, old placeholder invalidation, valid silence/quantized peaks, playback rejection/cancellation, and actual audio-route range responses, alongside prior-stage preservation/security tests. Lint and production build pass (Google Fonts required network access; the existing tracing warning remains Stage 5). An isolated desktop browser verified replacement of a stale 20-second cache with a 10-second timeline, successful bulk regeneration, a midpoint seek at 4.99 seconds, comment submission during playback, and switching from a 10-second original to a 5-second silent variant with the old player stopped. Physical iOS/Android playback, background Media Session behavior, and codec-specific duration differences still need rollout smoke checks; no physical-device validation is claimed.

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
