"""
Flask server owning journal.db - the only process that touches it.
Serves the web UI (calendar + Quill editor) and the small JSON API it uses.

Run with: gunicorn --workers 1 --threads 4 --bind 0.0.0.0:8420 app:app

Single worker is required: the decryption key lives in an in-memory dict
scoped to this one process (never written to disk, never sent back to the
browser), and sqlite3 access is guarded by a single lock rather than built
for multi-process use. This is meant for one person's low-traffic personal
journal, not concurrent multi-user load - `--threads 4` is enough to avoid
one slow request blocking others.
"""

import base64
import html as html_lib
import os
import re
import secrets
import threading
import time
import uuid
from datetime import timedelta
from functools import wraps
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request, session
from werkzeug.middleware.proxy_fix import ProxyFix

import db

DATA_DIR = Path(os.environ.get("JOURNAL_DATA_DIR", Path(__file__).resolve().parent / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "journal.db"
SECRET_KEY_PATH = DATA_DIR / "flask_secret.key"


def _load_or_create_secret_key() -> bytes:
    """Persisted next to journal.db so sessions survive container restarts,
    without needing a separate secret configured by hand."""
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_bytes()
    key = secrets.token_bytes(32)
    SECRET_KEY_PATH.write_bytes(key)
    return key


app = Flask(__name__)
app.config["SECRET_KEY"] = _load_or_create_secret_key()
# A login lasts this long from the moment the password is entered, however
# active you are - a hard cap, not an idle timeout. The server forgets the
# key at that point (see _current_key) and the open page locks itself.
SESSION_LIFETIME = timedelta(hours=2)
app.permanent_session_lifetime = SESSION_LIFETIME
# Don't push the cookie's expiry forward on every request - it should run
# out when the server-side session does.
app.config["SESSION_REFRESH_EACH_REQUEST"] = False
_hours = SESSION_LIFETIME.total_seconds() / 3600
_SESSION_LIFETIME_LABEL = f"{_hours:g} hour{'' if _hours == 1 else 's'}"  # "2 hours", for the UI
# Behind Cloudflare/nginx doing TLS termination, set JOURNAL_COOKIE_SECURE=1
# once that's confirmed working - left off by default so local/plain-HTTP
# testing (and first-time LAN setup before HTTPS is wired up) isn't broken
# by the browser silently refusing to send the cookie.
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("JOURNAL_COOKIE_SECURE") == "1"
# Lax: the browser won't attach the cookie to POSTs started by other sites.
# Not enough alone - "site" includes sibling subdomains (other self-hosted
# services on the same domain) - hence the origin check in _reject_cross_origin.
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# Behind a reverse proxy every request seems to come from the proxy, so the
# login rate limit below would lump all visitors together (and someone
# guessing passwords would lock you out too). Set JOURNAL_PROXY_COUNT to the
# number of proxies that append to X-Forwarded-For in front of this server
# to rate-limit by the real visitor address instead. Too high a number lets
# a visitor fake their address, so leave it unset if unsure.
_proxy_count = int(os.environ.get("JOURNAL_PROXY_COUNT", "0"))
if _proxy_count:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=_proxy_count)

_conn = db.connect(str(DB_PATH))
_conn_lock = threading.Lock()  # sqlite3 connections aren't safe to share across threads unguarded

# Opaque session token (the only thing that reaches the browser, inside the
# signed session cookie) -> (derived Fernet key, expiry on the monotonic
# clock). The key never leaves this process. This is what "decrypts
# server-side, holds the key in server memory for the session" means in code.
_sessions = {}
_sessions_lock = threading.Lock()

_DATA_URI_RE = re.compile(r'src="data:image/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)"')


def _start_session(key):
    """Logs this browser in with `key`, dropping any expired sessions from
    memory while we're here. Returns the response for the login request."""
    token = secrets.token_urlsafe(32)
    now = time.monotonic()
    with _sessions_lock:
        for old_token, (_, expires_at) in list(_sessions.items()):
            if expires_at <= now:
                del _sessions[old_token]
        _sessions[token] = (key, now + SESSION_LIFETIME.total_seconds())
    session.clear()
    session.permanent = True
    session["sid"] = token
    return jsonify({"ok": True, "expires_in": int(SESSION_LIFETIME.total_seconds())})


def _session_remaining():
    """Seconds left on this browser's login, or None if it isn't logged in.
    An expired session's key is forgotten on the spot."""
    token = session.get("sid")
    if token is None:
        return None
    with _sessions_lock:
        entry = _sessions.get(token)
        if entry is None:
            return None
        remaining = entry[1] - time.monotonic()
        if remaining <= 0:
            del _sessions[token]
            return None
    return remaining


def _current_key():
    if _session_remaining() is None:
        return None
    with _sessions_lock:
        entry = _sessions.get(session.get("sid"))
    return entry[0] if entry else None


_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@app.before_request
def _reject_cross_origin():
    """CSRF protection: only this app's own pages may change anything.

    Browsers label every request with Sec-Fetch-Site; anything other than
    "same-origin" on a state-changing request is refused. Unlike comparing
    Origin with Host, this keeps working behind a reverse proxy that
    rewrites Host. Browsers too old to send it (pre-2023 Safari) still send
    Origin on cross-site POSTs, so fall back to comparing that. A request
    with neither isn't from a browser at all (curl etc.), and CSRF needs a
    browser carrying your cookie, so it's let through."""
    if request.method in _SAFE_METHODS:
        return None
    fetch_site = request.headers.get("Sec-Fetch-Site")
    if fetch_site is not None:
        if fetch_site != "same-origin":
            abort(403)
        return None
    origin = request.headers.get("Origin")
    if origin is not None and origin != request.host_url.rstrip("/"):
        abort(403)
    return None


@app.after_request
def _no_store(response):
    """Keep decrypted entries, images and search results out of the
    browser's on-disk cache, where they'd outlive logging out. Only the app's
    own static files (code and styles, nothing from the journal) may be
    cached."""
    if not request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _json_body() -> dict:
    """The request's JSON object. Only an application/json body counts -
    other sites can't send that cross-origin without CORS permission, which
    this server never grants. Anything else is refused rather than read as
    an empty body, which for a save would mean deleting the entry."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(415)
    return body


def _key_while_locked():
    """This session's key, read while holding _conn_lock - call it only
    inside `with _conn_lock:`. Reading the key before taking the lock would
    let a request that waited out a password change (which holds the lock
    while re-encrypting) carry on with the old key and write an entry
    nothing can decrypt any more. A session that ended meanwhile gets 401."""
    key = _current_key()
    if key is None:
        abort(401)
    return key


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if _current_key() is None:
            return jsonify({"error": "not authenticated"}), 401
        return view(*args, **kwargs)
    return wrapped


def _extract_inline_images(html):
    """Quill embeds newly inserted images as inline base64 data URIs.
    Pull each one out into its own encrypted row and point the HTML at it
    by id instead, so entries stay small and an image is only fetched
    (via /images/<id>) when it's displayed. Returns (html, {id: raw_bytes})
    for the new images only - ones already stored are referenced by id."""
    images = {}

    def _extract(match):
        try:
            raw = base64.b64decode(match.group(1))
        except (base64.binascii.Error, ValueError):
            return match.group(0)  # malformed data URI - leave it alone
        image_id = uuid.uuid4().hex
        images[image_id] = raw
        return f'src="{image_id}"'

    html = _DATA_URI_RE.sub(_extract, html)
    return html, images


_IMG_TAG_SRC_RE = re.compile(r'<img\b[^>]*?\bsrc="([^"]*)"')


def _own_copies_of_borrowed_images(page_key, html):
    """Images referenced here but stored under another page - which is what
    importing the template produces - get copied to this page under new
    ids, so editing or deleting the other page can't break them here.
    Returns (html pointing at the copies, {new_id: original_id})."""
    owners = db.image_owners(_conn, set(db.IMG_SRC_RE.findall(html)))
    copies = {}
    for image_id, owner in owners.items():
        if owner != page_key:
            new_id = uuid.uuid4().hex
            copies[new_id] = image_id
            html = html.replace(f'src="{image_id}"', f'src="{new_id}"')
    return html, copies


def _guess_image_mime(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if raw.startswith(b"BM"):
        return "image/bmp"
    return "application/octet-stream"


# ---------------------------------------------------------------- Pages

@app.route("/")
def index():
    remaining = _session_remaining()
    if remaining is not None:
        return render_template(
            "app.html",
            session_expires_in=int(remaining),
            session_lifetime_label=_SESSION_LIFETIME_LABEL,
            min_password_length=MIN_PASSWORD_LENGTH,
        )
    with _conn_lock:
        initialized = db.is_initialized(_conn)
    return render_template("login.html", initialized=initialized, min_password_length=MIN_PASSWORD_LENGTH)


# ---------------------------------------------------------------- Auth

# The password doesn't just guard the login - it's what the encryption key is
# derived from, so anyone with a copy of journal.db (a backup, say) can guess
# offline, where rate limiting doesn't apply. Only checked when creating a
# journal; an existing journal's password is never re-checked against it.
MIN_PASSWORD_LENGTH = 12


@app.route("/api/setup", methods=["POST"])
def setup_route():
    body = _json_body()
    password = body.get("password", "")
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"Password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400

    with _conn_lock:
        if db.is_initialized(_conn):
            return jsonify({"error": "Journal is already set up"}), 400
        key = db.setup_password(_conn, password)

    return _start_session(key)


def _check_password(password, wrong_status):
    """Rate-limited password check, shared by login and change password so
    both count towards the same limit. Returns (key, None) if the password
    is right, else (None, error response) - a wrong one answers with
    `wrong_status`. Call with _login_lock held."""
    client = request.remote_addr or "unknown"
    # Checked before deriving the key, so a locked-out guesser doesn't even
    # cost the server a password check.
    wait = _login_wait(client)
    if wait:
        response = jsonify({"error": f"Too many wrong passwords - try again in {_describe_wait(wait)}."})
        response.headers["Retry-After"] = str(int(wait + 0.999))
        return None, (response, 429)

    with _conn_lock:
        key = db.unlock(_conn, password)

    if key is None:
        lockout = _record_login_failure(client)
        message = "Incorrect password."
        if lockout:
            message += f" Too many wrong passwords - wait {_describe_wait(lockout)} before trying again."
        return None, (jsonify({"error": message}), wrong_status)

    _login_failures.pop(client, None)
    return key, None


@app.route("/login", methods=["POST"])
def login_route():
    password = _json_body().get("password", "")
    with _conn_lock:
        if not db.is_initialized(_conn):
            return jsonify({"error": "Journal not set up yet"}), 400
    with _login_lock:
        key, error = _check_password(password, 401)
    if error:
        return error
    return _start_session(key)


@app.route("/api/change-password", methods=["POST"])
@require_auth
def change_password_route():
    """Re-encrypts the whole journal under a key derived from the new
    password. Every other session is ended - their keys can't read anything
    now - and this browser gets a fresh one with the new key."""
    body = _json_body()
    new_password = body.get("new_password", "")
    if len(new_password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"New password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400

    with _login_lock:
        # 403, not 401: the page treats 401 as "your session expired".
        old_key, error = _check_password(body.get("current_password", ""), 403)
    if error:
        return error

    with _conn_lock:
        new_key = db.change_password(_conn, old_key, new_password)
        with _sessions_lock:
            _sessions.clear()
    return _start_session(new_key)


# ---------------------------------------------------------------- Login rate limiting
# Per visitor address: a few free wrong guesses, then a wait that doubles
# with each further one, up to a cap. A correct password, or a day without
# failures, starts over. In memory only, like sessions.

LOGIN_FREE_ATTEMPTS = 5
LOGIN_FIRST_LOCKOUT = 30  # seconds, after the free attempts are used up
LOGIN_MAX_LOCKOUT = 15 * 60
LOGIN_FAILURE_MEMORY = 24 * 60 * 60  # forget a visitor's failures after this long

_login_failures = {}  # address -> (failure count, last failure, locked until) on the monotonic clock
# Held for the whole check-verify-record sequence, so parallel requests
# can't all get past the check before any failure is recorded.
_login_lock = threading.Lock()


def _login_wait(client) -> float:
    """Seconds this address must wait before trying again (0 if it can)."""
    entry = _login_failures.get(client)
    return max(0.0, entry[2] - time.monotonic()) if entry else 0.0


def _record_login_failure(client) -> float:
    """Counts a wrong password; returns the lockout it triggers (0 if none)."""
    now = time.monotonic()
    for other, (_, last, _) in list(_login_failures.items()):
        if now - last > LOGIN_FAILURE_MEMORY:
            del _login_failures[other]
    count = _login_failures.get(client, (0, now, now))[0] + 1
    excess = count - LOGIN_FREE_ATTEMPTS
    lockout = 0.0 if excess < 0 else min(LOGIN_FIRST_LOCKOUT * 2 ** excess, LOGIN_MAX_LOCKOUT)
    _login_failures[client] = (count, now, now + lockout)
    return lockout


def _describe_wait(seconds) -> str:
    seconds = int(seconds + 0.999)
    if seconds < 60:
        return f"{seconds} second{'' if seconds == 1 else 's'}"
    minutes = (seconds + 59) // 60
    return f"{minutes} minute{'' if minutes == 1 else 's'}"


@app.route("/logout", methods=["POST"])
def logout_route():
    token = session.pop("sid", None)
    if token is not None:
        with _sessions_lock:
            _sessions.pop(token, None)
    return jsonify({"ok": True})


# ---------------------------------------------------------------- Entries

@app.route("/api/dates")
@require_auth
def dates_route():
    with _conn_lock:
        dates = db.list_entry_dates(_conn)
    return jsonify({"dates": sorted(dates)})


_TAG_RE = re.compile(r"<[^>]+>")
_SPACE_RE = re.compile(r"\s+")
SEARCH_MAX_RESULTS = 200
SNIPPET_CONTEXT = 60  # characters either side of the first match


def _html_to_text(html: str) -> str:
    # Tags become spaces, not nothing, so "<p>end</p><p>start</p>" doesn't
    # turn into "endstart".
    return _SPACE_RE.sub(" ", html_lib.unescape(_TAG_RE.sub(" ", html))).strip()


def _snippet(text: str, at: int, length: int) -> str:
    start = max(0, at - SNIPPET_CONTEXT)
    end = min(len(text), at + length + SNIPPET_CONTEXT)
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


# POST rather than GET ?q=... so search terms never land in access logs or
# proxy logs - they're as private as the entries themselves.
@app.route("/api/search", methods=["POST"])
@require_auth
def search_route():
    """Case-insensitive search across all dated entries. Every word in the
    query must appear somewhere in the entry (in any order). Decrypts the
    whole journal per search, which is fine at one person's scale."""
    body = _json_body()
    terms = [t for t in str(body.get("q", "")).lower().split() if t]
    if not terms:
        return jsonify({"results": [], "truncated": False})

    with _conn_lock:
        entries = db.list_entries(_conn, _key_while_locked())

    results = []
    truncated = False
    for date, html in entries:
        text = _html_to_text(html)
        lowered = text.lower()
        if all(term in lowered for term in terms):
            if len(results) == SEARCH_MAX_RESULTS:
                truncated = True
                break
            first = terms[0]
            results.append({"date": date, "snippet": _snippet(text, lowered.index(first), len(first))})
    return jsonify({"results": results, "truncated": truncated})


def _get_page(page_key):
    with _conn_lock:
        html, version = db.get_entry(_conn, _key_while_locked(), page_key)
    return jsonify({"html": html, "version": version})


def _save_page(page_key):
    """Saves the posted HTML for a day or special page; a blank page is
    deleted outright rather than stored, so it doesn't count as an entry.

    Conflict check: the client sends `base_version`, the version it last
    loaded or saved (null if the page didn't exist). If the page has been
    saved from somewhere else since (another tab or device), nothing is
    written and the response is 409 with the other copy, so the client can
    ask what to keep instead of silently overwriting it. A request with no
    `base_version` at all (e.g. from a tab opened before this existed) skips
    the check."""
    body = _json_body()
    html, images = _extract_inline_images(body.get("html") or "")
    with _conn_lock:
        key = _key_while_locked()
        if "base_version" in body and body["base_version"] != db.get_version(_conn, page_key):
            their_html, their_version = db.get_entry(_conn, key, page_key)
            return jsonify({"error": "conflict", "html": their_html, "version": their_version}), 409
        if html.strip():
            html, copies = _own_copies_of_borrowed_images(page_key, html)
            version = db.save_entry(_conn, key, page_key, html, images, copies)
        else:
            db.delete_entry(_conn, page_key)
            version = None
    # Each <img>'s src as stored, in document order. Inline images and
    # borrowed ones have just been given new ids; the client switches its
    # editor over to them so the next save doesn't upload or copy them all
    # over again.
    return jsonify({"ok": True, "version": version, "image_srcs": _IMG_TAG_SRC_RE.findall(html)})


@app.route("/entries/<date>", methods=["GET"])
@require_auth
def get_entry_route(date):
    return _get_page(date)


@app.route("/entries/<date>", methods=["POST"])
@require_auth
def save_entry_route(date):
    return _save_page(date)


# ---------------------------------------------------------------- Template and Info
# Pages not tied to a date, stored as entries under sentinel keys.

@app.route("/template", methods=["GET"])
@require_auth
def get_template_route():
    return _get_page(db.TEMPLATE_KEY)


@app.route("/template", methods=["POST"])
@require_auth
def save_template_route():
    return _save_page(db.TEMPLATE_KEY)


@app.route("/info", methods=["GET"])
@require_auth
def get_info_route():
    return _get_page(db.INFO_KEY)


@app.route("/info", methods=["POST"])
@require_auth
def save_info_route():
    return _save_page(db.INFO_KEY)


# ---------------------------------------------------------------- Images

@app.route("/images/<image_id>")
@require_auth
def image_route(image_id):
    with _conn_lock:
        raw = db.get_image(_conn, _key_while_locked(), image_id)
    if raw is None:
        abort(404)
    return Response(raw, mimetype=_guess_image_mime(raw))


if __name__ == "__main__":
    # Dev convenience only - use gunicorn (see module docstring) in production.
    # Debug mode serves Werkzeug's interactive debugger, which can run any
    # code, so it only listens on this machine - never the LAN.
    app.run(host="127.0.0.1", port=8420, debug=True)
