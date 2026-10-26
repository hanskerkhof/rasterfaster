import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import library_ops
import main


@pytest.fixture
def world(tmp_path: Path):
    library = tmp_path / "3D" / "RASTERFASTER"
    (library / "1.4.BOLTS & NUTS").mkdir(parents=True)
    (library / "1.4.BOLTS & NUTS" / "Long old name (1).stl").write_bytes(b"original bytes")
    (library / "1.4.BOLTS & NUTS" / "other.stl").write_bytes(b"other")
    (library / "TOP.stl").write_bytes(b"top")
    (library / "notes.txt").write_text("not an stl")
    documents = tmp_path / "docs"
    documents.mkdir()
    item = lambda path, name: {"id": name, "path": path, "name": name, "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    (documents / "d1.json").write_text(json.dumps({"name": "D1", "items": [
        item("1.4.BOLTS & NUTS/Long old name (1).stl", "Long old name (1)"),   # label is still the file name
        item("1.4.BOLTS & NUTS/Long old name (1).stl", "My bolt"),             # a label of the user's own
        item("1.4.BOLTS & NUTS/other.stl", "other"),
        item("TOP.stl", "TOP")]}))
    versions = documents / "d1.versions"
    versions.mkdir()
    (versions / "v1.json").write_text(json.dumps({"version": 1, "savedAt": 1, "name": "D1", "items": [item("1.4.BOLTS & NUTS/Long old name (1).stl", "Long old name (1)")]}))
    return {"library": library.resolve(), "backup": (tmp_path / "3D_BACKUP").resolve(), "documents": documents.resolve()}


def do(world, path, new, dry=False):
    return library_ops.rename(world["library"], world["backup"], world["documents"], path, new, dry)


def doc(world, name="d1"):
    return json.loads((world["documents"] / f"{name}.json").read_text())


def test_first_rename_of_a_file_backs_up_the_original_in_the_same_hierarchy(world):
    result = do(world, "1.4.BOLTS & NUTS/Long old name (1).stl", "Short.stl")
    backup = world["backup"] / "RASTERFASTER" / "1.4.BOLTS & NUTS" / "Long old name (1).stl"
    assert backup.read_bytes() == b"original bytes" and result["backup"] == str(backup) and result["backedUp"] is True
    assert not (world["library"] / "1.4.BOLTS & NUTS" / "Long old name (1).stl").exists()
    assert (world["library"] / "1.4.BOLTS & NUTS" / "Short.stl").read_bytes() == b"original bytes"


def test_only_the_first_rename_is_backed_up_even_when_renamed_again_and_again(world):
    do(world, "1.4.BOLTS & NUTS/Long old name (1).stl", "B.stl")
    second = do(world, "1.4.BOLTS & NUTS/B.stl", "C.stl")
    assert second["backup"] is None and second["backedUp"] is False
    backups = sorted(p.name for p in (world["backup"] / "RASTERFASTER").rglob("*.stl"))
    assert backups == ["Long old name (1).stl"]  # one backup, of the original
    registry = json.loads((world["backup"] / ".rasterfaster" / "registry.json").read_text())
    assert list(registry) == ["1.4.BOLTS & NUTS/C.stl"] and registry["1.4.BOLTS & NUTS/C.stl"]["originalPath"] == "1.4.BOLTS & NUTS/Long old name (1).stl"


def test_a_name_without_extension_gets_stl_and_the_documents_follow(world):
    do(world, "1.4.BOLTS & NUTS/Long old name (1).stl", "Short")
    items = doc(world)["items"]
    assert [i["path"] for i in items][:2] == ["1.4.BOLTS & NUTS/Short.stl"] * 2
    assert [i["name"] for i in items][:2] == ["Short", "My bolt"]  # only the label that equalled the file name follows
    assert items[2]["path"] == "1.4.BOLTS & NUTS/other.stl" and items[3]["path"] == "TOP.stl"
    version = json.loads((world["documents"] / "d1.versions" / "v1.json").read_text())
    assert version["items"][0]["path"] == "1.4.BOLTS & NUTS/Short.stl" and version["items"][0]["name"] == "Short"


