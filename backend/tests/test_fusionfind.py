import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import fusionfind  # (first: it puts scripts/ on the path for f3dsearch)
import f3dsearch
import main


@pytest.fixture
def fusion(tmp_path: Path, monkeypatch):
    """A Fusion folder with two dummy .f3d files, a private index file, and no Fusion cache: nothing of the real Fusion setup is touched."""
    folder = tmp_path / "FUSION360"
    (folder / ".meta").mkdir(parents=True)
    (folder / "RF11 - work_v3.f3d").write_bytes(b"a")
    (folder / "RF4_v2.f3d").write_bytes(b"bb")
    (folder / ".meta" / "RF11 - work_v3.tree.json").write_text(json.dumps({"tree": {"name": "RF11 - work", "children": [{"component": "SWITCHING", "children": [{"component": "work-SWITCHING POWER SUPPLY", "children": []}]}, {"component": "TOETER BACKPLANE", "children": []}]}}))
    monkeypatch.setenv("RF_FUSION", str(folder))
    monkeypatch.setattr(f3dsearch, "indexFile", tmp_path / "index" / "f3d-index.json")
    monkeypatch.setattr(f3dsearch, "cache_folders", lambda: [])
    names = {"RF11 - work_v3.f3d": ["work-SWITCHING POWER SUPPLY", "TOETER BACKPLANE"], "RF4_v2.f3d": ["TOETER", "BOLT_S3_BLIND"]}
    monkeypatch.setattr(f3dsearch, "design_names", lambda file: names[file.name])
    return TestClient(main.app)


def wait_for_index(client):
    assert client.post("/api/fusion/index").status_code == 200
    for _ in range(100):
        state = client.get("/api/fusion/status").json()
        if state["state"] != "running":
            return state
        time.sleep(0.05)
    raise AssertionError("the index run did not finish")


def test_queries_come_from_the_component_in_the_file_name():
    assert fusionfind.queries_for("11.25.RENOO_TIMER_RF11 - work v199_work-SWITCHING POWER SUPPLY.stl") == ["work-SWITCHING POWER SUPPLY", "11.25.RENOO_TIMER_RF11 - work v199_work-SWITCHING POWER SUPPLY"]
    assert fusionfind.queries_for("1.4.BOLTS & NUTS_RF1 v245_BOLTS MODELS_RF6 v189_BOLT_S2 2mm EMBEDDED (1).stl")[:2] == ["BOLT_S2 2mm EMBEDDED", "BOLTS MODELS_RF6 v189_BOLT_S2 2mm EMBEDDED"]  # the deepest component first
    assert fusionfind.queries_for("1.1 - PLATE - 3x4 - BLIND.stl") == ["1.1 - PLATE - 3x4 - BLIND"]
    assert fusionfind.queries_for("x_RF1 v1_CORNER LEFT 3h (2) (1).stl")[0] == "CORNER LEFT 3h"  # numbers in brackets are left off
    assert fusionfind.queries_for("work-SWITCHING POWER SUPPLY copy.stl") == ["work-SWITCHING POWER SUPPLY"]


def test_nothing_is_found_before_the_index_exists(fusion):
    assert fusion.get("/api/fusion/find", params={"path": "A/x.stl"}).status_code == 409
    status = fusion.get("/api/fusion/status").json()
    assert status["indexed"] == 0 and status["pending"] == 2 and status["folderExists"]


def test_index_then_find_a_part(fusion):
    state = wait_for_index(fusion)
    assert state["state"] == "done" and state["indexed"] == 2 and state["pending"] == 0
    found = fusion.get("/api/fusion/find", params={"path": "MOUNTS/11.25.RENOO_TIMER_RF11 - work v199_work-SWITCHING POWER SUPPLY.stl"}).json()
    assert found["found"] and found["query"] == "work-SWITCHING POWER SUPPLY"
    assert [d["design"] for d in found["designs"]] == ["RF11 - work_v3"] and found["designs"][0]["exact"]
    match = found["designs"][0]["matches"][0]
    assert match["name"] == "work-SWITCHING POWER SUPPLY" and match["exact"] and match["places"] == ["SWITCHING"]  # where it sits, from the hierarchy file
    assert found["designs"][0]["path"].endswith("RF11 - work_v3.f3d") and found["designs"][0]["source"] == "local"
    toeter = fusion.get("/api/fusion/find", params={"path": "a/4.1.BAUKLANK DADA_RF4 v168_TOETER.stl"}).json()
    assert [d["design"] for d in toeter["designs"]] == ["RF4_v2", "RF11 - work_v3"]  # the exact name first, then the design where it is part of a longer name
    nothing = fusion.get("/api/fusion/find", params={"path": "x/NO SUCH COMPONENT.stl"}).json()
    assert nothing["found"] is False and nothing["designs"] == []


def test_a_new_file_is_pending_until_it_is_indexed(fusion):
    wait_for_index(fusion)
    folder = Path(fusionfind.fusion_folder())
    (folder / "NEW_v1.f3d").write_bytes(b"ccc")
    assert fusion.get("/api/fusion/status").json()["pending"] == 1  # the search still works with what is known; the page offers to update
    assert fusion.get("/api/fusion/find", params={"path": "x/TOETER.stl"}).status_code == 200


def test_reveal_only_shows_indexed_files(fusion):
    wait_for_index(fusion)
    assert fusion.post("/api/fusion/reveal", json={"path": "/etc/hosts"}).status_code == 404
