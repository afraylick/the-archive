# Security deployment notes

The archive stores user data and uploads outside of Git in `ARCHIVE_STORAGE_DIR` or `./data`.
Do not copy a development `data` directory over the production storage directory during deploys.

## Required production environment

- `ARCHIVE_AUTH_SECRET`: long random secret used to sign sessions and verify legacy password hashes. Set this before starting the app in production.
- `ARCHIVE_STORAGE_DIR`: absolute path to the production storage directory that contains `data.json`, `uploads`, `stems`, `users.json`, and `accounts.json`.

New archives have no default password. Set `ARCHIVE_ACCOUNT_CODES='{"adam":"choose-a-long-unique-password"}'` explicitly for initial setup. The first successful login persists a salted scrypt hash; then remove this setting and restart. User passwords created or changed in production must be at least eight characters.

Generate a secret with:

```bash
openssl rand -base64 48
```

## Before pulling new code on the server

Back up the storage directory:

```bash
cp -a "$ARCHIVE_STORAGE_DIR" "$ARCHIVE_STORAGE_DIR.backup.$(date +%F-%H%M)"
```

Then pull/build/restart the app. Git should only update code, not the storage directory.


## Stage 3 upgrade and rollback

Keep the existing storage path and signing secret. Existing stored passwords and account IDs remain valid. Successful login upgrades legacy HMAC hashes to salted scrypt hashes in `users.json`; recordings and their metadata are not migrated. Accounts still relying on old built-in passwords (`admin` or a legacy account name) need an explicit operator-configured password before rollout; those public defaults are intentionally retired. Older sessions are rejected once this release is installed, so everyone must sign in again. Password resets invalidate that account's existing sessions, including resets to the same password.

Back up the complete storage directory with the app stopped before upgrading, including any legacy `./data/users.json` and `./data/accounts.json` when those differ from the configured storage root. The new `credentials-initialized.json` marker must stay with `users.json`: missing credentials after initialization or corrupt credentials fail closed. Restore missing/corrupt files from backup; do not remove the marker to bypass the check.

Old releases cannot verify the new scrypt hashes. A rollback therefore needs the matching pre-upgrade credential/account files as well as the old code and original secret. Account/password changes made since that backup must be reconciled before rollback; do not overwrite newer recordings or archive metadata with an old storage snapshot.

## Proxy and processing limits

Login throttling is stored under `ARCHIVE_STORAGE_DIR`. By default all clients share a bucket, locked for 15 minutes after seven failed attempts. Forwarding headers are ignored unless `ARCHIVE_TRUSTED_IP_HEADER` explicitly names `x-real-ip`, `cf-connecting-ip`, or `x-forwarded-for`. Only enable this when your proxy overwrites that header with one IP and direct origin access is blocked. Missing, invalid, or multi-address values use the shared bucket. Corrupt limiter storage denies login until repaired.

Password operations are serialized with at most 16 waiting jobs. Audio generation/transcoding shares two active jobs and eight waiting jobs per process. Queued jobs time out after 30 seconds. Each ffmpeg invocation times out after two minutes, limits stderr to 64 KiB, and limits decoded waveform output to four hours at 8 kHz. The WAV fallback independently validates format/frame/chunk boundaries, limits duration to four hours, and times out after two minutes. An ffmpeg failure can be followed by a WAV fallback, so the overall operation can take longer than two minutes.

These limits and JSON transactions assume one application process per storage root. Multiple workers or replicas require shared locking/transactional storage before deployment.


## Stage 5 dependency review — October 14, 2026

Updated Next.js and its ESLint configuration to 16.4.0, refreshed compatible transitive packages, and removed unused Multer/types and the obsolete PostCSS 8.5.10 override. PostCSS now resolves to 8.5.23 within Next and 8.5.30 within Tailwind; Sharp resolves to 0.35.5. React stays on 19.2.4; unrelated major-version migrations are outside this stage.

The initial full npm audit reported 17 entries (1 critical, 13 high, 2 moderate, 1 low). After updates, `npm audit --omit=dev` reports zero vulnerabilities. The full audit reports five high entries, all from one unpatched [braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) propagated through `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, and `eslint-config-next`. This path runs during development linting, not application request handling. Its glob patterns come from repository/tool configuration; do not run lint tooling against untrusted configurations. Recheck for an upstream patch during dependency maintenance. Do not apply `npm audit fix --force`: its proposed downgrade to Next's 14.x lint configuration is incompatible with the selected framework generation. ESLint remains on its existing 9.x major for plugin compatibility; npm marks that major unsupported, so a coordinated lint-plugin/ESLint upgrade remains follow-up maintenance.

Production builds use Webpack and run the artifact guard automatically. Turbopack's route exclusions did not remove private data from the tested proxy trace. This was verified by inspecting trace paths without opening credential or recording contents. The supported build passes all 30 traces and no longer emits the broad whole-project tracing warning. The guard is a path-based packaging check, not a secret-content scanner; keep runtime secrets out of public environment variables and bundled source code.

Supported runtime: Node 24 LTS; this stage was tested on 24.21.0. A production smoke test used a disposable directory, copied build output, and an external runtime storage directory. No production data migration, archive rewrite, or deployment is required by Stage 5. Existing Stage 3 credential and Stage 4 waveform rollout instructions still apply.
