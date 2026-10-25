"""Builds a binary glTF (.glb) for Blender from a RASTERFASTER document.

Blender imports glTF natively (File > Import > glTF 2.0): one object per part in black PLA (or the document's colour), placed exactly as in the
document (Z up, 1 Blender unit = 1 m, so a 20 mm cell is 0.02 m), plus a camera placed like the app's 3D view (`view`),
or at the isometric Home view when none is given. There is no camera animation and no camera path.
"""
import json
import math
import struct
from typing import Callable

import numpy as np

import export3mf

fovDegrees = 35.0
aspect = 16 / 9
mmToMetre = 0.001
# Document axes (X right, Y back, Z up) -> glTF axes (Y up, -Z forward); Blender's importer turns that back into the document axes.
toGltf = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])


homeDirection = np.array([1.0, -1.0, 0.8]) / np.linalg.norm([1.0, -1.0, 0.8])  # the app's Home view


def parse_view(text: str) -> dict:
    """`dx,dy,dz;tx,ty,tz;height;projection[;fov]`: viewing direction (target -> camera), view centre (mm), visible height at the centre (mm),
    `persp` or `ortho`, and for `persp` optionally the view's vertical field of view in degrees (a zoomed-in view has a narrow one, which looks flatter)."""
    try:
        direction, target, height, projection, *fov = text.split(";")
        view = {"direction": np.array([float(v) for v in direction.split(",")]), "target": np.array([float(v) for v in target.split(",")]),
                "height": float(height), "projection": projection, "fov": float(fov[0]) if fov else fovDegrees}
        assert len(fov) <= 1 and 1.0 <= view["fov"] <= 120.0
        assert view["direction"].shape == (3,) and view["target"].shape == (3,) and view["projection"] in ("persp", "ortho")
        assert np.isfinite(view["direction"]).all() and np.isfinite(view["target"]).all() and np.isfinite(view["height"])
        assert np.linalg.norm(view["direction"]) > 1e-6 and view["height"] > 0
    except (ValueError, AssertionError):
        raise ValueError("view must be dx,dy,dz;tx,ty,tz;height;persp|ortho[;fov]")
    view["direction"] = view["direction"] / np.linalg.norm(view["direction"])
    return view


def camera_basis(direction: np.ndarray):
    forward = -direction
    right = np.cross(forward, [0.0, 0.0, 1.0])
    if np.linalg.norm(right) < 1e-8:
        right = np.array([1.0, 0, 0])
    right /= np.linalg.norm(right)
    return right, np.cross(right, forward), forward


def fit_distance(direction: np.ndarray, low: np.ndarray, high: np.ndarray) -> float:
    """How far the camera must be so the whole assembly is in view for this direction (16:9, with some margin)."""
    right, up, _ = camera_basis(direction)
    half = math.tan(math.radians(fovDegrees) / 2)
    distance = 0.0
    for corner in np.array([[x, y, z] for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])]) - (low + high) / 2:
        depth = float(corner @ direction)
        distance = max(distance, abs(float(corner @ up)) / half + depth, abs(float(corner @ right)) / (half * aspect) + depth)
    return distance * 1.2


def quaternion(matrix: np.ndarray) -> list[float]:
    """Rotation matrix (columns = axes) -> unit quaternion [x, y, z, w]."""
    m = matrix
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    norm = math.sqrt(sum(v * v for v in q))
    return [v / norm for v in q]


