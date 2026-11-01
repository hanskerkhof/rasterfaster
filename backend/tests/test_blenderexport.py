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


def test_dimmed_parts_get_a_translucent_material():
    items, stls = items_and_stls()
    items = [{**items[0], "muted": True}, items[1], {**items[2], "muted": True}]
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False))
    by_node = {n["name"]: gltf["materials"][gltf["meshes"][n["mesh"]]["primitives"][0]["material"]] for n in gltf["nodes"]}
    dimmed = by_node[items[0]["name"]]
    assert dimmed["alphaMode"] == "BLEND" and dimmed["pbrMetallicRoughness"]["baseColorFactor"][3] == blenderexport.dimmedAlpha
    solid = by_node[items[1]["name"]]
    assert "alphaMode" not in solid and solid["pbrMetallicRoughness"]["baseColorFactor"][3] == 1.0
    assert by_node[items[2]["name"]] is not solid and by_node[items[2]["name"]]["alphaMode"] == "BLEND"
    # with the document's colours a dimmed part gets its own translucent copy of the colour
    coloured, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False, colours=True))
    assert any(m["name"].endswith("_dimmed") and m["alphaMode"] == "BLEND" for m in coloured["materials"])
    assert any(not m["name"].endswith("_dimmed") and "alphaMode" not in m for m in coloured["materials"])


def camera_forward(rotation):
    x, y, z, w = rotation
    return -np.array([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)])


def test_default_camera_is_the_home_view_without_animation_or_path():
    items, stls = items_and_stls()
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__))
    assert gltf["cameras"][0]["type"] == "perspective" and "animations" not in gltf
    assert "Camera path" not in {n["name"] for n in gltf["nodes"]} and all(m["name"] != "Camera path" for m in gltf["meshes"])
    node = next(n for n in gltf["nodes"] if n.get("camera") == 0)
    eye = np.array(node["translation"])
    # looking at the middle of the parts (document (47.5, 15, 22.5) mm = glTF (x, z, -y)) from the +X, -Y, +Z side
    centre = np.array([0.0475, 0.0225, -0.015])
    to_centre = (centre - eye) / np.linalg.norm(centre - eye)
    assert float(camera_forward(node["rotation"]) @ to_centre) > 0.99
    assert eye[0] > centre[0] and eye[2] > centre[2] and eye[1] > centre[1]  # +X, -Y (glTF +Z), +Z (glTF +Y) in the document


def test_camera_follows_the_apps_view():
    items, stls = items_and_stls()
    view = blenderexport.parse_view("0,-1,0;50,20,10;240;persp")  # looking along +Y at (50, 20, 10) mm, 240 mm visible
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, view=view))
    node = next(n for n in gltf["nodes"] if n.get("camera") == 0)
    distance = 0.240 / 2 / np.tan(np.radians(blenderexport.fovDegrees) / 2)
    # document (50, 20 - distance, 10) mm -> glTF (x, z, -y)
    assert np.allclose(node["translation"], [0.050, 0.010, -(0.020 - distance)], atol=1e-6)
    assert np.allclose(camera_forward(node["rotation"]), [0, 0, -1], atol=1e-6)  # looking along +Y in the document = along -Z in glTF
    ortho, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, view=blenderexport.parse_view("1,0,0;0,0,0;100;ortho")))
    assert ortho["cameras"][0]["type"] == "orthographic" and abs(ortho["cameras"][0]["orthographic"]["ymag"] - 0.05) < 1e-9


@pytest.mark.parametrize("text", ["", "1,2;3,4,5;6;persp", "0,0,0;0,0,0;10;persp", "1,0,0;0,0,0;-5;persp", "1,0,0;0,0,0;10;fisheye", "a,b,c;0,0,0;10;persp"])
def test_bad_view_is_rejected(text):
    with pytest.raises(ValueError):
        blenderexport.parse_view(text)


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
    monkeypatch.setattr(blenderexport, "build_blend", lambda glb, blender, studio=True, light=None: b"BLENDER-v500" + glb[:4])
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


def test_zoomed_in_perspective_view_gets_its_narrow_field_of_view():
    items, stls = items_and_stls()
    view = blenderexport.parse_view("0,-1,0;50,20,10;240;persp;12")
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, view=view))
    assert abs(gltf["cameras"][0]["perspective"]["yfov"] - np.radians(12)) < 1e-9
    node = next(n for n in gltf["nodes"] if n.get("camera") == 0)
    assert abs(node["translation"][2] - -(0.020 - 0.240 / 2 / np.tan(np.radians(6)))) < 1e-6  # far away: same framing, flatter perspective
    assert blenderexport.parse_view("0,-1,0;0,0,0;10;persp")["fov"] == blenderexport.fovDegrees
    with pytest.raises(ValueError):
        blenderexport.parse_view("0,-1,0;0,0,0;10;persp;0")


