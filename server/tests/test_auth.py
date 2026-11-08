"""Setup, login, sessions, rate limiting, password changes and key strength."""

import pytest

import app as app_module
import crypto
import db
from conftest import PASSWORD, PNG_1PX, save

DAY = "/entries/2026-11-08"


def login(client, password=PASSWORD):
    return client.post("/login", json={"password": password})


# ---------------------------------------------------------------- Setup and login

def test_setup_requires_minimum_length(new_client):
    c = new_client()
    assert c.post("/api/setup", json={"password": "a" * 11}).status_code == 400
    assert c.post("/api/setup", json={"password": "a" * 12}).status_code == 200


def test_setup_only_once(client, new_client):
    assert new_client().post("/api/setup", json={"password": "another-password"}).status_code == 400


def test_login_right_and_wrong(client, new_client):
    assert login(new_client()).status_code == 200
    assert login(new_client(), "wrong-password").status_code == 401


def test_existing_short_password_still_unlocks(new_client, monkeypatch):
    # Journals created before the 12-character minimum keep working.
    db.setup_password(app_module._conn, "abcd")
    assert login(new_client(), "abcd").status_code == 200


def test_requests_need_a_session(new_client):
    c = new_client()
    assert c.get(DAY).status_code == 401
    assert save(c, DAY, "<p>x</p>").status_code == 401


def test_logout_ends_the_session(client):
    client.post("/logout")
    assert client.get(DAY).status_code == 401


# ---------------------------------------------------------------- Session lifetime

def test_session_is_a_hard_two_hours(new_client, clock):
    c = new_client()
    c.post("/api/setup", json={"password": PASSWORD})
    clock.advance(60 * 60)
    assert c.get(DAY).status_code == 200  # activity doesn't extend it...
    clock.advance(60 * 60 + 1)
    assert c.get(DAY).status_code == 401  # ...it ends 2 hours after login
    assert not app_module._sessions  # and the key is gone from memory


def test_page_is_told_how_long_the_session_has_left(clock, client):  # clock first, so login uses it
    clock.advance(30 * 60)
    page = client.get("/").get_data(as_text=True)
    assert 'data-session-expires-in="5400"' in page


# ---------------------------------------------------------------- Rate limiting

def test_five_free_attempts_then_lockout(client, new_client, clock):
    c = new_client()
    for _ in range(4):
        r = login(c, "wrong-password")
        assert r.status_code == 401 and "wait" not in r.get_json()["error"]
    r = login(c, "wrong-password")
    assert r.status_code == 401 and "30 seconds" in r.get_json()["error"]

    locked = login(c)  # even the right password
    assert locked.status_code == 429 and locked.headers["Retry-After"] == "30"

    clock.advance(31)
    assert login(c).status_code == 200


def test_lockout_doubles_up_to_fifteen_minutes(client, new_client, clock):
    c = new_client()
    waits = []
    for _ in range(12):
        login(c, "wrong-password")
        _, _, locked_until = app_module._login_failures["127.0.0.1"]
        waits.append(round(locked_until - clock.now))
        clock.advance(16 * 60)
    assert waits == [0, 0, 0, 0, 30, 60, 120, 240, 480, 900, 900, 900]


def test_success_resets_the_count(client, new_client, clock):
    c = new_client()
    for _ in range(4):
        login(c, "wrong-password")
    assert login(c).status_code == 200
    assert "wait" not in login(c, "wrong-password").get_json()["error"]


def test_locked_out_attempt_skips_the_password_check(client, new_client, clock, monkeypatch):
    c = new_client()
    for _ in range(5):
        login(c, "wrong-password")
    monkeypatch.setattr(db, "unlock", lambda *a: pytest.fail("password was checked while locked out"))
    assert login(c).status_code == 429


# ---------------------------------------------------------------- Change password

def change(client, current, new):
    return client.post("/api/change-password", json={"current_password": current, "new_password": new})


def test_change_password(client, new_client):
    save(client, DAY, f'<p>entry</p><p><img src="data:image/png;base64,{PNG_1PX}"></p>')
    other_device = new_client()
    login(other_device)

    assert change(client, PASSWORD, "brand-new-password").status_code == 200

    assert client.get(DAY).get_json()["html"].startswith("<p>entry</p>")  # still logged in
    (image_id,) = db.IMG_SRC_RE.findall(client.get(DAY).get_json()["html"])
    assert client.get(f"/images/{image_id}").status_code == 200
    assert other_device.get(DAY).status_code == 401  # logged out
    assert login(new_client()).status_code == 401
    assert login(new_client(), "brand-new-password").status_code == 200


def test_change_password_wrong_current_is_403_not_401(client):
    # 401 would make the page think the session had expired.
    assert change(client, "wrong-password", "brand-new-password").status_code == 403


def test_change_password_requires_minimum_length(client):
    assert change(client, PASSWORD, "short").status_code == 400


def test_failed_change_leaves_journal_untouched(client, new_client, monkeypatch):
    save(client, "/entries/2026-01-01", "<p>one</p>")
    save(client, "/entries/2026-01-02", "<p>two</p>")
    real_encrypt = db.encrypt_bytes
    calls = []

    def fail_on_second(key, data):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("simulated failure")
        return real_encrypt(key, data)

    monkeypatch.setattr(db, "encrypt_bytes", fail_on_second)
    app_module.app.config["PROPAGATE_EXCEPTIONS"] = False
    try:
        assert change(client, PASSWORD, "brand-new-password").status_code == 500
    finally:
        app_module.app.config["PROPAGATE_EXCEPTIONS"] = None
    monkeypatch.setattr(db, "encrypt_bytes", real_encrypt)

    fresh = new_client()
    assert login(fresh).status_code == 200
    assert fresh.get("/entries/2026-01-02").get_json()["html"] == "<p>two</p>"


# ---------------------------------------------------------------- Key strength

def test_real_settings_are_strong():
    assert crypto.KDF_PARAMS == {"n": 2**17, "r": 8, "p": 1}


def test_new_journal_records_its_settings(client):
    assert db._kdf_params(app_module._conn) == db.KDF_PARAMS
    assert not db.kdf_needs_upgrade(app_module._conn)


def test_weaker_journal_is_rekeyed_on_login(new_client, monkeypatch):
    # A journal from before settings were recorded: legacy n=2**14, no 'kdf' row.
    monkeypatch.setattr(db, "KDF_PARAMS", crypto.LEGACY_KDF_PARAMS)
    c = new_client()
    c.post("/api/setup", json={"password": PASSWORD})
    save(c, DAY, "<p>old journal</p>")
    app_module._conn.execute("DELETE FROM meta WHERE key = 'kdf'")
    app_module._conn.commit()
    monkeypatch.setattr(db, "KDF_PARAMS", {"n": 2**11, "r": 8, "p": 1})  # "current" settings
    assert db.kdf_needs_upgrade(app_module._conn)

    fresh = new_client()
    assert login(fresh).status_code == 200
    assert db._kdf_params(app_module._conn) == {"n": 2**11, "r": 8, "p": 1}
    assert fresh.get(DAY).get_json()["html"] == "<p>old journal</p>"
    assert c.get(DAY).status_code == 401  # sessions with the old key were ended
