"""Shared fixtures. Every test gets an empty journal of its own.

app.py opens journal.db when it's imported, so JOURNAL_DATA_DIR has to point
somewhere disposable before that import - never at a real journal.
"""

import os
import sys
import tempfile
from pathlib import Path

os.environ["JOURNAL_DATA_DIR"] = tempfile.mkdtemp(prefix="journal-tests-")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import app as app_module  # noqa: E402
import db  # noqa: E402

PASSWORD = "correct-horse-battery"
# Full-strength scrypt takes ~0.3s per derivation, which adds up over a suite
# full of logins. test_kdf.py checks the real settings separately.
FAST_KDF = {"n": 2**10, "r": 8, "p": 1}
SAME_ORIGIN = {"HTTP_SEC_FETCH_SITE": "same-origin"}
PNG_1PX = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def fresh_journal(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "KDF_PARAMS", FAST_KDF)
    monkeypatch.setattr(app_module, "_conn", db.connect(str(tmp_path / "journal.db")))
    app_module._sessions.clear()
    app_module._login_failures.clear()
    yield
    app_module._conn.close()


@pytest.fixture
def new_client():
    """Makes a browser-like client: its requests are marked same-origin, as
    the journal's own pages' requests are."""
    def make():
        c = app_module.app.test_client()
        c.environ_base.update(SAME_ORIGIN)
        return c
    return make


@pytest.fixture
def client(new_client):
    """A client logged in to a newly set-up journal."""
    c = new_client()
    assert c.post("/api/setup", json={"password": PASSWORD}).status_code == 200
    return c


@pytest.fixture
def clock(monkeypatch):
    """Controls the monotonic clock behind session expiry and rate limiting.
    Advance it with clock.advance(seconds)."""
    class Clock:
        now = 1_000_000.0

        def advance(self, seconds):
            self.now += seconds

    c = Clock()
    monkeypatch.setattr(app_module.time, "monotonic", lambda: c.now)
    return c


def save(client, path, html, **extra):
    return client.post(path, json={"html": html, **extra})

