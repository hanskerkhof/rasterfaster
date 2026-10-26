import io
import re
import struct
import zipfile
from xml.etree import ElementTree
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import export3mf
import main


def box_stl(x: float, y: float, z: float) -> bytes:
    """Binary STL of an axis-aligned box with its min corner at the origin."""
    c = np.array([[i, j, k] for i in (0, x) for j in (0, y) for k in (0, z)], dtype=np.float32)
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    out = bytearray(b"\0" * 80 + struct.pack("<I", len(faces)))
    for a, b, d in faces:
        out += struct.pack("<12fH", 0, 0, 0, *c[a], *c[b], *c[d], 0)
    return bytes(out)


def items_and_stls():
    items = [
        {"id": "a", "path": "big.stl", "name": "Big", "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]},
        # rotated 90° about Z: a 10x20x30 box becomes 20x10x30
        {"id": "b", "path": "small.stl", "name": 'Small "one"', "color": 2, "position": [100, 40, 8], "rotation": [0, 0, 0.7071067811865476, 0.7071067811865476]},
        {"id": "c", "path": "small.stl", "name": "Small two", "color": 2, "position": [20, 0, 0], "rotation": [0, 0, 0, 1]},
    ]
    stls = {"big.stl": box_stl(40, 40, 10), "small.stl": box_stl(10, 20, 30)}
    return items, stls


def parse(data: bytes):
    package = zipfile.ZipFile(io.BytesIO(data))
    assert set(package.namelist()) == {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"}
    model = package.read("3D/3dmodel.model").decode()
    objects = {}
    for objectId, body in re.findall(r'<object id="(\d+)"[^>]*>(.*?)</object>', model, re.S):
        vertices = np.array(re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', body), dtype=float)
        objects[int(objectId)] = vertices
    build = [(int(i), np.array(t.split(), dtype=float)) for i, t in re.findall(r'<item objectid="(\d+)" transform="([^"]+)"', model)]
    return model, objects, build


def world_bounds(vertices: np.ndarray, transform: np.ndarray):
    matrix, translation = transform[:9].reshape(3, 3), transform[9:]
    world = vertices @ matrix + translation  # 3MF row-vector convention
    return world.min(axis=0), world.max(axis=0)


def test_read_stl_welds_vertices():
    mesh = export3mf.read_stl(box_stl(1, 2, 3))
    assert len(mesh.vertices) == 8 and len(mesh.triangles) == 12


def test_read_stl_ascii():
    text = b"solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n"
    mesh = export3mf.read_stl(text)
    assert len(mesh.vertices) == 3 and len(mesh.triangles) == 1


def test_assembly_layout_keeps_positions_and_centres_on_plate():
    items, stls = items_and_stls()
    model, objects, build = parse(export3mf.build_3mf({"name": "Doc & co", "items": items}, stls.__getitem__, 256))
    ns = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
    root = ElementTree.fromstring(model)  # well-formed even with & and " in names
    assert root.find("m:metadata", ns).text == "Doc & co"
    assert {o.get("name") for o in root.iterfind(".//m:object", ns)} == {"Big", 'Small "one"'}
    assert len(objects) == 2 and len(build) == 3  # parts used twice share one mesh
    bounds = [world_bounds(objects[i], t) for i, t in build]
    # relative placement is preserved (min corners at the document positions, minus the common shift)
    shift = bounds[0][0] - np.array(items[0]["position"])
    for (low, _), item in zip(bounds, items):
        assert np.allclose(low, np.array(item["position"]) + shift, atol=1e-3)
    # rotated part really is 20 x 10 x 30
    assert np.allclose(bounds[1][1] - bounds[1][0], [20, 10, 30], atol=1e-3)
    # whole assembly centred on the plate in XY, z untouched
    low = np.min([b[0] for b in bounds], axis=0)
    high = np.max([b[1] for b in bounds], axis=0)
    assert np.allclose((low + high)[:2] / 2, [128, 128], atol=1e-3) and shift[2] == pytest.approx(0)


def test_empty_document_is_rejected():
    with pytest.raises(ValueError):
        export3mf.build_3mf({"name": "x", "items": []}, lambda p: b"")


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    library = tmp_path / "lib"
    library.mkdir()
    for name, data in items_and_stls()[1].items():
        (library / name).write_bytes(data)
    monkeypatch.setattr(main, "libraryRoot", library.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    return TestClient(main.app)


def test_export_endpoint(client):
    items, _ = items_and_stls()
    document = client.post("/api/documents", json={"name": "My Box", "items": items}).json()
    response = client.get(f"/api/documents/{document['id']}/export.3mf")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("model/3mf")
    assert 'filename="My_Box-assembly.3mf"' in response.headers["content-disposition"]
    assert len(parse(response.content)[2]) == 3


def test_export_reports_missing_stl_and_empty_document(client):
    items, _ = items_and_stls()
    items[0]["path"] = "gone.stl"
    document = client.post("/api/documents", json={"name": "x", "items": items}).json()
    response = client.get(f"/api/documents/{document['id']}/export.3mf")
    assert response.status_code == 422 and "gone.stl" in response.json()["detail"]
    empty = client.post("/api/documents", json={"name": "e"}).json()
    assert client.get(f"/api/documents/{empty['id']}/export.3mf").status_code == 422


def test_parts_marked_do_not_export_are_left_out_and_not_even_read(client):
    items, _ = items_and_stls()
    items[1] = {**items[1], "noExport": True}  # the rotated "small" part
    items[2] = {**items[2], "path": "gone.stl", "noExport": True}  # a mock whose STL isn't in the library at all
    document = client.post("/api/documents", json={"name": "mock", "items": items}).json()
    assert [i["noExport"] for i in document["items"]] == [False, True, True]
    threemf = client.get(f"/api/documents/{document['id']}/export.3mf")
    assert threemf.status_code == 200
    _, objects, build = parse(threemf.content)
    assert len(build) == 1 and len(objects) == 1  # only "Big" remains
    svg = client.get(f"/api/documents/{document['id']}/export.svg")
    assert svg.status_code == 200 and "Small" not in svg.text and "Big" in svg.text


def test_export_with_every_part_excluded_is_refused(client):
    items, _ = items_and_stls()
    document = client.post("/api/documents", json={"name": "all mock", "items": [{**i, "noExport": True} for i in items]}).json()
    for kind in ("export.3mf", "export.svg"):
        response = client.get(f"/api/documents/{document['id']}/{kind}")
        assert response.status_code == 422 and "Do not export" in response.json()["detail"]
