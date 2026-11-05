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
    kept = client.post(base, content=PNG, params={"settings": '{"lamp": 40, "ambient": 2}'}).json()
    assert kept["settings"] == {"lamp": 40, "ambient": 2}
    assert client.post(base, content=PNG, params={"settings": "[1]"}).status_code == 422
    assert client.post(base, content=PNG, params={"settings": "{oops"}).status_code == 422
    assert client.get(base).json()[0]["settings"] == {"lamp": 40, "ambient": 2}


def test_render_note_has_the_settings_in_words_and_the_focus_part_name():
    document = main.DocumentOut(id="d", modified=0, name="N", items=[main.DocumentItem(id="p1", path="a.stl", name="Part A", color=1, position=(0, 0, 0), rotation=(0, 0, 0, 1))],
                                render=main.DocumentRenderSettings(depthOfField=True, focusId="p1", lamp=50, ambient=3))
    note = main.render_note(document, None, main.resolve_render_settings(document))
    assert note["focus"] == "Part A" and note["lamp"] == 50 and note["ambient"] == 3 and note["depthOfField"] is True and note["projection"] == "persp" and note["focusId"] == "p1" and note["view"] is None
    off = main.render_note(document, "0,-1,0;0,0,0;100;ortho", main.resolve_render_settings(document, dof=False, lamp=20))
    assert off["focus"] is None and off["lamp"] == 20 and off["projection"] == "ortho"


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


def test_part_render_settings_are_kept_and_checked(client):
    item = {"id": "a", "path": "a10.stl", "name": "A", "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "R", "items": [{**item, "render": {"color": 0x336699, "finish": "mirror", "hidden": True}}]})
    assert created.status_code == 201
    assert client.get(f"/api/documents/{created.json()['id']}").json()["items"][0]["render"] == {"color": 0x336699, "finish": "mirror", "hidden": True}
    assert client.post("/api/documents", json={"name": "R", "items": [item]}).json()["items"][0]["render"] is None
    assert client.post("/api/documents", json={"name": "R", "items": [{**item, "render": {"finish": "chrome"}}]}).status_code == 422
    assert client.post("/api/documents", json={"name": "R", "items": [{**item, "render": {"color": -1}}]}).status_code == 422


def test_saved_view_of_a_picture_is_checked_and_kept_in_its_note():
    good = '{"projection": "persp", "position": [1, 2, 3], "target": [0, 0, 0], "zoom": 2, "radius": 100, "mode": "shaded", "appMode": "render", "unknown": 1}'
    kept = main.parse_saved_view(good)
    assert kept["position"] == (1, 2, 3) and kept["appMode"] == "render" and "id" not in kept and "unknown" not in kept
    assert main.parse_saved_view(None) is None and main.parse_saved_view("{oops") is None
    assert main.parse_saved_view('{"projection": "sideways"}') is None
    document = main.DocumentOut(id="d", modified=0, name="N", items=[])
    note = main.render_note(document, None, main.resolve_render_settings(document), None, kept)
    assert note["savedView"] == kept and "savedView" not in main.render_note(document, None, main.resolve_render_settings(document))


def test_a_file_of_your_own_goes_into_the_gallery(client):
    document = client.post("/api/documents", json={"name": "Mine", "items": []}).json()["id"]
    base = f"/api/documents/{document}/images"
    png = client.post(base, content=PNG, params={"kind": "file", "name": "my picture", "samples": 0})
    assert png.status_code == 201 and png.json()["kind"] == "file" and png.json()["media"] == "png"
    mp4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 40
    assert client.post(base, content=mp4, params={"kind": "file", "name": "clip"}).status_code == 422  # a video needs its size
    video = client.post(base, content=mp4, params={"kind": "file", "name": "clip", "width": 960, "height": 540, "samples": 0})
    assert video.status_code == 201 and video.json()["kind"] == "file" and video.json()["media"] == "mp4" and (video.json()["width"], video.json()["height"]) == (960, 540)
    assert client.get(f"{base}/{video.json()['id']}.mp4").status_code == 200
    assert [n["name"] for n in client.get(base).json()] == ["clip", "my picture"]


def test_catalog_lists_every_stl_with_its_top_folder(client, tmp_path):
    (tmp_path / "BOXES" / "deep").mkdir()
    (tmp_path / "BOXES" / "deep" / "c.STL").write_bytes(b"solid 1")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / ".hidden" / "h.stl").write_bytes(b"x")
    (tmp_path / ".dot.stl").write_bytes(b"x")
    found = client.get("/api/catalog").json()
    assert [(e["path"], e["folder"]) for e in found] == [("a2.stl", ""), ("a10.stl", ""), ("BOXES/b.stl", "BOXES"), ("BOXES/deep/c.STL", "BOXES")]  # natural, case-insensitive
    assert found[3]["name"] == "c.STL" and found[3]["size"] == 7 and found[3]["modified"] > 0


