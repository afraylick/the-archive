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
- Optional Finder color-to-rating logic for each queued batch, disabled by default.
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

- A single Admin account on clean installations.
- Admin-created member accounts; there is no public registration flow.
- Editable display names without changing the stable internal IDs used by ratings, likes, comments, and upload history.
- Admin-controlled password changes.
- Per-user summaries for rating count and average, likes, comments, rated songs, liked songs, and commented songs.
- Password-only login: the submitted password identifies the account, so every account must use a unique password.
- Signed, HTTP-only session cookies with a 30-day lifetime.
- Login throttling: seven failed attempts within 15 minutes trigger a 15-minute lockout for that client.

### Optional macOS tools

- Finder color-tag exporter using macOS Spotlight metadata (`mdls`).
- Double-clickable Finder export command.
- Voice-memo metadata repair script that derives dates from filenames, updates MP3 metadata with `ffmpeg`, updates filesystem dates, and optionally updates Finder dates with `SetFile`.

## Accounts and permissions

The application has two roles: Admin and member. Clean installations contain one Admin. Accounts created through **Manage Users** are members.

| Capability | Admin | Member |
| --- | --- | --- |
| Browse, filter, play, and download audio | Yes | Yes |
| Download attached stems | Yes | Yes |
| Rate and like recordings | Yes | Yes, for their own account |
| Add comments and delete their own comments | Yes | Yes |
| Add or remove recordings from collections | Yes | Yes |
| Upload a version to an existing song project | Yes | Yes |
| Upload new song projects in bulk | Yes | No |
| Rename projects and edit tags or Admin notes | Yes | No |
| Edit another user's rating | Yes | No |
| Manage stems, waveforms, collections, and files | Yes | No |
| View archive-wide activity and user summaries | Yes | No |
| Create, rename, update, or delete users | Yes | No |

The Admin account cannot be deleted. Deleting a custom member also removes that member's ratings, likes, and comments, so back up the archive before deleting an account whose history may be needed.

## Requirements

- Node.js 20.9 or newer.
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

4. Copy `.env.example` to the environment file used by your runtime and set both required values:

   ```dotenv
   ARCHIVE_AUTH_SECRET="replace-with-the-generated-secret"
   ARCHIVE_STORAGE_DIR="/absolute/path/to/persistent/archive-data"
   ```

5. Ensure the account running the application can create files and directories under `ARCHIVE_STORAGE_DIR`. Begin with an empty storage directory for a clean installation.

6. Build and start the application:

   ```bash
   npm run build
   npm run start
   ```

7. Open the application and sign in with the initial password `admin`.

8. Open **Users** and immediately replace the Admin password. Passwords created or changed while running in production must contain at least eight characters.

9. Open **Upload** to add the first recordings.

A fresh archive is initialized with:

- Archive title: `the archive`
- Account: `Admin`
- Initial password: `admin`
- Instrument choices: Guitar, Vocals, Bass, Drums, and Synth
- Vibe choices: none
- Finish filtering: no automatic selection, so all recordings are shown

The default Admin's stable internal ID is `adam` for data-schema compatibility. Changing the display name on the Users page does not change that ID or any existing history.

## Configuration

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ARCHIVE_AUTH_SECRET` | Production | Signs sessions and protects stored password hashes. Use a long random value and preserve it with deployment secrets. |
| `ARCHIVE_STORAGE_DIR` | Strongly recommended | Absolute path to the persistent archive directory. Defaults to `./data` for local development. |
| `ARCHIVE_FFMPEG_PATH` | Optional | Absolute path or command name for `ffmpeg` when it is not available as `ffmpeg` on `PATH`. |
| `ARCHIVE_ACCOUNT_CODES` | Optional | JSON object mapping internal user IDs to initial passwords for accounts that do not yet have a stored password hash. Prefer managing passwords in the Users page after setup. |

Example optional account-code configuration:

```dotenv
ARCHIVE_ACCOUNT_CODES='{"adam":"use-a-long-unique-password"}'
```

Do not change `ARCHIVE_AUTH_SECRET` casually. Existing password hashes use that secret, and changing it invalidates active sessions and can prevent stored passwords from matching. Treat the secret and the storage directory as two parts of the same installation.

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
| `accounts.json` | Created users and display-name overrides |
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
3. Use **Bulk tagging** to apply metadata to every queued file.
4. Review each entry, listen to its preview, and adjust its tags, Finish, year, rating, or notes.
5. Remove entries that should not be uploaded.
6. Select **Upload All** and leave the page open until the request completes.

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

Drop the JSON with the corresponding audio or select it in the Finder JSON area. Matching is case-insensitive by filename. Finder colors are always attached to matched queue entries.

Enable **Use Finder Color-Rating logic** only when you want these batch-specific rating rules:

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
4. Run `npm run build`.
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
npm run build               # Production build and TypeScript validation
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
- The initial `admin` password is publicly known and must be changed immediately.
- Account deletion removes that member's interaction history. File and project deletion removes audio from disk and is not recoverable without a backup.
- Large uploads are read and processed by the Node.js application, so memory, request limits, proxy timeouts, and available disk space must be sized accordingly.
- Review [SECURITY.md](SECURITY.md) before exposing an archive to the internet.

## License

This repository does not currently include a license file. Add an appropriate open-source license before distributing the project for reuse.
