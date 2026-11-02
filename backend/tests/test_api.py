from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    (tmp_path / "BOXES").mkdir()
    (tmp_path / "BOXES" / "b.stl").write_bytes(b"solid")
    (tmp_path / "BOXES" / "notes.txt").write_text("x")
    (tmp_path / "a10.stl").write_bytes(b"solid")
    (tmp_path / "a2.stl").write_bytes(b"solid")
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path.parent / (tmp_path.name + "_docs")).resolve())
    return TestClient(main.app)


def test_list_sorts_dirs_first_natural_and_hides_non_stl(client):
    names = [entry["name"] for entry in client.get("/api/list").json()]
    assert names == ["BOXES", "a2.stl", "a10.stl"]
    assert [e["name"] for e in client.get("/api/list", params={"path": "BOXES"}).json()] == ["b.stl"]


def test_file_served(client):
    assert client.get("/api/file", params={"path": "BOXES/b.stl"}).content == b"solid"


@pytest.mark.parametrize("path", ["../x.stl", "../../etc/passwd", "/etc/passwd"])
def test_path_escape_is_forbidden(client, path):
    assert client.get("/api/file", params={"path": path}).status_code in (403, 400)
    assert client.get("/api/list", params={"path": path}).status_code == 403


def test_non_stl_rejected(client):
    assert client.get("/api/file", params={"path": "BOXES/notes.txt"}).status_code == 400


def test_list_has_modified(client):
    assert all(entry["modified"] > 0 for entry in client.get("/api/list").json())


def test_search_returns_matches_and_ancestors(client, tmp_path):
    (tmp_path / "BOXES" / "deep").mkdir()
    (tmp_path / "BOXES" / "deep" / "Cover 11x5.stl").write_bytes(b"solid")
    results = {e["path"]: e for e in client.get("/api/search", params={"q": "COVER"}).json()}
    assert results["BOXES/deep/Cover 11x5.stl"]["match"] is True
    assert results["BOXES/deep"]["match"] is False
    assert results["BOXES"]["match"] is False
    assert client.get("/api/search", params={"q": "  "}).json() == []


def test_runtime_restart_schedules_exec_without_executing(client, monkeypatch):
    scheduled = []
    monkeypatch.setattr(main, "schedule_runtime_restart", scheduled.append)
    body = client.post("/api/runtime/restart", json={"reason": "t", "delay_ms": 50}).json()
    assert body["ok"] and body["reason"] == "t" and body["delay_ms"] == 100  # clamped to 100..5000
    assert scheduled == [100]


def sample_item(name="cover"):
    return {"id": "a1", "path": "BOXES/b.stl", "name": name, "color": 7317724, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}


def test_document_crud_roundtrip(client):
    assert client.get("/api/documents").json() == []
    created = client.post("/api/documents", json={"name": "My Box!", "items": [sample_item()]})
    assert created.status_code == 201
    document = created.json()
    assert document["id"].startswith("my-box-") and document["items"][0]["name"] == "cover"

    listed = client.get("/api/documents").json()
    assert [(d["id"], d["name"], d["itemCount"]) for d in listed] == [(document["id"], "My Box!", 1)]

    updated = client.put(f"/api/documents/{document['id']}", json={"name": "Renamed", "items": []})
    assert updated.status_code == 200 and updated.json()["name"] == "Renamed" and updated.json()["items"] == []
    assert client.get(f"/api/documents/{document['id']}").json()["name"] == "Renamed"

    assert client.delete(f"/api/documents/{document['id']}").status_code == 204
    assert client.get(f"/api/documents/{document['id']}").status_code == 404
    assert client.delete(f"/api/documents/{document['id']}").status_code == 404


def test_document_create_defaults_and_validation(client):
    assert client.post("/api/documents").json()["name"] == "Untitled"
    bad = sample_item()
    bad["position"] = [0, 0]
    assert client.post("/api/documents", json={"name": "x", "items": [bad]}).status_code == 422
    assert client.put("/api/documents/nope", json={"name": "x", "items": []}).status_code == 404


@pytest.mark.parametrize("documentId", ["../x", "..%2Fx", "A B", ".hidden"])
def test_document_id_cannot_escape(client, documentId):
    assert client.get(f"/api/documents/{documentId}").status_code == 404
    assert client.delete(f"/api/documents/{documentId}").status_code in (404, 405)


def test_document_item_muted_roundtrip(client):
    item = {**sample_item(), "muted": True}
    created = client.post("/api/documents", json={"name": "m", "items": [item, sample_item("plain")]}).json()
    assert [i["muted"] for i in created["items"]] == [True, False]  # missing field defaults to not muted
    fetched = client.get(f"/api/documents/{created['id']}").json()
    assert [i["muted"] for i in fetched["items"]] == [True, False]


