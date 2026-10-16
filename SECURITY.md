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

## Collaborative archives — October 16, 2026

Archive administration is independent of the site Owner, Site Admin, and Member roles. New archives and collections are private by default. Existing recordings are attributed to Adam’s archive without rewriting audio or metadata, and its membership is snapshotted once from existing accounts. Later accounts need an explicit archive invitation.

Every recording endpoint checks source archive membership or an explicit collection context. Collection grants include only recordings that belong to that collection; they do not grant archive browsing, access to unshared versions, source metadata editing, version uploads, or onward sharing. Source archive listeners can share accessible recordings into collections they can edit. Public collections expose their included recordings to every signed-in account. Removing source archive access does not revoke an independent collection grant. Audio responses revalidate access on subsequent requests; previously downloaded/buffered bytes cannot be recalled.

Include `archives.json`, `collections.json`, `inbox.json`, and `retired-user-ids.json` in whole-storage backups along with credentials, metadata, and media. Retired account IDs cannot be reused. Archive Admins cannot leave while their archive exists; they may permanently delete their archive. The site Owner may also delete any archive. Recoverable trash retains media until explicit permanent deletion; restoring does not reinstate collection grants. Site account administrators remain trusted because they can reset Member passwords.

The pre-collaboration local checkpoint is Git tag `checkpoint/pre-collaborative-2026-10-16`, with code history and local storage copied under `.checkpoints/pre-collaborative-2026-10-16/`. These local copies and all runtime storage are excluded from deployment traces and checked by the artifact guard. Remote production storage is not included in the local checkpoint.

## Trash, quotas, and archive-only accounts

The site does not maintain backups. Trash is retained in the authoritative recording store using deletion timestamps and batch IDs; files stay in place until permanently deleted. The active metadata index excludes trash, so waveform, audio, stems, comments, likes, ratings, and version endpoints reject trashed IDs. Collection membership is cleared in the same recording commit; restoring cannot reinstate a sharing grant. Purge requires a trashed recording, recording-management permission, and explicit confirmation. Media cleanup follows the metadata commit.

The upload quota is 5 GiB per uploader including trash, original/version audio, and stem ZIPs. Streaming reservations cover concurrent requests in one Node process; failed uploads release them. Stem replacement credits are locked per recording. Quotas exclude generated caches. Continue running one process per storage directory.

Archive-only accounts have a persistent `archiveScopeId`, remain Members, and cannot create archives or join other archives. Collection access is limited to collections belonging to their assigned archive; existing collection grants can intentionally include individual cross-archive recordings. Only the Archive Admin can create/manage these accounts through archive endpoints; site account administrators remain trusted. The site Owner sets each archive’s account cap (default 10, permitted range 0–100). Scoped accounts cannot be promoted, and passwords/limits/ownership are rechecked after asynchronous hashing. Archive Admin accounts cannot be removed while their archive exists. Archive Admins can delete their own archive; the site Owner can delete any archive. Deletion closes access before resumable cleanup, removes active and trashed media and archive-only accounts, and clears affected collection and inbox references. Replacement archive IDs never reuse the deleted archive ID. The site Owner account is preserved.

Manage is authenticated in its server-rendered page. Archive Admins can enter only their own archive’s Manage view; site administrators retain site-account navigation without gaining another archive’s settings or account controls. The Activity tab is exclusive to the selected archive’s Archive Admin, including when a site administrator browses another archive. Archive selection and creation remain in the title dropdown; settings, access, deletion, and archive accounts are under Manage.

Archive palettes are persisted as one of eight validated IDs in `archives.json`. Only that archive’s Archive Admin may change them, using the same access checks as archive settings. Invalid palette updates cannot partially commit settings. Styles are resolved from a fixed local catalog; arbitrary CSS is never stored or rendered. Collection-only viewers may see the collection archive’s palette without gaining archive access.
