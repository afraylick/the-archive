# Security deployment notes

The archive stores user data and uploads outside of Git in `ARCHIVE_STORAGE_DIR` or `./data`.
Do not copy a development `data` directory over the production storage directory during deploys.

## Required production environment

- `ARCHIVE_AUTH_SECRET`: long random secret used to sign sessions and password hashes. Set this before starting the app in production.
- `ARCHIVE_STORAGE_DIR`: absolute path to the production storage directory that contains `data.json`, `uploads`, `stems`, `users.json`, and `accounts.json`.

New archives initially accept the password `admin` for the Admin account. Change it immediately from the Manage Users page. User passwords created or changed in production must be at least eight characters.

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