def test_document_item_centered_roundtrip(client):
    created = client.post("/api/documents", json={"name": "c", "items": [{**sample_item(), "centered": True}, sample_item("plain")]}).json()
    assert [i["centered"] for i in client.get(f"/api/documents/{created['id']}").json()["items"]] == [True, False]


def test_document_item_origin_roundtrip(client):
    created = client.post("/api/documents", json={"name": "o", "items": [{**sample_item(), "origin": [1.5, 2, -3]}, sample_item("plain")]}).json()
    items = client.get(f"/api/documents/{created['id']}").json()["items"]
    assert items[0]["origin"] == [1.5, 2, -3] and items[1].get("origin") is None


def test_document_light_roundtrip(client):
    light = {"direction": [-0.2, 0.3, 0.9], "targetId": "a"}
    created = client.post("/api/documents", json={"name": "l", "items": [sample_item()], "light": light}).json()
    fetched = client.get(f"/api/documents/{created['id']}").json()
    assert fetched["light"] == {"direction": [-0.2, 0.3, 0.9], "target": None, "targetId": "a"}
    updated = client.put(f"/api/documents/{created['id']}", json={"name": "l", "items": [sample_item()]}).json()
    assert updated["light"] is None  # saving without a light puts the default one back
    assert client.post("/api/documents", json={"name": "bad", "light": {"direction": [1, 2]}}).status_code == 422


def test_health(client):
    first = client.get("/api/health").json()
    assert first["status"] == "ok" and first["documents"] == 0
    created = client.post("/api/documents", json={"name": "A"}).json()
    assert client.get("/api/health").json()["documents"] == created["modified"]  # changes when a document is written


def test_update_with_a_stale_base_is_refused_with_the_current_document(client):
    created = client.post("/api/documents", json={"name": "Shared"}).json()
    base = created["modified"]
    first = client.put(f"/api/documents/{created['id']}", params={"baseModified": base}, json={"name": "From window one", "items": []})
    assert first.status_code == 200 and first.json()["name"] == "From window one"
    stale = client.put(f"/api/documents/{created['id']}", params={"baseModified": base}, json={"name": "From window two", "items": []})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["current"]["name"] == "From window one" and detail["current"]["modified"] == first.json()["modified"]
    assert client.get(f"/api/documents/{created['id']}").json()["name"] == "From window one"  # nothing was overwritten
    again = client.put(f"/api/documents/{created['id']}", params={"baseModified": first.json()["modified"]}, json={"name": "Merged", "items": []})
    assert again.status_code == 200


def test_update_without_a_base_still_overwrites(client):
    created = client.post("/api/documents", json={"name": "Old school"}).json()
    client.put(f"/api/documents/{created['id']}", json={"name": "One", "items": []})
    assert client.put(f"/api/documents/{created['id']}", json={"name": "Two", "items": []}).status_code == 200


