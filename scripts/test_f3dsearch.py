import json
import struct
import sys
import zipfile
from pathlib import Path

import pytest

zstandard = pytest.importorskip("zstandard")
sys.path.insert(0, str(Path(__file__).parent))
import f3dsearch


def utf16(*texts: str) -> bytes:
    """Names the way Fusion stores them, between binary noise."""
    return b"".join(b"\x01\x02\xff" + text.encode("utf-16le") + b"\x00\x00\x03" for text in texts)


def make_f3d(path: Path, design_entry: str, texts: list[str], zstd: bool) -> None:
    data = utf16(*texts)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("Manifest.dat", b"x")
        archive.writestr(design_entry, zstandard.ZstdCompressor().compress(data) if zstd else data)
        archive.writestr("FusionAssetName[Active]/FusionBrowserSegmentType1/BulkStream.dat", utf16("not a design name"))
    if zstd:  # the zip module cannot write method 93: mark the design entry as zstd in its local and central headers
        raw = bytearray(path.read_bytes())
        for signature, at in ((b"PK\x03\x04", 8), (b"PK\x01\x02", 10)):
            start = 0
            while (found := raw.find(signature, start)) >= 0:
                nameLength = struct.unpack("<H", raw[found + (26 if signature == b"PK\x03\x04" else 28):][:2])[0]
                nameAt = found + (30 if signature == b"PK\x03\x04" else 46)
                if bytes(raw[nameAt:nameAt + nameLength]) == design_entry.encode():
                    raw[found + at:found + at + 2] = struct.pack("<H", 93)
                start = found + 4
        path.write_bytes(bytes(raw))


@pytest.mark.parametrize("zstd", [True, False])
@pytest.mark.parametrize("entry", ["FusionAssetName[Active]/Design1/BulkStream.dat", "FusionAssetName[Active]/FusionDesignSegmentType1/BulkStream.dat"])
def test_names_are_read_from_the_design_stream_only(tmp_path, entry, zstd):
    file = tmp_path / "Thing.0174a662-c7bf-40d2-9bcd-ad44cf10650f.f3d"
    make_f3d(file, entry, ["BALL JOINT WITH 2x2", "2.21.ESP32 devkit_RF2 MNTS ACTIVE v854_TOP - ALT IV", "0174a662-c7bf-40d2-9bcd-ad44cf10650f$", "ab"], zstd)
    names = f3dsearch.design_names(file)
    assert names == ["2.21.ESP32 devkit_RF2 MNTS ACTIVE v854_TOP - ALT IV", "BALL JOINT WITH 2x2"]  # no guid, no 2-letter noise, nothing from the browser stream
    assert f3dsearch.display_name(file) == "Thing"


def test_a_name_split_between_two_chunks_is_not_lost(tmp_path, monkeypatch):
    monkeypatch.setattr(f3dsearch, "chunkSize", 50)
    file = tmp_path / "Big.f3d"
    texts = [f"COMPONENT NUMBER {i:03d} IN A LONG NAME" for i in range(40)]
    make_f3d(file, "FusionAssetName[Active]/Design1/BulkStream.dat", texts, zstd=True)
    assert f3dsearch.design_names(file) == sorted(texts, key=str.lower)


