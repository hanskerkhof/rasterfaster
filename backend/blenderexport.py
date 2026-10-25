"""Builds a binary glTF (.glb) for Blender from a RASTERFASTER document.

Blender imports glTF natively (File > Import > glTF 2.0): one object per part with the document's colour, placed exactly as in the
document (Z up, 1 Blender unit = 1 m, so a 20 mm cell is 0.02 m), plus a perspective camera that follows the fly-around path
(one closed loop of `flightLoopSeconds`, keyframed as an animation) and the path itself as a line object.
"""
import json
import math
import struct
from typing import Callable

import numpy as np

import export3mf

flightLoopSeconds = 280.0  # the same closed loop as the fly-around in the frontend (stl-viewer.ts)
sampleSeconds = 0.5
fovDegrees = 35.0
aspect = 16 / 9
mmToMetre = 0.001
# Document axes (X right, Y back, Z up) -> glTF axes (Y up, -Z forward); Blender's importer turns that back into the document axes.
toGltf = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])


def flight_pose(t: float, azimuth0: float, low: np.ndarray, high: np.ndarray):
    """Direction (model -> camera), view centre and zoom factor at time t: the path of the frontend's fly-around, which closes after one loop."""
    size = high - low
    w = 2 * math.pi / flightLoopSeconds
    azimuth = azimuth0 + t * 4 * w
    elevation = math.radians(38 + 26 * math.sin(t * 6 * w + 0.8) + 8 * math.sin(t * 14 * w))
    direction = np.array([math.cos(elevation) * math.cos(azimuth), math.cos(elevation) * math.sin(azimuth), math.sin(elevation)])
    centre = (low + high) / 2 + np.array([size[0] * 0.16 * math.sin(t * 8 * w), size[1] * 0.16 * math.cos(t * 5 * w), size[2] * 0.2 * math.sin(t * 10 * w)])
    return direction, centre, 1 + 0.45 * (0.5 + 0.5 * math.sin(t * 9 * w - 1))


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


def build_glb(document: dict, load_stl: Callable[[str], bytes], camera: bool = True) -> bytes:
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
        colour = int(item["color"]) & 0xFFFFFF
        if colour not in materialIndex:
            materialIndex[colour] = len(materials)
            materials.append({"name": f"colour_{colour:06x}", "pbrMetallicRoughness": {
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
    gltf: dict = {"asset": {"version": "2.0", "generator": "RASTERFASTER composition tool"}, "scene": 0,
                  "meshes": gltfMeshes, "materials": materials, "nodes": nodes}

    if camera:
        low = np.min([item["position"] for item in items], axis=0).astype(np.float64)
        high = np.max([np.array(item["position"]) + p.size for p, item in zip(placements, items)], axis=0)
        azimuth0 = math.atan2(-1.0, 1.0)  # starts at the isometric view, like Home
        times = np.arange(0.0, flightLoopSeconds + sampleSeconds / 2, sampleSeconds)
        positions, rotations = [], []
        for t in times:
            direction, centre, zoom = flight_pose(float(t), azimuth0, low, high)
            eye = centre + direction * fit_distance(direction, low, high) / zoom
            right, up, forward = camera_basis(direction)
            positions.append(mmToMetre * (toGltf @ eye))
            rotations.append(quaternion(np.column_stack([toGltf @ right, toGltf @ up, -(toGltf @ forward)])))  # glTF cameras look down -Z
        positions = np.array(positions, dtype=np.float32)
        rotations = np.array(rotations, dtype=np.float32)
        for i in range(1, len(rotations)):  # keep neighbouring quaternions on the same side so playback never spins the long way round
            if float(rotations[i] @ rotations[i - 1]) < 0:
                rotations[i] = -rotations[i]
        gltf["cameras"] = [{"name": "Fly-around camera", "type": "perspective", "perspective": {
            "yfov": math.radians(fovDegrees), "aspectRatio": aspect, "znear": 0.01, "zfar": 20.0}}]
        nodes.append({"name": "Fly-around camera", "camera": 0, "translation": positions[0].tolist(), "rotation": rotations[0].tolist()})
        cameraNode = len(nodes) - 1
        pathPositions = np.vstack([positions, positions[:1]]).astype(np.float32)  # closed
        gltf["meshes"].append({"name": "Camera path", "primitives": [{"attributes": {"POSITION": buffer.add(pathPositions, 5126, "VEC3", 34962, bounds=True)}, "mode": 3}]})
        nodes.append({"name": "Camera path", "mesh": len(gltf["meshes"]) - 1})
        sceneNodes += [cameraNode, len(nodes) - 1]
        timeAccessor = buffer.add(times.astype(np.float32).reshape(-1, 1), 5126, "SCALAR", bounds=True)
        gltf["animations"] = [{"name": "Fly-around", "samplers": [
            {"input": timeAccessor, "output": buffer.add(positions, 5126, "VEC3"), "interpolation": "LINEAR"},
            {"input": timeAccessor, "output": buffer.add(rotations, 5126, "VEC4"), "interpolation": "LINEAR"}],
            "channels": [{"sampler": 0, "target": {"node": cameraNode, "path": "translation"}},
                         {"sampler": 1, "target": {"node": cameraNode, "path": "rotation"}}]}]

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
