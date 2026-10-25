import re
from xml.etree import ElementTree

import numpy as np
import pytest
from fastapi.testclient import TestClient

import export3mf
import main
import svgexport
from test_export3mf import box_stl, items_and_stls

SVG = "{http://www.w3.org/2000/svg}"


def build(items=None, stls=None):
    default_items, default_stls = items_and_stls()
    stls = stls or default_stls
    return svgexport.build_svg({"name": "Doc & <co>", "items": items or default_items}, stls.__getitem__)


def numbers(path_d: str) -> np.ndarray:
    return np.array(re.findall(r"-?\d+\.?\d*", path_d), dtype=float)


def test_box_feature_edges_top_view():
    mesh = export3mf.read_stl(box_stl(40, 30, 10))
    visible, hidden = svgexport.feature_edges(mesh.vertices, mesh.triangles, np.array([0.0, 0.0, 1.0]))
    assert len(visible) + len(hidden) == 12  # all 12 box edges are sharp
    heights = lambda pairs: sorted(tuple(sorted(mesh.vertices[v][2] for v in pair)) for pair in pairs)
    assert heights(visible).count((10.0, 10.0)) == 4  # the four edges around the top face
    assert heights(hidden).count((0.0, 0.0)) == 4  # the four bottom edges face away from the viewer


def test_flat_coplanar_faces_do_not_make_lines():
    mesh = export3mf.read_stl(box_stl(10, 10, 10))
    visible, hidden = svgexport.feature_edges(mesh.vertices, mesh.triangles, np.array([0.0, 0.0, 1.0]))
    assert len(visible) + len(hidden) == 12  # the diagonals splitting each square face are not drawn (12 box edges only)


def test_svg_is_well_formed_with_three_views_and_legend():
    root = ElementTree.fromstring(build())
    ids = {g.get("id") for g in root.iter(f"{SVG}g")}
    assert {"top", "front", "right", "legend", "top-1", "front-3", "right-2"} <= ids
    assert root.find(f"{SVG}title").text == "Doc & <co>"
    assert root.get("width").endswith("mm")
    legend = "".join(root.find(f".//{SVG}g[@id='legend']").itertext())
    assert "Small \"one\"" in legend and "Overall" in legend


def test_top_view_extent_matches_part_size():
    items = [{"id": "a", "path": "b.stl", "name": "B", "color": 0xFF0000, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}]
    root = ElementTree.fromstring(build(items, {"b.stl": box_stl(40, 30, 10)}))
    edges = root.find(f".//{SVG}g[@id='top-1']").findall(f"{SVG}path")
    coords = np.concatenate([numbers(p.get("d")) for p in edges]).reshape(-1, 2)
    assert coords[:, 0].max() - coords[:, 0].min() == pytest.approx(40, abs=0.2)
    assert coords[:, 1].max() - coords[:, 1].min() == pytest.approx(30, abs=0.2)


def test_empty_document_rejected():
    with pytest.raises(ValueError):
        svgexport.build_svg({"name": "x", "items": []}, lambda p: b"")


def test_svg_endpoint(tmp_path, monkeypatch):
    library = tmp_path / "lib"
    library.mkdir()
    for name, data in items_and_stls()[1].items():
        (library / name).write_bytes(data)
    monkeypatch.setattr(main, "libraryRoot", library.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    document = client.post("/api/documents", json={"name": "My Box", "items": items_and_stls()[0]}).json()
    response = client.get(f"/api/documents/{document['id']}/export.svg")
    assert response.status_code == 200 and response.headers["content-type"].startswith("image/svg+xml")
    assert 'filename="My_Box.svg"' in response.headers["content-disposition"]
    ElementTree.fromstring(response.text)
    empty = client.post("/api/documents", json={"name": "e"}).json()
    assert client.get(f"/api/documents/{empty['id']}/export.svg").status_code == 422
