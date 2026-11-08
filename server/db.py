"""
SQLite storage for Journal, owned exclusively by the Flask server (app.py).
Nothing else touches journal.db directly - the desktop app talks to this
over HTTP via the client db.py at the repo root.

One row per day in `entries` (encrypted rich-text HTML as a blob).
Images embedded in an entry are extracted and stored encrypted in
`images`, keyed by a random id that the entry's HTML references via
<img src="id">. Everything at rest is ciphertext - the password
itself is never stored, only a salt and a verifier token.
"""

import re
import sqlite3
from crypto import (
    generate_salt,
    derive_key,
    make_verifier,
    check_verifier,
    encrypt_text,
    decrypt_text,
    encrypt_bytes,
    decrypt_bytes,
)

TEMPLATE_KEY = "__template__"  # sentinel "date" in entries, never a real calendar day
INFO_KEY = "__info__"  # sentinel "date" for the free-form reference/notes page
IMG_SRC_RE = re.compile(r'src="([^"]+)"')  # same pattern as the desktop app's window.py

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    date TEXT PRIMARY KEY,      -- 'YYYY-MM-DD'
    content BLOB NOT NULL,      -- encrypted HTML
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,        -- resource name referenced in the entry's HTML
    entry_date TEXT NOT NULL,
    data BLOB NOT NULL,         -- encrypted image bytes
    FOREIGN KEY(entry_date) REFERENCES entries(date)
);
"""


def connect(path: str) -> sqlite3.Connection:
    # check_same_thread=False: the Flask server handles requests on
    # different threads (gunicorn --threads, or the dev server), unlike
    # the desktop app this function originally served. Safe here because
    # every caller of this connection serializes access with a lock
    # (see _conn_lock in app.py) - sqlite3 itself just can't know that.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def is_initialized(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT value FROM meta WHERE key = 'salt'").fetchone()
    return row is not None


def setup_password(conn: sqlite3.Connection, password: str) -> bytes:
    """First-run only: create the salt + verifier for a new journal."""
    salt = generate_salt()
    key = derive_key(password, salt)
    verifier = make_verifier(key)
    conn.execute("INSERT INTO meta (key, value) VALUES ('salt', ?)", (salt,))
    conn.execute("INSERT INTO meta (key, value) VALUES ('verifier', ?)", (verifier,))
    conn.commit()
    return key


def unlock(conn: sqlite3.Connection, password: str):
    """Returns the derived key if the password is correct, else None."""
    salt = conn.execute("SELECT value FROM meta WHERE key = 'salt'").fetchone()[0]
    verifier = conn.execute("SELECT value FROM meta WHERE key = 'verifier'").fetchone()[0]
    key = derive_key(password, bytes(salt))
    if check_verifier(key, bytes(verifier)):
        return key
    return None


def list_entry_dates(conn: sqlite3.Connection) -> set:
    rows = conn.execute(
        "SELECT date FROM entries WHERE date NOT IN (?, ?)", (TEMPLATE_KEY, INFO_KEY)
    ).fetchall()
    return {r[0] for r in rows}


def list_entries(conn: sqlite3.Connection, key: bytes) -> list:
    """Every dated entry as (date, html_text), newest first - text only,
    images aren't decrypted. Used for search."""
    rows = conn.execute(
        "SELECT date, content FROM entries WHERE date NOT IN (?, ?) ORDER BY date DESC",
        (TEMPLATE_KEY, INFO_KEY),
    ).fetchall()
    return [(date, decrypt_text(key, bytes(content))) for date, content in rows]


def get_entry(conn: sqlite3.Connection, key: bytes, date: str):
    """Returns (html_text, {image_id: raw_bytes}) or (None, {}) if no entry exists."""
    row = conn.execute("SELECT content FROM entries WHERE date = ?", (date,)).fetchone()
    if row is None:
        return None, {}
    html = decrypt_text(key, bytes(row[0]))

    images = {}
    for img_id, data in conn.execute(
        "SELECT id, data FROM images WHERE entry_date = ?", (date,)
    ).fetchall():
        images[img_id] = decrypt_bytes(key, bytes(data))
    return html, images


def save_entry(conn: sqlite3.Connection, key: bytes, date: str, html_text: str, images: dict):
    """
    Saves (or overwrites) the entry for `date`. `images` is
    {image_id: raw_bytes} for new or changed images. Previously stored
    images for this date are kept as long as the HTML still references
    them - the web client only ever sends new images, referring to
    already-stored ones by id alone - and removed otherwise (e.g. the
    user deleted an image).
    """
    import datetime

    encrypted_content = encrypt_text(key, html_text)
    now = datetime.datetime.now().isoformat(timespec="seconds")

    conn.execute(
        """INSERT INTO entries (date, content, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at""",
        (date, encrypted_content, now),
    )

    referenced_ids = set(IMG_SRC_RE.findall(html_text))
    for (img_id,) in conn.execute(
        "SELECT id FROM images WHERE entry_date = ?", (date,)
    ).fetchall():
        if img_id in images or img_id not in referenced_ids:
            conn.execute("DELETE FROM images WHERE id = ?", (img_id,))
    for img_id, raw_bytes in images.items():
        encrypted_data = encrypt_bytes(key, raw_bytes)
        conn.execute(
            "INSERT INTO images (id, entry_date, data) VALUES (?, ?, ?)",
            (img_id, date, encrypted_data),
        )
    conn.commit()


def delete_entry(conn: sqlite3.Connection, date: str):
    conn.execute("DELETE FROM images WHERE entry_date = ?", (date,))
    conn.execute("DELETE FROM entries WHERE date = ?", (date,))
    conn.commit()


def get_image(conn: sqlite3.Connection, key: bytes, image_id: str):
    """Fetches a single image by id, independent of which entry it belongs
    to (id is globally unique). Used to serve <img src="id"> requests from
    the web client. Returns raw bytes, or None if no such image exists."""
    row = conn.execute("SELECT data FROM images WHERE id = ?", (image_id,)).fetchone()
    if row is None:
        return None
    return decrypt_bytes(key, bytes(row[0]))


def get_template(conn: sqlite3.Connection, key: bytes):
    """Returns (html_text, {image_id: raw_bytes}) or (None, {}) if no template is saved."""
    return get_entry(conn, key, TEMPLATE_KEY)


def save_template(conn: sqlite3.Connection, key: bytes, html_text: str, images: dict):
    if html_text.strip() or images:
        save_entry(conn, key, TEMPLATE_KEY, html_text, images)
    else:
        delete_entry(conn, TEMPLATE_KEY)


def get_info(conn: sqlite3.Connection, key: bytes):
    """Returns (html_text, {image_id: raw_bytes}) or (None, {}) if no info page is saved."""
    return get_entry(conn, key, INFO_KEY)


def save_info(conn: sqlite3.Connection, key: bytes, html_text: str, images: dict):
    if html_text.strip() or images:
        save_entry(conn, key, INFO_KEY, html_text, images)
    else:
        delete_entry(conn, INFO_KEY)