def test_index_is_incremental_and_search_needs_every_word(tmp_path, monkeypatch):
    make_f3d(tmp_path / "A.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["8x11_BASEPLATE", "BALL JOINT"], zstd=False)
    make_f3d(tmp_path / "B.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["9x6_BASEPLATE", "BALL JOINT 2x2"], zstd=True)
    reports: list[str] = []
    index = f3dsearch.update_index({"files": {}}, [tmp_path], reports.append)
    assert len(reports) == 2 and len(index["files"]) == 2
    f3dsearch.update_index(index, [tmp_path], reports.append)
    assert len(reports) == 2  # nothing changed: nothing read again
    assert [h[0] for h in f3dsearch.search(index, ["baseplate", "8X11"])] == ["A"]
    assert [h[0] for h in f3dsearch.search(index, ["ball", "joint"])] == ["B", "A"] or {h[0] for h in f3dsearch.search(index, ["ball", "joint"])} == {"A", "B"}
    (tmp_path / "A.f3d").unlink()
    f3dsearch.update_index(index, [tmp_path], reports.append)
    assert list(index["files"]) == [str(tmp_path / "B.f3d")]  # a file that is gone leaves the index


def _entry(name, names, mtime=1):
    return {"name": name, "size": 1, "mtime": mtime, "names": names}


def test_versions_and_copies_of_one_design_are_one_design():
    assert f3dsearch.design_key("RF14_v3") == ("rf14", 3)
    assert f3dsearch.design_key("RF14 v12") == ("rf14", 12)
    assert f3dsearch.design_key("_RF14") == ("rf14", 0)
    assert f3dsearch.design_key("RF14") == ("rf14", 0)
    assert f3dsearch.design_key("my_v2_part") == ("my_v2_part", 0)


def test_search_shows_the_newest_version_that_has_a_match_and_says_what_is_hidden():
    index = {"files": {
        "/x/RF14_v1.f3d": _entry("RF14_v1", ["BALL JOINT", "BOLT A"]),
        "/x/RF14_v2.f3d": _entry("RF14_v2", ["BALL JOINT", "BOLT A"]),
        "/x/RF14_v10.f3d": _entry("RF14_v10", ["BALL JOINT"]),          # v10 is newer than v2 (a number, not text)
        "/x/OTHER.f3d": _entry("OTHER", ["BALL JOINT"]),
    }}
    hits = {h[0]: h for h in f3dsearch.search(index, ["ball"])}
    assert set(hits) == {"RF14_v10", "OTHER"}
    assert "2 older versions with a match hidden" in hits["RF14_v10"][3] and "RF14_v2" in hits["RF14_v10"][3]
    assert hits["OTHER"][3] == ""
    # a component that only older versions have: the newest version with a match is shown and the note says that v10 has none
    hits = f3dsearch.search(index, ["bolt"])
    assert [h[0] for h in hits] == ["RF14_v2"] and "newest version, RF14_v10, has no match" in hits[0][3]
    # with a name that is in v10 and also something only older versions have
    index["files"]["/x/RF14_v1.f3d"]["names"].append("BALL JOINT 2")
    note = {h[0]: h[3] for h in f3dsearch.search(index, ["ball"])}["RF14_v10"]
    assert "1 matching name only in older versions, e.g. BALL JOINT 2" in note


def test_all_versions_lists_every_file_with_a_match_and_a_cache_copy_loses_to_the_newer_export():
    index = {"files": {
        "/cache/W.login/F/_RF14.guid.f3d": _entry("_RF14", ["BALL JOINT"], mtime=1),
        "/exports/RF14.f3d": _entry("RF14", ["BALL JOINT"], mtime=2),
        "/exports/RF14_v1.f3d": _entry("RF14_v1", ["BALL JOINT"], mtime=3),
    }}
    assert sorted(h[0] for h in f3dsearch.search(index, ["ball"], all_versions=True)) == ["RF14", "RF14_v1", "_RF14"]
    assert [h[0] for h in f3dsearch.search(index, ["ball"])] == ["RF14_v1"]
    groups = f3dsearch.designs(index)
    assert [e["name"] for _, e in groups["rf14"]] == ["RF14_v1", "RF14", "_RF14"]  # the version first, then the newer file


def test_a_versions_folder_is_skipped_unless_it_is_given_itself(tmp_path):
    make_f3d(tmp_path / "RF14_v4.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["LATEST PART"], zstd=False)
    (tmp_path / "VERSIONS").mkdir()
    make_f3d(tmp_path / "VERSIONS" / "RF14_v1.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["OLD PART"], zstd=False)
    (tmp_path / "other").mkdir()
    make_f3d(tmp_path / "other" / "X.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["X PART"], zstd=False)
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    assert sorted(Path(k).name for k in index["files"]) == ["RF14_v4.f3d", "X.f3d"]       # VERSIONS is not searched
    index = f3dsearch.update_index(index, [tmp_path, tmp_path / "VERSIONS"], lambda message: None)
    assert sorted(Path(k).name for k in index["files"]) == ["RF14_v1.f3d", "RF14_v4.f3d", "X.f3d"]  # asked for explicitly: it is
    index = f3dsearch.update_index(index, [tmp_path], lambda message: None)
    assert sorted(Path(k).name for k in index["files"]) == ["RF14_v4.f3d", "X.f3d"]       # and forgotten again when it is not asked for


TREE = {"name": "(root)", "component": "(root)", "bodies": ["NUT PLATE", "[mesh] SCAN"], "children": [
    {"name": "14.2.NERO_BIANCO_CONTROL:1", "component": "14.2.NERO_BIANCO_CONTROL", "bodies": ["BUTTON", "NERO"], "children": [
        {"name": "letters:1", "component": "letters", "bodies": ["NERO", "NERO (1)"], "children": []}]},
    {"name": "BLACK HOLE SUN:1", "component": "BLACK HOLE SUN", "bodies": ["TOP"], "children": []}]}


def _sidecar(directory, stem, tree=TREE):
    (directory / ".meta").mkdir(exist_ok=True)
    (directory / ".meta" / (stem + ".tree.json")).write_text(json.dumps({"version": 1, "components": 3, "bodies": 7, "savedAt": "2026-10-27T10:00:00", "tree": tree}))


def test_places_say_where_every_name_sits():
    places = f3dsearch.places_in(TREE)
    assert places["NUT PLATE"] == ["(root)"] and places["SCAN"] == ["(root)"]           # a mesh body without its prefix
    assert places["letters"] == ["14.2.NERO_BIANCO_CONTROL"] and places["BLACK HOLE SUN"] == ["(root)"]
    assert places["NERO"] == ["14.2.NERO_BIANCO_CONTROL", "14.2.NERO_BIANCO_CONTROL › letters"]


def test_the_index_reads_the_sidecar_and_notices_when_only_it_changes(tmp_path):
    make_f3d(tmp_path / "RF14_v6.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO", "BUTTON"], zstd=False)
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    entry = next(iter(index["files"].values()))
    assert entry["places"] == {} and entry["treeMtime"] is None                          # no sidecar yet
    _sidecar(tmp_path, "RF14_v6")
    reports: list[str] = []
    f3dsearch.update_index(index, [tmp_path], reports.append)
    assert reports == ["hierarchy of RF14_v6: read"] and entry["places"]["BUTTON"] == ["14.2.NERO_BIANCO_CONTROL"]   # the .f3d itself was not read again
    (tmp_path / ".meta" / "RF14_v6.tree.json").unlink()
    f3dsearch.update_index(index, [tmp_path], reports.append)
    assert reports[-1] == "hierarchy of RF14_v6: removed" and entry["places"] == {}


def test_search_prints_where_a_name_is(tmp_path, capsys, monkeypatch):
    make_f3d(tmp_path / "RF14_v6.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO", "BUTTON"], zstd=False)
    _sidecar(tmp_path, "RF14_v6")
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    monkeypatch.setattr(f3dsearch, "load_index", lambda: index)
    f3dsearch.main(["search", "nero"])
    out = capsys.readouterr().out
    assert "NERO   in 14.2.NERO_BIANCO_CONTROL (+1 more places)" in out


def test_tree_command_prints_the_hierarchy(tmp_path, capsys, monkeypatch):
    make_f3d(tmp_path / "RF14_v6.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO"], zstd=False)
    make_f3d(tmp_path / "RF14_v7.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO"], zstd=False)   # newer, but without a hierarchy
    _sidecar(tmp_path, "RF14_v6")
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    monkeypatch.setattr(f3dsearch, "load_index", lambda: index)
    assert f3dsearch.main(["tree", "RF14"]) == 0
    out = capsys.readouterr().out
    assert "RF14_v6" in out and "(root)   [2 bodies]" in out                               # the newest design with a hierarchy file is used
    assert "├─ ▸ 14.2.NERO_BIANCO_CONTROL   [2 bodies, 1 sub-components]" in out and "│  └─ ▸ letters   [2 bodies]" in out and "└─ ▸ BLACK HOLE SUN" in out
    assert "· BUTTON" not in out                                                           # bodies only with --bodies
    f3dsearch.main(["tree", "RF14", "--bodies", "--depth", "1", "--limit", "1"])
    out = capsys.readouterr().out
    assert "· NUT PLATE" in out and "... 1 more bodies" in out and "letters" not in out
    assert f3dsearch.main(["tree", "nothing here"]) == 1


def test_a_design_without_any_hierarchy_says_how_to_get_one(tmp_path, capsys, monkeypatch):
    make_f3d(tmp_path / "RF14_v6.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO"], zstd=False)
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    monkeypatch.setattr(f3dsearch, "load_index", lambda: index)
    assert f3dsearch.main(["tree", "RF14_v6"]) == 1
    assert "No hierarchy is stored for RF14_v6" in capsys.readouterr().out


