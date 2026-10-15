# The Archive

The Archive is a self-hosted, private audio library for collecting, organizing, reviewing, and sharing songs, demos, voice memos, mixes, and other recordings with a small group of trusted users.

It combines browser-based batch uploads, waveform playback, metadata and collection management, ratings, likes, time-coded comments, alternate song versions, downloadable stems, user administration, and optional macOS Finder-tag import tools. Audio and metadata stay on storage controlled by the operator; the application does not require an external database or third-party account service.

## Contents

- [Feature overview](#feature-overview)
- [Accounts and permissions](#accounts-and-permissions)
- [Requirements](#requirements)
- [Install a new archive](#install-a-new-archive)
- [Configuration](#configuration)
- [Persistent storage](#persistent-storage)
- [Using the archive](#using-the-archive)
- [Finder color-tag workflow](#finder-color-tag-workflow)
- [Backup, restore, and updates](#backup-restore-and-updates)
- [Development](#development)
- [Architecture and operational limits](#architecture-and-operational-limits)

## Feature overview

### Audio library and metadata

- Audio projects with an original recording and any number of attached alternate versions.
- Supported browser audio types: MP3, WAV, M4A, AAC, FLAC, OGG, AIF, and AIFF.
- Multiple instrument tags, multiple vibe tags, and multiple collections per recording.
- Finish categories for `Tracked`, `Recorder`, and `Voice Memo`, plus compatibility with Finish values already stored in an archive.
- Recording year and full recorded date, upload date, original filename, notes, Finder color tags, and cached waveform data.
- One-to-five-star ratings for the Admin and each member.
- Per-user likes.
- Comments with optional playhead timestamps or manually entered timecodes.
- Optional ZIP attachment for stems or other supporting files.
- Direct downloads of original audio and attached stems.

### Uploading

- Admin-only browser page for uploading batches of new audio projects.
- Drag and drop across the entire upload page, or use the file picker.
- Queue multiple files and remove unwanted entries before submitting.
- Apply instruments, vibes, collections, Finish, and a fallback rating to the whole queue.
- Override tags, Finish, year, rating, and notes for each individual file.
- Play a temporary waveform preview before uploading.
- Upload progress and status display.
- Drop an optional Finder-tag JSON file with the audio; the JSON is selected automatically but the batch is not submitted automatically.
- Finder import and color-to-rating logic remain implemented; the dedicated Finder controls are hidden from the upload UI for now. Manual batch and per-file ratings remain available.
- Any authenticated user can attach a new version to an existing song project from its card. Versions retain their own source filename, uploader, upload date, notes, comments, ratings, and likes.

### Playback

- Responsive WaveSurfer waveform players with click or drag seeking.
- Cached waveform peaks for quick loading and lower browser decoding cost.
- Only one recording plays at a time.
- Select the original or any uploaded version directly from the song card.
- Admin-selectable default version for each song project.
- Time-coded comment markers displayed directly over the waveform.
- Persistent mini-player with play/pause, seeking, volume, and stop/repeat/continue-to-next modes.
- Browser Media Session integration for play, pause, previous, next, seek, and lock-screen metadata when supported.
- HTTP range streaming for efficient seeking.
- Firefox MP3 playback uses an in-memory MP4 sample table with exact frame timestamps. Audio bytes stream from the original file; no transcode, persistent copy, or full-file browser decode is required. Downloads remain the original file. Safari and Chromium retain their existing playback paths.
- Automatic cached MP3 transcodes for WAV playback on mobile devices when `ffmpeg` is available.
- Incremental rendering in groups of 30 recordings for larger libraries.
- Authenticated single-recording pages at `/player/<recording-id>` for direct navigation to a focused player and metadata view.

### Search, filtering, and discovery

- Search by song name, with an option to include Admin notes.
- Include or exclude instruments, vibes, collections, Finish values, years, and Admin ratings.
- Admin filtering by users who rated, liked, commented on, or uploaded a version of a song.
- Filter to the current user's liked songs.
- Admin-only filter for recordings without instrument or vibe tags.
- Live counts beside filter choices.
- Sort by random order, name, recorded date, date added, Admin rating, or the current user's rating, in either direction.
- Random button that selects five recordings from the current eligible set.
- Voice Memo inclusion control beside the random selector.
- Collection selection creates a focused collection view and resets unrelated filters.
- Clean installations start with no Finish filter selected, so every recording is visible. Legacy installations retain their previous default Finish selection.

### Collaboration

- Individual member ratings while retaining a distinct Admin rating.
- Per-user likes and a personal liked-song filter.
- Comments from every authenticated user.
- Comments can point to the current playhead or a typed timecode such as `1:23`.
- Clicking a time-coded comment seeks to that moment and starts playback.
- Users can delete their own comments.
- All authenticated users can add or remove a song from collections and create a new collection name while doing so.
- All authenticated users can upload alternate versions to an existing project.
- Admin activity feed for ratings and comments from other users.

### Administration

- Management dashboard at `/manage` with inline recording-type changes and a metadata editor using the library's cached waveform and audio stream.
- Open **Collections**, then **Rename** on a collection to update its name across all recordings and versions. Bulk **Add to collection** preserves existing memberships.
- **Maintenance → Advanced tools** provides the stems, variation, rating, Finder-tag, full-export, and deletion controls.
- **Members & access** at `/users` provides a searchable account directory, member activity, name edits, password resets, and account creation or deletion.
- Rename song projects and retain the original filename.
- Add or remove instrument and vibe tags from the main library.
- Edit Admin notes, Finish, year, ratings, and variation details.
- Choose the default version that opens for a song project.
- Search the management view across titles, filenames, notes, tags, Finish, and year.
- Rename a collection everywhere or remove it from every recording without deleting audio.
- Upload, replace, download, or delete a stems ZIP.
- Generate, regenerate, cull, or rebuild all cached waveforms.
- Reset member ratings on an individual original or variation.
- Import Finder color tags into recordings already in the archive.
- Export a CSV containing metadata, likes, per-user ratings, comments, collections, stems information, tags, dates, Finder colors, waveform status, duration, and internal IDs.
- Delete one variation without deleting its parent project.
- Delete a project and all of its versions, audio files, and stems.
- Delete every project after a typed confirmation.

### User management

- A single protected Owner account on clean installations; existing installations automatically recognize the original administrator (`adam`) as Owner.
- Admin-created member accounts; there is no public registration flow.
- Editable display names without changing the stable internal IDs used by ratings, likes, comments, and upload history.
- Owners can promote Members to Admin or demote Admins from **Members & access → Access role**.
- Admins can manage Member accounts and their own name/password, but cannot change roles or edit, reset passwords for, or delete other Admin or Owner accounts.
- Last successful login appears in the member directory and details, with sorting by last login. Tracking starts after this update; earlier logins show **Not recorded**.
- Per-user summaries for rating count and average, likes, comments, rated songs, liked songs, and commented songs.
- Password-only login: the submitted password identifies the account, so every account must use a unique password.
- Signed, HTTP-only session cookies with a 30-day lifetime.
- Login throttling: seven failed attempts within 15 minutes trigger a 15-minute lockout for that client.

### Optional macOS tools

- Finder color-tag exporter using macOS Spotlight metadata (`mdls`).
- Double-clickable Finder export command.
- Voice-memo metadata repair script that derives dates from filenames, updates MP3 metadata with `ffmpeg`, updates filesystem dates, and optionally updates Finder dates with `SetFile`.

## Accounts and permissions

The application has three roles: Owner, Admin, and Member. The original administrator's stable ID (`adam`) automatically receives Owner access when this version is deployed, including existing production installations and renamed accounts. Passwords, session cookies, and interaction history are preserved. New accounts start as Members.

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| Browse, filter, play, and download audio or stems | Yes | Yes | Yes |
| Rate, like, and comment; delete own comments | Yes | Yes | Yes |
| Update recording collections or upload alternate versions | Yes | Yes | Yes |
| Upload new song projects in bulk | Yes | Yes | No |
| Edit projects, tags, notes, or another user's rating | Yes | Yes | No |
| Manage stems, waveforms, collections, and files | Yes | Yes | No |
| View archive-wide activity and user summaries | Yes | Yes | No |
| Create and manage Member accounts | Yes | Yes | No |
| Edit own name and password | Yes | Yes | No |
| Manage other Admin or Owner accounts | Yes | No | No |
| Promote Members to Admin or demote Admins | Yes | No | No |

Only Owners change roles. Owner access is protected from demotion and deletion. Built-in legacy accounts cannot be deleted. Deleting a custom account also removes its ratings, likes, and comments, so back up the archive before deleting an account whose history may be needed.

## Requirements

- Node.js 24 LTS (the supported production major; `.nvmrc` selects 24).
- npm and the checked-in `package-lock.json`.
- A persistent, writable local filesystem directory for metadata and audio.
- Enough free disk space for original audio, stems, waveform metadata, and mobile transcodes.
- HTTPS when the archive is reachable over a network you do not fully trust.
- `ffmpeg` strongly recommended and available on `PATH`, or configured through `ARCHIVE_FFMPEG_PATH`.
- Outbound access during installation and production builds for npm packages and the configured Geist web fonts.

`ffmpeg` is used for waveform generation across all supported formats and for mobile-friendly WAV transcoding. Without it, the server can generate waveforms only for supported PCM or float WAV files; a compatible browser may still generate and save a waveform after loading a recording.

## Install a new archive

These steps describe the application setup itself and are independent of any particular hosting provider.

1. Clone the repository and enter the project directory:

   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```

2. Install the locked dependencies:

   ```bash
   npm ci
   ```

3. Create a long, random authentication secret:

   ```bash
   openssl rand -base64 48
   ```

4. Copy `.env.example` to the environment file used by your runtime and set the storage, secret, and explicit initial Owner password:

   ```dotenv
   ARCHIVE_AUTH_SECRET="replace-with-the-generated-secret"
   ARCHIVE_STORAGE_DIR="/absolute/path/to/persistent/archive-data"
   ARCHIVE_ACCOUNT_CODES='{"adam":"choose-a-long-unique-password"}'
   ```

5. Ensure the account running the application can create files and directories under `ARCHIVE_STORAGE_DIR`. Begin with an empty storage directory for a clean installation.

6. Build and start the application:

   ```bash
   npm run build
   npm run start
   ```

7. Open the application and sign in with the password you configured for `adam`. The first successful login saves a salted password hash.

8. Remove `ARCHIVE_ACCOUNT_CODES` from the runtime environment and restart after the first successful login. Manage subsequent passwords in **Users**. Passwords created or changed in production must contain at least eight characters.

9. Open **Upload** to add the first recordings.

A fresh archive is initialized with:

- Archive title: `the archive`
- Account: `Owner`
- Initial password: explicitly configured by the operator; there is no built-in password
- Instrument choices: Guitar, Vocals, Bass, Drums, and Synth
- Vibe choices: none
- Finish filtering: no automatic selection, so all recordings are shown

The default Owner's stable internal ID is `adam` for data-schema compatibility. Changing the display name on the Users page does not change that ID or any existing history.

## Configuration

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ARCHIVE_AUTH_SECRET` | Production | Signs sessions and verifies legacy password hashes. Use a long random value and preserve it with deployment secrets. |
| `ARCHIVE_STORAGE_DIR` | Strongly recommended | Absolute path to the persistent archive directory. Defaults to `./data` for local development. |
| `ARCHIVE_FFMPEG_PATH` | Optional | Absolute path or command name for `ffmpeg` when it is not available as `ffmpeg` on `PATH`. |
| `ARCHIVE_TRUSTED_IP_HEADER` | Optional | A proxy-overwritten single IP header: `x-real-ip`, `cf-connecting-ip`, or `x-forwarded-for`. Requires blocked direct origin access. Unset uses one shared login throttle bucket. |
| `ARCHIVE_ACCOUNT_CODES` | Initial setup if no stored credentials | JSON object mapping internal user IDs to initial passwords for accounts that do not yet have a stored password hash. Prefer managing passwords in the Users page after setup. |

Example optional account-code configuration:

```dotenv
ARCHIVE_ACCOUNT_CODES='{"adam":"use-a-long-unique-password"}'
```

Do not change `ARCHIVE_AUTH_SECRET` casually. Legacy password hashes use that secret until upgraded on successful login, and changing it invalidates active sessions and can prevent stored passwords from matching. Treat the secret and the storage directory as two parts of the same installation.

### Installation settings

The application creates `archive-settings.json` in `ARCHIVE_STORAGE_DIR`. There is currently no settings page for these values, so stop the application, back up the file, edit it directly, and restart when changing installation-wide defaults.

Clean-installation example:

```json
{
  "version": 1,
  "legacyDefaults": false,
  "archiveName": "the archive",
  "defaultInstruments": ["Guitar", "Vocals", "Bass", "Drums", "Synth"],
  "defaultVibes": []
}
```

- `archiveName` controls the title shown on the login and main archive screens.
- `defaultInstruments` and `defaultVibes` seed tag choices; tags already used by recordings are also discovered automatically.
- `legacyDefaults` is an installation-compatibility marker. Leave it `false` for a new archive.

If `archive-settings.json` does not exist, the presence of `data.json` marks the installation as legacy so older archives retain their users, tags, title, and initial Finish filter behavior. Therefore, use an empty storage directory when creating a genuinely new archive.

## Persistent storage

The application uses JSON metadata plus ordinary files rather than an external database. The important contents of `ARCHIVE_STORAGE_DIR` are:

| Path | Contents |
| --- | --- |
| `data.json` | Song projects, variations, metadata, waveform peaks, ratings, likes, comments, collections, and stems references |
| `archive-settings.json` | Installation title, defaults, and compatibility mode |
| `accounts.json` | Created users, display-name overrides, roles, and last successful login timestamps |
| `users.json` | Password hashes |
| `uploads/` | Original audio and uploaded versions |
| `stems/` | Attached ZIP files |
| `transcoded/` | Regenerable mobile MP3 versions of WAV files |

The application creates missing storage subdirectories as needed. Never place production storage on an ephemeral filesystem or inside a directory that is replaced by code deployments.

The repository's local `data/` directory and `.env*` files are excluded from Git. Keep them excluded; they can contain passwords, interactions, private audio, and other installation data.

### Current upload limits

| Upload type | Limit |
| --- | --- |
| New-project batch | 200 files |
| Each file in a new-project batch | 500 MB |
| Entire new-project batch | 5 GB |
| Alternate version | 30 MB |
| Stems ZIP | 2 GB |
| Admin notes or variation notes | 10,000 characters |
| Comment | 4,000 characters |
| Comments on one recording | 1,000 |
| Instrument or vibe tags submitted in one category | 25 |
| Tag or collection name | 80 characters |
| Collections on one recording | 50 |

Your web server, proxy, platform, or browser may impose smaller request-size and timeout limits. Configure the surrounding infrastructure to support the largest uploads you intend to accept.

## Using the archive

### Uploading new projects

Only the Admin can open **Upload** and create new top-level song projects.

1. Drag supported audio anywhere onto the page or click the selection box.
2. Optionally include one Finder JSON export in the same drop.
3. Use **Batch settings** to apply metadata to every queued file.
4. Review each entry, listen to its preview, and adjust its tags, Finish, year, rating, or notes.
5. Remove entries that should not be uploaded.
6. Select **Upload all** and leave the page open until the request completes.

The browser sends recording dates with the upload metadata. The server also performs the same filename-date detection as a fallback.

### Automatic date and Finish detection

The upload queue recognizes these date patterns when they are separated from surrounding text by a space, underscore, hyphen, period, or filename boundary:

- `YYYYMMDDHHMMSS`
- `YYYYMMDD_HHMMSS`
- `YYYYMMDD`
- `MMDDYY`

Valid detected dates set the recorded date and year. Date-only values use noon as their time. Two-digit years from 70 through 99 are interpreted as 1970 through 1999; values from 00 through 69 are interpreted as 2000 through 2069.

The current Finish inference is:

- A valid detected filename date: `Tracked`
- Otherwise, a filename containing `ste-0`: `Recorder`
- Otherwise: `Voice Memo`

Review the queue before upload and click the selected Finish to clear it or choose another value when that inference does not match your workflow.

### Organizing recordings

- Admins can rename a project by using the edit control beside its title.
- Admins can add or remove instrument and vibe tags from a song card.
- Admin notes are editable by the Admin and readable by members when present.
- Every user can add a recording to existing collections or create a collection from a song card.
- Admins can rename or remove a collection globally from **Manage**.
- Finish and year can be changed from **Manage** for originals and variations.
- Changing a project's display name does not rename the stored audio file.

### Ratings, likes, and comments

- Members see the Admin rating and their own rating.
- Admins can see all submitted ratings and can edit a rating on another account's behalf.
- Each account has an independent liked state.
- Comments support plain text, the current playhead, or a manually entered timecode.
- Time-coded comments appear as waveform markers.
- A user can delete their own comments; deleting an account removes that account's comments, likes, and ratings.

### Alternate versions

Every authenticated user can open **Upload** on a song card and attach one supported audio file up to 30 MB. A new version:

- stays grouped with the parent song;
- records its original filename, uploader, and upload date;
- inherits instruments, vibes, Finish, collections, and Finder color tags from the parent at upload time;
- starts with independent notes, comments, ratings, and likes; and
- can be selected from the version menu on the main page.

The Admin can choose which version is selected by default and can edit or delete each variation independently. Deleting the parent project deletes all attached versions.

### Stems

From **Manage**, the Admin can attach one ZIP file to an original or variation. Uploading another ZIP replaces the previous attachment. Any authenticated user can download the current stems ZIP from the song card.

### Waveforms

Waveforms are cached in `data.json` rather than stored as image files. They are normally generated during upload. The Admin can regenerate or remove an individual cache, rebuild every waveform, or cull all cached waveforms from **Manage**.

Stage 4 uses waveform cache version 6. Earlier caches are ignored because mobile placeholder peaks may have been saved as audio. After deploying, reload open pages and use **Manage → Regenerate All Waveforms**. Keep that page open until it reports completion; failed items retain their previous saved data and can be retried individually. Regeneration updates only waveform peaks, duration, and cache version; it preserves recordings, metadata, ratings, likes, and comments. Do not cull caches first. Desktop playback can regenerate missing caches from decoded audio; mobile playback can stream while awaiting an Admin regeneration and must never save its display placeholder as audio.

Playback, waveform seeking, comment positions, and Media Session use the media duration once available, with cached duration only as a startup fallback. Real silent recordings are valid waveforms. After rollout, verify a representative recording on desktop and a physical iPhone/Android device, including seeking, switching versions, and background playback.


If server-side generation fails, the browser may generate a compatible cache after decoding the audio. Installing `ffmpeg` provides the most reliable behavior across the supported formats.

### CSV export

**Manage → Export CSV** exports both originals and variations. The export contains metadata and interactions, but it does not contain the audio itself and is not a complete backup. Use a storage-directory backup for disaster recovery.

## Finder color-tag workflow

Finder integration is optional and intended for macOS users who already organize source audio with Finder color tags.

### Export Finder tags

From Terminal:

```bash
npm run export:finder-tags -- /path/to/audio-folder finder-tags-export.json
```

The exporter recursively finds supported audio files, reads `kMDItemUserTags` with macOS `mdls`, and writes filename, relative path, absolute path, original Finder tags, and normalized color names to JSON.

The repository also includes `Export Finder Tags.command` for a Finder-oriented workflow.

### Apply Finder tags during upload

Drop the JSON with the corresponding audio. Matching is case-insensitive by filename. Finder colors are always attached to matched queue entries. The dedicated JSON picker and Finder color-rating controls are temporarily hidden in the redesigned upload UI.

The retained Finder color-rating implementation uses these rules when enabled; its UI switch is currently hidden:

- Yellow → 2
- Green → 3
- Blue → 5
- Yellow + Green → 2
- Blue + Green → 4
- Four or more colors → 5
- Other combinations retain the fallback rating

The toggle is off by default.

### Import Finder tags after upload

**Manage → Import Finder Tags** applies a JSON export to existing records. Files with no match are skipped; filenames matching more than one stored record are reported as ambiguous. This management import preserves an existing nonzero Admin rating but automatically derives the Admin rating from colors when the current rating is zero.

### Repair voice-memo metadata on macOS

The optional script below updates MP3 dates based on the same filename patterns used by the application:

```bash
./scripts/fix-voice-memo-metadata.command /path/to/folder
```

Use `DRY_RUN=1` to preview its work. The script can rewrite embedded metadata with `ffmpeg`, uses `touch` for filesystem dates, and uses `SetFile` for Finder creation dates when installed. It modifies source files, so work on a backup.

## Backup, restore, and updates

### Backup

For the most consistent snapshot, stop the application or otherwise prevent writes, then copy the complete storage directory:

```bash
cp -a "$ARCHIVE_STORAGE_DIR" "$ARCHIVE_STORAGE_DIR.backup.$(date +%F-%H%M)"
```

Also preserve `ARCHIVE_AUTH_SECRET` in your secret manager or deployment configuration. A storage copy without the matching secret may not accept existing password hashes.

### Restore

1. Stop the application.
2. Move the damaged or unwanted storage directory aside rather than overwriting it immediately.
3. Restore the complete backed-up directory to the path configured by `ARCHIVE_STORAGE_DIR`.
4. Restore the matching `ARCHIVE_AUTH_SECRET`.
5. Start the application and verify accounts, several recordings, comments, stems, and downloads.

The `transcoded/` directory is a cache and can be regenerated, but restoring the entire directory is simplest.

### Update the application

1. Back up `ARCHIVE_STORAGE_DIR`.
2. Pull or otherwise deploy the new source code.
3. Run `npm ci` so installed packages match `package-lock.json`.
4. Run `npm run build`. This runs the supported Webpack builder and rejects deployment traces containing archive data or credential files. Do not bypass it with a bare `next build`.
5. Restart the application using the same environment and persistent storage directory.
6. Sign in and verify the archive before discarding the backup.

Code updates should never replace `ARCHIVE_STORAGE_DIR`. Existing IDs and interactions remain in the storage data when display names or code change.

## Development

Install dependencies and start the development server:

```bash
npm ci
npm run dev
```

The development fallback storage directory is `./data`. To avoid using an existing local archive, point `ARCHIVE_STORAGE_DIR` at a new temporary directory before starting the server.

Available scripts:

```bash
npm run dev                 # Next.js development server using webpack
npm run build               # Webpack production build, TypeScript, and artifact safety check
npm run start               # Start the built application
npm run lint                # ESLint
npm test                    # Isolated storage and route regression tests
npm run export:finder-tags  # macOS Finder metadata exporter
```

The main source areas are:

- `app/page.tsx` — library, filters, song cards, playback, and collaboration UI
- `app/upload/page.tsx` — browser batch upload queue
- `app/manage/page.tsx` — file, waveform, stems, collection, Finder, and CSV administration
- `app/users/page.tsx` — user administration and interaction summaries
- `app/api/` — authenticated route handlers
- `lib/auth.ts` — accounts, password verification, and sessions
- `lib/storage.ts` — storage paths and file safety helpers
- `lib/archive-settings.ts` — installation defaults and legacy compatibility
- `lib/server-waveform.ts` — `ffmpeg` and WAV waveform generation
- `scripts/` — optional local macOS utilities

Before committing changes, run:

```bash
npm test
npm run lint
npm run build
```

### MP3 seek regression diagnostic

Firefox's native raw-MP3 demuxer can report the requested `currentTime` while
playing audio from an earlier position. On `210221_WaveringTrip.mp3`, captured
Firefox 158 output after a seek to 4:02 was about 2.72 seconds behind a sequential
FFmpeg decode. This also reproduced without WaveSurfer; waiting for `seeked` did
not correct it. Rebuilding the Xing TOC still left about 2.4 seconds of error.
The demuxer estimates frame timestamps using average frame sizes even when a
TOC is present (see [Mozilla's MP3 demuxer source](https://github.com/mozilla/gecko-dev/blob/master/dom/media/mp3/MP3Demuxer.cpp),
`FastSeek`, `FrameIndexFromOffset`, and `ScanUntil`).

The Firefox playback URL requests `?format=mp4`. The server scans MP3 frame
headers and constructs MP4 sample sizes, offsets, and timestamps, then serves a
virtual file consisting of that header followed by the original MP3 bytes.
The sample table excludes ID3/Xing metadata from audio samples. LAME gapless
timing is represented with an edit list. No FFmpeg process is used for playback.
The header cache is bounded to 32 MiB / 64 entries, invalidated on source changes,
and shared by concurrent range requests. Unsupported/corrupt structures fall
back to original streaming; those files may retain the native seek limitation.

The supplied 13.9 MB sample needs a 167,672-byte header; local indexing took about
19 ms. In an actual Firefox 158 headless run using WaveSurfer 7.12.6 and the app's
seek helper, corrected output at 1:00, 4:02, 6:40, and a backward seek to 4:02
matched the reference within 44 ms (the capture includes audio-callback timing
uncertainty). Local buffered seeks took 1–3 ms; network latency is additional.
Waveform height stayed fixed, and rapid seeks resolved to the final target.
The production-build library page also matched the reference within 41 ms at
4:02, made zero full-file decode calls, and retained its 92 px waveform height.
The original download matched the supplied file byte for byte (SHA-256). A WAV
control matched within 34 ms across the same seek sequence.
Safari testing was explicitly deferred; this workaround is not enabled there.

To reproduce with a local file (requires FFmpeg; analysis requires Python/NumPy):

```bash
node scripts/diagnostics/mp3-seek.cjs /path/to/sample.mp3 /tmp/seek-results
# Open localhost:3016/?mode=original, click Run capture, then repeat with mode=indexed.
python3 scripts/diagnostics/analyze-seeks.py /tmp/seek-results
```

The diagnostic binds to loopback, captures the media element's decoded output
without a microphone, and compares it to sequentially decoded reference PCM.
It rejects any attempt to use `decodeAudioData` in the browser. Use a sample
longer than seven minutes for the fixed seek targets. Inspect correlation as
well as offset; silence and interrupted captures cannot establish alignment.
Diagnostic PCM/results stay in the explicitly supplied output directory and
are not application caches or deployment assets.

## Architecture and operational limits

- The application is built with Next.js 16, React 19, TypeScript, Tailwind CSS 4, and WaveSurfer.js.
- It expects a Node.js server runtime with a writable local filesystem. It is not designed for a static export.
- Metadata is stored in one JSON file. Writes use synchronous read/modify/write operations with atomic file replacement; uploads and waveform generation re-read the latest metadata before committing. Library reads do not rewrite the archive or delete metadata for missing audio.
- Recording edits update only explicitly submitted fields. Older open pages using the retired whole-record save must be reloaded after updating the application.
- Attachment replacement and deletion commit metadata before cleaning up old files; cleanup failures are logged and may leave unreferenced files on disk.
- Run one application process against a storage directory. Multiple replicas or concurrent writers can overwrite one another because there is no database transaction or distributed lock layer.
- This architecture is best suited to a personal archive or a small trusted group, not an untrusted public upload service or a horizontally scaled deployment.
- All library pages and file endpoints require authentication; there is no anonymous public-sharing mode.
- There is no self-registration, email recovery, or automatic password-reset flow. The Admin manages accounts directly.
- Fresh installations require an explicitly configured initial password; there is no built-in `admin` password.
- Account deletion removes that member's interaction history. File and project deletion removes audio from disk and is not recoverable without a backup.
- Large uploads are read and processed by the Node.js application, so memory, request limits, proxy timeouts, and available disk space must be sized accordingly.
- Review [SECURITY.md](SECURITY.md) before exposing an archive to the internet.

## License

This repository does not currently include a license file. Add an appropriate open-source license before distributing the project for reuse.


### Stage 5 deployment artifacts

Use Node 24 LTS, `npm ci`, and `npm run build`. The build uses Webpack because the tested Turbopack build retained local archive files in its proxy trace even with route exclusions. `npm run check:artifacts` is also available separately. It checks all production route/proxy/server traces, server/static/standalone output paths, and `public` for archive storage, known credential filenames, environment files, private keys, and audio/ZIP assets. It fails when no completed production build or traces exist. It checks paths and symlink targets, not arbitrary secret strings embedded in JavaScript; never expose secrets through `NEXT_PUBLIC_*` or Next config `env`.

Keep `ARCHIVE_STORAGE_DIR` and `ARCHIVE_AUTH_SECRET` in runtime configuration. Storage remains external and writable; excluding it from deployment traces does not delete it or change its runtime path. If building with a custom storage location, supply the same `ARCHIVE_STORAGE_DIR` to the build/check so that location is explicitly excluded and checked. Deploy code/build output with your existing persistent storage mounted separately. Do not package `.next/cache`, `.next/dev`, repository `data/`, `.env*`, or whole working-directory snapshots. Rebuild older artifacts before packaging; previous traces may include private archive paths.

Next.js and `eslint-config-next` are aligned at 16.4.0. Unused Multer packages and the old PostCSS override were removed; the lockfile now resolves patched compatible PostCSS versions without overrides. See `SECURITY.md` for the dated dependency audit and remaining development-tool advisory.
