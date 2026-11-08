"""Saving and loading pages, images, conflicts and search."""

import base64

import app as app_module
import db
from conftest import PNG_1PX, save

DAY = "/entries/2026-11-08"
INLINE_IMG = f'<p><img src="data:image/png;base64,{PNG_1PX}" width="40" height="40"></p>'


def image_ids(html):
    return db.IMG_SRC_RE.findall(html or "")


# ---------------------------------------------------------------- Basics

def test_save_and_load_roundtrip(client):
    save(client, DAY, "<p>Hello</p>")
    assert client.get(DAY).get_json()["html"] == "<p>Hello</p>"
    assert client.get("/api/dates").get_json()["dates"] == ["2026-11-08"]


def test_missing_page_loads_as_empty(client):
    assert client.get(DAY).get_json() == {"html": None, "version": None}


def test_saving_blank_deletes_the_entry(client):
    save(client, DAY, "<p>Hello</p>")
    save(client, DAY, "")
    assert client.get(DAY).get_json()["html"] is None
    assert client.get("/api/dates").get_json()["dates"] == []


def test_template_and_info_are_not_dated_entries(client):
    save(client, "/template", "<p>T</p>")
    save(client, "/info", "<p>I</p>")
    assert client.get("/template").get_json()["html"] == "<p>T</p>"
    assert client.get("/info").get_json()["html"] == "<p>I</p>"
    assert client.get("/api/dates").get_json()["dates"] == []


def test_entries_are_encrypted_at_rest(client):
    save(client, DAY, "<p>my secret thoughts</p>")
    (content,) = app_module._conn.execute("SELECT content FROM entries").fetchone()
    assert b"secret" not in bytes(content)


# ---------------------------------------------------------------- Images

def test_inline_image_is_extracted_and_served(client):
    r = save(client, DAY, "<p>pic</p>" + INLINE_IMG)
    (image_id,) = image_ids(client.get(DAY).get_json()["html"])
    assert r.get_json()["image_srcs"] == [image_id]
    img = client.get(f"/images/{image_id}")
    assert img.status_code == 200 and img.mimetype == "image/png"


def test_image_survives_edits_that_reference_it_by_id(client):
    save(client, DAY, INLINE_IMG)
    html = client.get(DAY).get_json()["html"]
    (image_id,) = image_ids(html)
    save(client, DAY, html + "<p>more text</p>")
    assert client.get(f"/images/{image_id}").status_code == 200


def test_image_is_deleted_when_removed_from_the_entry(client):
    save(client, DAY, INLINE_IMG)
    (image_id,) = image_ids(client.get(DAY).get_json()["html"])
    save(client, DAY, "<p>no picture now</p>")
    assert client.get(f"/images/{image_id}").status_code == 404


def test_imported_template_image_becomes_the_entrys_own_copy(client):
    save(client, "/template", "<p>T</p>" + INLINE_IMG)
    (template_image,) = image_ids(client.get("/template").get_json()["html"])

    r = save(client, DAY, f'<p>T</p><p><img src="{template_image}"></p>')
    (entry_image,) = r.get_json()["image_srcs"]
    assert entry_image != template_image

    save(client, "/template", "<p>template without its image</p>")
    assert client.get(f"/images/{template_image}").status_code == 404
    assert client.get(f"/images/{entry_image}").status_code == 200


def test_webp_is_served_with_its_type(client):
    # Smallest valid-looking WebP header is enough for type detection.
    webp = base64.b64encode(b"RIFF\x1a\x00\x00\x00WEBPVP8L" + b"\x00" * 14).decode()
    save(client, DAY, f'<p><img src="data:image/webp;base64,{webp}"></p>')
    (image_id,) = image_ids(client.get(DAY).get_json()["html"])
    assert client.get(f"/images/{image_id}").mimetype == "image/webp"


# ---------------------------------------------------------------- Conflicts

def test_save_based_on_current_version_succeeds(client):
    v1 = save(client, DAY, "<p>one</p>", base_version=None).get_json()["version"]
    r = save(client, DAY, "<p>two</p>", base_version=v1)
    assert r.status_code == 200 and r.get_json()["version"] != v1


def test_stale_save_is_refused_with_the_other_copy(client):
    v1 = save(client, DAY, "<p>one</p>", base_version=None).get_json()["version"]
    save(client, DAY, "<p>from the phone</p>", base_version=v1)
    r = save(client, DAY, "<p>from the laptop</p>", base_version=v1)
    assert r.status_code == 409
    assert r.get_json()["html"] == "<p>from the phone</p>"
    assert client.get(DAY).get_json()["html"] == "<p>from the phone</p>"


def test_save_of_a_page_deleted_elsewhere_conflicts(client):
    v1 = save(client, DAY, "<p>one</p>", base_version=None).get_json()["version"]
    save(client, DAY, "", base_version=v1)
    r = save(client, DAY, "<p>still editing</p>", base_version=v1)
    assert r.status_code == 409 and r.get_json()["html"] is None


def test_save_without_base_version_skips_the_check(client):
    save(client, DAY, "<p>one</p>")
    assert save(client, DAY, "<p>two</p>").status_code == 200


def test_old_journal_gets_version_column(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        "CREATE TABLE entries (date TEXT PRIMARY KEY, content BLOB NOT NULL, updated_at TEXT NOT NULL);"
        "INSERT INTO entries VALUES ('2026-01-01', x'00', '2026-01-01T00:00:00');"
    )
    old.commit()
    old.close()
    conn = db.connect(str(path))
    (version,) = conn.execute("SELECT version FROM entries").fetchone()
    assert version and len(version) == 32


# ---------------------------------------------------------------- Search

def test_search_matches_all_words_newest_first(client):
    save(client, "/entries/2026-01-01", "<p>River walk with Sam</p>")
    save(client, "/entries/2026-02-01", "<p>Rainy day by the <b>river</b></p>")
    save(client, "/entries/2026-03-01", "<p>Nothing relevant</p>")
    save(client, "/template", "<p>river template</p>")

    results = client.post("/api/search", json={"q": "river"}).get_json()["results"]
    assert [r["date"] for r in results] == ["2026-02-01", "2026-01-01"]
    assert "<b>" not in results[0]["snippet"]

    both = client.post("/api/search", json={"q": "RIVER sam"}).get_json()["results"]
    assert [r["date"] for r in both] == ["2026-01-01"]


def test_search_unescapes_html_entities(client):
    save(client, DAY, "<p>Dinner with Sam &amp; Alex</p>")
    (result,) = client.post("/api/search", json={"q": "sam & alex"}).get_json()["results"]
    assert "Sam & Alex" in result["snippet"]