thumbBody = {"modified": 0, "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>', "dims": [1.0, 2.0, 3.0], "volume": 6.0}


def test_thumbnail_is_stored_served_and_listed_in_the_catalog(client, tmp_path):
    stamp = (tmp_path / "a2.stl").stat().st_mtime
    assert client.get("/api/catalog/thumb", params={"path": "a2.stl"}).status_code == 404
    assert client.put("/api/catalog/thumb", params={"path": "a2.stl"}, json={**thumbBody, "modified": stamp}).status_code == 204
    served = client.get("/api/catalog/thumb", params={"path": "a2.stl", "v": "1"})
    assert served.status_code == 200 and served.headers["content-type"].startswith("image/svg+xml") and "<path" in served.text
    assert "sandbox" in served.headers["content-security-policy"]
    drawn = {e["path"]: e for e in client.get("/api/catalog").json()}
    assert drawn["a2.stl"]["thumbVersion"] == 1  # a drawing made without a version is the first look
    assert drawn["a2.stl"]["drawn"] and drawn["a2.stl"]["dims"] == [1.0, 2.0, 3.0] and drawn["a2.stl"]["volume"] == 6.0
    assert not drawn["a10.stl"]["drawn"] and drawn["a10.stl"]["dims"] is None
    assert (main.documentsRoot / ".catalog-cache").is_dir()  # hidden, next to the documents
    assert client.get("/api/documents").json() == []  # and it is not a document


def test_changed_file_needs_a_new_thumbnail(client, tmp_path):
    client.put("/api/catalog/thumb", params={"path": "a2.stl"}, json={**thumbBody, "modified": (tmp_path / "a2.stl").stat().st_mtime})
    import os
    os.utime(tmp_path / "a2.stl", (1, 1))
    assert not {e["path"]: e for e in client.get("/api/catalog").json()}["a2.stl"]["drawn"]


@pytest.mark.parametrize("path,status", [("../x.stl", 403), ("missing.stl", 404), ("BOXES/notes.txt", 404)])
def test_thumbnail_paths_are_checked(client, path, status):
    assert client.put("/api/catalog/thumb", params={"path": path}, json=thumbBody).status_code == status
    assert client.get("/api/catalog/thumb", params={"path": path}).status_code in (403, 404)


@pytest.mark.parametrize("svg", ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"/>', "<html></html>", '<svg><a href="javascript:x"/></svg>'])
def test_unsafe_thumbnail_is_refused(client, svg):
    assert client.put("/api/catalog/thumb", params={"path": "a2.stl"}, json={**thumbBody, "svg": svg}).status_code == 400


def test_thumbnail_keeps_the_version_it_was_drawn_with(client, tmp_path):
    client.put("/api/catalog/thumb", params={"path": "a2.stl"}, json={**thumbBody, "modified": (tmp_path / "a2.stl").stat().st_mtime, "version": 2})
    assert {e["path"]: e for e in client.get("/api/catalog").json()}["a2.stl"]["thumbVersion"] == 2


def _scan(client):
    import time
    assert client.post("/api/catalog/duplicates/scan").status_code == 200
    for _ in range(100):
        state = client.get("/api/catalog/duplicates").json()
        if state["state"] != "running":
            return state
        time.sleep(0.05)
    raise AssertionError("the scan did not finish")


def _distinct(tmp_path):
    """The fixture's three files are all the same 'solid': give them contents of their own."""
    (tmp_path / "a2.stl").write_bytes(b"solid a2 !")
    (tmp_path / "a10.stl").write_bytes(b"solid a10 !!")
    (tmp_path / "BOXES" / "b.stl").write_bytes(b"solid b !!!")


def test_duplicate_scan_groups_identical_files(client, tmp_path):
    _distinct(tmp_path)
    (tmp_path / "A").mkdir()
    (tmp_path / "A" / "same.stl").write_bytes(b"solid same content")
    (tmp_path / "BOXES" / "same copy.stl").write_bytes(b"solid same content")
    (tmp_path / "a11.stl").write_bytes(b"solid same content")
    (tmp_path / "A" / "other.stl").write_bytes(b"solid other content!")  # a different size
    (tmp_path / "A" / "alike.stl").write_bytes(b"solid same contenT")  # the same size, other content
    (tmp_path / "empty1.stl").write_bytes(b"")
    (tmp_path / "empty2.stl").write_bytes(b"")
    state = _scan(client)
    assert state["state"] == "done"
    assert [g["paths"] for g in state["groups"]] == [["a11.stl", "A/same.stl", "BOXES/same copy.stl"]]
    assert state["groups"][0]["size"] == len(b"solid same content")
    assert state["total"] == 4  # a11, same, same copy and alike share a size; empty files and 'other' are not read


def test_duplicate_scan_remembers_hashes_and_notices_changes(client, tmp_path, monkeypatch):
    from rf_library import duplicates
    _distinct(tmp_path)
    (tmp_path / "x1.stl").write_bytes(b"solid one")
    (tmp_path / "x2.stl").write_bytes(b"solid one")
    reads = []
    real = duplicates.sha1_of
    monkeypatch.setattr(duplicates, "sha1_of", lambda file: (reads.append(file.name), real(file))[1])
    assert len(_scan(client)["groups"]) == 1
    first = len(reads)
    assert first >= 2
    assert len(_scan(client)["groups"]) == 1 and len(reads) == first  # nothing was read again
    (tmp_path / "x2.stl").write_bytes(b"solid two")  # changed: read again, no longer the same
    assert _scan(client)["groups"] == [] and len(reads) > first


def test_used_paths_come_from_documents_and_versions(client):
    doc = client.post("/api/documents", json={"name": "d", "items": [{"id": "1", "path": "BOXES/b.stl", "name": "b", "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}]}).json()
    client.post(f"/api/documents/{doc['id']}/versions")
    assert client.get("/api/catalog/used").json() == {"paths": ["BOXES/b.stl"]}


def _binary_stl(triangles, header: bytes = b"") -> bytes:
    import struct
    out = header.ljust(80, b" ")[:80] + struct.pack("<I", len(triangles))
    for t in triangles:
        out += struct.pack("<3f", 0, 0, 1) + b"".join(struct.pack("<3f", *corner) for corner in t) + b"\0\0"
    return out


def _scan_mode(client, mode):
    import time
    assert client.post("/api/catalog/duplicates/scan", params={"mode": mode}).status_code == 200
    for _ in range(100):
        state = client.get("/api/catalog/duplicates", params={"mode": mode}).json()
        if state["state"] != "running":
            return state
        time.sleep(0.05)
    raise AssertionError("the scan did not finish")


def test_same_shape_finds_re_exports_that_exact_misses(client, tmp_path):
    _distinct(tmp_path)
    t1, t2, t3 = ((0, 0, 0), (10, 0, 0), (0, 10, 0)), ((0, 0, 0), (0, 10, 0), (0, 0, 10)), ((10, 0, 0), (0, 10, 0), (0, 0, 10))
    (tmp_path / "part.stl").write_bytes(_binary_stl([t1, t2, t3], b"exported by A"))
    (tmp_path / "part (1).stl").write_bytes(_binary_stl([t3, t1, t2], b"exported again"))  # the triangles in another order, another header
    (tmp_path / "part (2).stl").write_bytes(_binary_stl([(c, b, a) for a, b, c in (t1, t2, t3)], b"third"))  # the corners of each triangle the other way round
    (tmp_path / "part (3).stl").write_bytes(_binary_stl([[(x + 80, y, z) for x, y, z in t] for t in (t1, t2, t3)], b"moved"))  # the same part at another place
    mid = ((10 + 0) / 2, (0 + 10) / 2, 0)  # the first triangle cut in two: another triangulation of the same surface (another triangle count and file size)
    (tmp_path / "part split.stl").write_bytes(_binary_stl([(t1[0], t1[1], mid), (t1[0], mid, t1[2]), t2, t3], b"retriangulated"))
    (tmp_path / "other.stl").write_bytes(_binary_stl([t1, t2, ((10, 0, 0), (0, 10, 0), (0, 0, 11))]))  # one corner moved: another shape, the same size
    assert _scan_mode(client, "exact")["groups"] == []  # not a single byte-identical pair
    state = _scan_mode(client, "shape")
    assert [g["paths"] for g in state["groups"]] == [["part (1).stl", "part (2).stl", "part (3).stl", "part split.stl", "part.stl"]]  # (3) is the same part moved 80 mm, "split" is triangulated differently
    assert state["total"] == 9  # every file is measured, whatever its size (the three tiny ones of the fixture are no STL and are left out of the groups)


def test_shape_features_ignore_place_format_and_noise_but_not_shape(tmp_path):
    from rf_library import duplicates
    tri = ((0, 0, 0), (5, 0, 0), (0, 5, 0))
    ascii_text = "solid x\n" + "facet normal 0 0 1\nouter loop\n" + "".join(f"vertex {a} {b} {c}\n" for a, b, c in tri) + "endloop\nendfacet\nendsolid x\n"
    (tmp_path / "a.stl").write_text(ascii_text)
    (tmp_path / "b.stl").write_text(ascii_text.replace("vertex 5 0 0", "vertex 5.0000001 0 0"))  # noise
    (tmp_path / "c.stl").write_bytes(_binary_stl([tri]))  # binary instead of ASCII
    (tmp_path / "d.stl").write_bytes(_binary_stl([[(x + 40, y - 3, z + 7) for x, y, z in tri]]))  # moved
    (tmp_path / "e.stl").write_bytes(_binary_stl([((0, 0, 0), (5, 0, 0), (0, 6, 0))]))  # another shape
    features = {name: duplicates.shape_features(tmp_path / f"{name}.stl") for name in "abcde"}
    for name in "bcd":
        assert duplicates.same_shape(features["a"], features[name]), name
    assert not duplicates.same_shape(features["a"], features["e"])


def test_matches_of_one_part(client, tmp_path):
    _distinct(tmp_path)
    t1, t2, t3 = ((0, 0, 0), (10, 0, 0), (0, 10, 0)), ((0, 0, 0), (0, 10, 0), (0, 0, 10)), ((10, 0, 0), (0, 10, 0), (0, 0, 10))
    (tmp_path / "part.stl").write_bytes(_binary_stl([t1, t2, t3], b"A"))
    (tmp_path / "exact copy.stl").write_bytes(_binary_stl([t1, t2, t3], b"A"))
    (tmp_path / "moved.stl").write_bytes(_binary_stl([[(x + 80, y, z) for x, y, z in t] for t in (t1, t2, t3)], b"B"))
    (tmp_path / "reordered.stl").write_bytes(_binary_stl([t3, t1, t2], b"C"))
    (tmp_path / "other.stl").write_bytes(_binary_stl([t1, t2, ((10, 0, 0), (0, 10, 0), (0, 0, 11))], b"A"))
    found = client.get("/api/catalog/matches", params={"path": "part.stl"}).json()
    (tmp_path / "split.stl").write_bytes(_binary_stl([(t1[0], t1[1], (5, 5, 0)), (t1[0], (5, 5, 0), t1[2]), t2, t3], b"D"))  # another triangulation: 50 bytes more
    found = client.get("/api/catalog/matches", params={"path": "part.stl"}).json()
    assert found["identical"] == ["exact copy.stl"]
    assert found["sameShape"] == ["moved.stl", "reordered.stl", "split.stl"]  # not "other.stl": one corner differs
    again = client.get("/api/catalog/matches", params={"path": "split.stl"}).json()  # from the remembered measurements, though its file size is another
    assert again["identical"] == [] and set(again["sameShape"]) == {"part.stl", "exact copy.stl", "moved.stl", "reordered.stl"}
    assert client.get("/api/catalog/matches", params={"path": "a2.stl"}).json()["sameShape"] == []
    assert client.get("/api/catalog/matches", params={"path": "missing.stl"}).status_code == 404
    assert client.get("/api/catalog/matches", params={"path": "../x.stl"}).status_code == 403


def test_matches_use_what_a_library_check_has_measured(client, tmp_path):
    _distinct(tmp_path)
    t1, t2, t3 = ((0, 0, 0), (10, 0, 0), (0, 10, 0)), ((0, 0, 0), (0, 10, 0), (0, 0, 10)), ((10, 0, 0), (0, 10, 0), (0, 0, 10))
    (tmp_path / "part.stl").write_bytes(_binary_stl([t1, t2, t3]))
    pieces = []
    for a, b, c in (t1, t2, t3):  # every triangle cut in two: the file is twice as big, far outside the size window of one part
        m = tuple((y + z) / 2 for y, z in zip(b, c))
        pieces += [(a, b, m), (a, m, c)]
    (tmp_path / "fine.stl").write_bytes(_binary_stl(pieces))
    assert client.get("/api/catalog/matches", params={"path": "part.stl"}).json()["sameShape"] == []  # not measured, not near in size
    assert [g["paths"] for g in _scan_mode(client, "shape")["groups"]] == [["fine.stl", "part.stl"]]
    assert client.get("/api/catalog/matches", params={"path": "part.stl"}).json()["sameShape"] == ["fine.stl"]  # now it is known


def _turn(triangles, rotation):
    """The triangles with every corner mapped by a function (x, y, z) -> (x', y', z')."""
    return [tuple(rotation(*corner) for corner in t) for t in triangles]


def _box_triangles(x0, y0, z0, x1, y1, z1):
    """The 12 triangles of a box, wound outwards."""
    p = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (2, 3, 7), (2, 7, 6), (1, 2, 6), (1, 6, 5), (3, 0, 4), (3, 4, 7)]
    return [(p[a], p[b], p[c]) for a, b, c in faces]


def test_same_shape_matches_a_part_turned_by_quarter_turns_but_not_a_mirror_image(tmp_path):
    from rf_library import duplicates
    # a solid that is not symmetric: a long block with a smaller block on one end and a flat tab at the side
    base = _box_triangles(0, 0, 0, 40, 10, 6) + _box_triangles(0, 0, 6, 10, 10, 12) + _box_triangles(15, 10, 0, 25, 14, 3)
    variants = {
        "a": base,
        "standing": _turn(base, lambda x, y, z: (x, -z, y)),  # a quarter turn about X: lying flat becomes standing
        "turned": _turn(base, lambda x, y, z: (-y, x, z)),  # a quarter turn about Z
        "upside": _turn(base, lambda x, y, z: (x, -y, -z)),  # a half turn about X
        "moved": _turn(base, lambda x, y, z: (x + 70, y - 3, z + 5)),
        "mirror": _turn(base, lambda x, y, z: (-x, y, z)),  # left becomes right: a different part
        "other": _box_triangles(0, 0, 0, 40, 10, 6) + _box_triangles(0, 0, 6, 10, 10, 12) + _box_triangles(15, 10, 0, 25, 14, 3.5),  # the tab a little thicker
    }
    for name, triangles in variants.items():
        (tmp_path / f"{name}.stl").write_bytes(_binary_stl(triangles))
    features = {name: duplicates.shape_features(tmp_path / f"{name}.stl") for name in variants}
    for name in ("standing", "turned", "upside", "moved"):
        assert duplicates.same_shape(features["a"], features[name]), name
        assert duplicates.same_shape(features[name], features["a"]), name  # the other way round too
    assert not duplicates.same_shape(features["a"], features["mirror"])  # a LEFT and a RIGHT part are two parts
    assert not duplicates.same_shape(features["a"], features["other"])


def test_a_symmetric_part_is_the_same_shape_as_its_mirror_image(tmp_path):
    from rf_library import duplicates
    base = _box_triangles(0, 0, 0, 40, 10, 6) + _box_triangles(15, 0, 6, 25, 10, 12)  # a bar with a block in the middle: symmetric
    (tmp_path / "left.stl").write_bytes(_binary_stl(base))
    (tmp_path / "right.stl").write_bytes(_binary_stl(_turn(base, lambda x, y, z: (-x, y, z))))
    assert duplicates.same_shape(duplicates.shape_features(tmp_path / "left.stl"), duplicates.shape_features(tmp_path / "right.stl"))
