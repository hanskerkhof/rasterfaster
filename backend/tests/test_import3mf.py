import io
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import export3mf
import import3mf
import main
from test_export3mf import box_stl


def make_library(tmp_path: Path) -> Path:
    library = tmp_path / "lib"
    (library / "a").mkdir(parents=True)
    (library / "b").mkdir()
    (library / "a" / "big.stl").write_bytes(box_stl(40, 40, 10))
    (library / "a" / "small.stl").write_bytes(box_stl(10, 20, 30))
    (library / "b" / "small.stl").write_bytes(box_stl(10, 20, 30))      # the same name in two folders, the same shape
    (library / "b" / "other.stl").write_bytes(box_stl(7, 8, 9))
    return library


def document(items):
    return {"name": "Round trip", "items": items}


def sample_items():
    return [
        {"id": "a", "path": "a/big.stl", "name": "big", "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]},
        {"id": "b", "path": "a/small.stl", "name": "small", "color": 2, "position": [100, 40, 8], "rotation": [0, 0, 0.7071067811865476, 0.7071067811865476]},
        {"id": "c", "path": "b/other.stl", "name": "other", "color": 3, "position": [20, 0, 0], "rotation": [0, 0, 0, 1]},
    ]


def export(library: Path, items) -> bytes:
    return export3mf.build_3mf(document(items), lambda path: (library / path).read_bytes())


def test_round_trip_keeps_paths_rotations_and_relative_layout(tmp_path):
    library = make_library(tmp_path)
    result = import3mf.import_3mf(export(library, sample_items()), import3mf.index_library(library))
    assert [i["path"] for i in result.items] == ["a/big.stl", "a/small.stl", "b/other.stl"]
    assert all(line["matchedBy"] == "path" for line in result.report)
    original = np.array([i["position"] for i in sample_items()])
    imported = np.array([i["position"] for i in result.items])
    assert np.allclose(imported - imported[0], original - original[0], atol=1e-3)
    assert np.allclose(result.items[1]["rotation"], [0, 0, 0.7071068, 0.7071068], atol=1e-5)
    assert all(abs(i["position"][0] % 20) < 1e-3 and abs(i["position"][1] % 20) < 1e-3 for i in result.items[:1])  # back on the grid


def test_old_export_without_path_is_found_by_name_and_shape(tmp_path):
    library = make_library(tmp_path)
    data = export(library, sample_items())
    stripped = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(stripped, "w") as target:
        for entry in source.namelist():
            text = source.read(entry)
            if entry.endswith("3dmodel.model"):
                import re
                text = re.sub(rb' partnumber="[^"]*" type="model"', b' type="model"', text)
            target.writestr(entry, text)
    result = import3mf.import_3mf(stripped.getvalue(), import3mf.index_library(library))
    by = {line["path"]: line["matchedBy"] for line in result.report}
    assert by["a/big.stl"] == "name" and by["b/other.stl"] == "name"
    assert by["a/small.stl"] == "name-ambiguous"      # two identical copies of small.stl


def test_unknown_name_is_found_by_shape_and_missing_keeps_the_3mf_geometry(tmp_path):
    library = make_library(tmp_path)
    items = [{"id": "a", "path": "b/other.stl", "name": "renamed", "color": 1, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}]
    data = export3mf.build_3mf(document(items), lambda path: (library / path).read_bytes())
    data = _rewrite_model(data, lambda text: text.replace(b'partnumber="b/other.stl"', b'').replace(b'name="renamed"', b'name="nothing like it"'))
    result = import3mf.import_3mf(data, import3mf.index_library(library))
    assert result.report[0]["matchedBy"] == "shape" and result.items[0]["path"] == "b/other.stl"
    (library / "b" / "other.stl").unlink()
    result = import3mf.import_3mf(data, import3mf.index_library(library))
    assert result.report[0]["matchedBy"] == "embedded" and result.items[0]["name"] == "nothing like it"
    path = result.items[0]["path"]
    assert path in result.embedded and path.startswith("embedded:") and result.embedded[path][84:] and len(result.embedded[path]) == 84 + 50 * 12


def _rewrite_model(data: bytes, change) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(out, "w") as target:
        for entry in source.namelist():
            body = source.read(entry)
            target.writestr(entry, change(body) if entry.endswith("3dmodel.model") else body)
    return out.getvalue()


def test_bambu_style_package_with_components_and_a_scaled_primitive(tmp_path):
    library = make_library(tmp_path)
    box = export3mf.read_stl(box_stl(10, 20, 30))
    vertices = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in (box.vertices - box.vertices.mean(axis=0)).tolist())
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in box.triangles.tolist())
    mesh = f'<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object></resources><build/></model>'
    p = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'
    main_model = (f'<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" {p}><resources>'
                  '<object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>'
                  '<object id="3" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></components></object>'
                  '</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 15"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 200 100 15"/></build></model>')
    config = '<config><object id="2"><metadata key="name" value="small"/><part id="1"><metadata key="name" value="small.stl"/></part></object></config>'
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as package:
        package.writestr("3D/3dmodel.model", main_model)
        package.writestr("3D/Objects/object_1.model", mesh)
        package.writestr("Metadata/model_settings.config", config)
    result = import3mf.import_3mf(out.getvalue(), import3mf.index_library(library))
    assert len(result.items) == 1 and result.items[0]["path"] in ("a/small.stl", "b/small.stl")
    assert result.items[0]["position"][2] == pytest.approx(0.0, abs=1e-3)   # 15 mm up, minus the box's half height of 15
    assert any(line["matchedBy"] == "skipped" for line in result.report)       # the x2 scaled one


def test_not_a_3mf_is_refused():
    index = import3mf.LibraryIndex({}, {}, lambda path: b"")
    with pytest.raises(import3mf.ThreeMfError):
        import3mf.import_3mf(b"hello", index)


def test_import_endpoint(tmp_path, monkeypatch):
    library = make_library(tmp_path)
    monkeypatch.setattr(main, "libraryRoot", library.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    response = client.post("/api/documents/import-3mf", content=export(library, sample_items()), headers={"Content-Type": "model/3mf"})
    assert response.status_code == 201
    body = response.json()
    assert body["document"]["name"] == "Round trip (imported)" and len(body["document"]["items"]) == 3
    assert client.get(f"/api/documents/{body['document']['id']}").status_code == 200
    assert client.post("/api/documents/import-3mf", content=b"nope").status_code == 422
    assert client.post("/api/documents/import-3mf", content=b"").status_code == 422


def test_embedded_geometry_is_stored_served_and_not_missing(tmp_path, monkeypatch):
    library = make_library(tmp_path)
    monkeypatch.setattr(main, "libraryRoot", library.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    data = export(library, sample_items())
    data = _rewrite_model(data, lambda text: text.replace(b'partnumber="b/other.stl"', b"").replace(b'name="other"', b'name="gone.stl"'))
    (library / "b" / "other.stl").unlink()
    body = client.post("/api/documents/import-3mf", content=data).json()
    embedded = [i for i in body["document"]["items"] if i["path"].startswith("embedded:")]
    assert len(embedded) == 1 and embedded[0]["name"] == "gone"
    path = embedded[0]["path"]
    assert client.get("/api/file", params={"path": path}).content[84:]            # served like a library file
    assert client.post("/api/library/missing", json={"paths": [path, "b/other.stl"]}).json() == {"missing": ["b/other.stl"]}
    assert client.get(f"/api/documents/{body['document']['id']}/export.3mf").status_code == 200   # the exports find it too
    assert client.get("/api/file", params={"path": "embedded:../../etc/passwd.stl"}).status_code in (403, 404)