def test_light_of_the_shaded_view_is_parsed():
    light = blenderexport.parse_light("0,0,5;100,20,30")
    assert np.allclose(light["direction"], [0, 0, 1]) and np.allclose(light["target"], [100, 20, 30])
    for bad in ("", "0,0,0;1,2,3", "1,2;3,4,5", "a,b,c;1,2,3"):
        try:
            blenderexport.parse_light(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} should be refused")


def test_blend_export_keeps_the_document_colours_unless_black_pla_is_asked_for(monkeypatch, tmp_path):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Colours", "items": [item]}).json()
    seen = []
    real = blenderexport.build_glb
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    monkeypatch.setattr(blenderexport, "build_glb", lambda document, load, camera=True, colours=False, view=None: seen.append(colours) or real(document, load, camera, colours, view))
    monkeypatch.setattr(blenderexport, "build_blend", lambda glb, blender, studio=True, light=None: b"BLENDER-v500")
    assert client.get(f"/api/documents/{created['id']}/export.blend").status_code == 200
    assert client.get(f"/api/documents/{created['id']}/export.blend?colours=false").status_code == 200
    assert seen == [True, False]


def test_light_can_aim_at_a_part_and_parts_carry_their_id():
    light = blenderexport.parse_light("0,0,1;part:abc-123_x")
    assert light["part"] == "abc-123_x" and light["target"] is None
    assert blenderexport.parse_light("0,0,1;")["part"] is None
    with pytest.raises(ValueError):
        blenderexport.parse_light("0,0,1;part:no spaces")
    items, stls = items_and_stls()
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False))
    assert [n["extras"]["itemId"] for n in gltf["nodes"] if "mesh" in n] == [i["id"] for i in items]


def test_render_endpoint_returns_a_png_and_checks_the_size(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Render me", "items": [item], "light": {"direction": [0, 0, 1], "targetId": "a"}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = {}
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24: seen.update(light=light, width=width, samples=samples) or b"\x89PNG-fake")
    response = client.get(f"/api/documents/{created['id']}/render.png", params={"width": 640, "samples": 8})
    assert response.status_code == 200 and response.headers["content-type"] == "image/png" and response.content.startswith(b"\x89PNG")
    assert seen["width"] == 640 and seen["samples"] == 8 and seen["light"]["part"] == "a"  # the light saved in the document is the key light
    assert client.get(f"/api/documents/{created['id']}/render.png", params={"width": 20}).status_code == 422
    monkeypatch.setattr(blenderexport, "find_blender", lambda: None)
    assert client.get(f"/api/documents/{created['id']}/render.png").status_code == 503


def test_render_jobs_run_report_progress_and_can_be_cancelled(tmp_path, monkeypatch):
    import time
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    main.renderJobs.clear()
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Job", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")

    def fake(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180):
        progress(0.5)
        time.sleep(0.2)
        return b"\x89PNG-hd"

    monkeypatch.setattr(blenderexport, "build_render", fake)
    job = client.post(f"/api/documents/{created['id']}/render-jobs", params={"width": 1920}).json()
    assert job["state"] == "running" and job["width"] == 1920 and job["samples"] == 96
    for _ in range(50):
        status = client.get(f"/api/render-jobs/{job['id']}").json()
        if status["state"] != "running":
            break
        time.sleep(0.05)
    assert status["state"] == "done" and status["progress"] == 1.0
    assert client.get(f"/api/render-jobs/{job['id']}/image.png").content == b"\x89PNG-hd"

    def slow(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180):
        time.sleep(0.3)
        raise RuntimeError("killed")

    monkeypatch.setattr(blenderexport, "build_render", slow)
    second = client.post(f"/api/documents/{created['id']}/render-jobs").json()
    assert client.delete(f"/api/render-jobs/{second['id']}").json()["state"] == "cancelled"
    time.sleep(0.5)
    assert client.get(f"/api/render-jobs/{second['id']}").json()["state"] == "cancelled"  # a killed Blender is not reported as an error
    assert client.get(f"/api/render-jobs/{second['id']}/image.png").status_code == 409
    assert client.get("/api/render-jobs/nope").status_code == 404


def test_render_state_reaches_the_page_over_the_websocket_and_only_one_render_runs(tmp_path, monkeypatch):
    import time
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    main.renderJobs.clear()
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Socket", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")

    def fake(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180):
        progress(0.5)
        time.sleep(0.4)
        return b"\x89PNG-hd"

    monkeypatch.setattr(blenderexport, "build_render", fake)
    with client.websocket_connect("/api/ws") as socket:
        assert socket.receive_json() == {"type": "render", "state": "idle"}
        job = client.post(f"/api/documents/{created['id']}/render-jobs").json()
        assert client.post(f"/api/documents/{created['id']}/render-jobs").status_code == 409  # one render at a time
        states = []
        while not states or states[-1]["state"] == "running":
            states.append(socket.receive_json())
        assert all(m["type"] == "render" and m["id"] == job["id"] for m in states) and states[-1]["state"] == "done" and states[-1]["name"] == "Socket"
    with client.websocket_connect("/api/ws") as late:  # a page opened afterwards still hears that a render is ready
        assert late.receive_json()["state"] == "done"