def black_pla() -> dict:
    """Satin black filament: very dark, fairly rough, with a thin glossy coat for the sheen of printed PLA."""
    return {"name": "Black PLA", "pbrMetallicRoughness": {"baseColorFactor": [0.012, 0.012, 0.014, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.42},
            "extensions": {"KHR_materials_clearcoat": {"clearcoatFactor": 0.12, "clearcoatRoughnessFactor": 0.35}}}


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


class Buffer:
    """Collects binary data and the glTF bufferViews / accessors that describe it."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.views: list[dict] = []
        self.accessors: list[dict] = []

    def add(self, array: np.ndarray, componentType: int, kind: str, target: int | None = None, bounds: bool = False) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        view = {"buffer": 0, "byteOffset": len(self.data), "byteLength": array.nbytes}
        if target:
            view["target"] = target
        self.data += array.tobytes()
        self.views.append(view)
        accessor = {"bufferView": len(self.views) - 1, "componentType": componentType, "count": int(array.shape[0]), "type": kind}
        if bounds:
            accessor["min"] = array.min(axis=0).tolist()
            accessor["max"] = array.max(axis=0).tolist()
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def node_matrix(placement: export3mf.Placement) -> list[float]:
    """Column-major 4x4 of the part's placement, expressed in glTF axes and metres."""
    linear = toGltf @ placement.rotation @ toGltf.T
    matrix = np.eye(4)
    matrix[:3, :3] = linear
    matrix[:3, 3] = mmToMetre * (toGltf @ placement.translation)
    return matrix.T.flatten().tolist()


def build_glb(document: dict, load_stl: Callable[[str], bytes], camera: bool = True, colours: bool = False, view: dict | None = None) -> bytes:
    """Parts get one shared \"Black PLA\" material; with `colours` they keep the colours of the document instead."""
    items = document["items"]
    if not items:
        raise ValueError("document has no items")
    meshes = {path: export3mf.read_stl(load_stl(path)) for path in dict.fromkeys(item["path"] for item in items)}
    placements = export3mf.place_assembly(items, meshes, 0.0, centre=False)  # the document's own coordinates

    buffer = Buffer()
    accessors = {}
    for path, mesh in meshes.items():
        positions = (mmToMetre * (mesh.vertices @ toGltf.T)).astype(np.float32)
        accessors[path] = (buffer.add(positions, 5126, "VEC3", 34962, bounds=True),
                           buffer.add(mesh.triangles.astype(np.uint32).reshape(-1), 5125, "SCALAR", 34963))
    gltfMeshes, materials, materialIndex, meshIndex = [], [], {}, {}
    nodes, partNodes = [], []
    for item, placement in zip(items, placements):
        colour = (int(item["color"]) & 0xFFFFFF) if colours else -1  # -1: Black PLA
        if colour not in materialIndex:
            materialIndex[colour] = len(materials)
            materials.append(black_pla() if colour < 0 else {"name": f"colour_{colour:06x}", "pbrMetallicRoughness": {
                "baseColorFactor": [*(srgb_to_linear(((colour >> shift) & 255) / 255) for shift in (16, 8, 0)), 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.6}})
        key = (item["path"], colour)  # one glTF mesh per library file and colour; parts used several times share it
        if key not in meshIndex:
            meshIndex[key] = len(gltfMeshes)
            position, indices = accessors[item["path"]]
            gltfMeshes.append({"name": item["path"].rsplit("/", 1)[-1], "primitives": [{
                "attributes": {"POSITION": position}, "indices": indices, "material": materialIndex[colour]}]})  # no normals: faces shade flat
        nodes.append({"name": item["name"], "mesh": meshIndex[key], "matrix": node_matrix(placement)})
        partNodes.append(len(nodes) - 1)

    sceneNodes = list(partNodes)
    gltf: dict = {"extensionsUsed": ["KHR_materials_clearcoat"], "asset": {"version": "2.0", "generator": "RASTERFASTER composition tool"}, "scene": 0,
                  "meshes": gltfMeshes, "materials": materials, "nodes": nodes}

    if camera:
        low = np.min([item["position"] for item in items], axis=0).astype(np.float64)
        high = np.max([np.array(item["position"]) + p.size for p, item in zip(placements, items)], axis=0)
        if view is None:  # isometric Home view, the whole assembly in frame
            distance = fit_distance(homeDirection, low, high)
            view = {"direction": homeDirection, "target": (low + high) / 2, "projection": "persp", "height": 2 * distance * math.tan(math.radians(fovDegrees) / 2)}
        direction, target, height = view["direction"], view["target"], view["height"]
        if view["projection"] == "ortho":
            distance = 4 * float(np.linalg.norm(high - low))  # distance does not change the picture, it only has to clear the parts
            gltf["cameras"] = [{"name": "App view camera", "type": "orthographic", "orthographic": {
                "xmag": height / 2 * aspect * mmToMetre, "ymag": height / 2 * mmToMetre, "znear": 0.01, "zfar": 50.0}}]
        else:
            fov = view.get("fov", fovDegrees)
            distance = height / 2 / math.tan(math.radians(fov) / 2)
            gltf["cameras"] = [{"name": "App view camera", "type": "perspective", "perspective": {
                "yfov": math.radians(fov), "aspectRatio": aspect, "znear": 0.01, "zfar": 50.0}}]
        eye = target + direction * distance
        right, up, forward = camera_basis(direction)
        rotation = quaternion(np.column_stack([toGltf @ right, toGltf @ up, -(toGltf @ forward)]))  # glTF cameras look down -Z
        nodes.append({"name": "App view camera", "camera": 0, "translation": (mmToMetre * (toGltf @ eye)).tolist(), "rotation": rotation})
        sceneNodes.append(len(nodes) - 1)

    gltf["scenes"] = [{"name": document["name"], "nodes": sceneNodes}]
    gltf["bufferViews"], gltf["accessors"] = buffer.views, buffer.accessors
    while len(buffer.data) % 4:
        buffer.data.append(0)
    gltf["buffers"] = [{"byteLength": len(buffer.data)}]
    jsonBytes = json.dumps(gltf, separators=(",", ":")).encode()
    jsonBytes += b" " * (-len(jsonBytes) % 4)
    total = 12 + 8 + len(jsonBytes) + 8 + len(buffer.data)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(jsonBytes), 0x4E4F534A) + jsonBytes
            + struct.pack("<II", len(buffer.data), 0x004E4942) + bytes(buffer.data))


