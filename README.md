# Journal

A small, encrypted journal you use in the browser: a Flask server that owns
the database, does all the encryption, and serves the web app.
No cloud, no third-party sync - the server is yours, wherever you run it.

## Architecture

```
Flask server (server/app.py)         <- the only process that ever touches journal.db
  owns journal.db, decrypts entries server-side,
  holds the decryption key in memory for your session only
    |
    | HTTP (a small web UI + the JSON API it uses)
    |
    +-- Web browser                   <- calendar + Quill.js editor
```

## Running the server

```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# dev (auto-reload, one process, fine for testing):
python app.py

# production:
gunicorn --workers 1 --threads 4 --bind 0.0.0.0:8420 app:app
```

`--workers 1` is required, not just a default: the decryption key for an
unlocked session lives in an in-memory dict inside this one process, and
sqlite3 access is guarded by a single lock rather than built for
multi-process use. This is meant for one person's low-traffic personal
journal, not concurrent multi-user load - `--threads 4` is enough to keep
one slow request from blocking others.

Data (journal.db + the Flask session secret) is written to `JOURNAL_DATA_DIR`
(defaults to `server/data/`). Point that at a mounted volume in Docker so it
survives container rebuilds.

### Docker

`server/Dockerfile` builds a self-contained image from the `server/`
directory alone. `server/docker-compose.example.yml` is a service block
meant to be merged into an existing compose stack - it builds straight from
GitHub (`context: https://github.com/<you>/Journal.git#main:server`), so
`docker compose build journal` re-pulls and rebuilds without a separate
registry or CI step. It deliberately publishes no host port: your reverse
proxy (nginx, Caddy, whatever) reaches it over the internal Docker network
by service name.

### Reachability

The server has no built-in exposure story of its own - LAN-only, behind a
reverse proxy + Cloudflare, behind Tailscale, whatever you already do for
your other self-hosted services applies here too. `JOURNAL_COOKIE_SECURE=1`
should be set once it's actually served over HTTPS (see the comment next to
it in `app.py` for why it's off by default).

## First run

Open the server's URL in a browser. Against a fresh server it asks you to
set a password - this is what encrypts everything server-side. **There is
no password recovery.** If you lose it, your entries are gone for good (a
consequence of real encryption, not a missing feature). Keep it somewhere
durable - a password manager, or written down safely.

## Using it

- Click a date on the calendar to open that day's entry, or use the
  month/year dropdowns, ◀/▶ and **Today** to move around. The calendar
  works from the keyboard too: arrow keys move by day/week, Home/End to the
  start/end of the week, PageUp/PageDown by month, Enter to open.
- **‹ ›** beside the date heading (or Alt+PageUp / Alt+PageDown from
  anywhere) step to the previous/next day.
- Type - it autosaves about a second after you stop typing, and also saves
  when you switch pages or close the tab. The status bar shows "Saving…",
  "Saved", or "Not saved - retrying…" if the server can't be reached; unsaved
  text is kept and retried rather than lost.
- A login lasts 2 hours from when you enter the password (or until the
  server restarts). When it runs out the page locks itself, hiding the
  entry behind an unlock prompt - unlock and pending saves go through.
- Open on more than one device or tab? If a page was saved somewhere else
  since you opened it, your save is held back and you're shown both copies
  to choose from: keep yours, keep the other, or keep both. A tab you come
  back to with no unsaved edits quietly picks up the newer copy instead.
- Toolbar: **Bold**, *Italic*, headings, font size, insert image, and
  **Resize Images** (Small/Standard/Large) for every image in the entry.
  Inserted images are scaled to a reasonable default automatically.
- **Search entries** (under Template/Info) finds entries containing every
  word you type; click a result to open it, Escape to get the calendar back.
- **Template** and **Info** (top of the calendar panel) each switch to a
  reusable page not tied to any date, edited exactly like any day's entry -
  Template for a reusable starting point, Info for whatever you want at hand
  for quick reference. **Import Template** inserts the template into
  whatever day you're on.
- Dates with an entry are marked with a small dot on the calendar. Clearing
  an entry completely deletes it.
- On a phone, the calendar and the entry are separate tabs.
- **Change password** (bottom of the calendar panel) re-encrypts every
  entry and image under the new password in one go - if anything fails
  partway, nothing changes. Other devices are logged out and need the new
  password; this one stays logged in. Wrong current-password attempts count
  towards the login rate limit.

## Where your data lives

Everything is in one SQLite file on the server:

```
$JOURNAL_DATA_DIR/journal.db   (defaults to server/data/journal.db)
```

Every entry's text and every embedded image is encrypted before it's
written to that file. Back this one file up however you like - the backup
is only ever ciphertext without the password.

## Security model, plainly

- Password → scrypt (a slow, memory-hard KDF - resists brute force better
  than a fast hash) → a Fernet key (AES-128-CBC + HMAC-SHA256, from the
  `cryptography` library). This happens entirely server-side now.
- The password itself is never stored - only a random salt and a small
  "verifier" token used to check a password is correct on unlock.
- The derived key lives only in the server process's memory, scoped to an
  opaque session token in a signed cookie. The key itself never reaches
  the browser, and is never written to disk.
- A login is a hard 2 hours (`SESSION_LIFETIME` in `server/app.py`), not an
  idle timeout - after that the server forgets the key and the page locks.
- Only the app's own pages can change anything (CSRF protection): the
  session cookie is `SameSite=Lax`, POSTs must be `application/json`, and
  requests the browser marks as coming from another origin - including
  sibling subdomains - are refused.
- No custom crypto anywhere - both scrypt and Fernet are established,
  independently reviewed primitives, not something invented for this app.
- This is a deliberately low-effort security posture for a personal
  self-hosted tool, not a hardened multi-user service - see `server/app.py`'s
  module docstring for the specific tradeoffs (single worker, in-memory
  sessions).
- Wrong passwords are rate-limited per visitor address: 5 free tries, then
  a wait that doubles from 30 seconds up to 15 minutes; a correct password
  resets it. Behind a reverse proxy every visitor looks like the proxy, so
  the limit then applies to everyone together - set `JOURNAL_PROXY_COUNT`
  (see `server/docker-compose.example.yml`) to limit by real address instead.

## Repo layout

```
server/app.py                         Flask server - the only thing that touches journal.db
server/db.py, server/crypto.py        SQLite storage + encryption (server-side only)
server/templates/, server/static/     web UI (calendar + Quill.js editor)
server/Dockerfile, docker-compose.example.yml
```

## Extending it later

- **Faster search**: search currently decrypts every entry per query, which
  is fine at one person's scale. A large journal would want an index - a
  tradeoff between speed and what stays encrypted, worth deciding
  deliberately.
- **Tags or multiple entries per day**: would mean moving from `date` as
  the primary key to a proper `id`, with date as a separate indexed column.
- **Export**: dump decrypted entries to Markdown/JSON - straightforward
  since you already have `get_entry()` for every date.
