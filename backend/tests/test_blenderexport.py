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
    monkeypatch.setattr(blenderexport, "build_blend", lambda glb, blender, studio=True, light=None, dof="0": b"BLENDER-v500" + glb[:4])
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
    monkeypatch.setattr(blenderexport, "build_blend", lambda glb, blender, studio=True, light=None, dof="0": b"BLENDER-v500")
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
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, dof="0", crop=False, phase=None: seen.update(light=light, width=width, samples=samples) or b"\x89PNG-fake")
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

    def fake(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw"):
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

    def slow(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw"):
        time.sleep(0.3)
        raise RuntimeError("killed")

    monkeypatch.setattr(blenderexport, "build_render", slow)
    second = client.post(f"/api/documents/{created['id']}/render-jobs").json()
    assert client.delete(f"/api/render-jobs/{second['id']}").json()["state"] == "cancelled"
    time.sleep(0.5)
    assert client.get(f"/api/render-jobs/{second['id']}").json()["state"] == "cancelled"  # a killed Blender is not reported as an error
    assert client.get(f"/api/render-jobs/{second['id']}/image.png").status_code == 409
    assert client.get("/api/render-jobs/nope").status_code == 404


def test_render_state_reaches_the_page_over_the_websocket_and_renders_queue_up(tmp_path, monkeypatch):
    import time
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    monkeypatch.setattr(main, "renderQueueMax", 2)  # the running render and one waiting
    main.renderJobs.clear()
    main.renderQueue.clear()
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Socket", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    order = []

    def fake(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw"):
        order.append(width)
        progress(0.5)
        time.sleep(0.4)
        return b"\x89PNG-hd"

    monkeypatch.setattr(blenderexport, "build_render", fake)
    with client.websocket_connect("/api/ws") as socket:
        assert socket.receive_json() == {"type": "render", "state": "idle"}
        first = client.post(f"/api/documents/{created['id']}/render-jobs", params={"width": 1000}).json()
        second = client.post(f"/api/documents/{created['id']}/render-jobs", params={"width": 2000})
        assert second.status_code == 202 and second.json()["state"] == "queued" and second.json()["position"] == 1  # it waits its turn
        full = client.post(f"/api/documents/{created['id']}/render-jobs", params={"width": 3000})
        assert full.status_code == 409 and "queue is full" in full.json()["detail"]
        messages = []
        while not messages or messages[-1]["id"] != second.json()["id"] or messages[-1]["state"] != "done":
            messages.append(socket.receive_json())
        done_first = next(i for i, m in enumerate(messages) if m["id"] == first["id"] and m["state"] == "done")
        running_second = next(i for i, m in enumerate(messages) if m["id"] == second.json()["id"] and m["state"] == "running")
        assert done_first < running_second and order == [1000, 2000]  # one at a time, in the order they came
    with client.websocket_connect("/api/ws") as late:  # a page opened afterwards still hears that a render is ready
        assert late.receive_json()["state"] == "done"


def test_waiting_renders_can_be_cancelled_one_by_one_or_all_at_once(tmp_path, monkeypatch):
    import threading
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    main.renderJobs.clear()
    main.renderQueue.clear()
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Cancel", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    release = threading.Event()

    def slow(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw"):
        release.wait(5)
        return b"\x89PNG-hd"

    monkeypatch.setattr(blenderexport, "build_render", slow)
    url = f"/api/documents/{created['id']}/render-jobs"
    running = client.post(url).json()
    waiting = [client.post(url).json() for _ in range(3)]
    assert client.get(f"/api/render-jobs/{running['id']}").json()["state"] == "running" and client.get(f"/api/render-jobs/{waiting[2]['id']}").json()["position"] == 3
    assert client.delete(f"/api/render-jobs/{waiting[1]['id']}").json()["state"] == "cancelled"
    assert [main.renderQueue[i][0].id for i in range(2)] == [waiting[0]["id"], waiting[2]["id"]]  # the others close up
    assert client.delete("/api/render-jobs").json() == {"cancelled": 3}
    assert not main.renderQueue and client.get(f"/api/render-jobs/{waiting[0]['id']}").json()["state"] == "cancelled"
    release.set()


def test_depth_of_field_focus_comes_from_the_call_or_the_document(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Focus", "items": [item], "render": {"depthOfField": True, "focusId": "a"}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None: seen.append(dof) or b"\x89PNG")
    url = f"/api/documents/{created['id']}/render.png"
    assert client.get(url).status_code == 200 and seen[-1] == "1|3|a#0,40,,,1,16:9,0,0,none,z:50:0,a"  # what the document says
    client.get(url, params={"dof": "false"})
    assert seen[-1] == "0#0,40,,,1,16:9,0,0,none,z:50:0,a"  # the focus travels with it (the Thermal style is hottest there)
    client.get(url, params={"dof": "true", "focus": "other-part"})
    assert seen[-1] == "1|3|other-part#0,40,,,1,16:9,0,0,none,z:50:0,other-part"
    client.get(url, params={"dof": "true", "strength": 5})
    assert seen[-1] == "1|5|a#0,40,,,1,16:9,0,0,none,z:50:0,a"
    assert client.get(url, params={"dof": "true", "strength": 6}).status_code == 422
    assert client.get(url, params={"dof": "true", "focus": "not a part"}).status_code == 422


def test_ambient_preset_comes_from_the_call_or_the_document(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Amb", "items": [item], "render": {"ambient": 2}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None: seen.append(dof) or b"\x89PNG")
    url = f"/api/documents/{created['id']}/render.png"
    assert client.get(url).status_code == 200 and seen[-1] == "0#2,40,,,1,16:9,0,0,none,z:50:0,"  # what the document says
    assert client.get(url + "?ambient=5").status_code == 200 and seen[-1] == "0#5,40,,,1,16:9,0,0,none,z:50:0,"
    assert client.get(url + "?ambient=6").status_code == 422
    assert client.get(url + "?lamp=20").status_code == 200 and seen[-1] == "0#2,20,,,1,16:9,0,0,none,z:50:0,"
    assert client.get(url + "?lamp=61").status_code == 422


def test_render_job_reports_the_size_of_its_picture():
    job = main.RenderJob("Size", 1920, 96)
    assert job.view()["size"] is None
    job.png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + (1920).to_bytes(4, "big") + (1080).to_bytes(4, "big")
    assert job.view()["size"] == [1920, 1080]


def test_render_job_tracks_its_steps_and_learns_how_long_they_take():
    job = main.RenderJob("Steps", 1920, 96)
    assert job.view()["state"] == "queued" and job.view()["phase"] is None  # nothing has begun while it waits
    job.begin()
    assert [p["name"] for p in job.view()["phases"]] == ["prepare", "load", "render", "finish"]
    assert job.view()["phase"] == "prepare" and job.view()["phases"][0]["start"] is not None and job.view()["phases"][1]["start"] is None
    job.enter("load")
    job.enter("render")
    job.enter("finish")
    job.state = "done"
    job.close()
    phases = job.view()["phases"]
    assert all(p["start"] is not None and p["end"] is not None for p in phases)
    assert phases[0]["end"] <= phases[1]["start"] + 1e-6


def test_part_marked_do_not_render_stays_in_the_scene_with_a_marker():
    items, stls = items_and_stls()
    items[1]["noRender"] = True
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False))
    marked = {node["extras"]["itemId"]: node["extras"].get("noRender", False) for node in gltf["nodes"] if "extras" in node}
    assert marked == {items[0]["id"]: False, items[1]["id"]: True, items[2]["id"]: False}


def test_finishes_become_materials_and_their_extensions():
    items, stls = items_and_stls()
    items = [dict(item) for item in items]
    items[0]["render"] = {"finish": "metal"}
    items[1]["render"] = {"finish": "glass"}
    items[2]["render"] = {"finish": "mirror"}
    gltf, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False, colours=True))
    pbr = {m["name"].split("_")[-1]: m for m in gltf["materials"]}
    assert pbr["metal"]["pbrMetallicRoughness"]["metallicFactor"] == 1.0 and pbr["mirror"]["pbrMetallicRoughness"]["roughnessFactor"] == 0.0
    assert pbr["glass"]["extensions"]["KHR_materials_transmission"]["transmissionFactor"] == 1.0
    assert "KHR_materials_transmission" in gltf["extensionsUsed"]
    plain, _ = parse_glb(blenderexport.build_glb({"name": "Doc", "items": items}, stls.__getitem__, camera=False, colours=False))  # Black PLA: no finishes
    assert [m["name"] for m in plain["materials"]] == ["Black PLA"]


def test_render_view_uses_render_colours_and_leaves_hidden_parts_out():
    def item(identifier, **extra):
        return main.DocumentItem(id=identifier, path="a.stl", name=identifier, color=0x111111, position=(0, 0, 0), rotation=(0, 0, 0, 1), **extra)
    document = main.DocumentOut(id="d", modified=0, name="N", items=[item("plain"), item("coloured", render=main.DocumentItemRender(color=0xabcdef, finish="metal")), item("gone", render=main.DocumentItemRender(hidden=True))])
    seen = main.render_view(document)
    assert [(i.id, i.color) for i in seen.items] == [("plain", 0x111111), ("coloured", 0xabcdef)]
    assert seen.items[1].render.finish == "metal"  # the finish rides along
    assert [i.color for i in document.items] == [0x111111] * 3  # the document itself is untouched
    with pytest.raises(main.HTTPException):
        main.render_view(document.model_copy(update={"items": [document.items[2]]}))


def test_pei_finish_is_a_matte_material_named_for_the_grain_in_blender():
    material = blenderexport.colour_material(0x336699, False, "pei")
    assert material["name"].endswith("_pei") and material["pbrMetallicRoughness"]["metallicFactor"] == 0.0 and material["pbrMetallicRoughness"]["roughnessFactor"] > 0.5
    assert "extensions" not in material  # no clear coat on a powder-coated plate


def test_picture_shape_and_transparent_background_reach_the_blender_script(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Shape", "items": [item], "render": {"aspect": "4:5", "transparent": True}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None: seen.append(dof) or b"\x89PNG")
    url = f"/api/documents/{created['id']}/render.png"
    assert client.get(url).status_code == 200 and seen[-1].endswith(",4:5,1,0,none,z:50:0,")  # what the document says
    client.get(url, params={"aspect": "1:1", "transparent": "false"})
    assert seen[-1].endswith(",1:1,0,0,none,z:50:0,")
    assert client.get(url, params={"aspect": "7:3"}).status_code == 422
    assert main.aspect_ratio("9:16") == 9 / 16 and abs(main.RenderJob("S", 1920, 96, aspect=1.0).megapixels - 3.6864) < 1e-6
    assert client.post("/api/documents", json={"name": "Bad", "items": [item], "render": {"aspect": "2:1"}}).status_code == 422


def test_turntable_renders_a_video_into_the_library_and_is_checked(tmp_path, monkeypatch):
    import time
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    main.renderJobs.clear()
    main.renderQueue.clear()
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Turn", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []

    def fake(glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw"):
        seen.append((width, samples, turntable, crop))
        return b"\x00\x00\x00\x18ftypisom" + b"\x00" * 40 if turntable else b"\x89PNG-hd"

    monkeypatch.setattr(blenderexport, "build_render", fake)
    url = f"/api/documents/{created['id']}/render-jobs"
    assert client.post(url, params={"turntable": "orbit", "width": 5000}).status_code == 422  # 4K at most
    assert client.post(url, params={"turntable": "orbit", "fps": 25}).status_code == 422
    assert client.post(url, params={"turntable": "sideways"}).status_code == 422
    job = client.post(url, params={"turntable": "spin", "seconds": 3, "fps": 24, "width": 960, "samples": 16, "crop": "true", "transparent": "true"}).json()
    assert job["kind"] == "turntable" and job["frames"] == 72 and job["motion"] == "spin"
    for _ in range(100):
        status = client.get(f"/api/render-jobs/{job['id']}").json()
        if status["state"] == "done" and status["imageId"]:  # the library gets it a moment after the render is done
            break
        time.sleep(0.05)
    assert status["state"] == "done" and seen[-1] == (960, 16, (72, "spin", 24), False)  # a video has no crop
    assert client.get(f"/api/render-jobs/{job['id']}/video.mp4").headers["content-type"] == "video/mp4"
    assert client.get(f"/api/render-jobs/{job['id']}/image.png").status_code == 409
    note = client.get(f"/api/documents/{created['id']}/images").json()[0]
    assert note["kind"] == "turntable" and note["media"] == "mp4" and note["settings"]["turntable"] == {"motion": "spin", "seconds": 3, "fps": 24, "direction": "ccw"} and note["width"] == 960
    assert client.get(f"/api/documents/{created['id']}/images/{note['id']}.mp4").headers["content-type"] == "video/mp4"
    assert client.get(f"/api/documents/{created['id']}/images/{note['id']}.png").status_code == 404
    assert client.delete(f"/api/documents/{created['id']}/images/{note['id']}").status_code == 204


def test_the_queue_is_listed_in_every_render_message():
    main.renderQueue.clear()
    running, first, second = main.RenderJob("Run", 1920, 96), main.RenderJob("Still", 2560, 256), main.RenderJob("Video", 1920, 48, aspect=1.0, turntable=(90, "spin", 30))
    main.renderQueue.extend([(first, ()), (second, ())])
    try:
        view = running.view()
        assert [(q["name"], q["kind"], q["samples"], q["size"]) for q in view["queue"]] == [("Still", "picture", 256, "2560 x 1440"), ("Video", "turntable", 48, "1920 x 1920")]
        assert view["queue"][1]["frames"] == 90 and view["queue"][1]["motion"] == "spin" and view["waiting"] == 2 and second.view()["position"] == 2
    finally:
        main.renderQueue.clear()


def test_render_estimate_scales_with_frames_samples_and_size(monkeypatch):
    monkeypatch.setattr(main, "phaseHistory", {"prepare": 10.0, "load": 5.0, "render": 0.2, "finish": 1.0})
    client = TestClient(main.app)
    still = client.get("/api/render-estimate", params={"width": 1920, "samples": 96}).json()["seconds"]
    video = client.get("/api/render-estimate", params={"width": 1920, "samples": 96, "frames": 100}).json()["seconds"]
    cheaper = client.get("/api/render-estimate", params={"width": 960, "samples": 12, "frames": 100}).json()["seconds"]
    assert still == round(10 + 5 + 0.2 * 1920 * 1080 / 1e6 * 96 + 1.0 * 1920 * 1080 / 1e6) and video > 50 * still and cheaper < video / 10
    assert client.get("/api/render-estimate", params={"aspect": "2:1"}).status_code == 422


def test_quick_video_is_a_small_synchronous_turntable(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Quick", "items": [item]}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="view", look_at="view", direction="ccw": seen.append((width, samples, turntable, crop)) or b"\x00\x00\x00\x18ftypisom")
    url = f"/api/documents/{created['id']}/render.mp4"
    answer = client.get(url, params={"motion": "spin", "seconds": 2, "crop": "true", "transparent": "true"})
    assert answer.status_code == 200 and answer.headers["content-type"] == "video/mp4" and seen[-1] == (640, 8, (48, "spin", 24), False)
    assert json.loads(answer.headers["x-render-settings"])["turntable"] == {"motion": "spin", "seconds": 2, "fps": 24, "direction": "ccw"}
    assert client.get(url, params={"seconds": 9}).status_code == 422 and client.get(url, params={"width": 2000}).status_code == 422


def test_a_turntable_can_track_a_part_and_the_note_names_it(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    items = [{"id": "a", "path": "a.stl", "name": "Base", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}, {"id": "b", "path": "a.stl", "name": "Knob", "color": 255, "position": [30, 0, 0], "rotation": [0, 0, 0, 1]}]
    created = client.post("/api/documents", json={"name": "Track", "items": items, "render": {"trackId": "b"}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="view", look_at="view", direction="ccw": seen.append(track) or b"\x00\x00\x00\x18ftypisom")
    url = f"/api/documents/{created['id']}/render.mp4"
    answer = client.get(url)
    assert answer.status_code == 200 and seen[-1] == "b" and json.loads(answer.headers["x-render-settings"])["track"] == "Knob"  # the document's choice
    client.get(url, params={"track": "a"})
    assert seen[-1] == "a"  # the call's own
    assert client.get(url, params={"track": "no good"}).status_code == 422
    assert client.post("/api/documents", json={"name": "T", "items": items, "render": {"trackId": "x" * 100}}).status_code == 422


def test_the_camera_can_go_round_the_view_or_the_tracked_part(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    plain = client.post("/api/documents", json={"name": "Pivot", "items": [item], "render": {"trackId": "a"}}).json()
    round_part = client.post("/api/documents", json={"name": "Pivot2", "items": [item], "render": {"trackId": "a", "trackPivot": "part"}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="view", look_at="view", direction="ccw": seen.append((track, track_pivot)) or b"\x00\x00\x00\x18ftypisom")
    client.get(f"/api/documents/{plain['id']}/render.mp4")
    assert seen[-1] == ("a", "all")  # the default: round the view, looking at the part
    client.get(f"/api/documents/{round_part['id']}/render.mp4")
    assert seen[-1] == ("a", "part")
    client.get(f"/api/documents/{plain['id']}/render.mp4", params={"trackPivot": "part"})
    assert seen[-1] == ("a", "part") and client.get(f"/api/documents/{plain['id']}/render.mp4", params={"trackPivot": "sideways"}).status_code == 422


def test_the_camera_pivot_has_three_choices_and_defaults_to_all_objects(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    kept = lambda render: client.post("/api/documents", json={"name": "P", "items": [], "render": render}).json()["render"]["trackPivot"]
    assert kept({}) == "all" and kept({"trackPivot": "view"}) == "view" and kept({"trackPivot": "part"}) == "part"
    assert client.post("/api/documents", json={"name": "P", "items": [], "render": {"trackPivot": "sideways"}}).status_code == 422


def test_where_the_camera_goes_round_and_what_it_looks_at_are_two_settings(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    untracked = client.post("/api/documents", json={"name": "U", "items": [item]}).json()
    tracked = client.post("/api/documents", json={"name": "T", "items": [item], "render": {"trackId": "a"}}).json()
    explicit = client.post("/api/documents", json={"name": "E", "items": [item], "render": {"trackId": "a", "trackPivot": "view", "lookAt": "all"}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw": seen.append((track_pivot, look_at)) or b"\x00\x00\x00\x18ftypisom")
    get = lambda document, **params: client.get(f"/api/documents/{document['id']}/render.mp4", params=params)
    get(untracked)
    assert seen[-1] == ("all", "view")  # nothing tracked: it keeps the angle it has
    get(tracked)
    assert seen[-1] == ("all", "part")  # a tracked part is looked at unless something else was chosen
    get(explicit)
    assert seen[-1] == ("view", "all")
    get(explicit, lookAt="part", trackPivot="part")
    assert seen[-1] == ("part", "part") and get(explicit, lookAt="sideways").status_code == 422


def test_reflections_preset_comes_from_the_call_or_the_document(tmp_path, monkeypatch):
    (tmp_path / "a.stl").write_bytes(box_stl(20, 20, 10))
    monkeypatch.setattr(main, "libraryRoot", tmp_path.resolve())
    monkeypatch.setattr(main, "documentsRoot", (tmp_path / "docs").resolve())
    client = TestClient(main.app)
    item = {"id": "a", "path": "a.stl", "name": "A", "color": 255, "position": [0, 0, 0], "rotation": [0, 0, 0, 1]}
    created = client.post("/api/documents", json={"name": "Refl", "items": [item], "render": {"reflections": 1}}).json()
    monkeypatch.setattr(blenderexport, "find_blender", lambda: "/fake/blender")
    seen = []
    monkeypatch.setattr(blenderexport, "build_render", lambda glb, blender, studio=True, light=None, width=800, samples=24, progress=None, started=None, timeout=180, dof="0", crop=False, phase=None, turntable=None, track="", track_pivot="all", look_at="view", direction="ccw": seen.append(dof) or b"\x89PNG")
    url = f"/api/documents/{created['id']}/render.png"
    client.get(url)
    assert seen[-1].endswith(",16:9,0,1,none,z:50:0,")  # the document's
    client.get(url, params={"reflections": 3})
    assert seen[-1].endswith(",16:9,0,3,none,z:50:0,") and client.get(url, params={"reflections": 5}).status_code == 422
    assert client.post("/api/documents", json={"name": "Bad", "items": [item], "render": {"reflections": 9}}).status_code == 422
