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
