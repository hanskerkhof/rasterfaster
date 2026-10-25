import json
import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

import blenderexport
import main
from test_export3mf import box_stl, items_and_stls


def parse_glb(data: bytes):
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2 and length == len(data)
    jsonLength, jsonType = struct.unpack_from("<II", data, 12)
    assert jsonType == 0x4E4F534A
    gltf = json.loads(data[20:20 + jsonLength])
    binLength, binType = struct.unpack_from("<II", data, 20 + jsonLength)
    assert binType == 0x004E4942 and 28 + jsonLength + binLength == len(data)
    return gltf, data[28 + jsonLength:]


def read_accessor(gltf, blob, index):
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    dtype = {5126: "<f4", 5125: "<u4"}[accessor["componentType"]]
    return np.frombuffer(blob, dtype=dtype, count=accessor["count"] * width, offset=view["byteOffset"]).reshape(accessor["count"], width)


def test_parts_are_placed_in_document_coordinates_in_metres_and_y_up():
    items, stls = items_and_stls()
    gltf, blob = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False))
    assert len(gltf["meshes"]) == 2 and len(gltf["nodes"]) == 3 and "cameras" not in gltf  # the part used twice shares a mesh
    node = next(n for n in gltf["nodes"] if n["name"] == "Small two")
    positions = read_accessor(gltf, blob, gltf["meshes"][node["mesh"]]["primitives"][0]["attributes"]["POSITION"])
    matrix = np.array(node["matrix"]).reshape(4, 4).T
    world = positions @ matrix[:3, :3].T + matrix[:3, 3]
    # document box 10 x 20 x 30 mm at (20, 0, 0) -> glTF (x, z, -y) in metres
    assert np.allclose(world.min(axis=0), [0.020, 0.0, -0.020], atol=1e-6)
    assert np.allclose(world.max(axis=0), [0.030, 0.030, 0.0], atol=1e-6)


def test_camera_follows_a_closed_looping_animation():
    items, stls = items_and_stls()
    gltf, blob = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__))
    assert gltf["cameras"][0]["type"] == "perspective"
    assert {n["name"] for n in gltf["nodes"]} >= {"Fly-around camera", "Camera path"}
    sampler = gltf["animations"][0]["samplers"]
    times = read_accessor(gltf, blob, sampler[0]["input"])[:, 0]
    translation = read_accessor(gltf, blob, sampler[0]["output"])
    rotation = read_accessor(gltf, blob, sampler[1]["output"])
    assert times[0] == 0 and times[-1] == blenderexport.flightLoopSeconds
    assert np.allclose(translation[0], translation[-1], atol=1e-5) and np.allclose(rotation[0], rotation[-1], atol=1e-5)
    assert np.allclose(np.linalg.norm(rotation, axis=1), 1, atol=1e-5)
    # the camera looks at the assembly: its forward axis (-Z rotated) points from the eye towards the middle of the parts
    q = rotation[0]
    x, y, z, w = q
    forward = -np.array([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)])
    centre = np.array([0.0475, 0.015, -0.0225])  # roughly the middle of the assembly in glTF axes
    assert float(forward @ (centre - translation[0]) / np.linalg.norm(centre - translation[0])) > 0.95


def test_no_items_is_an_error():
    with pytest.raises(ValueError):
        blenderexport.build_glb({"name": "x", "items": []}, lambda p: b"")


def test_endpoint(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Blend me", "items": [item]}).json()
    response = client.get(f"/api/documents/{created['id']}/export.glb")
    assert response.status_code == 200 and response.headers["content-type"] == "model/gltf-binary"
    assert "Blend_me.glb" in response.headers["content-disposition"]
    parse_glb(response.content)
    assert "cameras" not in parse_glb(client.get(f"/api/documents/{created['id']}/export.glb", params={"camera": "false"}).content)[0]


def test_blend_endpoint(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Blend me", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: None)
    assert client.get(f"/api/documents/{created['id']}/export.blend").status_code == 503
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    monkeypatch.setattr(blenderexport, "build_blend", lambda glb, blender, studio=True: b"BLENDER-v500" + glb[:4])
    response = client.get(f"/api/documents/{created['id']}/export.blend")
    assert response.status_code == 200 and response.content.startswith(b"BLENDER") and "Blend_me.blend" in response.headers["content-disposition"]


def test_parts_are_black_pla_unless_colours_are_asked_for():
    items, stls = items_and_stls()
    document = {"name": "Doc", "items": items}
    gltf, _ = parse_glb(blenderexport.build_glb(document, stls.__getitem__, camera=False))
    assert [m["name"] for m in gltf["materials"]] == ["Black PLA"] and len(gltf["meshes"]) == 2
    assert "KHR_materials_clearcoat" in gltf["extensionsUsed"]
    coloured, _ = parse_glb(blenderexport.build_glb(document, stls.__getitem__, camera=False, colours=True))
    assert {m["name"] for m in coloured["materials"]} == {"colour_000001", "colour_000002"}
