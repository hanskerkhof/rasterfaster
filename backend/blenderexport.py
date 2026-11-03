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


homeDirection = np.array([1.0, -1.0, 0.3]) / np.linalg.norm([1.0, -1.0, 0.3])  # the app's Home view (from the front right, about 12° above the horizon)


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


def parse_light(text: str) -> dict:
    """`dx,dy,dz;tx,ty,tz`: where the app's light shines from (a direction, from what it points at to the light) and the point it points at (mm).
    The target can also be `part:<item id>` (the middle of that part) or empty (the middle of the scene)."""
    try:
        direction, target = text.split(";")
        light = {"direction": np.array([float(v) for v in direction.split(",")]), "target": None, "part": None}
        if target.startswith("part:"):
            light["part"] = target[5:]
            assert light["part"] and all(c.isalnum() or c in "-_" for c in light["part"])
        elif target:
            light["target"] = np.array([float(v) for v in target.split(",")])
            assert light["target"].shape == (3,) and np.isfinite(light["target"]).all()
        assert light["direction"].shape == (3,)
        assert np.isfinite(light["direction"]).all() and np.linalg.norm(light["direction"]) > 1e-6
    except (ValueError, AssertionError):
        raise ValueError("light must be dx,dy,dz;tx,ty,tz")
    light["direction"] = light["direction"] / np.linalg.norm(light["direction"])
    return light


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


dimmedAlpha = 0.18  # a dimmed (muted) part: how much of it shows
finishes = ("metal", "glass", "mirror", "pei")  # Render mode's finishes besides satin PLA


def colour_material(colour: int, dimmed: bool, finish: str | None) -> dict:
    """The material of a part in its colour: satin PLA, or one of Render mode's finishes (metal, glass, mirror)."""
    base = [srgb_to_linear(((colour >> shift) & 255) / 255) for shift in (16, 8, 0)]
    alpha = dimmedAlpha if dimmed else 1.0
    name = f"colour_{colour:06x}" + (f"_{finish}" if finish else "") + ("_dimmed" if dimmed else "")
    extra = {"alphaMode": "BLEND"} if dimmed else {}
    if finish == "metal":  # brushed metal in the colour of the part
        return {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*base, alpha], "metallicFactor": 1.0, "roughnessFactor": 0.28}, **extra}
    if finish == "mirror":  # a polished mirror: almost white metal with only a trace of the colour
        tint = [0.85 + 0.15 * c for c in base]
        return {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*tint, alpha], "metallicFactor": 1.0, "roughnessFactor": 0.0}, **extra}
    if finish == "pei":  # a textured PEI print plate: matte, the fine grain itself is added in Blender (see grain_pei_parts)
        return {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*base, alpha], "metallicFactor": 0.0, "roughnessFactor": 0.62}, **extra}
    if finish == "glass":  # see-through plastic or glass in the colour of the part
        return {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*base, alpha], "metallicFactor": 0.0, "roughnessFactor": 0.04},
                "extensions": {"KHR_materials_transmission": {"transmissionFactor": 1.0}}, **extra}
    return {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*base, alpha], "metallicFactor": 0.0, "roughnessFactor": 0.42},  # the same satin finish as Black PLA, in the document's colour
            "extensions": {"KHR_materials_clearcoat": {"clearcoatFactor": 0.12, "clearcoatRoughnessFactor": 0.35}}, **extra}


