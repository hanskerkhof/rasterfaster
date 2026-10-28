"""Builds a 3MF package (core spec, readable by Bambu Studio) from a RASTERFASTER document: the assembly, with the parts exactly where they
sit in the document, centred on the plate."""
import io
import re
import struct
import zipfile
from dataclasses import dataclass
from typing import Callable
from xml.sax.saxutils import escape, quoteattr

import numpy as np

contentTypesXml = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    "</Types>"
)
relsXml = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    "</Relationships>"
)


@dataclass
class Mesh:
    vertices: np.ndarray  # (n, 3) float64, unique
    triangles: np.ndarray  # (m, 3) int


def read_stl(data: bytes) -> Mesh:
    """Binary or ASCII STL -> indexed mesh (vertices welded, as 3MF wants)."""
    count = struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else 0
    if len(data) == 84 + 50 * count:
        record = np.dtype([("normal", "<f4", 3), ("vertex", "<f4", (3, 3)), ("attr", "<u2")])
        corners = np.frombuffer(data, dtype=record, count=count, offset=84)["vertex"].reshape(-1, 3).astype(np.float64)
    else:
        numbers = re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data)
        if not numbers or len(numbers) % 3:
            raise ValueError("not a valid STL file")
        corners = np.array(numbers, dtype=np.float64)
    if len(corners) == 0:
        raise ValueError("STL has no triangles")
    vertices, inverse = np.unique(corners, axis=0, return_inverse=True)
    return Mesh(vertices, inverse.reshape(-1, 3))


def rotation_matrix(q: list[float]) -> np.ndarray:
    x, y, z, w = q
    norm = np.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / norm, y / norm, z / norm, w / norm
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


@dataclass
class Placement:
    """World = vertices @ rotation.T + translation (column-vector convention)."""
    rotation: np.ndarray
    translation: np.ndarray
    size: np.ndarray  # world-axis extent of the placed part


def place_assembly(items: list[dict], meshes: dict[str, Mesh], plateSize: float, centre: bool = True) -> list[Placement]:
    """Document positions are the min corner of the rotated bounding box; optionally centre the whole assembly on the plate in XY."""
    placements = []
    for item in items:
        mesh = meshes[item["path"]]
        rotation = rotation_matrix(item["rotation"])
        rotated = mesh.vertices @ rotation.T
        low = rotated.min(axis=0)
        translation = np.array(item["position"], dtype=np.float64) - low
        placements.append(Placement(rotation, translation, rotated.max(axis=0) - low))
    if placements and centre:
        lows = np.array([item["position"] for item in items], dtype=np.float64)
        highs = lows + np.array([p.size for p in placements])
        centre = (lows.min(axis=0) + highs.max(axis=0)) / 2
        shift = np.array([plateSize / 2 - centre[0], plateSize / 2 - centre[1], 0.0])
        for placement in placements:
            placement.translation = placement.translation + shift
    return placements


def transform_attribute(placement: Placement) -> str:
    """3MF stores row-vector transforms: v' = v @ A + t, so A is the transpose of our column-vector rotation."""
    matrix = placement.rotation.T
    values = [*matrix[0], *matrix[1], *matrix[2], *placement.translation]
    return " ".join(f"{v:.6g}" for v in values)


def object_xml(objectId: int, name: str, mesh: Mesh, path: str = "") -> str:
    vertices = "".join(f'<vertex x="{x:.5f}" y="{y:.5f}" z="{z:.5f}"/>' for x, y, z in mesh.vertices.tolist())
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in mesh.triangles.tolist())
    link = f" partnumber={quoteattr(path)}" if path else ""  # the library path: import3mf finds the file again from it
    return (f'<object id="{objectId}" name={quoteattr(name)}{link} type="model"><mesh>'
            f"<vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object>")


def build_3mf(document: dict, load_stl: Callable[[str], bytes], plateSize: float = 256.0) -> bytes:
    items = document["items"]
    if not items:
        raise ValueError("document has no items")
    meshes = {path: read_stl(load_stl(path)) for path in dict.fromkeys(item["path"] for item in items)}
    placements = place_assembly(items, meshes, plateSize)

    objectIds = {path: index + 1 for index, path in enumerate(meshes)}
    names: dict[str, str] = {}
    for item in items:
        names.setdefault(item["path"], item["name"])  # a part used several times is named after its first use
    resources = "".join(object_xml(objectIds[path], names[path], mesh, path) for path, mesh in meshes.items())
    build = "".join(
        f'<item objectid="{objectIds[item["path"]]}" transform="{transform_attribute(placement)}" partnumber={quoteattr(item["name"])}/>'
        for item, placement in zip(items, placements)
    )
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<metadata name="Title">{escape(document["name"])}</metadata>'
        '<metadata name="Application">RASTERFASTER composition tool</metadata>'
        f"<resources>{resources}</resources><build>{build}</build></model>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", contentTypesXml)
        package.writestr("_rels/.rels", relsXml)
        package.writestr("3D/3dmodel.model", model)
    return buffer.getvalue()
