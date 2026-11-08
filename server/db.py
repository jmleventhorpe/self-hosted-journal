"""
SQLite storage for Journal, owned exclusively by the Flask server (app.py).
Nothing else touches journal.db directly.

One row per day in `entries` (encrypted rich-text HTML as a blob).
Images embedded in an entry are extracted and stored encrypted in
`images`, keyed by a random id that the entry's HTML references via
<img src="id">. Everything at rest is ciphertext - the password
itself is never stored, only a salt and a verifier token.
"""

import re
import secrets
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
IMG_SRC_RE = re.compile(r'src="([^"]+)"')  # image ids referenced by an entry's HTML

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    date TEXT PRIMARY KEY,      -- 'YYYY-MM-DD'
    content BLOB NOT NULL,      -- encrypted HTML
    updated_at TEXT NOT NULL,
    version TEXT                -- random token, new on every save; see save_entry
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
    # different threads (gunicorn --threads, or the dev server). Safe because
    # every caller of this connection serializes access with a lock
    # (see _conn_lock in app.py) - sqlite3 itself just can't know that.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()
    return conn


def _migrate(conn: sqlite3.Connection):
    """Brings journals created by older versions up to the current schema."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(entries)")}
    if "version" not in columns:
        conn.execute("ALTER TABLE entries ADD COLUMN version TEXT")
    # Entries saved before versions existed get one now, so every stored
    # entry can be checked for conflicting edits the same way.
    conn.execute("UPDATE entries SET version = lower(hex(randomblob(16))) WHERE version IS NULL")


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


def change_password(conn: sqlite3.Connection, old_key: bytes, new_password: str) -> bytes:
    """Re-encrypts every entry and image under a key derived from
    `new_password` (with a fresh salt) and replaces the verifier. All in one
    transaction: if anything fails partway, the rollback leaves the journal
    exactly as it was, still on the old password. Returns the new key."""
    salt = generate_salt()
    new_key = derive_key(new_password, salt)
    try:
        # One row at a time, so a journal full of photos isn't all held in
        # memory at once.
        for (date,) in conn.execute("SELECT date FROM entries").fetchall():
            (content,) = conn.execute("SELECT content FROM entries WHERE date = ?", (date,)).fetchone()
            conn.execute(
                "UPDATE entries SET content = ? WHERE date = ?",
                (encrypt_bytes(new_key, decrypt_bytes(old_key, bytes(content))), date),
            )
        for (img_id,) in conn.execute("SELECT id FROM images").fetchall():
            (data,) = conn.execute("SELECT data FROM images WHERE id = ?", (img_id,)).fetchone()
            conn.execute(
                "UPDATE images SET data = ? WHERE id = ?",
                (encrypt_bytes(new_key, decrypt_bytes(old_key, bytes(data))), img_id),
            )
        conn.execute("UPDATE meta SET value = ? WHERE key = 'salt'", (salt,))
        conn.execute("UPDATE meta SET value = ? WHERE key = 'verifier'", (make_verifier(new_key),))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return new_key


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
    """Returns (decrypted HTML, version), or (None, None) if no entry exists.
    Images aren't included - they're fetched one by one via get_image."""
    row = conn.execute("SELECT content, version FROM entries WHERE date = ?", (date,)).fetchone()
    if row is None:
        return None, None
    return decrypt_text(key, bytes(row[0])), row[1]


def get_version(conn: sqlite3.Connection, date: str):
    """The entry's current version token, or None if no entry exists."""
    row = conn.execute("SELECT version FROM entries WHERE date = ?", (date,)).fetchone()
    return None if row is None else row[0]


def image_owners(conn: sqlite3.Connection, image_ids) -> dict:
    """{image_id: entry_date} for whichever of `image_ids` are stored."""
    image_ids = list(image_ids)
    if not image_ids:
        return {}
    placeholders = ",".join("?" * len(image_ids))
    rows = conn.execute(
        f"SELECT id, entry_date FROM images WHERE id IN ({placeholders})", image_ids
    ).fetchall()
    return dict(rows)


def save_entry(conn: sqlite3.Connection, key: bytes, date: str, html_text: str, images: dict,
               copies: dict = None):
    """
    Saves (or overwrites) the entry for `date`. `images` is
    {image_id: raw_bytes} for new or changed images. Previously stored
    images for this date are kept as long as the HTML still references
    them - the web client only ever sends new images, referring to
    already-stored ones by id alone - and removed otherwise (e.g. the
    user deleted an image).

    `copies` is {new_id: existing_id} for images this entry should get its
    own copy of (e.g. ones brought in by importing the template), so it
    doesn't depend on another page keeping them. The stored ciphertext is
    copied as-is - every image is encrypted under the same key.

    Returns the entry's new version token. It's random rather than a
    counter so a stale copy can never match by coincidence - e.g. after the
    entry is deleted and written again from scratch elsewhere.
    """
    import datetime

    encrypted_content = encrypt_text(key, html_text)
    now = datetime.datetime.now().isoformat(timespec="seconds")
    version = secrets.token_hex(16)

    conn.execute(
        """INSERT INTO entries (date, content, updated_at, version) VALUES (?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET content=excluded.content,
               updated_at=excluded.updated_at, version=excluded.version""",
        (date, encrypted_content, now, version),
    )

    referenced_ids = set(IMG_SRC_RE.findall(html_text))
    for (img_id,) in conn.execute(
        "SELECT id FROM images WHERE entry_date = ?", (date,)
    ).fetchall():
        if img_id in images or img_id not in referenced_ids:
            conn.execute("DELETE FROM images WHERE id = ?", (img_id,))
    for new_id, source_id in (copies or {}).items():
        conn.execute(
            "INSERT INTO images (id, entry_date, data) SELECT ?, ?, data FROM images WHERE id = ?",
            (new_id, date, source_id),
        )
    for img_id, raw_bytes in images.items():
        encrypted_data = encrypt_bytes(key, raw_bytes)
        conn.execute(
            "INSERT INTO images (id, entry_date, data) VALUES (?, ?, ?)",
            (img_id, date, encrypted_data),
        )
    conn.commit()
    return version


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
