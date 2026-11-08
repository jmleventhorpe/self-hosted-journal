"""Cross-site request protection, request bodies and response headers."""

import pytest

from conftest import PASSWORD

DAY = "/entries/2026-11-08"


@pytest.fixture
def entry(client):
    client.post(DAY, json={"html": "<p>keep me</p>"})
    return client


def attempt(client, **kwargs):
    r = client.post(DAY, **kwargs)
    return r.status_code, client.get(DAY).get_json()["html"]


@pytest.mark.parametrize("headers", [
    {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"},  # a sibling subdomain
    {"Sec-Fetch-Site": "none"},
])
def test_other_origins_cannot_change_anything(entry, headers):
    assert attempt(entry, json={"html": ""}, headers=headers) == (403, "<p>keep me</p>")


def test_old_browser_with_foreign_origin_is_refused(entry):
    # No Sec-Fetch-Site (pre-2023 Safari) - falls back to Origin.
    entry.environ_base.pop("HTTP_SEC_FETCH_SITE")
    assert attempt(entry, json={"html": ""}, headers={"Origin": "https://evil.example"}) == (403, "<p>keep me</p>")
    assert attempt(entry, json={"html": "<p>ok</p>"}, headers={"Origin": "http://localhost"}) == (200, "<p>ok</p>")


def test_non_browser_clients_are_allowed(entry):
    entry.environ_base.pop("HTTP_SEC_FETCH_SITE")
    assert attempt(entry, json={"html": "<p>from curl</p>"}) == (200, "<p>from curl</p>")


def test_form_style_body_is_refused_not_read_as_empty(entry):
    # Read as empty, this would have deleted the entry.
    status, html = attempt(entry, data='{"html": ""}', content_type="text/plain")
    assert (status, html) == (415, "<p>keep me</p>")


def test_cross_site_logout_is_refused(entry):
    assert entry.post("/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert entry.get(DAY).status_code == 200


def test_session_cookie_flags(new_client):
    r = new_client().post("/api/setup", json={"password": PASSWORD})
    cookie = r.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie


@pytest.mark.parametrize("path,cache_control", [
    ("/", "no-store"),
    (DAY, "no-store"),
    ("/api/dates", "no-store"),
    ("/static/js/main.js", None),  # Flask's default: cacheable, revalidated
])
def test_journal_data_is_not_cached(entry, path, cache_control):
    header = entry.get(path).headers.get("Cache-Control")
    if cache_control:
        assert header == cache_control
    else:
        assert header != "no-store"


def test_page_loads_no_third_party_code(entry):
    page = entry.get("/").get_data(as_text=True)
    assert "https://" not in page


@pytest.mark.parametrize("path", ["/", DAY, "/static/js/main.js"])
def test_security_headers_on_every_response(entry, path):
    headers = entry.get(path).headers
    csp = headers["Content-Security-Policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["Referrer-Policy"] == "no-referrer"


@pytest.mark.parametrize("logged_in", [False, True])
def test_pages_have_no_inline_script(new_client, logged_in):
    # The CSP would block it, breaking the page.
    import re
    c = new_client()
    if logged_in:
        c.post("/api/setup", json={"password": PASSWORD})
    page = c.get("/").get_data(as_text=True)
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", page)
    assert not re.search(r"\son[a-z]+=", page)  # onclick= etc. are inline script too