def test_a_design_with_a_hierarchy_is_searched_by_its_component_and_body_names_only(tmp_path):
    make_f3d(tmp_path / "RF14_v6.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["NERO", "( 13 / 2 ) * 1 mm NERO", "BUTTON"], zstd=False)
    make_f3d(tmp_path / "OLD_v1.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["( 13 / 2 ) * 1 mm NERO"], zstd=False)   # no hierarchy file: every string counts
    _sidecar(tmp_path, "RF14_v6")
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    found = {h[0]: h[2] for h in f3dsearch.search(index, ["nero"])}
    assert found["RF14_v6"] == ["14.2.NERO_BIANCO_CONTROL", "NERO", "NERO (1)"]             # from the hierarchy: not the expression
    assert found["OLD_v1"] == ["( 13 / 2 ) * 1 mm NERO"]
    raw = {h[0]: h[2] for h in f3dsearch.search(index, ["nero"], raw=True)}
    assert "( 13 / 2 ) * 1 mm NERO" in raw["RF14_v6"]


def _node(name, bodies=(), children=()):
    return {"name": name + ":1", "component": name, "bodies": list(bodies), "children": list(children)}


def test_compare_trees_finds_added_removed_and_moved():
    before = {"name": "(root)", "component": "(root)", "bodies": ["PLATE", "OLD PART"], "children": [
        _node("CONTROL", ["BUTTON", "NERO"], [_node("letters", ["NERO", "NERO (1)"])]), _node("SUN", ["TOP"])]}
    after = {"name": "(root)", "component": "(root)", "bodies": ["PLATE", "BUTTON"], "children": [        # BUTTON moved to the root, OLD PART gone
        _node("CONTROL", ["NERO", "NEW"], [_node("letters", ["NERO", "NERO (1)", "NERO (2)"])]), _node("SUN", ["TOP"]), _node("DISPLAY", ["LCD"])]}
    changes = f3dsearch.compare_trees(before, after)
    assert [(k, n) for k, _, n in changes["added"]] == [("component", "DISPLAY"), ("body", "LCD"), ("body", "NERO (2)"), ("body", "NEW")]
    assert [n for _, _, n in changes["removed"]] == ["OLD PART"]
    assert changes["moved"] == [("body", "BUTTON", "CONTROL", "(root)")]
    assert f3dsearch.compare_trees(before, before) == {"added": [], "removed": [], "moved": []}


def test_diff_command_compares_two_versions_by_name_or_the_two_newest(tmp_path, capsys, monkeypatch):
    older = {"name": "(root)", "component": "(root)", "bodies": ["PLATE"], "children": [_node("CONTROL", ["BUTTON", "OLD"])]}
    newer = {"name": "(root)", "component": "(root)", "bodies": ["PLATE"], "children": [_node("CONTROL", ["BUTTON", "NEW"])]}
    for stem, tree, mtime in (("RF14_v5", older, 1), ("RF14_v6", newer, 2), ("RF14_v7", newer, 3)):
        make_f3d(tmp_path / f"{stem}.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["X"], zstd=False)
        _sidecar(tmp_path, stem, tree)
    make_f3d(tmp_path / "LONELY.f3d", "FusionAssetName[Active]/Design1/BulkStream.dat", ["X"], zstd=False)
    index = f3dsearch.update_index({"files": {}}, [tmp_path], lambda message: None)
    for key, entry in index["files"].items():                                              # the files were written within one second
        entry["mtime"] = {"RF14_v5": 1, "RF14_v6": 2, "RF14_v7": 3}.get(entry["name"], 0)
    monkeypatch.setattr(f3dsearch, "load_index", lambda: index)
    assert f3dsearch.main(["diff", "RF14_v5", "RF14_v6"]) == 0
    out = capsys.readouterr().out
    assert "RF14_v5 → RF14_v6" in out and "+ added (1)" in out and "· NEW   in CONTROL" in out and "- removed (1)" in out and "· OLD   in CONTROL" in out
    assert f3dsearch.main(["diff", "RF14"]) == 0                                           # the two newest with a hierarchy: v6 -> v7
    out = capsys.readouterr().out
    assert "RF14_v6 → RF14_v7" in out and "no difference" in out
    assert f3dsearch.main(["diff", "RF14_v6", "NOPE"]) == 1 and "Not indexed: NOPE" in capsys.readouterr().out
    assert f3dsearch.main(["diff", "LONELY"]) == 1 and "needs two" in capsys.readouterr().out
    assert f3dsearch.main(["diff", "a", "b", "c"]) == 1
