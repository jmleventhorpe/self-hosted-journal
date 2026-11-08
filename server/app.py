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
        )
    with _conn_lock:
        initialized = db.is_initialized(_conn)
    return render_template("login.html", initialized=initialized)


# ---------------------------------------------------------------- Auth

@app.route("/api/setup", methods=["POST"])
def setup_route():
    body = request.get_json(force=True, silent=True) or {}
    password = body.get("password", "")
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400

    with _conn_lock:
        if db.is_initialized(_conn):
            return jsonify({"error": "Journal is already set up"}), 400
        key = db.setup_password(_conn, password)

    return _start_session(key)


@app.route("/login", methods=["POST"])
def login_route():
    body = request.get_json(force=True, silent=True) or {}
    password = body.get("password", "")

    with _conn_lock:
        if not db.is_initialized(_conn):
            return jsonify({"error": "Journal not set up yet"}), 400
        key = db.unlock(_conn, password)

    if key is None:
        return jsonify({"error": "Incorrect password"}), 401

    return _start_session(key)


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
    key = _current_key()
    body = request.get_json(force=True, silent=True) or {}
    terms = [t for t in str(body.get("q", "")).lower().split() if t]
    if not terms:
        return jsonify({"results": [], "truncated": False})

    with _conn_lock:
        entries = db.list_entries(_conn, key)

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
    key = _current_key()
    with _conn_lock:
        html, version = db.get_entry(_conn, key, page_key)
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
    key = _current_key()
    body = request.get_json(force=True, silent=True) or {}
    html, images = _extract_inline_images(body.get("html") or "")
    with _conn_lock:
        if "base_version" in body and body["base_version"] != db.get_version(_conn, page_key):
            their_html, their_version = db.get_entry(_conn, key, page_key)
            return jsonify({"error": "conflict", "html": their_html, "version": their_version}), 409
        if html.strip():
            version = db.save_entry(_conn, key, page_key, html, images)
        else:
            db.delete_entry(_conn, page_key)
            version = None
    return jsonify({"ok": True, "version": version})


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
    key = _current_key()
    with _conn_lock:
        raw = db.get_image(_conn, key, image_id)
    if raw is None:
        abort(404)
    return Response(raw, mimetype=_guess_image_mime(raw))


if __name__ == "__main__":
    # Dev convenience only - use gunicorn (see module docstring) in production.
    app.run(host="0.0.0.0", port=8420, debug=True)