def test_renaming_a_directory_copies_nothing_logs_it_and_moves_the_paths_below_it(world):
    result = do(world, "1.4.BOLTS & NUTS", "1.4 Bolts")
    assert result["kind"] == "directory" and result["backup"] is None
    assert not (world["backup"] / "RASTERFASTER").exists()  # nothing was copied
    assert (world["library"] / "1.4 Bolts" / "other.stl").is_file()
    assert [i["path"] for i in doc(world)["items"]] == ["1.4 Bolts/Long old name (1).stl"] * 2 + ["1.4 Bolts/other.stl", "TOP.stl"]
    assert [i["name"] for i in doc(world)["items"]][:2] == ["Long old name (1)", "My bolt"]  # file names did not change: labels stay
    log = json.loads((world["backup"] / ".rasterfaster" / "log.json").read_text())
    assert log[-1]["kind"] == "rename-directory" and log[-1]["status"] == "done" and log[-1]["documentsUpdated"] == 4


def test_a_registered_file_inside_a_renamed_directory_stays_registered(world):
    do(world, "1.4.BOLTS & NUTS/other.stl", "renamed.stl")
    do(world, "1.4.BOLTS & NUTS", "Bolts")
    again = do(world, "Bolts/renamed.stl", "again.stl")
    assert again["backup"] is None  # it was backed up before the directory moved
    registry = json.loads((world["backup"] / ".rasterfaster" / "registry.json").read_text())
    assert list(registry) == ["Bolts/again.stl"]


def test_log_has_one_entry_per_rename(world):
    do(world, "TOP.stl", "TOP2.stl")
    do(world, "TOP2.stl", "TOP3.stl")
    log = json.loads((world["backup"] / ".rasterfaster" / "log.json").read_text())
    assert [(e["from"], e["to"], e["status"]) for e in log] == [("TOP.stl", "TOP2.stl", "done"), ("TOP2.stl", "TOP3.stl", "done")]
    assert log[0]["backup"] is not None and log[1]["backup"] is None


def test_dry_run_reports_and_changes_nothing(world):
    result = do(world, "1.4.BOLTS & NUTS/Long old name (1).stl", "X.stl", dry=True)
    assert result["dryRun"] is True and result["backup"] and result["documents"] == {"d1.json": 2, "d1.versions/v1.json": 1}
    assert (world["library"] / "1.4.BOLTS & NUTS" / "Long old name (1).stl").is_file()
    assert not world["backup"].exists()
    assert doc(world)["items"][0]["path"].endswith("Long old name (1).stl")


@pytest.mark.parametrize("name,status", [("", 422), ("   ", 422), (".hidden.stl", 422), ("a/b.stl", 422), ("a:b.stl", 422), ("..", 422), ("other.stl", 409), ("x" * 300, 422)])
def test_bad_names_and_collisions_change_nothing(world, name, status):
    with pytest.raises(library_ops.LibraryError) as error:
        do(world, "1.4.BOLTS & NUTS/Long old name (1).stl", name)
    assert error.value.status == status
    assert (world["library"] / "1.4.BOLTS & NUTS" / "Long old name (1).stl").is_file() and not world["backup"].exists()


def test_cannot_rename_the_root_things_outside_or_non_stl_files(world):
    for path, status in [("", 403), ("../outside.stl", 403), ("nope.stl", 404)]:
        with pytest.raises(library_ops.LibraryError) as error:
            do(world, path, "x.stl")
        assert error.value.status == status
    with pytest.raises(library_ops.LibraryError):
        do(world, "notes.txt", "notes2.txt")