blenderScript = r'''
import math
import sys
import bpy
from mathutils import Vector

source, target, studio = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=source)
scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
scene.unit_settings.system = "METRIC"
for obj in bpy.data.objects:
    if obj.type == "CAMERA":
        scene.camera = obj
        if obj.animation_data and obj.animation_data.action:
            first, last = obj.animation_data.action.frame_range
            scene.frame_start, scene.frame_end = int(first), int(last)
    if obj.name == "Camera path":
        obj.hide_render = True  # a guide line, not part of the picture

if studio == "1":
    parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name != "Camera path"]
    low = Vector((1e9,) * 3)
    high = Vector((-1e9,) * 3)
    for o in parts:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            low, high = Vector(map(min, low, w)), Vector(map(max, high, w))
    centre, r = (low + high) / 2, (high - low).length / 2

    # Studio floor: a dark matte disc just under the parts, so they sit on something and cast soft shadows.
    bpy.ops.mesh.primitive_circle_add(vertices=96, radius=r * 6, fill_type="NGON", location=(centre.x, centre.y, low.z - 0.0005))
    floor = bpy.context.active_object
    floor.name = "Studio floor"
    mat = bpy.data.materials.new("Studio floor")
    mat.use_nodes = True
    tree = mat.node_tree
    surface = tree.nodes["Principled BSDF"]
    surface.inputs["Base Color"].default_value = (0.05, 0.055, 0.065, 1)
    surface.inputs["Roughness"].default_value = 0.55
    # Solid seen from above, invisible seen from below: a camera under the floor looks straight through it (it still catches the shadows from above).
    clear, back, mix, material_output = (tree.nodes.new(n) for n in ("ShaderNodeBsdfTransparent", "ShaderNodeNewGeometry", "ShaderNodeMixShader", "ShaderNodeOutputMaterial"))
    tree.links.new(back.outputs["Backfacing"], mix.inputs["Fac"])
    tree.links.new(surface.outputs["BSDF"], mix.inputs[1])
    tree.links.new(clear.outputs["BSDF"], mix.inputs[2])
    tree.links.new(mix.outputs["Shader"], material_output.inputs["Surface"])
    for node in tree.nodes:
        if node.type == "OUTPUT_MATERIAL" and node is not material_output:
            node.is_active_output = False
    material_output.is_active_output = True
    floor.data.materials.append(mat)

    # World: a dark vertical gradient with a bluish horizon glow.
    world = bpy.data.worlds.new("Studio")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    coord, mapping, grad, ramp = (nt.nodes.new(n) for n in ("ShaderNodeTexCoord", "ShaderNodeMapping", "ShaderNodeTexGradient", "ShaderNodeValToRGB"))
    bg, out = nt.nodes.new("ShaderNodeBackground"), nt.nodes.new("ShaderNodeOutputWorld")
    mapping.inputs["Rotation"].default_value = (math.radians(90), 0, 0)
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs[0], grad.inputs[0])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs[0])
    ramp.color_ramp.elements[0].color = (0.01, 0.012, 0.02, 1)
    ramp.color_ramp.elements[1].color = (0.10, 0.14, 0.22, 1)
    bg.inputs["Strength"].default_value = 0.12

    def light(name, location, energy, color, size):
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.color, data.shape, data.size, data.size_y = energy, color, "RECTANGLE", size, size * 0.6
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        scene.collection.objects.link(obj)
        aim = bpy.data.objects.new(name + " target", None)
        aim.location = centre
        scene.collection.objects.link(aim)
        track = obj.constraints.new("TRACK_TO")
        track.target, track.track_axis, track.up_axis = aim, "TRACK_NEGATIVE_Z", "UP_Y"

    d = r * 3
    light("Key (warm)", centre + Vector((d * 0.8, -d, d * 0.9)), 7, (1.0, 0.86, 0.7), r * 2.2)
    light("Fill (cool)", centre + Vector((-d, -d * 0.5, d * 0.4)), 2.2, (0.6, 0.75, 1.0), r * 3)
    light("Under fill (cool)", centre + Vector((d * 0.3, -d * 0.3, -d)), 3, (0.55, 0.7, 1.0), r * 3)  # soft light for views from below the floor
    light("Rim (magenta)", centre + Vector((-d * 0.3, d, d * 0.6)), 4, (1.0, 0.45, 0.8), r * 1.5)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.3

bpy.ops.wm.save_as_mainfile(filepath=target, compress=True)
'''