def item(name="a"):
    return {"id": name, "path": "a.stl", "name": name, "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}


def test_versions_are_numbered_snapshots_of_the_working_copy(client):
    doc = client.post("/api/documents", json={"name": "Versioned", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    assert doc["version"] == 0 and doc["changedSinceVersion"] is True and client.get(f"{url}/versions").json() == []
    v1 = client.post(f"{url}/versions").json()
    assert v1["version"] == 1 and v1["created"] is True and v1["itemCount"] == 1
    again = client.post(f"{url}/versions").json()
    assert again["version"] == 1 and again["created"] is False  # nothing changed: no v2
    now = client.get(url).json()
    assert now["version"] == 1 and now["changedSinceVersion"] is False
    client.put(url, json={"name": "Versioned", "items": [item("one"), item("two")]})
    assert client.get(url).json()["changedSinceVersion"] is True
    v2 = client.post(f"{url}/versions").json()
    assert v2["version"] == 2 and v2["itemCount"] == 2
    listing = client.get(f"{url}/versions").json()
    assert [v["version"] for v in listing] == [2, 1] and listing[1]["itemCount"] == 1  # newest first, v1 untouched
    assert [i["name"] for i in client.get(f"{url}/versions/1").json()["items"]] == ["one"]
    assert client.get(f"{url}/versions/9").status_code == 404


def test_promote_makes_an_old_version_the_working_copy_and_a_new_latest(client):
    doc = client.post("/api/documents", json={"name": "Promote", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    client.post(f"{url}/versions")
    client.put(url, json={"name": "Promote", "items": [item("one"), item("two")]})
    client.post(f"{url}/versions")
    promoted = client.post(f"{url}/versions/1/promote").json()
    assert [i["name"] for i in promoted["items"]] == ["one"] and promoted["version"] == 3 and promoted["changedSinceVersion"] is False
    assert [v["version"] for v in client.get(f"{url}/versions").json()] == [3, 2, 1]
    assert [i["name"] for i in client.get(f"{url}/versions/2").json()["items"]] == ["one", "two"]  # v2 is not rewritten
    assert client.post(f"{url}/versions/9/promote").status_code == 404


def test_versions_can_be_deleted_the_newest_too(client):
    doc = client.post("/api/documents", json={"name": "Prune", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    for name in ("two", "three"):
        client.post(f"{url}/versions")
        client.put(url, json={"name": "Prune", "items": [item(name)]})
    client.post(f"{url}/versions")                                  # v1, v2, v3
    assert client.delete(f"{url}/versions/2").status_code == 204
    assert [v["version"] for v in client.get(f"{url}/versions").json()] == [3, 1]
    assert client.delete(f"{url}/versions/2").status_code == 404
    assert [v["version"] for v in client.delete(f"{url}/versions").json()] == [3]   # everything but the newest
    assert client.get(url).json()["version"] == 3
    assert client.post(f"{url}/versions").json()["created"] is False  # nothing changed: still v3
    assert client.delete(f"{url}/versions/3").status_code == 204     # the newest too: the document is back to "no version"
    gone = client.get(url).json()
    assert gone["version"] == 0 and gone["changedSinceVersion"] is True and client.get(f"{url}/versions").json() == []
    assert client.post(f"{url}/versions").json()["version"] == 1


def test_deleting_a_document_deletes_its_versions(client):
    doc = client.post("/api/documents", json={"name": "Gone", "items": []}).json()
    url = f"/api/documents/{doc['id']}"
    client.post(f"{url}/versions")
    assert client.delete(url).status_code == 204
    assert client.get(f"{url}/versions").status_code == 404
    assert not (main.documentsRoot / f"{doc['id']}.versions").exists()


def test_document_file_round_trip_restores_everything_including_versions(client):
    doc = client.post("/api/documents", json={"name": "Backup me", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    client.post(f"{url}/versions")
    client.put(url, json={"name": "Backup me", "items": [item("one"), item("two")]})
    client.post(f"{url}/versions")
    client.put(url, json={"name": "Backup me", "items": [item("one"), item("two"), item("three")]})  # working copy ahead of v2
    saved = client.get(f"{url}/export.rasterfaster")
    assert saved.status_code == 200 and "Backup_me-v2-edited.rasterfaster.json" in saved.headers["content-disposition"]  # v2 is the newest version, the working copy is ahead of it
    assert [v["version"] for v in saved.json()["versions"]] == [1, 2]
    assert client.delete(url).status_code == 204
    restored = client.post("/api/documents/import", content=saved.content, headers={"Content-Type": "application/json"})
    assert restored.status_code == 201
    body = restored.json()
    assert body["id"] == doc["id"] and [i["name"] for i in body["items"]] == ["one", "two", "three"]
    assert body["version"] == 2 and body["changedSinceVersion"] is True
    assert [v["version"] for v in client.get(f"{url}/versions").json()] == [2, 1]
    assert [i["name"] for i in client.get(f"{url}/versions/1").json()["items"]] == ["one"]


def test_importing_over_an_existing_document_asks_then_replaces_or_copies(client):
    doc = client.post("/api/documents", json={"name": "Original", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    client.post(f"{url}/versions")
    saved = client.get(f"{url}/export.rasterfaster").content
    client.put(url, json={"name": "Edited later", "items": []})
    client.post(f"{url}/versions")
    ask = client.post("/api/documents/import", content=saved, headers={"Content-Type": "application/json"})
    assert ask.status_code == 409 and ask.json()["detail"]["existing"]["name"] == "Edited later"
    copy = client.post("/api/documents/import", params={"onConflict": "copy"}, content=saved, headers={"Content-Type": "application/json"})
    assert copy.status_code == 201 and copy.json()["id"] != doc["id"] and copy.json()["name"] == "Original"
    assert client.get(url).json()["name"] == "Edited later"  # the existing one is untouched
    replaced = client.post("/api/documents/import", params={"onConflict": "replace"}, content=saved, headers={"Content-Type": "application/json"})
    assert replaced.status_code == 201 and replaced.json()["name"] == "Original" and replaced.json()["id"] == doc["id"]
    assert [v["version"] for v in client.get(f"{url}/versions").json()] == [1]  # the history is the file's, not the old one


@pytest.mark.parametrize("payload", [
    {"format": "something-else", "formatVersion": 1, "id": "x", "name": "n", "items": []},
    {"format": "rasterfaster-document", "formatVersion": 2, "id": "x", "name": "n", "items": []},
    {"format": "rasterfaster-document", "formatVersion": 1, "id": "../evil", "name": "n", "items": []},
    {"format": "rasterfaster-document", "formatVersion": 1, "id": "ok", "name": "n", "items": [], "versions": [
        {"version": 1, "savedAt": 1, "name": "n", "items": []}, {"version": 1, "savedAt": 2, "name": "n", "items": []}]},
    {"not": "a document"},
])
def test_import_rejects_files_that_are_not_documents(client, payload):
    assert client.post("/api/documents/import", json=payload).status_code == 422


def test_document_file_name_carries_the_version(client):
    doc = client.post("/api/documents", json={"name": "Named", "items": [item("one")]}).json()
    url = f"/api/documents/{doc['id']}"
    assert 'filename="Named.rasterfaster.json"' in client.get(f"{url}/export.rasterfaster").headers["content-disposition"]  # no version yet
    client.post(f"{url}/versions")
    assert 'filename="Named-v1.rasterfaster.json"' in client.get(f"{url}/export.rasterfaster").headers["content-disposition"]
    client.put(url, json={"name": "Named", "items": []})
    assert 'filename="Named-v1-edited.rasterfaster.json"' in client.get(f"{url}/export.rasterfaster").headers["content-disposition"]


def test_document_view_roundtrip_and_validation(client):
    view = {"projection": "persp", "position": [1, 2, 3], "target": [0, 0, 0], "zoom": 2.5, "radius": 120}
    created = client.post("/api/documents", json={"name": "v", "items": [sample_item()], "view": view}).json()
    fetched = client.get(f"/api/documents/{created['id']}").json()
    assert fetched["view"] == {**view, "position": [1, 2, 3], "target": [0, 0, 0]}
    assert fetched["changedSinceVersion"] is True
    version = client.post(f"/api/documents/{created['id']}/versions").json()
    moved = client.put(f"/api/documents/{created['id']}", json={"name": "v", "items": [sample_item()], "view": {**view, "zoom": 4}}).json()
    assert moved["view"]["zoom"] == 4 and moved["changedSinceVersion"] is False  # moving the camera is not a change since the version
    assert client.post("/api/documents", json={"name": "bad", "view": {**view, "zoom": 0}}).status_code == 422
    assert client.post("/api/documents", json={"name": "bad", "view": {**view, "projection": "fisheye"}}).status_code == 422


# a tiny valid PNG header (1 x 1): the library only reads the size from it
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x40\x00\x00\x00\x24\x08\x06\x00\x00\x00" + b"\x00" * 40
JPEG = b"\xff\xd8\xff" + b"\x00" * 200


def test_image_library_keeps_pictures_with_the_document_version(client):
    document = client.post("/api/documents", json={"name": "Imgs", "items": []}).json()["id"]
    base = f"/api/documents/{document}/images"
    assert client.get(base).json() == []
    first = client.post(base, content=PNG, params={"kind": "quick", "name": "A"})
    assert first.status_code == 201 and first.json()["version"] == 0 and first.json()["edited"] is True and (first.json()["width"], first.json()["height"]) == (64, 36)
    client.post(f"/api/documents/{document}/versions")
    second = client.post(base, content=PNG, params={"kind": "hd", "name": "B"}).json()
    assert second["version"] == 1 and second["edited"] is False
    assert [note["name"] for note in client.get(base).json()] == ["B", "A"]  # newest first
    assert client.get(f"{base}/{second['id']}.png").content == PNG
    assert "attachment" in client.get(f"{base}/{second['id']}.png", params={"download": True}).headers["content-disposition"]
    assert client.post(base, content=b"not a png").status_code == 422


def test_image_library_thumbnail_rename_and_deleting(client):
    document = client.post("/api/documents", json={"name": "Imgs", "items": []}).json()["id"]
    base = f"/api/documents/{document}/images"
    old = client.post(base, content=PNG, params={"kind": "quick"}).json()
    client.post(f"/api/documents/{document}/versions")
    new = client.post(base, content=PNG, params={"kind": "hd"}).json()
    assert client.get(f"{base}/{old['id']}/thumb.jpg").status_code == 404
    assert client.put(f"{base}/{old['id']}/thumb.jpg", content=JPEG).status_code == 204
    assert client.put(f"{base}/{old['id']}/thumb.jpg", content=b"nope").status_code == 422
    assert client.get(f"{base}/{old['id']}/thumb.jpg").content == JPEG
    assert next(n for n in client.get(base).json() if n["id"] == old["id"])["thumb"] is True
    assert client.patch(f"{base}/{new['id']}", json={"name": "Front"}).json()["name"] == "Front"
    assert client.delete(base).status_code == 422  # needs a filter
    assert client.delete(base, params={"beforeVersion": 1}).json() == {"deleted": 1}  # the one made before v1
    assert [n["id"] for n in client.get(base).json()] == [new["id"]]
    assert client.delete(f"{base}/{new['id']}").status_code == 204
    assert client.delete(f"{base}/{new['id']}").status_code == 404
    assert client.get(f"/api/documents/nope/images").status_code == 404
