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