def find_blender() -> str | None:
    """The Blender executable: $BLENDER, `blender` on the PATH, or the macOS / Linux default locations."""
    import os
    import shutil
    from pathlib import Path

    candidates = [os.environ.get("BLENDER"), shutil.which("blender"), "/Applications/Blender.app/Contents/MacOS/Blender", "/usr/bin/blender", "/snap/bin/blender"]
    return next((c for c in candidates if c and Path(c).is_file()), None)


def build_blend(glb: bytes, blender: str, studio: bool = True) -> bytes:
    """Runs Blender in the background to turn the glTF into a real .blend (camera set as the scene camera, 1080p;
    with `studio` also a floor, a dark gradient world and three area lights, rendered with Cycles)."""
    import subprocess
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as folder:
        source, target, script = Path(folder, "scene.glb"), Path(folder, "scene.blend"), Path(folder, "make_blend.py")
        source.write_bytes(glb)
        script.write_text(blenderScript)
        result = subprocess.run([blender, "--background", "--factory-startup", "--python", str(script), "--", str(source), str(target), "1" if studio else "0"],
                                capture_output=True, text=True, timeout=120)
        if not target.is_file():
            raise RuntimeError(f"Blender could not write the .blend: {(result.stderr or result.stdout)[-300:]}")
        return target.read_bytes()