def black_pla(dimmed: bool = False) -> dict:
    """Satin black filament: very dark, fairly rough, with a thin glossy coat for the sheen of printed PLA. Dimmed parts are translucent."""
    material = {"name": "Black PLA (dimmed)" if dimmed else "Black PLA", "pbrMetallicRoughness": {"baseColorFactor": [0.012, 0.012, 0.014, dimmedAlpha if dimmed else 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.42},
                "extensions": {"KHR_materials_clearcoat": {"clearcoatFactor": 0.12, "clearcoatRoughnessFactor": 0.35}}}
    if dimmed:
        material["alphaMode"] = "BLEND"
    return material


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
    """Parts get one shared \"Black PLA\" material; with `colours` they keep the colours of the document instead. Dimmed (muted) parts are translucent."""
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
        dimmed = bool(item.get("muted"))
        finish = (item.get("render") or {}).get("finish") if colours else None  # Render mode's finish (none: satin PLA)
        if finish not in finishes:
            finish = None
        if (colour, dimmed, finish) not in materialIndex:
            materialIndex[(colour, dimmed, finish)] = len(materials)
            if colour < 0:
                materials.append(black_pla(dimmed))
            else:
                materials.append(colour_material(colour, dimmed, finish))
        key = (item["path"], colour, dimmed, finish)  # one glTF mesh per library file, colour, dimming and finish; parts used several times share it
        if key not in meshIndex:
            meshIndex[key] = len(gltfMeshes)
            position, indices = accessors[item["path"]]
            gltfMeshes.append({"name": item["path"].rsplit("/", 1)[-1], "primitives": [{
                "attributes": {"POSITION": position}, "indices": indices, "material": materialIndex[(colour, dimmed, finish)]}]})  # no normals: faces shade flat
        nodes.append({"name": item["name"], "mesh": meshIndex[key], "matrix": node_matrix(placement), "extras": {"itemId": item["id"], **({"noRender": True} if item.get("noRender") else {})}})  # the id lets a light find its part; a part marked "Do not render" stays in the scene (to focus or aim on) but is not drawn
        partNodes.append(len(nodes) - 1)

    sceneNodes = list(partNodes)
    used = ["KHR_materials_clearcoat"] + (["KHR_materials_transmission"] if any("KHR_materials_transmission" in m.get("extensions", {}) for m in materials) else [])
    gltf: dict = {"extensionsUsed": used, "asset": {"version": "2.0", "generator": "RASTERFASTER composition tool"}, "scene": 0,
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

# the lamp types, from a spotlight (razor-sharp shadows) to a flood (very soft ones): the angle of the sun in degrees, and the size of the warm key light
BEAM_ANGLES = [0.5, 3, 10, 25, 60]
BEAM_SIZES = [0.15, 1, 2.5, 5, 10]
# the ambient light presets (Soft glow, Overcast, Softbox, Daylight, Bright studio): the power of the softbox above the scene (per square metre of its
# distance above the parts), its colour and how much brighter the world gets
AMBIENT_PRESETS = [(2, (0.85, 0.9, 1.0), 0.15), (4, (0.92, 0.95, 1.0), 0.3), (7, (1.0, 0.98, 0.95), 0.45), (11, (1.0, 0.95, 0.88), 0.7), (16, (1.0, 1.0, 1.0), 1.1)]
CROP_PADDING = 0.04  # room left on each side of the parts when the picture is cropped to them, as a share of their width
DOF_BLUR_SHARES = [0.003, 0.006, 0.012, 0.025, 0.05]  # the five strengths: how blurred the part farthest from the focus is, as a share of the picture width (the third: unsharp, still recognizable)
SUN_STRENGTH = 6.0  # W/m² (a clear day is ~ 5 in Blender; stronger washes the colours out)
SUPPORT_SCALE = 0.35  # with the app's light as key, the fill, rim and under lights are turned down to this share so the key light shows

# the arguments: the glTF, the .blend to write, "1" with the studio setup, the app's light ("dx,dy,dz;tx,ty,tz" in mm, or ""), "width,samples" to render a PNG
# instead of saving the .blend (or ""), the depth of field ("0", "1" or "1|strength|part id") and "1" to crop the picture to the parts
source, target, studio, light_spec, render_spec, dof_spec, crop_flag, turntable_spec = sys.argv[sys.argv.index("--") + 1:]
dof_spec, _, extra_text = dof_spec.partition("#")  # the depth of field spec may end in "#<ambient light preset, 0 to 5>,<lamp, 0 to 60>"
ambient_text, _, rest_text = extra_text.partition(",")
lamp_text, _, rest_text = rest_text.partition(",")
background_text, _, rest_text = rest_text.partition(",")
ground_text, _, rest_text = rest_text.partition(",")
beam_text, _, rest_text = rest_text.partition(",")
aspect_text, _, rest_text = rest_text.partition(",")  # the shape of the picture ("16:9", "1:1" ...)
transparent_text, _, rest_text = rest_text.partition(",")  # "1" for a transparent background
reflections_text, _, rest_text = rest_text.partition(",")  # what metal, mirror and glass reflect (0 to 4)
fx_text, _, rest_text = rest_text.partition(",")  # the style of the picture
cut_text, _, focus_text = rest_text.partition(",")  # where the cut-away cuts ("z:50:0"), and the part the focus menu chose (the Thermal style is hottest there)
reflections = min(max(int(reflections_text or 0), 0), 4)
fx = fx_text if fx_text in ("cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink") else "none"
aspect_w, _, aspect_h = (aspect_text or "16:9").partition(":")
aspect_ratio = max(0.2, min(5.0, int(aspect_w or 16) / max(int(aspect_h or 9), 1)))
transparent_background = transparent_text == "1"
beam = min(max(int(beam_text or 1), 0), 4)  # the lamp type: 0 spot, 1 direct (the studio's own), 2 soft, 3 diffuse, 4 flood  # the colours of the background and of the ground disc, as hex (empty: the studio's own)

def srgb_colour(text):
    if not text:
        return None
    value = int(text, 16)
    return tuple(((c / 12.92) if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in (((value >> shift) & 255) / 255 for shift in (16, 8, 0))) + (1,)

background_colour, ground_colour = srgb_colour(background_text), srgb_colour(ground_text)
ambient = min(max(int(ambient_text or 0), 0), 5)
lamp = 2 ** ((min(max(int(lamp_text or 40), 0), 60) - 40) / 10)  # the lamp slider: 40 is the normal strength, every 10 steps double or halve it (from 1/16 to 4 times)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=source)
scene = bpy.context.scene

def let_light_through_glass():
    # Cycles blocks the shadow rays of lights at glass, so a glass panel (a diffuser in a ceiling, a window) would stay dark behind it.
    # The glass parts let most of the light of the lamps through (shadow rays see a transparent surface); the camera and the reflections still see glass.
    for material in bpy.data.materials:
        if "_glass" not in material.name or not material.use_nodes:
            continue
        tree = material.node_tree
        output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if output is None or not output.inputs["Surface"].links:
            continue
        glass = output.inputs["Surface"].links[0].from_node
        light_path = tree.nodes.new("ShaderNodeLightPath")
        scale = tree.nodes.new("ShaderNodeMath")
        scale.operation = "MULTIPLY"
        scale.inputs[1].default_value = 0.92  # a trace of shadow stays
        tree.links.new(light_path.outputs["Is Shadow Ray"], scale.inputs[0])
        clear = tree.nodes.new("ShaderNodeBsdfTransparent")
        mix = tree.nodes.new("ShaderNodeMixShader")
        tree.links.new(scale.outputs[0], mix.inputs[0])
        tree.links.new(glass.outputs[0], mix.inputs[1])
        tree.links.new(clear.outputs[0], mix.inputs[2])
        tree.links.new(mix.outputs[0], output.inputs["Surface"])

let_light_through_glass()

def grain_pei_parts():
    # The finish of a textured PEI print plate: a coarse, sparkly powder-coat grain (a black part under a lamp glitters with tiny bright flecks). The parts
    # have no UV coordinates, so the grain is made of tiny cells (about 0.3 mm) on the part's own coordinates: every cell tilts the normal a random bit,
    # so some cells catch the light and flash and the rest stay dark.
    for material in bpy.data.materials:
        if "_pei" not in material.name or not material.use_nodes:
            continue
        tree = material.node_tree
        principled = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if principled is None:
            continue
        coordinates = tree.nodes.new("ShaderNodeTexCoord")
        cells = tree.nodes.new("ShaderNodeTexVoronoi")
        cells.voronoi_dimensions = "3D"
        cells.feature = "F1"
        cells.inputs["Scale"].default_value = 5200.0
        cells.inputs["Randomness"].default_value = 1.0
        tree.links.new(coordinates.outputs["Object"], cells.inputs["Vector"])
        centred = tree.nodes.new("ShaderNodeVectorMath")
        centred.operation = "SUBTRACT"
        centred.inputs[1].default_value = (0.5, 0.5, 0.5)
        tree.links.new(cells.outputs["Color"], centred.inputs[0])
        tilt = tree.nodes.new("ShaderNodeVectorMath")
        tilt.operation = "SCALE"
        tilt.inputs["Scale"].default_value = 0.8  # how far a cell can tilt: the sparkle
        tree.links.new(centred.outputs["Vector"], tilt.inputs[0])
        geometry = tree.nodes.new("ShaderNodeNewGeometry")
        tilted = tree.nodes.new("ShaderNodeVectorMath")
        tilted.operation = "ADD"
        tree.links.new(geometry.outputs["Normal"], tilted.inputs[0])
        tree.links.new(tilt.outputs["Vector"], tilted.inputs[1])
        unit = tree.nodes.new("ShaderNodeVectorMath")
        unit.operation = "NORMALIZE"
        tree.links.new(tilted.outputs["Vector"], unit.inputs[0])
        tree.links.new(unit.outputs["Vector"], principled.inputs["Normal"])
        principled.inputs["Roughness"].default_value = 0.38  # glossy enough for the flecks to flash

grain_pei_parts()

def smooth_shiny_parts():
    # The export has no normals, so every triangle shades flat: harmless on satin plastic, but a mirror or metal shows each facet as a patch of its
    # reflection. Parts with a finish are smoothed by angle (as the 3D view does): round surfaces reflect smoothly, sharp edges stay sharp.
    import math
    done = set()
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data.name in done:
            continue
        if not any(slot.material and any(f in slot.material.name for f in ("_metal", "_mirror", "_glass")) for slot in obj.material_slots):
            continue
        done.add(obj.data.name)
        for other in bpy.context.view_layer.objects:
            other.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        except Exception:  # an older Blender: smooth everything, the creases of a flat part stay soft but it still reflects better than facets
            bpy.ops.object.shade_smooth()
    for other in bpy.context.view_layer.objects:
        other.select_set(False)

smooth_shiny_parts()
scene.render.resolution_x, scene.render.resolution_y = 1920, round(1920 / aspect_ratio)
scene.unit_settings.system = "METRIC"
for obj in bpy.data.objects:
    if obj.type == "CAMERA":
        scene.camera = obj
        if abs(aspect_ratio - 16 / 9) > 1e-6:  # another shape: the picture is as high as the 16:9 one (the frame drawn in the view), the width follows the shape
            if obj.data.type == "PERSP":  # the glTF importer gives the vertical angle (the sensor fits the height): keep it, whatever the width
                vertical = obj.data.angle_y
                obj.data.sensor_fit = "VERTICAL"
                obj.data.angle_y = vertical
            else:
                obj.data.ortho_scale = obj.data.ortho_scale * aspect_ratio / (16 / 9)  # the importer's scale is the width of the 16:9 picture
                obj.data.sensor_fit = "HORIZONTAL"
        if obj.animation_data and obj.animation_data.action:
            first, last = obj.animation_data.action.frame_range
            scene.frame_start, scene.frame_end = int(first), int(last)
    if obj.name == "Camera path":
        obj.hide_render = True  # a guide line, not part of the picture

if dof_spec.startswith("1") and scene.camera and scene.camera.data.type == "PERSP":  # depth of field (an orthographic camera has none)
    from bpy_extras.object_utils import world_to_camera_view

    _, strength_text, chosen = (dof_spec.split("|") + ["", ""])[:3]
    strength = min(max(int(strength_text or 3), 1), 5)
    camera = scene.camera
    camera_position = camera.matrix_world.translation
    looking = -(camera.matrix_world.to_3x3() @ Vector((0, 0, 1)))
    candidates = []  # (is the chosen part, is in the picture, distance, middle of its box, depth along the view)
    for o in bpy.data.objects:
        if o.type != "MESH" or o.name == "Camera path" or o.hide_render:
            continue
        if o.get("noRender") and (chosen == "" or o.get("itemId") != chosen):
            continue  # a part that is not rendered can only be the focus when it was chosen
        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
        middle = sum(corners, Vector()) / len(corners)
        view = world_to_camera_view(scene, camera, middle)
        candidates.append((chosen != "" and o.get("itemId") == chosen, 0 <= view.x <= 1 and 0 <= view.y <= 1 and view.z > 0, (middle - camera_position).length, middle, view.z))
    if chosen == "_centre":  # the middle of the box round all the parts that are drawn
        drawn = [corner for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Camera path", "Studio floor") and not o.hide_render and not o.get("noRender") for corner in (o.matrix_world @ Vector(c) for c in o.bound_box)]
        if drawn:
            middle_all = (Vector(map(min, *[tuple(c) for c in drawn])) + Vector(map(max, *[tuple(c) for c in drawn]))) / 2
            candidates = [(True, True, (middle_all - camera_position).length, middle_all, 0.0)]
    pool = [c for c in candidates if c[0]] or [c for c in candidates if c[1]] or candidates  # the chosen part, else what is in the picture, else everything
    if pool:
        focus_target = min(pool, key=lambda c: c[2])  # the nearest of them
        focus = max((focus_target[3] - camera_position).dot(looking), 0.01)
        camera.data.dof.use_dof = True
        camera.data.dof.focus_distance = focus
        # The lens opening is chosen from the size of what is in the picture: something that lies about half the scene's size behind (or in front of)
        # the focus is blurred by a set share of the picture width, from barely soft to very soft. A small stack and a big machine, seen from the
        # distance that makes them fill the picture, then look about equally blurred. Thin lens: blur = f^2 * |d - s| / (N * d * (s - f)).
        points = []
        for o in bpy.data.objects:
            if o.type != "MESH" or o.name == "Camera path" or o.hide_render or o.get("noRender"):
                continue
            corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
            middle = sum(corners, Vector()) / len(corners)
            view = world_to_camera_view(scene, camera, middle)
            if 0 <= view.x <= 1 and 0 <= view.y <= 1 and view.z > 0:
                points += corners
        if not points:
            points = [focus_target[3]]
        size = (Vector(map(max, *points)) - Vector(map(min, *points))).length if len(points) > 1 else 0.1  # the diagonal of what is in the picture
        farthest = max(abs(world_to_camera_view(scene, camera, p).z - focus) for p in points)  # how far from the focus the parts really reach
        offset = min(max(farthest, 0.25 * size), 0.6 * size)
        f = camera.data.lens / 1000
        sensor = camera.data.sensor_width / 1000
        blur = DOF_BLUR_SHARES[strength - 1] * sensor
        depth = focus + offset
        n = f * f * offset / (blur * max(depth, 0.01) * max(focus - f, 0.001))
        camera.data.dof.aperture_fstop = min(max(n, 0.1), 22.0)

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
    floor.is_shadow_catcher = transparent_background  # with a transparent background the floor is invisible but still shows the shadows of the parts
    floor.visible_shadow = False  # the floor receives shadows but casts none: a light below the ground (the app allows it) still reaches the parts
    mat = bpy.data.materials.new("Studio floor")
    mat.use_nodes = True
    tree = mat.node_tree
    surface = tree.nodes["Principled BSDF"]
    surface.inputs["Base Color"].default_value = (0.05, 0.055, 0.065, 1)
    surface.inputs["Roughness"].default_value = 0.55
    if reflections:  # a reflection preset is for the shiny parts: the matte floor keeps only a little of it
        for name in ("Specular IOR Level", "Specular"):
            if name in surface.inputs:
                surface.inputs[name].default_value = 0.12
                break
    if ground_colour:
        surface.inputs["Base Color"].default_value = ground_colour
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
    if background_colour:  # what the camera sees is the chosen colour; the gradient keeps lighting the scene
        seen = nt.nodes.new("ShaderNodeBackground")
        seen.inputs["Color"].default_value = background_colour
        seen.inputs["Strength"].default_value = 1.6  # AgX and the -0.3 exposure darken what the camera sees: this brings the colour back to about the one chosen
        path, mixer = nt.nodes.new("ShaderNodeLightPath"), nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(path.outputs["Is Camera Ray"], mixer.inputs["Fac"])
        nt.links.new(bg.outputs[0], mixer.inputs[1])
        nt.links.new(seen.outputs[0], mixer.inputs[2])
        for link in list(out.inputs[0].links):
            nt.links.remove(link)
        nt.links.new(mixer.outputs[0], out.inputs[0])

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
    if light_spec:  # the light of the app's "Shaded with light" view: a sun shining from that direction at that point (mm -> m)
        direction_text, aim_text = light_spec.split(";")
        direction = Vector(float(v) for v in direction_text.split(","))
        aim_point = centre
        if aim_text.startswith("part:"):  # the middle of a part (found by the id the export put on it)
            for o in parts:
                if o.get("itemId") == aim_text[5:]:
                    corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
                    aim_point = sum(corners, Vector()) / len(corners)
        elif aim_text:
            aim_point = Vector(float(v) for v in aim_text.split(",")) * 0.001
        sun_data = bpy.data.lights.new("Key (sun)", "SUN")
        sun_data.energy, sun_data.color, sun_data.angle = SUN_STRENGTH * lamp, (1.0, 0.94, 0.86), math.radians(BEAM_ANGLES[beam])  # how soft the shadows are; 3 degrees, a little soft like the app's shadows, is the normal one
        sun = bpy.data.objects.new("Key (sun)", sun_data)
        sun.location = aim_point + direction.normalized() * d
        scene.collection.objects.link(sun)
        sun_aim = bpy.data.objects.new("Key (sun) target", None)
        sun_aim.location = aim_point
        scene.collection.objects.link(sun_aim)
        sun_track = sun.constraints.new("TRACK_TO")
        sun_track.target, sun_track.track_axis, sun_track.up_axis = sun_aim, "TRACK_NEGATIVE_Z", "UP_Y"
        support = SUPPORT_SCALE
    else:
        support = 1.0
        light("Key (warm)", centre + Vector((d * 0.8, -d, d * 0.9)), 7 * lamp, (1.0, 0.86, 0.7), r * 2.2 * BEAM_SIZES[beam])
    light("Fill (cool)", centre + Vector((-d, -d * 0.5, d * 0.4)), 2.2 * support, (0.6, 0.75, 1.0), r * 3)
    light("Under fill (cool)", centre + Vector((d * 0.3, -d * 0.3, -d)), 3 * support, (0.55, 0.7, 1.0), r * 3)  # soft light for views from below the floor
    light("Rim (magenta)", centre + Vector((-d * 0.3, d, d * 0.6)), 4 * support, (1.0, 0.45, 0.8), r * 1.5)
    if ambient:  # the ambient light presets: a big softbox above the scene (the generic soft top light of a studio) and a lighter world
        power, tint, world_extra = AMBIENT_PRESETS[ambient - 1]
        above = r * 2.5
        top = bpy.data.lights.new("Ambient softbox", "AREA")
        top.shape, top.size, top.size_y, top.energy, top.color = "RECTANGLE", r * 5, r * 5, power * above * above * 10, tint
        top_object = bpy.data.objects.new("Ambient softbox", top)
        top_object.location = (centre.x, centre.y, high.z + above)  # an area light shines down along its own -Z
        scene.collection.objects.link(top_object)
        bg.inputs["Strength"].default_value += world_extra
    if reflections == 1:  # Softbox: a big soft panel above and a bright strip on each side: product-photo reflections. Invisible to the camera, but in every mirror and highlight.
        def panel(name, location, size, size_y, power):
            data = bpy.data.lights.new(name, "AREA")
            data.shape, data.size, data.size_y, data.color = "RECTANGLE", size, size_y, (1.0, 1.0, 1.0)
            data.energy = power * (r * 3) ** 2 * 10
            panel_object = bpy.data.objects.new(name, data)
            panel_object.location = location
            panel_object.visible_camera = False  # not seen by the camera ...
            panel_object.visible_diffuse = False  # ... and not lighting the matte parts and the floor: it is only what shiny and see-through things reflect
            scene.collection.objects.link(panel_object)
            panel_aim = bpy.data.objects.new(name + " target", None)
            panel_aim.location = centre
            scene.collection.objects.link(panel_aim)
            panel_track = panel_object.constraints.new("TRACK_TO")
            panel_track.target, panel_track.track_axis, panel_track.up_axis = panel_aim, "TRACK_NEGATIVE_Z", "UP_Y"
        panel("Softbox top", Vector((centre.x, centre.y, high.z + r * 3)), r * 6, r * 4, 5)
        panel("Softbox left", centre + Vector((-r * 3.5, -r * 0.5, r * 0.8)), r * 1.6, r * 5, 3)
        panel("Softbox right", centre + Vector((r * 3.5, -r * 0.5, r * 0.8)), r * 1.6, r * 5, 3)
    elif reflections in (2, 3, 4):  # Daylight (a sky), a neutral grey room or nothing at all (black): only what shiny and see-through parts reflect and refract; the camera and the lighting of everything else stay as they are
        env = nt.nodes.new("ShaderNodeBackground")
        if reflections == 2:
            sky = nt.nodes.new("ShaderNodeTexSky")
            try:
                sky.sky_type = "NISHITA"
                sky.sun_disc = False  # a soft skylight: the lamps make the shadows
                sky.sun_elevation = math.radians(40)
            except (TypeError, AttributeError):
                pass
            nt.links.new(sky.outputs[0], env.inputs["Color"])
            env.inputs["Strength"].default_value = 0.45
        elif reflections == 3:
            env.inputs["Color"].default_value = (0.5, 0.5, 0.5, 1)
            env.inputs["Strength"].default_value = 1.0
        else:  # None: shiny parts reflect nothing of the surroundings
            env.inputs["Color"].default_value = (0, 0, 0, 1)
            env.inputs["Strength"].default_value = 0.0
        studio_source = out.inputs[0].links[0].from_node
        shiny_path, shiny, environment_mix = nt.nodes.new("ShaderNodeLightPath"), nt.nodes.new("ShaderNodeMath"), nt.nodes.new("ShaderNodeMixShader")
        shiny.operation = "MAXIMUM"  # a reflection ray or a ray through glass sees the environment, every other ray the studio
        for link in list(out.inputs[0].links):
            nt.links.remove(link)
        nt.links.new(shiny_path.outputs["Is Glossy Ray"], shiny.inputs[0])
        nt.links.new(shiny_path.outputs["Is Transmission Ray"], shiny.inputs[1])
        nt.links.new(shiny.outputs[0], environment_mix.inputs["Fac"])
        nt.links.new(studio_source.outputs[0], environment_mix.inputs[1])
        nt.links.new(env.outputs[0], environment_mix.inputs[2])
        nt.links.new(environment_mix.outputs[0], out.inputs[0])
    scene.render.engine = "CYCLES"
    scene.render.film_transparent = transparent_background  # no background in the picture (the lighting stays)
    if transparent_background:
        scene.render.image_settings.color_mode = "RGBA"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.cycles.glossy_bounces = 8  # mirrors facing each other (and a mirror in a mirror) stay bright for a few more reflections
    scene.cycles.transmission_bounces = 12
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.3
    if ambient and scene.camera:  # a closed scene (a box around the parts) lit from above can come out burnt: a tiny test render sets the exposure so the brightest areas stay below white
        import os
        import tempfile
        import numpy
        saved = (scene.render.resolution_x, scene.render.resolution_y, scene.cycles.samples, scene.cycles.use_denoising, scene.render.filepath, scene.render.image_settings.file_format)
        probe = os.path.join(tempfile.mkdtemp(), "probe.png")
        scene.render.resolution_x, scene.render.resolution_y, scene.cycles.samples, scene.cycles.use_denoising = 96, max(2, round(96 / aspect_ratio)), 12, False
        scene.render.filepath, scene.render.image_settings.file_format = probe, "PNG"
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(probe)
        pixels = numpy.array(image.pixels[:], dtype=numpy.float32).reshape(-1, 4)[:, :3]
        bpy.data.images.remove(image)
        bright = float(numpy.percentile(pixels.max(axis=1), 97))  # what the picture shows (display values 0 to 1): the 97th percentile of the brightest channel
        if bright > 0.85:  # about the brightness of a white wall that is still not burnt
            stops = math.log2(0.85 ** 2.2 / max(bright, 1e-3) ** 2.2)  # the display values are about gamma 2.2 of the light
            scene.view_settings.exposure += max(stops, -3.0)
        scene.render.resolution_x, scene.render.resolution_y, scene.cycles.samples, scene.cycles.use_denoising, scene.render.filepath, scene.render.image_settings.file_format = saved

def apply_fx():
    # A style for the picture (cartoon, outline, sketch, clay, blueprint): one material for every part and/or lines drawn by Freestyle, and a plain paper
    # for the camera (the lighting stays). The studio floor goes where the paper is the background.
    if fx == "none":
        return
    view_layer = bpy.context.view_layer
    # (colour of every part or None, paper or None, lines: (thickness in px, colour, hand drawn) or None, posterize steps)
    style = {
        "cartoon": (None, None, (2.2, (0.02, 0.02, 0.03), False), 7),
        "outline": ((1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (1.8, (0.02, 0.02, 0.03), False), 0),
        "sketch": ((0.93, 0.92, 0.9), (0.97, 0.96, 0.92), (2.2, (0.12, 0.12, 0.14), True), 0),
        "clay": ((0.6, 0.58, 0.56), None, None, 0),
        "blueprint": ((0.1, 0.3, 0.62), (0.07, 0.22, 0.5), (1.7, (0.88, 0.94, 1.0), False), 0),
        "isometric": (None, (1.0, 1.0, 1.0), (1.4, (0.05, 0.05, 0.07), False), 9),
        "xray": (None, (0.01, 0.03, 0.07), None, 0),
        "lowpoly": (None, None, None, 0),
        "wireframe": (None, (0.95, 0.95, 0.95), None, 0),
        "thermal": (None, None, None, 0),
        "cutaway": (None, None, None, 0),
        "clayrough": (None, None, None, 0),
        "clayroughcolour": (None, None, None, 0),
        "fog": (None, None, None, 0),
        "watercolour": (None, (0.97, 0.95, 0.9), None, 0),
        "watercolourintense": (None, (0.97, 0.95, 0.9), None, 0),
        "watercolourink": (None, (0.97, 0.95, 0.9), (2.6, (0.02, 0.02, 0.03), True), 0),  # intense watercolour with black marker lines on top  # cream paper, no lines: the edges are where the colour stops
        "lowfog": (None, None, None, 0),
        "hiddenlines": (None, (0x1b / 255, 0x1d / 255, 0x22 / 255), (0.7, (0.8, 0.8, 0.8), False), 0),  # the studio background; the lines take the colour of their part
    }[fx]
    colour, paper, lines, steps = style
    if fx == "xray":  # see-through parts whose edges glow: the more a surface turns away from the camera, the more it shines
        material = bpy.data.materials.new("FX xray")
        material.use_nodes = True
        tree = material.node_tree
        for node in list(tree.nodes):
            if node.type != "OUTPUT_MATERIAL":
                tree.nodes.remove(node)
        output = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
        edge, glow, clear, mix, share = (tree.nodes.new(k) for k in ("ShaderNodeFresnel", "ShaderNodeEmission", "ShaderNodeBsdfTransparent", "ShaderNodeMixShader", "ShaderNodeMath"))
        edge.inputs["IOR"].default_value = 1.15
        share.operation = "MULTIPLY_ADD"  # 0.12 + 0.88 x the edge
        share.inputs[1].default_value = 0.88
        share.inputs[2].default_value = 0.12
        glow.inputs["Color"].default_value = (0.25, 0.75, 1.0, 1)
        glow.inputs["Strength"].default_value = 3.0
        tree.links.new(edge.outputs[0], share.inputs[0])
        tree.links.new(share.outputs[0], mix.inputs[0])
        tree.links.new(clear.outputs[0], mix.inputs[1])
        tree.links.new(glow.outputs[0], mix.inputs[2])
        tree.links.new(mix.outputs[0], output.inputs["Surface"])
        view_layer.material_override = material
        scene.cycles.transparent_max_bounces = 32
    if fx == "lowpoly":  # few, flat facets: the meshes are reduced and every face shades on its own
        for obj in bpy.data.objects:
            if obj.type != "MESH" or obj.name in ("Studio floor", "Camera path"):
                continue
            if len(obj.data.polygons) > 60:
                reduce = obj.modifiers.new("FX low poly", "DECIMATE")
                reduce.ratio = 0.1
            for polygon in obj.data.polygons:
                polygon.use_smooth = False
    if fx == "isometric" and scene.camera and scene.camera.data.type == "PERSP":  # a technical drawing: no perspective, parallel lines
        camera_data = scene.camera.data
        parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Studio floor", "Camera path") and not o.hide_render]
        corners = [o.matrix_world @ Vector(c) for o in parts for c in o.bound_box]
        if corners:
            middle = (Vector(map(min, *[tuple(c) for c in corners])) + Vector(map(max, *[tuple(c) for c in corners]))) / 2
            forward = -(scene.camera.matrix_world.to_3x3() @ Vector((0, 0, 1)))
            depth = max((middle - scene.camera.matrix_world.translation).dot(forward), 0.01)
            visible_height = 2 * depth * math.tan(camera_data.angle_y / 2)
            camera_data.type = "ORTHO"
            camera_data.sensor_fit = "VERTICAL"
            camera_data.ortho_scale = visible_height
    if colour is not None:  # every part in one matte colour
        material = bpy.data.materials.new("FX " + fx)
        material.use_nodes = True
        shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        shader.inputs["Base Color"].default_value = (*(c ** 2.2 for c in colour), 1)
        shader.inputs["Roughness"].default_value = 0.9
        view_layer.material_override = material
    if fx in ("clayrough", "clayroughcolour"):  # clay modelled by hand: lumpy, with thumb prints and grain (mottled grey, or in the colours of the parts)
        def roughen(tree, shader, mottled):
            shader.inputs["Roughness"].default_value = 0.95
            coords = tree.nodes.new("ShaderNodeTexCoord")
            lumps, prints, grain = (tree.nodes.new("ShaderNodeTexNoise") for _ in range(3))
            for node, scale, detail, roughness in ((lumps, 14.0, 6.0, 0.62), (prints, 55.0, 8.0, 0.7), (grain, 420.0, 3.0, 0.55)):
                node.inputs["Scale"].default_value = scale
                node.inputs["Detail"].default_value = detail
                node.inputs["Roughness"].default_value = roughness
                tree.links.new(coords.outputs["Object"], node.inputs["Vector"])
            height = tree.nodes.new("ShaderNodeMath")  # the lumps count most, the prints less, the grain least
            height.operation = "MULTIPLY_ADD"
            height.inputs[1].default_value = 0.6
            tree.links.new(lumps.outputs["Fac"], height.inputs[0])
            both = tree.nodes.new("ShaderNodeMath")
            both.operation = "MULTIPLY_ADD"
            both.inputs[1].default_value = 0.3
            tree.links.new(prints.outputs["Fac"], both.inputs[0])
            tree.links.new(height.outputs[0], both.inputs[2])
            rough = tree.nodes.new("ShaderNodeMath")
            rough.operation = "MULTIPLY_ADD"
            rough.inputs[1].default_value = 0.1
            tree.links.new(grain.outputs["Fac"], rough.inputs[0])
            tree.links.new(both.outputs[0], rough.inputs[2])
            bump = tree.nodes.new("ShaderNodeBump")
            bump.inputs["Strength"].default_value = 1.0
            bump.inputs["Distance"].default_value = 0.012
            tree.links.new(rough.outputs[0], bump.inputs["Height"])
            tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
            if mottled:  # the colour is a little uneven, like clay that was not kneaded through
                ramp = tree.nodes.new("ShaderNodeValToRGB")
                ramp.color_ramp.elements[0].color = (0.19, 0.16, 0.135, 1)
                ramp.color_ramp.elements[1].color = (0.36, 0.31, 0.27, 1)
                tree.links.new(lumps.outputs["Fac"], ramp.inputs["Factor"])
                tree.links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
        if fx == "clayrough":
            material = bpy.data.materials.new("FX rough clay")
            material.use_nodes = True
            roughen(material.node_tree, next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), True)
            view_layer.material_override = material
        else:  # every material keeps its colour and gets the lumps
            for material in list(bpy.data.materials):
                if not material.use_nodes:
                    continue
                shader = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                if shader is not None:
                    shader.inputs["Metallic"].default_value = 0.0
                    shader.inputs["Coat Weight"].default_value = 0.0
                    roughen(material.node_tree, shader, False)
    if fx in ("fog", "lowfog"):  # mist: it thickens with distance (parts fade into it), or lies low on the ground (up to half the height of the parts)
        parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Studio floor", "Camera path") and not o.hide_render]
        corners = [o.matrix_world @ Vector(c) for o in parts for c in o.bound_box]
        if corners and scene.camera:
            low = Vector(map(min, *[tuple(c) for c in corners]))
            high = Vector(map(max, *[tuple(c) for c in corners]))
            mist = (0.82, 0.86, 0.92, 1) if fx == "fog" else (0.8, 0.82, 0.88, 1)
            if fx == "fog":  # the whole air in front of the camera: thicker the farther away
                camera_at = scene.camera.matrix_world.translation
                distances = [(c - camera_at).length for c in corners]
                near, reach = min(distances), max(distances)
                world = scene.world
                if world and world.use_nodes:
                    tree = world.node_tree
                    output = next((n for n in tree.nodes if n.type == "OUTPUT_WORLD"), None)
                    if output is not None:
                        # the air in front of the nearest part is clear, then the mist thickens towards the farthest part (and stays as thick behind it): like the haze of a real landscape
                        where = tree.nodes.new("ShaderNodeNewGeometry")
                        away = tree.nodes.new("ShaderNodeVectorMath")
                        away.operation = "DISTANCE"
                        away.inputs[1].default_value = camera_at
                        build_up = tree.nodes.new("ShaderNodeMapRange")
                        build_up.clamp = True
                        build_up.inputs["From Min"].default_value = near
                        build_up.inputs["From Max"].default_value = max(reach, near + 0.01)
                        build_up.inputs["To Min"].default_value = 0.0
                        build_up.inputs["To Max"].default_value = 1.0
                        thick = tree.nodes.new("ShaderNodeMath")
                        thick.operation = "MULTIPLY"
                        thick.inputs[1].default_value = 3.2 / max(reach - near, 0.01)  # through the whole depth of the scene about a quarter of the light gets through
                        glow = tree.nodes.new("ShaderNodeMath")  # the mist glows a little by itself: far parts fade into a light grey, not into black smoke
                        glow.operation = "MULTIPLY"
                        glow.inputs[1].default_value = 0.75
                        air = tree.nodes.new("ShaderNodeVolumePrincipled")
                        air.inputs["Color"].default_value = mist
                        air.inputs["Emission Color"].default_value = mist
                        air.inputs["Anisotropy"].default_value = 0.25
                        tree.links.new(where.outputs["Position"], away.inputs[0])
                        tree.links.new(away.outputs["Value"], build_up.inputs["Value"])
                        tree.links.new(build_up.outputs["Result"], thick.inputs[0])
                        tree.links.new(thick.outputs[0], air.inputs["Density"])
                        tree.links.new(thick.outputs[0], glow.inputs[0])
                        tree.links.new(glow.outputs[0], air.inputs["Emission Strength"])
                        tree.links.new(air.outputs[0], output.inputs["Volume"])
            else:  # a layer of mist on the ground: densest at the floor, thinning out upwards and with wisps
                import bmesh
                height = (high.z - low.z) / 2
                span = max(high.x - low.x, high.y - low.y, height) * 1.6
                shape = bmesh.new()
                bmesh.ops.create_cube(shape, size=1.0)
                body = bpy.data.meshes.new("FX fog")
                shape.to_mesh(body)
                shape.free()
                layer = bpy.data.objects.new("FX fog", body)
                scene.collection.objects.link(layer)
                layer.scale = Vector((span, span, height))
                layer.location = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z + height / 2))
                layer.visible_shadow = False
                material = bpy.data.materials.new("FX fog")
                material.use_nodes = True
                tree = material.node_tree
                for node in list(tree.nodes):
                    if node.type != "OUTPUT_MATERIAL":
                        tree.nodes.remove(node)
                output = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
                coords = tree.nodes.new("ShaderNodeTexCoord")
                split = tree.nodes.new("ShaderNodeSeparateXYZ")
                tree.links.new(coords.outputs["Generated"], split.inputs[0])
                thin = tree.nodes.new("ShaderNodeMath")  # 1 at the floor, 0 at the top of the layer, falling off smoothly
                thin.operation = "SUBTRACT"
                thin.inputs[0].default_value = 1.0
                tree.links.new(split.outputs["Z"], thin.inputs[1])
                soft = tree.nodes.new("ShaderNodeMath")
                soft.operation = "POWER"
                soft.inputs[1].default_value = 1.1  # thins out gently, so the mist is still there near the top of the layer
                tree.links.new(thin.outputs[0], soft.inputs[0])
                wisps = tree.nodes.new("ShaderNodeTexNoise")
                wisps.inputs["Scale"].default_value = 3.5
                wisps.inputs["Detail"].default_value = 4.0
                tree.links.new(coords.outputs["Object"], wisps.inputs["Vector"])
                patchy = tree.nodes.new("ShaderNodeMath")
                patchy.operation = "MULTIPLY_ADD"  # 0.45 + 1.1 x noise: thicker and thinner patches
                patchy.inputs[1].default_value = 1.1
                patchy.inputs[2].default_value = 0.0
                tree.links.new(wisps.outputs["Fac"], patchy.inputs[0])
                flat = tree.nodes.new("ShaderNodeCombineXYZ")  # across the layer: thickest in the middle, thinning out to nothing at the edges
                flat.inputs["Z"].default_value = 0.5
                tree.links.new(split.outputs["X"], flat.inputs["X"])
                tree.links.new(split.outputs["Y"], flat.inputs["Y"])
                wide = tree.nodes.new("ShaderNodeMapping")
                wide.inputs["Location"].default_value = (-1.0, -1.0, -0.5)
                wide.inputs["Scale"].default_value = (2.0, 2.0, 2.0)
                tree.links.new(flat.outputs[0], wide.inputs["Vector"])
                round_ = tree.nodes.new("ShaderNodeTexGradient")
                round_.gradient_type = "SPHERICAL"
                tree.links.new(wide.outputs[0], round_.inputs["Vector"])
                edge = tree.nodes.new("ShaderNodeMath")
                edge.operation = "POWER"
                edge.inputs[1].default_value = 0.8
                tree.links.new(round_.outputs["Fac"], edge.inputs[0])
                height_part = tree.nodes.new("ShaderNodeMath")
                height_part.operation = "MULTIPLY"
                tree.links.new(soft.outputs[0], height_part.inputs[0])
                tree.links.new(edge.outputs[0], height_part.inputs[1])
                density = tree.nodes.new("ShaderNodeMath")
                density.operation = "MULTIPLY"
                tree.links.new(height_part.outputs[0], density.inputs[0])
                tree.links.new(patchy.outputs[0], density.inputs[1])
                air = tree.nodes.new("ShaderNodeVolumeScatter")
                air.inputs["Color"].default_value = mist
                air.inputs["Anisotropy"].default_value = 0.2
                scale = tree.nodes.new("ShaderNodeMath")
                scale.operation = "MULTIPLY"
                scale.inputs[1].default_value = 9.0 / max(height, 1e-6)  # looking down through the layer lets little of the light through where it is densest
                tree.links.new(density.outputs[0], scale.inputs[0])
                tree.links.new(scale.outputs[0], air.inputs["Density"])
                tree.links.new(air.outputs[0], output.inputs["Volume"])
                layer.data.materials.append(material)
    if fx in ("watercolour", "watercolourintense", "watercolourink"):  # washes of colour on paper: the pigment varies a little in every part, the colours are smeared into patches and pale
        for material in list(bpy.data.materials):
            if not material.use_nodes or material.name.startswith("FX"):
                continue
            tree = material.node_tree
            shader = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if shader is None:
                continue
            shader.inputs["Roughness"].default_value = 1.0
            shader.inputs["Metallic"].default_value = 0.0
            shader.inputs["Coat Weight"].default_value = 0.0
            base = tuple(shader.inputs["Base Color"].default_value)
            coords = tree.nodes.new("ShaderNodeTexCoord")
            blotches = tree.nodes.new("ShaderNodeTexNoise")
            blotches.inputs["Scale"].default_value = 6.0 if fx != "watercolour" else 9.0
            blotches.inputs["Detail"].default_value = 7.0 if fx != "watercolour" else 5.0
            tree.links.new(coords.outputs["Object"], blotches.inputs["Vector"])
            ramp = tree.nodes.new("ShaderNodeValToRGB")  # more and less pigment
            ramp.color_ramp.elements[0].color = (0.2, 0.2, 0.2, 1) if fx != "watercolour" else (0.4, 0.4, 0.4, 1)
            ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
            ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[1].position = (0.3, 0.7) if fx != "watercolour" else (0.0, 1.0)  # intense: more contrast between the pale and the dark patches
            tree.links.new(blotches.outputs["Fac"], ramp.inputs["Factor"])
            wash = tree.nodes.new("ShaderNodeMix")
            wash.data_type = "RGBA"
            wash.blend_type = "MULTIPLY"
            wash.inputs["Factor"].default_value = 1.0
            wash.inputs[6].default_value = base
            tree.links.new(ramp.outputs["Color"], wash.inputs[7])
            tree.links.new(wash.outputs[2], shader.inputs["Base Color"])
        tree = bpy.data.node_groups.new("FX compositing", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        layers = tree.nodes.new("CompositorNodeRLayers")
        paint = tree.nodes.new("CompositorNodeKuwahara")
        paint.inputs["Size"].default_value = 14 if fx != "watercolour" else 9  # intense: bigger, wetter patches
        pale = tree.nodes.new("CompositorNodeHueSat")
        pale.inputs["Saturation"].default_value = 1.7 if fx != "watercolour" else 0.85  # intense: deep, juicy colours
        pale.inputs["Value"].default_value = 1.25 if fx != "watercolour" else 1.35
        out = tree.nodes.new("NodeGroupOutput")
        tree.links.new(layers.outputs["Image"], paint.inputs["Image"])
        tree.links.new(paint.outputs["Image"], pale.inputs["Image"])
        tree.links.new(pale.outputs["Image"], out.inputs[0])
    if fx == "hiddenlines":  # the "Hidden lines removed" look of the design view: faces in the background colour, only the visible edges drawn, in the colour of their part
        scene.view_settings.view_transform = "Standard"  # the colours as they are, not tone mapped
        scene.view_settings.look = "None"
        flat = (tuple(background_colour[:3]) if background_colour is not None else tuple((c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in paper)) + (1,)
        for material in list(bpy.data.materials):
            if not material.use_nodes or material.name.startswith("FX"):
                continue
            tree = material.node_tree
            shader = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            base = tuple(shader.inputs["Base Color"].default_value)[:3] if shader is not None else (0.8, 0.8, 0.8)
            material.line_color = (*base, 1.0)  # the Freestyle lines read it
            output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
            for node in list(tree.nodes):
                if output is None or node.name != output.name:
                    tree.nodes.remove(node)
            if output is not None:
                fill = tree.nodes.new("ShaderNodeEmission")
                fill.inputs["Color"].default_value = flat
                fill.inputs["Strength"].default_value = 1.0
                tree.links.new(fill.outputs[0], output.inputs["Surface"])
    if fx == "wireframe":  # light parts with the triangles of their meshes drawn on them
        material = bpy.data.materials.new("FX wireframe")
        material.use_nodes = True
        tree = material.node_tree
        output = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
        shaded = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        shaded.inputs["Base Color"].default_value = (0.62, 0.62, 0.64, 1)
        shaded.inputs["Roughness"].default_value = 0.8
        ink_node, wire, mix = tree.nodes.new("ShaderNodeEmission"), tree.nodes.new("ShaderNodeWireframe"), tree.nodes.new("ShaderNodeMixShader")
        ink_node.inputs["Color"].default_value = (0.02, 0.03, 0.05, 1)
        ink_node.inputs["Strength"].default_value = 1.0
        wire.use_pixel_size = True
        wire.inputs["Size"].default_value = 0.7
        tree.links.new(wire.outputs[0], mix.inputs[0])
        tree.links.new(shaded.outputs[0], mix.inputs[1])
        tree.links.new(ink_node.outputs[0], mix.inputs[2])
        tree.links.new(mix.outputs[0], output.inputs["Surface"])
        view_layer.material_override = material
    if fx == "cutaway":  # a plane cuts through the assembly: one side is cut away and the cut shows in orange
        parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Studio floor", "Camera path") and not o.hide_render and not o.get("noRender")]
        corners = [o.matrix_world @ Vector(c) for o in parts for c in o.bound_box]
        if corners:
            axis_name, position_text, flip_text = (cut_text or "z:50:0").split(":")
            axis = "xyz".index(axis_name)
            low = Vector(map(min, *[tuple(c) for c in corners]))
            high = Vector(map(max, *[tuple(c) for c in corners]))
            at = low[axis] + (high[axis] - low[axis]) * min(max(int(position_text), 0), 100) / 100
            sign = -1 if flip_text == "1" else 1  # which side goes: the high side (1) or the low side (-1)
            reach = max((high - low).length, 0.01) * 2
            cutter = bpy.data.objects.new("FX cutter", bpy.data.meshes.new("FX cutter"))
            import bmesh
            shape = bmesh.new()
            bmesh.ops.create_cube(shape, size=2.0)  # a closed box with outward faces
            shape.to_mesh(cutter.data)
            shape.free()
            scene.collection.objects.link(cutter)
            cutter.scale = Vector((reach, reach, reach))
            centre = (low + high) / 2
            centre[axis] = at + sign * reach
            cutter.location = centre
            cap = bpy.data.materials.new("FX cut")
            cap.use_nodes = True
            shader = next(n for n in cap.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            shader.inputs["Base Color"].default_value = (0.9, 0.32, 0.05, 1)
            shader.inputs["Roughness"].default_value = 0.7
            cutter.data.materials.append(cap)
            cutter.hide_render = True
            cutter.display_type = "BOUNDS"
            for obj in parts:
                cut = obj.modifiers.new("FX cut", "BOOLEAN")
                cut.operation = "DIFFERENCE"
                cut.object = cutter
                try:
                    cut.solver = "MANIFOLD"  # fast and exact on closed meshes
                except (TypeError, AttributeError):
                    cut.solver = "EXACT"
                try:
                    cut.material_mode = "TRANSFER"  # the cut faces take the cutter's colour
                except (TypeError, AttributeError):
                    pass
    if fx == "thermal":  # false colour by distance from the focused part, else what the lamp points at (the hottest): warm close to it, cold far from it
        camera = scene.camera
        if camera:
            view_layer.use_pass_position = True
            view_layer.use_pass_z = True  # the depth tells the sky (nothing there) from the parts
            parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Studio floor", "Camera path") and not o.hide_render]

            def box(o):
                corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
                return Vector(map(min, *[tuple(c) for c in corners])), Vector(map(max, *[tuple(c) for c in corners]))

            all_corners = [c for o in parts for c in box(o)]
            low = Vector(map(min, *[tuple(c) for c in all_corners])) if all_corners else Vector()
            high = Vector(map(max, *[tuple(c) for c in all_corners])) if all_corners else Vector()
            chosen = next((o for o in parts if o.get("itemId") == focus_text), None) if focus_text and focus_text != "_centre" else None
            aim = light_spec.split(";")[1] if light_spec else ""  # where the lamp points: a part, a point, or (nothing set) the middle of the scene
            lit_part = next((o for o in parts if o.get("itemId") == aim[5:]), None) if aim.startswith("part:") else None
            if focus_text == "_centre":  # the focus menu says: the middle of all the objects
                heat_at, heat_radius = (low + high) / 2, 0.0
            elif chosen is not None or lit_part is not None:  # the focused part, else the part the lamp points at: the whole part is at its hottest
                a_, b_ = box(chosen if chosen is not None else lit_part)
                heat_at, heat_radius = (a_ + b_) / 2, (b_ - a_).length / 2
            elif aim and not aim.startswith("part:"):  # the lamp points at a point
                heat_at, heat_radius = Vector(float(v) for v in aim.split(",")) * 0.001, 0.0
            else:
                heat_at, heat_radius = (low + high) / 2, 0.0
            farthest = max((c - heat_at).length for c in all_corners) if all_corners else 1.0
            farthest = max(farthest, heat_radius + 0.01)
            tree = bpy.data.node_groups.new("FX compositing", "CompositorNodeTree")
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            scene.compositing_node_group = tree
            layers = tree.nodes.new("CompositorNodeRLayers")
            away = tree.nodes.new("ShaderNodeVectorMath")
            away.operation = "DISTANCE"
            away.inputs[1].default_value = heat_at
            ranged = tree.nodes.new("ShaderNodeMapRange")
            ranged.inputs["From Min"].default_value = heat_radius
            ranged.inputs["From Max"].default_value = farthest
            ranged.inputs["To Min"].default_value = 1.0  # at the part: hot
            ranged.inputs["To Max"].default_value = 0.0
            ranged.clamp = True
            ramp = tree.nodes.new("ShaderNodeValToRGB")
            colours = [(0.0, (0.0, 0.0, 0.08, 1)), (0.2, (0.1, 0.0, 0.45, 1)), (0.4, (0.6, 0.0, 0.55, 1)), (0.6, (0.95, 0.15, 0.1, 1)), (0.8, (1.0, 0.7, 0.0, 1)), (1.0, (1.0, 1.0, 0.8, 1))]
            ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = colours[0]
            ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = colours[-1]
            for position, colour_ in colours[1:-1]:
                element = ramp.color_ramp.elements.new(position)
                element.color = colour_
            out = tree.nodes.new("NodeGroupOutput")
            sky = tree.nodes.new("ShaderNodeMath")
            sky.operation = "GREATER_THAN"
            sky.inputs[1].default_value = ((camera.matrix_world.translation - heat_at).length + farthest) * 3  # nothing of the scene is this far away
            keep = tree.nodes.new("ShaderNodeMath")
            keep.operation = "SUBTRACT"
            keep.inputs[0].default_value = 1.0
            cold_sky = tree.nodes.new("ShaderNodeMath")
            cold_sky.operation = "MULTIPLY"
            tree.links.new(layers.outputs["Depth"], sky.inputs[0])
            tree.links.new(sky.outputs[0], keep.inputs[1])
            tree.links.new(layers.outputs["Position"], away.inputs[0])
            tree.links.new(away.outputs["Value"], ranged.inputs["Value"])
            tree.links.new(ranged.outputs["Result"], cold_sky.inputs[0])
            tree.links.new(keep.outputs[0], cold_sky.inputs[1])
            tree.links.new(cold_sky.outputs[0], ramp.inputs["Factor"])
            tree.links.new(ramp.outputs["Color"], out.inputs[0])
    if paper is not None:  # the camera sees the paper
        to_linear = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        paper_linear = tuple(background_colour[:3]) if (fx == "hiddenlines" and background_colour is not None) else tuple(to_linear(c) for c in paper)  # the chosen background colour wins for the design-view look, everything else the studio's lighting
        floor = bpy.data.objects.get("Studio floor")
        if floor:
            floor.hide_render = True
        world = scene.world
        if world and world.use_nodes:
            tree = world.node_tree
            output = next((n for n in tree.nodes if n.type == "OUTPUT_WORLD"), None)
            if output and output.inputs["Surface"].links:
                lighting = output.inputs["Surface"].links[0].from_node
                plain = tree.nodes.new("ShaderNodeBackground")
                plain.inputs["Color"].default_value = (*paper_linear, 1)
                path, mix = tree.nodes.new("ShaderNodeLightPath"), tree.nodes.new("ShaderNodeMixShader")
                tree.links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
                tree.links.new(lighting.outputs[0], mix.inputs[1])
                tree.links.new(plain.outputs[0], mix.inputs[2])
                tree.links.new(mix.outputs[0], output.inputs["Surface"])
        scene.render.film_transparent = False
    if lines is not None:  # lines along the silhouettes, the borders and the sharp edges
        thickness, ink, drawn = lines
        scene.render.use_freestyle = True
        view_layer.use_freestyle = True
        scene.render.line_thickness_mode = "ABSOLUTE"
        scene.render.line_thickness = thickness
        settings = view_layer.freestyle_settings
        settings.crease_angle = math.radians(155 if fx == "hiddenlines" else 115)  # the design view draws every edge where the faces turn more than 25 degrees
        for old in list(settings.linesets):
            settings.linesets.remove(old)
        lineset = settings.linesets.new("FX lines")
        for name in (("select_silhouette", "select_border", "select_crease") if fx == "hiddenlines" else ("select_silhouette", "select_external_contour", "select_border") if fx == "watercolourink" else ("select_silhouette", "select_border", "select_crease", "select_material_boundary", "select_external_contour")):  # the ink drawing keeps to the contours: no lines on every little edge
            setattr(lineset, name, True)
        lineset.select_by_visibility = True
        drawn_parts = bpy.data.collections.new("FX parts")  # the lines belong to the parts, not to the studio floor (its rim would be a line across the picture)
        bpy.context.scene.collection.children.link(drawn_parts)
        for o in bpy.data.objects:
            if o.type == "MESH" and o.name not in ("Studio floor", "Camera path"):
                drawn_parts.objects.link(o)
        lineset.select_by_collection = True
        lineset.collection = drawn_parts
        style_ = bpy.data.linestyles.new("FX line style")
        style_.color = ink
        style_.thickness = thickness * (max(scene.render.resolution_x, 1000) / 1000 if fx == "hiddenlines" else 1.0)
        if fx == "hiddenlines":  # each line in the colour of its part
            by_part = style_.color_modifiers.new("Part colour", "MATERIAL")
            by_part.material_attribute = "LINE"
        if fx == "watercolourink":  # a marker pen: broad and thin with the direction of the stroke, swelling and thinning along it, and no tiny scraps
            scale_ = max(scene.render.resolution_x, 1000) / 1000
            style_.thickness = 1.0
            scene.render.line_thickness = 1.0  # the pen modifiers set the width
            try:
                style_.use_length_min = True
                style_.length_min = 45.0 * scale_
                pen = style_.thickness_modifiers.new("Pen", "CALLIGRAPHY")
                pen.thickness_min, pen.thickness_max, pen.orientation = 0.5 * scale_, 3.2 * scale_, math.radians(40)
                swell = style_.thickness_modifiers.new("Swell", "NOISE")
                swell.amplitude, swell.period, swell.seed = 0.9 * scale_, 40.0, 7
                swell.use_asymmetric = False
            except (RuntimeError, TypeError, AttributeError):
                pass
        if drawn:  # a wobbly, hand-drawn line
            try:
                style_.thickness_position = "CENTER"
                wobble = style_.geometry_modifiers.new("Wobble", "PERLIN_NOISE_1D")
                wobble.frequency = 12.0
                wobble.amplitude = 2.5
                wobble.seed = 3
            except (RuntimeError, TypeError, AttributeError):
                pass
        lineset.linestyle = style_
        if fx == "watercolourink":  # the marker lines stay out of the smeared picture and go over it afterwards, sharp
            settings.as_render_pass = True
            scene.render.use_freestyle = True
            group = scene.compositing_node_group
            if group is not None:
                layers = next((n for n in group.nodes if n.bl_idname == "CompositorNodeRLayers"), None)
                pale = next((n for n in group.nodes if n.bl_idname == "CompositorNodeHueSat"), None)
                out = next((n for n in group.nodes if n.bl_idname == "NodeGroupOutput"), None)
                if layers is not None and pale is not None and out is not None and "Freestyle" in layers.outputs:
                    over = group.nodes.new("CompositorNodeAlphaOver")
                    group.links.new(pale.outputs["Image"], over.inputs["Background"])
                    group.links.new(layers.outputs["Freestyle"], over.inputs["Foreground"])
                    group.links.new(over.outputs["Image"], out.inputs[0])
    if steps:  # flat bands of colour: the compositor posterizes the picture and makes it a little livelier
        tree = bpy.data.node_groups.new("FX compositing", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        layers = tree.nodes.new("CompositorNodeRLayers")
        lively = tree.nodes.new("CompositorNodeHueSat")
        lively.inputs["Saturation"].default_value = 1.25
        lively.inputs["Value"].default_value = 1.7  # the bands are cut from the linear picture: lift it so the colours are not all in the darkest band
        bands = tree.nodes.new("CompositorNodePosterize")
        bands.inputs["Steps"].default_value = steps
        out = tree.nodes.new("NodeGroupOutput")
        tree.links.new(layers.outputs["Image"], lively.inputs["Image"])
        tree.links.new(lively.outputs["Image"], bands.inputs["Image"])
        tree.links.new(bands.outputs["Image"], out.inputs[0])

apply_fx()

for o in bpy.data.objects:  # parts marked "Do not render": there, but neither drawn nor casting shadows or showing in reflections
    if o.get("noRender"):
        o.hide_render = True
        o.display_type = "WIRE"
if render_spec:  # a picture of this size and with this many samples: the settings go into the .blend, which is then rendered (see _run_blender)
    width, samples = (int(v) for v in render_spec.split(","))
    scene.render.resolution_x, scene.render.resolution_y = width, round(width / aspect_ratio)
    scene.render.resolution_percentage = 100
    if crop_flag == "1" and scene.camera:  # as wide as the parts: the height (and with it the framing) stays, the width follows the parts
        from bpy_extras.object_utils import world_to_camera_view

        camera = scene.camera
        shown = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Camera path", "Studio floor") and not o.hide_render]

        def horizontal_extent():
            low, high = 1e9, -1e9
            for o in shown:
                for corner in o.bound_box:
                    view = world_to_camera_view(scene, camera, o.matrix_world @ Vector(corner))
                    if view.z > 0:
                        low, high = min(low, view.x), max(high, view.x)
            return low, high

        low, high = horizontal_extent()
        if high > low:
            height = scene.render.resolution_y
            padding = 1 + 2 * CROP_PADDING
            fraction = min(max((high - low) * padding, 0.2), 1.0)  # the share of the 16:9 frame the parts take (a frame never gets wider)
            scene.render.resolution_x = max(2, round(height * aspect_ratio * fraction / 2) * 2)
            camera.data.shift_x = 0.0
            for _ in range(8):  # the parts in the middle of the narrower frame: shift the lens until their middle is the middle of the picture
                low, high = horizontal_extent()
                middle = (low + high) / 2 - 0.5
                if abs(middle) < 0.002:
                    break
                camera.data.shift_x += middle * (scene.render.resolution_x / max(scene.render.resolution_x, scene.render.resolution_y))
    if turntable_spec and scene.camera:  # a turntable: "frames,motion,fps", motion "orbit" (the camera circles) or "spin" (the parts turn, the camera stays)
        fields = turntable_spec.split(",")
        frames_text, motion, fps_text = fields[:3]
        track_id = fields[3] if len(fields) > 3 else ""  # the item id of the part the camera tracks
        direction_cw = len(fields) > 6 and fields[6] == "cw"  # the way round: counter-clockwise (the default) or clockwise, seen from above
        look_at = fields[5] if len(fields) > 5 else ("part" if track_id else "view")  # what the camera keeps looking at: "part", "all" (the middle of all the objects) or "view" (where it points now)
        track_pivot = fields[4] if len(fields) > 4 else "all"  # "part": the camera goes round that part; "all": round the middle of all the objects, "view": round the point the view looks at; a tracked part is looked at in every case
        frames, fps = int(frames_text), int(fps_text)
        scene.frame_start, scene.frame_end = 1, frames
        scene.render.fps = fps
        scene.render.resolution_x -= scene.render.resolution_x % 2  # H.264 wants even sizes
        scene.render.resolution_y -= scene.render.resolution_y % 2
        shown = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in ("Camera path", "Studio floor") and not o.hide_render]
        corners = [o.matrix_world @ Vector(c) for o in shown for c in o.bound_box] or [Vector((0, 0, 0))]
        low = Vector(map(min, *corners)) if len(corners) > 1 else corners[0]
        high = Vector(map(max, *corners)) if len(corners) > 1 else corners[0]
        middle = (low + high) / 2
        pivot = bpy.data.objects.new("Turntable pivot", None)
        scene.collection.objects.link(pivot)
        camera = scene.camera
        if motion == "spin":  # the parts turn about the middle of their footprint; the camera, the lamps and the floor stay where they are
            pivot.location = (middle.x, middle.y, low.z)
            bpy.context.view_layer.update()
            for o in bpy.data.objects:
                if o.type == "MESH" and o.name not in ("Camera path", "Studio floor") and o.parent is None:
                    o.parent = pivot
                    o.matrix_parent_inverse = pivot.matrix_world.inverted()
            # the camera stays where the view is, and may look at the tracked part (which turns with the parts) or at the middle of all of them
            tracked = [o for o in shown if track_id and o.get("itemId") == track_id]
            aim_at = None
            if look_at == "part" and tracked:
                points = [o.matrix_world @ Vector(c) for o in tracked for c in o.bound_box]
                aim_at = (Vector(map(min, *points)) + Vector(map(max, *points))) / 2 if len(points) > 1 else points[0]
            elif look_at == "all":
                aim_at = middle
            if aim_at is not None:
                aim = bpy.data.objects.new("Look target", None)
                aim.location = aim_at
                scene.collection.objects.link(aim)
                aim.parent = pivot  # it turns with the parts, so the camera follows the part round
                aim.matrix_parent_inverse = pivot.matrix_world.inverted()
                follow = camera.constraints.new("TRACK_TO")
                follow.target, follow.track_axis, follow.up_axis = aim, "TRACK_NEGATIVE_Z", "UP_Y"
        else:  # the camera circles about the upright line through the point it looks at (or through the part it tracks), keeping its height and its distance
            forward = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
            looked_at = camera.matrix_world.translation + forward * max((middle - camera.matrix_world.translation).dot(forward), 0.01)
            tracked = [o for o in shown if track_id and o.get("itemId") == track_id]
            part_centre = None
            if tracked:
                points = [o.matrix_world @ Vector(c) for o in tracked for c in o.bound_box]
                part_centre = (Vector(map(min, *points)) + Vector(map(max, *points))) / 2 if len(points) > 1 else points[0]
            # what the camera goes round: the point the view looks at (the default of `looked_at`), the middle of all the objects, or the tracked part
            if track_pivot == "part" and part_centre is not None:
                looked_at = part_centre
            elif track_pivot in ("all", "part"):
                looked_at = middle
            # what it keeps looking at: the tracked part, the middle of all the objects, or (view) nothing in particular: it keeps the angle it has
            aim_at = part_centre if look_at == "part" else middle if look_at == "all" else None
            if aim_at is not None:
                aim = bpy.data.objects.new("Look target", None)
                aim.location = aim_at
                scene.collection.objects.link(aim)
                follow = camera.constraints.new("TRACK_TO")
                follow.target, follow.track_axis, follow.up_axis = aim, "TRACK_NEGATIVE_Z", "UP_Y"
            pivot.location = looked_at
            bpy.context.view_layer.update()
            camera.parent = pivot
            camera.matrix_parent_inverse = pivot.matrix_world.inverted()
        # One full turn over the frames, at a constant speed (the next frame would be the first again: the video loops). A driver on the frame number, not keyframes:
        # keyframes ease in and out whatever interpolation is asked for, and a turntable that starts and ends slowly does not loop smoothly.
        driver = pivot.driver_add("rotation_euler", 2).driver
        driver.type = "SCRIPTED"
        turn_sign = (-1 if motion == "spin" else 1) * (-1 if direction_cw else 1)  # parts turning clockwise look the same as a camera circling counter-clockwise: switching the motion keeps the look of the turn
        driver.expression = f"{turn_sign} * (frame - 1) / {frames} * {2 * math.pi!r}"
        if hasattr(scene.render.image_settings, "media_type"):
            scene.render.image_settings.media_type = "VIDEO"
        scene.render.image_settings.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        scene.render.ffmpeg.ffmpeg_preset = "GOOD"
        scene.render.ffmpeg.audio_codec = "NONE"
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = samples
    if not turntable_spec:
        scene.render.image_settings.file_format = "PNG"
bpy.ops.wm.save_as_mainfile(filepath=target, compress=True)
'''


def find_blender() -> str | None:
    """The Blender executable: $BLENDER, `blender` on the PATH, or the macOS / Linux default locations."""
    import os
    import shutil
    from pathlib import Path

    candidates = [os.environ.get("BLENDER"), shutil.which("blender"), "/Applications/Blender.app/Contents/MacOS/Blender", "/usr/bin/blender", "/snap/bin/blender"]
    return next((c for c in candidates if c and Path(c).is_file()), None)


def _run_blender(glb: bytes, blender: str, studio: bool, light: dict | None, render: tuple[int, int] | None, timeout: int,
                 progress: "Callable[[float], None] | None" = None, started: "Callable[[object], None] | None" = None, dof: str = "0", crop: bool = False,
                 phase: "Callable[[str], None] | None" = None, turntable: "tuple[int, str, int] | None" = None, track: str = "", track_pivot: str = "all", look_at: str = "part", direction: str = "ccw") -> bytes:
    """Background Blender runs: the .blend (render is None), or, for `render` = (width, samples), that .blend rendered to a PNG.
    `progress` gets 0..1 while it renders (read from Blender's "Sample 24/96" lines); `started` gets the rendering process (so it can be stopped)."""
    import os
    import pty
    import re
    import subprocess
    import tempfile
    import time
    from pathlib import Path

    with tempfile.TemporaryDirectory() as folder:
        source, target, script = Path(folder, "scene.glb"), Path(folder, "scene.blend"), Path(folder, "make_blend.py")
        source.write_bytes(glb)
        spec = "" if light is None else ",".join(f"{v:.4f}" for v in light["direction"]) + ";" + (f"part:{light['part']}" if light.get("part") else ",".join(f"{v:.4f}" for v in light["target"]) if light.get("target") is not None else "")
        script.write_text(blenderScript)
        deadline = time.monotonic() + timeout
        made = subprocess.run([blender, "--background", "--factory-startup", "--python", str(script), "--", str(source), str(target), "1" if studio else "0", spec,
                               f"{render[0]},{render[1]}" if render else "", dof, "1" if crop else "0",
                               f"{turntable[0]},{turntable[1]},{turntable[2]},{track},{track_pivot},{look_at},{direction}" if turntable else ""], capture_output=True, text=True, timeout=timeout)
        if not target.is_file():
            raise RuntimeError(f"Blender could not write the .blend: {(made.stderr or made.stdout)[-300:]}")
        if not render:
            return target.read_bytes()
        if phase:
            phase("load")  # the second Blender run: opening the .blend and building what it renders from
        seen = set()

        # Rendering the saved file prints its progress ("Sample 24/96"); Blender buffers that when it writes to a pipe, so a pseudo-terminal is used.
        master, slave = pty.openpty()
        try:
            process = subprocess.Popen([blender, "--background", str(target), "-o", str(Path(folder, "picture_####")), *(["-a"] if turntable else ["-f", "1"])], stdout=slave, stderr=slave, stdin=subprocess.DEVNULL, close_fds=True)
        finally:
            os.close(slave)
        if started:
            started(process)
        tail = b""
        sample = re.compile(rb"Sample (\d+)/(\d+)")
        frame = re.compile(rb"Fra:(\d+)")
        frames = turntable[0] if turntable else 1
        try:
            buffer = b""
            while True:
                try:
                    chunk = os.read(master, 4096)
                except OSError:  # the other end is closed: Blender has ended
                    break
                if not chunk:
                    break
                tail = (tail + chunk)[-600:]
                buffer = (buffer + chunk)[-4096:]
                if progress:
                    found = sample.findall(buffer)
                    if found:
                        done, total = (int(v) for v in found[-1])
                        current = int((frame.findall(buffer) or [b"1"])[-1])  # the frame of a turntable (always 1 for a picture)
                        if phase and "render" not in seen:
                            seen.add("render")
                            phase("render")
                        progress(min(((current - 1) + min(done / max(total, 1), 1.0)) / frames, 1.0))
                        if phase and current >= frames and done >= total and "finish" not in seen:
                            seen.add("finish")
                            phase("finish")  # all samples are in: denoising, saving the picture (or encoding the video)
                if time.monotonic() > deadline:
                    process.kill()
                    raise RuntimeError("Blender took too long")
            process.wait()
        finally:
            if process.poll() is None:
                process.kill()
            os.close(master)
        picture = next(iter(sorted(Path(folder).glob("picture_*.mp4"))), None) if turntable else Path(folder, "picture_0001.png")
        if picture is None or not picture.is_file():
            raise RuntimeError(f"Blender could not render the {'video' if turntable else 'picture'}: {tail.decode(errors='replace')[-300:]}")
        return picture.read_bytes()


def build_blend(glb: bytes, blender: str, studio: bool = True, light: dict | None = None, dof: str = "0") -> bytes:
    """Runs Blender in the background to turn the glTF into a real .blend (camera set as the scene camera, 1080p;
    with `studio` also a floor, a dark gradient world and three area lights, rendered with Cycles; with `light` (see parse_light) the key
    light is a sun like the app's light source instead of the warm area light)."""
    return _run_blender(glb, blender, studio, light, None, 120, dof=dof)


def build_render(glb: bytes, blender: str, studio: bool = True, light: dict | None = None, width: int = 800, samples: int = 24,
                 progress: "Callable[[float], None] | None" = None, started: "Callable[[object], None] | None" = None, timeout: int = 180, dof: str = "0", crop: bool = False,
                 phase: "Callable[[str], None] | None" = None, turntable: "tuple[int, str, int] | None" = None, track: str = "", track_pivot: str = "all", look_at: str = "part", direction: str = "ccw") -> bytes:
    """A PNG of the scene (`width` pixels wide, Cycles with `samples` samples): a quick look at the light and the colours. With `turntable` = (frames, "orbit" | "spin", fps)
    an MP4 of that many frames instead: the camera circles the scene once, or the parts turn once in front of the camera."""
    return _run_blender(glb, blender, studio, light, (width, samples), timeout, progress, started, dof, crop, phase, turntable, track, track_pivot, look_at, direction)
