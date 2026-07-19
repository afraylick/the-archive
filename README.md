# The Archive

A self-hosted audio archive for uploading, organizing, reviewing, and sharing songs and recordings. It includes browser uploads, waveform playback, tags, collections, ratings, likes, comments, alternate versions, and user management.

## Requirements

- Node.js 20.9 or newer
- A persistent directory for archive metadata and audio files
- HTTPS when the archive is exposed to the internet

## First-time setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Create a production environment file or configure these variables through your host:

   ```bash
   ARCHIVE_AUTH_SECRET="replace-with-a-long-random-secret"
   ARCHIVE_STORAGE_DIR="/absolute/path/to/persistent/archive-data"
   ```

   Generate an authentication secret with:

   ```bash
   openssl rand -base64 48
   ```

3. Build and start the application:

   ```bash
   npm run build
   npm run start
   ```

4. Sign in with the initial password `admin`, open **Manage Users**, and replace that password immediately. The initial account is named **Admin** and is the only account created for a new archive.

The initial tag choices are Guitar, Vocals, Bass, Drums, and Synth. New archives do not include default vibe tags. Additional tags and users can be added in the application.

## Persistent storage

All user accounts, password hashes, song metadata, interactions, uploads, stems, waveform data, and installation settings live under `ARCHIVE_STORAGE_DIR`. Keep this directory on persistent storage and exclude it from code deployment replacements.

Important files and directories include:

- `data.json` — song metadata, ratings, likes, and comments
- `accounts.json` — created users and username overrides
- `users.json` — password hashes
- `archive-settings.json` — installation-specific defaults
- `uploads/`, `stems/`, and `transcoded/` — audio assets

Code updates do not reset an existing archive. Installations created before the public defaults were introduced retain their existing built-in users and tag choices. Historical account and song IDs stay stable when a username is changed.

## Development

Run the development server:

```bash
npm run dev
```

The development fallback storage directory is `./data`, which is ignored by Git. To test with an isolated archive, set `ARCHIVE_STORAGE_DIR` to a temporary directory before starting the app.

## Uploading

Administrators upload supported audio files through the browser. Audio can be selected from the upload box or dragged anywhere on the upload page. A Finder color-tag JSON export can be dropped with the audio or chosen separately; applying Finder colors to ratings is optional for each queued batch.

See [SECURITY.md](SECURITY.md) before deploying or updating a production archive.
