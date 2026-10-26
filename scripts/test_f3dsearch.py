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