def test_a_failed_backup_aborts_the_rename(world, monkeypatch):
    def broken_copy(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(library_ops.shutil, "copy2", broken_copy)
    with pytest.raises(library_ops.LibraryError) as error:
        do(world, "TOP.stl", "TOP2.stl")
    assert error.value.status == 500
    assert (world["library"] / "TOP.stl").is_file() and not (world["library"] / "TOP2.stl").exists()
    assert json.loads((world["backup"] / ".rasterfaster" / "log.json").read_text())[-1]["status"] == "failed"
    assert doc(world)["items"][3]["path"] == "TOP.stl"


def test_when_the_documents_cannot_follow_the_file_is_put_back(world, monkeypatch):
    real = library_ops.rewrite_documents
    calls = []

    def flaky(*args, **kwargs):
        calls.append(kwargs.get("dryRun", False))
        if not kwargs.get("dryRun", False):
            raise OSError("no space")
        return real(*args, **kwargs)

    monkeypatch.setattr(library_ops, "rewrite_documents", flaky)
    with pytest.raises(library_ops.LibraryError):
        do(world, "TOP.stl", "TOP2.stl")
    assert (world["library"] / "TOP.stl").is_file() and not (world["library"] / "TOP2.stl").exists()


def test_a_second_backup_never_overwrites_an_older_one(world):
    do(world, "TOP.stl", "A.stl")
    (world["library"] / "TOP.stl").write_bytes(b"a new file at the old path")  # something else uses the old name now
    second = do(world, "TOP.stl", "B.stl")
    names = sorted(p.name for p in (world["backup"] / "RASTERFASTER").glob("*.stl"))
    assert names == ["TOP (2).stl", "TOP.stl"] and second["backedUp"] is True
    assert (world["backup"] / "RASTERFASTER" / "TOP.stl").read_bytes() == b"top"


@pytest.fixture
def client(world, monkeypatch):
    monkeypatch.setattr(main, "libraryRoot", world["library"])
    monkeypatch.setattr(main, "documentsRoot", world["documents"])
    monkeypatch.setattr(main, "backupRoot", world["backup"])
    return TestClient(main.app)


def test_api_rename_dry_run_then_real(client, world):
    dry = client.post("/api/library/rename", params={"dryRun": True}, json={"path": "TOP.stl", "newName": "NEW"})
    assert dry.status_code == 200 and dry.json()["to"] == "NEW.stl" and (world["library"] / "TOP.stl").is_file()
    done = client.post("/api/library/rename", json={"path": "TOP.stl", "newName": "NEW"})
    assert done.status_code == 200 and done.json()["backedUp"] is True and (world["library"] / "NEW.stl").is_file()
    assert [e["name"] for e in client.get("/api/list").json()] == ["1.4.BOLTS & NUTS", "NEW.stl"]


def test_api_errors(client):
    assert client.post("/api/library/rename", json={"path": "TOP.stl", "newName": "a/b"}).status_code == 422
    assert client.post("/api/library/rename", json={"path": "gone.stl", "newName": "x"}).status_code == 404
    assert client.post("/api/library/rename", json={"path": "1.4.BOLTS & NUTS/other.stl", "newName": "Long old name (1)"}).status_code == 409
    assert client.post("/api/library/rename", json={"path": "../x.stl", "newName": "y"}).status_code == 403


# --- the Trash -----------------------------------------------------------------------------------------------------------------

def trash(world, path, dry=False):
    return library_ops.move_to_trash(world["library"], world["backup"], world["documents"], path, dry)


def put_back(world, item_id, on_conflict="ask"):
    return library_ops.put_back(world["library"], world["backup"], item_id, on_conflict)


def test_move_to_trash_moves_the_file_and_remembers_where_it_came_from(world):
    result = trash(world, "1.4.BOLTS & NUTS/other.stl")
    assert not (world["library"] / "1.4.BOLTS & NUTS" / "other.stl").exists()
    stored = world["backup"] / "_TRASH" / result["id"] / "other.stl"
    assert stored.read_bytes() == b"other"
    items = library_ops.list_trash(world["backup"])
    assert [(i["name"], i["originalPath"], i["kind"], i["size"], i["missing"]) for i in items] == [("other.stl", "1.4.BOLTS & NUTS/other.stl", "file", 5, False)]
    assert result["documents"] == {"d1.json": 1}
    # the documents are not rewritten: their parts keep the path and work again after Put Back
    assert doc(world)["items"][2]["path"] == "1.4.BOLTS & NUTS/other.stl"


def test_dry_run_of_trash_reports_the_documents_and_moves_nothing(world):
    result = trash(world, "1.4.BOLTS & NUTS", dry=True)
    assert result["id"] is None and result["kind"] == "directory" and result["documents"] == {"d1.json": 3, "d1.versions/v1.json": 1}
    assert (world["library"] / "1.4.BOLTS & NUTS" / "other.stl").is_file() and not world["backup"].exists()


def test_put_back_returns_the_item_and_removes_it_from_the_trash(world):
    item = trash(world, "TOP.stl")
    back = put_back(world, item["id"])
    assert back["path"] == "TOP.stl" and back["renamed"] is False
    assert (world["library"] / "TOP.stl").read_bytes() == b"top"
    assert library_ops.list_trash(world["backup"]) == [] and not (world["backup"] / "_TRASH" / item["id"]).exists()


def test_put_back_recreates_missing_folders_and_a_directory_comes_back_whole(world):
    item = trash(world, "1.4.BOLTS & NUTS")
    assert not (world["library"] / "1.4.BOLTS & NUTS").exists()
    put_back(world, item["id"])
    assert sorted(p.name for p in (world["library"] / "1.4.BOLTS & NUTS").iterdir()) == ["Long old name (1).stl", "other.stl"]
    nested = trash(world, "1.4.BOLTS & NUTS/other.stl")
    (world["library"] / "1.4.BOLTS & NUTS").rename(world["library"] / "moved away")  # its folder is gone from the old place
    put_back(world, nested["id"])
    assert (world["library"] / "1.4.BOLTS & NUTS" / "other.stl").is_file()  # made again


def test_put_back_into_a_taken_place_asks_then_restores_under_a_new_name(world):
    item = trash(world, "TOP.stl")
    (world["library"] / "TOP.stl").write_bytes(b"a new top")
    with pytest.raises(library_ops.LibraryError) as error:
        put_back(world, item["id"])
    assert error.value.status == 409 and library_ops.list_trash(world["backup"])  # still in the Trash
    back = put_back(world, item["id"], "rename")
    assert back["path"] == "TOP (restored).stl" and back["renamed"] is True
    assert (world["library"] / "TOP.stl").read_bytes() == b"a new top" and (world["library"] / "TOP (restored).stl").read_bytes() == b"top"


def test_the_registry_entry_goes_with_the_trashed_file_and_comes_back(world):
    do(world, "TOP.stl", "TOP2.stl")  # backed up and registered
    registry_file = world["backup"] / ".rasterfaster" / "registry.json"
    assert list(json.loads(registry_file.read_text())) == ["TOP2.stl"]
    item = trash(world, "TOP2.stl")
    assert json.loads(registry_file.read_text()) == {}
    put_back(world, item["id"])
    assert list(json.loads(registry_file.read_text())) == ["TOP2.stl"]
    assert do(world, "TOP2.stl", "TOP3.stl")["backup"] is None  # still not backed up a second time


def test_delete_immediately_and_empty_trash_remove_for_good(world):
    first, second, third = trash(world, "TOP.stl"), trash(world, "1.4.BOLTS & NUTS/other.stl"), trash(world, "1.4.BOLTS & NUTS")
    assert library_ops.delete_immediately(world["backup"], first["id"]) == 1
    assert not (world["backup"] / "_TRASH" / first["id"]).exists() and len(library_ops.list_trash(world["backup"])) == 2
    assert library_ops.delete_immediately(world["backup"], None) == 2
    assert library_ops.list_trash(world["backup"]) == [] and not any((world["backup"] / "_TRASH").iterdir())
    with pytest.raises(library_ops.LibraryError) as error:
        library_ops.delete_immediately(world["backup"], second["id"])
    assert error.value.status == 404


def test_trash_refuses_the_root_outside_paths_missing_things_and_other_files(world):
    for path, status in [("", 403), ("../outside.stl", 403), ("nope.stl", 404)]:
        with pytest.raises(library_ops.LibraryError) as error:
            trash(world, path)
        assert error.value.status == status
    with pytest.raises(library_ops.LibraryError):
        trash(world, "notes.txt")
    with pytest.raises(library_ops.LibraryError) as error:
        put_back(world, "no-such-id")
    assert error.value.status == 404


def test_trash_is_logged(world):
    item = trash(world, "TOP.stl")
    put_back(world, item["id"])
    log = json.loads((world["backup"] / ".rasterfaster" / "log.json").read_text())
    assert [(e["kind"], e["status"]) for e in log] == [("trash-file", "done"), ("put-back", "done")]


def test_api_trash_round_trip(client, world):
    dry = client.post("/api/library/trash", params={"dryRun": True}, json={"path": "TOP.stl"}).json()
    assert dry["documents"] == {"d1.json": 1} and (world["library"] / "TOP.stl").is_file()
    done = client.post("/api/library/trash", json={"path": "TOP.stl"}).json()
    assert not (world["library"] / "TOP.stl").exists() and client.get("/api/library/trash").json()[0]["id"] == done["id"]
    assert client.post(f"/api/library/trash/{done['id']}/put-back").json()["path"] == "TOP.stl"
    again = client.post("/api/library/trash", json={"path": "TOP.stl"}).json()
    assert client.delete(f"/api/library/trash/{again['id']}").json() == {"removed": 1}
    client.post("/api/library/trash", json={"path": "1.4.BOLTS & NUTS/other.stl"})
    assert client.delete("/api/library/trash").json() == {"removed": 1} and client.get("/api/library/trash").json() == []
    assert client.post("/api/library/trash", json={"path": "../x"}).status_code == 403
    assert client.post("/api/library/trash/nope/put-back").status_code == 404


# --- batch trash (multi-select) --------------------------------------------------------------------------------------------------

def test_collapse_nested_keeps_only_the_folder_and_drops_duplicates():
    paths = ["a/b/c.stl", "a", "a/x.stl", "z.stl", "z.stl", "ab/q.stl", "/y/"]
    assert library_ops.collapse_nested(paths) == ["a", "z.stl", "ab/q.stl", "y"]  # "ab/q.stl" is not inside "a"


def test_trash_batch_moves_everything_under_one_batch_id(world):
    result = library_ops.trash_batch(world["library"], world["backup"], world["documents"], ["TOP.stl", "1.4.BOLTS & NUTS/other.stl", "1.4.BOLTS & NUTS/Long old name (1).stl"])
    assert result["failed"] == [] and len(result["results"]) == 3
    assert {r["path"] for r in result["results"]} == {"TOP.stl", "1.4.BOLTS & NUTS/other.stl", "1.4.BOLTS & NUTS/Long old name (1).stl"}
    items = library_ops.list_trash(world["backup"])
    assert len(items) == 3 and {i["batchId"] for i in items} == {result["batchId"]}
    log = json.loads((world["backup"] / ".rasterfaster" / "log.json").read_text())
    assert {e["batchId"] for e in log} == {result["batchId"]}


def test_trash_batch_treats_a_folder_and_its_contents_as_the_folder(world):
    result = library_ops.trash_batch(world["library"], world["backup"], world["documents"], ["1.4.BOLTS & NUTS/other.stl", "1.4.BOLTS & NUTS", "TOP.stl"])
    assert sorted(r["path"] for r in result["results"]) == ["1.4.BOLTS & NUTS", "TOP.stl"]
    assert len(library_ops.list_trash(world["backup"])) == 2


def test_trash_batch_dry_run_sums_the_documents_and_moves_nothing(world):
    result = library_ops.trash_batch(world["library"], world["backup"], world["documents"], ["1.4.BOLTS & NUTS/other.stl", "TOP.stl"], dryRun=True)
    assert result["batchId"] is None and result["documents"] == {"d1.json": 2}
    assert (world["library"] / "TOP.stl").is_file() and not world["backup"].exists()


def test_trash_batch_with_a_bad_item_moves_nothing(world):
    for bad, status in [("nope.stl", 404), ("../outside.stl", 403)]:
        with pytest.raises(library_ops.LibraryError) as error:
            library_ops.trash_batch(world["library"], world["backup"], world["documents"], ["TOP.stl", bad])
        assert error.value.status == status
    assert (world["library"] / "TOP.stl").is_file() and not world["backup"].exists()
    with pytest.raises(library_ops.LibraryError):
        library_ops.trash_batch(world["library"], world["backup"], world["documents"], [])


def test_api_trash_batch_and_put_everything_back(client, world):
    done = client.post("/api/library/trash-batch", json={"paths": ["TOP.stl", "1.4.BOLTS & NUTS/other.stl"]}).json()
    assert len(done["results"]) == 2 and not (world["library"] / "TOP.stl").exists()
    for item in done["results"]:
        assert client.post(f"/api/library/trash/{item['id']}/put-back").status_code == 200
    assert (world["library"] / "TOP.stl").is_file() and (world["library"] / "1.4.BOLTS & NUTS" / "other.stl").is_file()
    assert client.post("/api/library/trash-batch", json={"paths": []}).status_code == 422
    assert client.post("/api/library/trash-batch", params={"dryRun": True}, json={"paths": ["TOP.stl"]}).json()["documents"] == {"d1.json": 1}
