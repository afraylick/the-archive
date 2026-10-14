# Stage 6 results and operations

Implemented October 14, 2026. No storage migration is required. Existing recordings, metadata, credentials, attachments and waveform caches remain in their existing locations. Reload browser tabs after deployment.

## Changes

- Updated clients request `/api/files?view=metadata`; waveform peaks load through authenticated per-recording GETs. The original full-library API remains compatible with older clients.
- A process-local ID index is invalidated by file identity, size and timestamps. Warm audio range requests no longer parse the entire JSON library. Cached waveform samples use exact Float64 storage with a 256 MiB budget; samples beyond that budget fall back to the authoritative JSON.
- Main-library players mount near the viewport and are destroyed offscreen, except the active/next track. Inactive players request no audio preload. Missing waveform caches use a display placeholder; regenerate them through Manage to restore detail. Placeholders are never saved as waveform data.
- Multipart uploads stream to private temporary files with backpressure, byte/part limits, two concurrent body readers and a ten-minute timeout. Failed uploads remove uncommitted files. Existing audio processing queue limits remain in place; simultaneous mobile requests share one transcode.
- Library/focused-player load failures offer Retry. Manage cache indicators understand metadata-only results. Admin-only `/api/health` reports storage availability, recording count, free disk, process memory, uptime and active upload/transcode counts, without credential contents or storage paths.

## Measurements

Run `node --expose-gc scripts/benchmark-library.cjs` with Node 24. Fixtures are created under the OS temporary directory and removed afterward. Each recording contains 4,000 waveform samples. Timings include response serialization/consumption but exclude HTTP transport and credential verification (the benchmark substitutes an admin session). The full legacy endpoint is the same-machine comparison.

| Records | Full response | Metadata response | Full request | Cold metadata | Warm metadata |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 2.99 MB | 44.7 KB | 27.67 ms | 9.62 ms | 0.80 ms |
| 1,000 | 29.90 MB | 448.8 KB | 260.39 ms | 91.27 ms | 6.75 ms |
| 5,000 | 149.51 MB | 2.25 MB | 1,263.69 ms | 451.72 ms | 26.76 ms |

At 1,000 records the response is about 98.5% smaller. One thousand warm indexed lookups took 3.2–4.0 ms total across these sizes; individual cached waveform retrieval took 0.06–0.13 ms. These are single local measurements, not production percentiles.

Packed waveform storage is approximately 3.1/30.5/152.6 MiB for these fixtures, plus metadata and process overhead. The combined benchmark's post-GC heap was 27.7/29.4/29.4 MiB, while RSS was 175/497/1,923 MiB. RSS includes fixture generation, legacy full responses, JSON parsing, buffer allocations and allocator retention; it is **not** an isolated steady-state production estimate. Cold parsing and JSON writes still allocate the full archive and block the process. At 5,000 records or frequent writes, a separate waveform store/SQLite migration is warranted if VM measurements show unacceptable pauses or memory pressure. It is deliberately deferred from this compatible release, not claimed solved. Use one application process; JSON writes are not coordinated across workers.

## Validation

- 53 reported tests pass on Node 24, including metadata isolation/invalidation, upload size/malformed-body cleanup, concurrent upload/comment preservation, shared mobile transcodes, backup corruption/missing-file detection, prior authorization and storage regressions.
- TypeScript and production build pass; artifact guard checks 31 traces. ESLint has zero errors and four existing full-page navigation warnings. Production dependency audit reports zero vulnerabilities; the Stage 5 development-only lint advisory remains documented in `SECURITY.md`.
- Disposable production server passes login/proxy authorization, external storage, metadata/waveform GETs, suffix audio ranges, waveform generation, streamed upload and health diagnostics.
- Desktop in-app browser with 1,000 records loaded the library and played a standard 44.1 kHz WAV. Scrolling replaced offscreen waveforms with placeholders; initial rendering remains a 30-card batch. This is a functional responsiveness check, not an FPS/long-task profile. The tiny 1 kHz API fixture was not browser-playable and was replaced with a standard-rate fixture for this check.
- Physical iOS/Android codecs, background controls, long recordings and production network/VM limits still require rollout smoke tests. No physical-device or sustained load-test claim is made.

## Backup and restore verification

Back up the **entire** configured storage directory, including credential/settings JSON and uploads/stems. Also securely preserve environment configuration (especially the auth secret), the systemd unit, reverse-proxy settings and the deployed Git commit outside the storage backup. The verifier does not back up those external settings or prove that a password works.

For a consistent copy, stop the service, record a manifest outside storage, copy storage with permissions preserved, and verify that copy before restarting. Example paths below assume default storage; substitute the actual `ARCHIVE_STORAGE_DIR` if configured. Choose a new backup directory each time:

```sh
cd /opt/the-archive/app
systemctl stop the-archive
mkdir -m 700 /root/archive-backup-2026-10-14
node scripts/verify-backup.mjs /opt/the-archive/app/data --record /root/archive-backup-2026-10-14/manifest.json
cp -a /opt/the-archive/app/data /root/archive-backup-2026-10-14/storage
node scripts/verify-backup.mjs /root/archive-backup-2026-10-14/storage --check /root/archive-backup-2026-10-14/manifest.json
systemctl start the-archive
```

If verification fails, inspect the error before treating the copy as a usable backup; restart the unchanged service when ready. The script refuses symlinks, unfinished staging/temp entries, malformed JSON, missing/unsafe recording references and duplicate IDs. SHA-256 comparison detects changed or missing files, including credentials and attachments. It never deletes files or repairs metadata. Legacy missing references can therefore fail validation and need investigation.

For a restore rehearsal, copy the verified backup into a new empty directory and run `--check` against the original manifest. Start an isolated application instance with that copy as `ARCHIVE_STORAGE_DIR`, then check login, metadata, original/version playback, comments and stem downloads. Do not point the rehearsal at production storage. A real restore requires stopping the live service, retaining its old storage for rollback, restoring ownership for `www-data`, then switching to the verified copy. Never overlay a live archive.

A crash can leave `.incoming-*` directories. Review/remove only confirmed abandoned staging directories while the service is stopped; they are not automatically deleted on startup.

## Deployment smoke check

Use the existing `git pull`, `npm ci`, `npm run build`, `systemctl restart the-archive` workflow with Node 24. Keep backups outside the checkout. Then check `systemctl status the-archive` and `journalctl -u the-archive -n 100 --no-pager`. Sign in as admin and open `/api/health`; verify free space and memory under normal use. Play and seek short/long tracks, scroll while playing, switch versions, upload a disposable recording and ZIP, and confirm existing comments/ratings/attachments remain present. Test mobile playback before considering rollout validation complete.
