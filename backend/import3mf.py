"""Reads a 3MF package (one exported by RASTERFASTER, or a Bambu Studio project) into document items that point at the library's STL files.

An object is linked to its file on disk, in this order:
  1. `partnumber` of the object: the library path that our own exports carry (when the file still exists);
  2. the object's name (Bambu: the part name / `source_file` of `Metadata/model_settings.config`) as a file name in the library; a name that exists
     in several folders is decided by the mesh's shape;
  3. the shape alone: a binary STL's size gives its triangle count, so only files of the right size are read and compared (bounding box).
What is not found keeps the 3MF's own geometry: it is returned as an embedded STL (path `embedded:<sha1>.stl`, stored by the API next to the
documents, never in the library), so the part shows in the document and Export STL can save it again. Parts with a scale or a mirrored
transform (Bambu primitives and modifiers) have no place in a document and are reported instead.
"""
import hashlib
import io
import os
import struct
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from xml.etree import ElementTree

import numpy as np

import export3mf

core = "{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
production = "{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}"
itemColors = [0x6FA8DC, 0x93C47D, 0xF6B26B, 0xC27BA0, 0x8E7CC3, 0xE06666, 0x76A5AF, 0xFFD966]  # as in the front end: parts take the next colour
gridStep = 20.0  # the document grid in X / Y (mm)
maxShapeReads = 50
shapeTolerance = 0.05  # mm


class ThreeMfError(ValueError):
    pass


@dataclass
class LibraryIndex:
    """What the import needs to know about the library: files by lower-case name and by byte size, and a way to read one."""
    byStem: dict[str, list[str]]
    bySize: dict[int, list[str]]
    read: Callable[[str], bytes]
    _extents: dict[str, np.ndarray] = field(default_factory=dict)

    def extents(self, path: str) -> np.ndarray | None:
        if path not in self._extents:
            try:
                self._extents[path] = sorted_extents(export3mf.read_stl(self.read(path)).vertices)
            except (OSError, ValueError):
                return None
        return self._extents[path]


def index_library(root: Path) -> LibraryIndex:
    byStem: dict[str, list[str]] = {}
    bySize: dict[int, list[str]] = {}
    for directory, dirNames, fileNames in os.walk(root):
        dirNames[:] = [name for name in dirNames if not name.startswith(".")]
        for name in fileNames:
            if not name.lower().endswith(".stl") or name.startswith("."):
                continue
            file = Path(directory) / name
            path = file.relative_to(root).as_posix()
            byStem.setdefault(file.stem.lower(), []).append(path)
            try:
                bySize.setdefault(file.stat().st_size, []).append(path)
            except OSError:
                pass
    for paths in (*byStem.values(), *bySize.values()):
        paths.sort()
    return LibraryIndex(byStem, bySize, lambda path: (root / path).read_bytes())


def sorted_extents(vertices: np.ndarray) -> np.ndarray:
    return np.sort(vertices.max(axis=0) - vertices.min(axis=0))


@dataclass
class ObjectDef:
    id: int
    name: str = ""
    partnumber: str = ""
    vertices: np.ndarray | None = None
    triangles: np.ndarray | None = None
    triangleCount: int = 0
    components: list[tuple[str | None, int, np.ndarray, np.ndarray]] = field(default_factory=list)  # (model file, object id, A, t)


def parse_transform(text: str | None) -> tuple[np.ndarray, np.ndarray]:
    """3MF row-vector transform 'm00 m01 m02 m10 ... m22 tx ty tz': v' = v @ A + t."""
    if not text:
        return np.eye(3), np.zeros(3)
    values = np.array(text.split(), dtype=np.float64)
    if len(values) != 12:
        raise ThreeMfError("a transform does not have 12 numbers")
    return values[:9].reshape(3, 3), values[9:]


def parse_objects(xml: bytes) -> tuple[dict[int, ObjectDef], list[tuple[int, np.ndarray, np.ndarray]], str]:
    root = ElementTree.fromstring(xml)
    objects: dict[int, ObjectDef] = {}
    for element in root.iter(f"{core}object"):
        definition = ObjectDef(int(element.get("id")), element.get("name") or "", element.get("partnumber") or "")
        mesh = element.find(f"{core}mesh")
        if mesh is not None:
            definition.vertices = np.array([[float(v.get("x")), float(v.get("y")), float(v.get("z"))] for v in mesh.iter(f"{core}vertex")], dtype=np.float64)
            definition.triangles = np.array([[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in mesh.iter(f"{core}triangle")], dtype=np.int64).reshape(-1, 3)
            definition.triangleCount = len(definition.triangles)
        for component in element.iter(f"{core}component"):
            matrix, offset = parse_transform(component.get("transform"))
            definition.components.append((component.get(f"{production}path"), int(component.get("objectid")), matrix, offset))
        objects[definition.id] = definition
    build = []
    for item in root.iter(f"{core}item"):
        matrix, offset = parse_transform(item.get("transform"))
        build.append((int(item.get("objectid")), matrix, offset))
    title = next((m.text or "" for m in root.iter(f"{core}metadata") if m.get("name") == "Title"), "")
    return objects, build, title.strip()


@dataclass
class BambuConfig:
    partNames: dict[int, str] = field(default_factory=dict)
    sourceFiles: dict[int, str] = field(default_factory=dict)
    objectNames: dict[int, str] = field(default_factory=dict)
    plates: dict[int, set[int]] = field(default_factory=dict)  # plate number -> object ids


def parse_bambu_config(xml: bytes) -> BambuConfig:
    config = BambuConfig()
    root = ElementTree.fromstring(xml)

    def meta(element, key):
        return next((m.get("value") for m in element.findall("metadata") if m.get("key") == key), None)

    for obj in root.findall("object"):
        objectId = int(obj.get("id"))
        config.objectNames[objectId] = meta(obj, "name") or ""
        for part in obj.findall("part"):
            partId = int(part.get("id"))
            config.partNames[partId] = meta(part, "name") or ""
            config.sourceFiles[partId] = meta(part, "source_file") or ""
    for plate in root.findall("plate"):
        number = int(meta(plate, "plater_id") or 0)
        config.plates[number] = {int(meta(instance, "object_id")) for instance in plate.findall("model_instance") if meta(instance, "object_id")}
    return config


@dataclass
class Leaf:
    key: tuple[str, int]          # (model file, object id): the same mesh used again resolves once
    definition: ObjectDef
    name: str
    sourceFile: str
    matrix: np.ndarray            # world = vertices @ matrix + offset
    offset: np.ndarray


def collect_leaves(topId: int, matrix: np.ndarray, offset: np.ndarray, load: Callable[[str | None], dict[int, ObjectDef]],
                   config: BambuConfig, fileName: str | None = None, topName: str = "") -> list[Leaf]:
    """The meshes below a build item with the transform that puts each one in the world."""
    objects = load(fileName)
    definition = objects.get(topId)
    if definition is None:
        raise ThreeMfError(f"object {topId} is missing")
    topName = topName or config.objectNames.get(topId) or definition.name
    if definition.vertices is not None:
        name = config.partNames.get(definition.id) or definition.name or topName
        return [Leaf((fileName or "", definition.id), definition, name, config.sourceFiles.get(definition.id, ""), matrix, offset)]
    leaves = []
    for childFile, childId, childMatrix, childOffset in definition.components:
        leaves += collect_leaves(childId, childMatrix @ matrix, childOffset @ matrix + offset, load, config, childFile or fileName, topName)
    return leaves


def quaternion(rotation: np.ndarray) -> list[float]:
    """Column-vector rotation matrix -> [x, y, z, w] (the inverse of export3mf.rotation_matrix)."""
    r = rotation
    trace = np.trace(r)
    if trace > 0:
        s = np.sqrt(trace + 1) * 2
        w, x, y, z = s / 4, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = np.sqrt(1 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        w, x, y, z = (r[2, 1] - r[1, 2]) / s, s / 4, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s
    elif r[1, 1] > r[2, 2]:
        s = np.sqrt(1 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        w, x, y, z = (r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, s / 4, (r[1, 2] + r[2, 1]) / s
    else:
        s = np.sqrt(1 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        w, x, y, z = (r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, s / 4
    q = np.array([x, y, z, w])
    q = q / np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    return [round(float(v), 7) + 0.0 for v in q]


def stem_of(name: str) -> str:
    name = name.strip()
    return (name[:-4] if name.lower().endswith(".stl") else name).lower()


def resolve(leaf: Leaf, library: LibraryIndex) -> tuple[str | None, str]:
    """(library path or None, how it was found: path | name | name-shape | name-ambiguous | shape | none)."""
    definition = leaf.definition
    extents = sorted_extents(definition.vertices)

    def same_shape(path: str) -> bool:
        other = library.extents(path)
        return other is not None and np.allclose(other, extents, atol=shapeTolerance)

    link = definition.partnumber.strip()
    if link.lower().endswith(".stl") and link in library.byStem.get(stem_of(Path(link).name), []):
        return link, "path"
    for candidate in dict.fromkeys(stem_of(n) for n in (leaf.name, leaf.sourceFile) if n):
        hits = library.byStem.get(candidate, [])
        if len(hits) == 1:
            return hits[0], "name"
        if hits:
            matching = [path for path in hits if same_shape(path)]
            if len(matching) == 1:
                return matching[0], "name-shape"
            if matching:
                return matching[0], "name-ambiguous"  # several files of that name have this very shape (copies in different folders)
            return hits[0], "name-ambiguous"
    sameSize = library.bySize.get(84 + 50 * definition.triangleCount, [])
    for path in sameSize[:maxShapeReads]:
        if same_shape(path):
            return path, "shape"
    return None, "none"


@dataclass
class ImportResult:
    name: str
    items: list[dict]
    report: list[dict]
    embedded: dict[str, bytes] = field(default_factory=dict)  # "embedded:<sha1>.stl" -> binary STL of a part that has no library file


def mesh_to_stl(vertices: np.ndarray, triangles: np.ndarray) -> bytes:
    """Binary STL of an indexed mesh, in the mesh's own coordinates."""
    corners = vertices[triangles]                                  # (m, 3, 3)
    normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    record = np.zeros(len(triangles), dtype=np.dtype([("normal", "<f4", 3), ("vertex", "<f4", (3, 3)), ("attr", "<u2")]))
    record["normal"], record["vertex"] = normals, corners
    return b"RASTERFASTER embedded from 3MF".ljust(80, b"\0") + struct.pack("<I", len(triangles)) + record.tobytes()


def stl_label(name: str) -> str:
    name = name.strip()
    return name[:-4] if name.lower().endswith(".stl") else name


def grid_shift(lows: np.ndarray) -> np.ndarray:
    """XY shift that puts the assembly's corner on the document grid. The 3MF export centres the assembly on the plate (an arbitrary shift), but the
    parts sat on the grid before: the most common remainder of their corners modulo the grid is that shift."""
    shift = np.zeros(3)
    for axis in (0, 1):
        remainders = Counter(round(float(v) % gridStep, 2) for v in lows[:, axis])
        mode = remainders.most_common(1)[0][0]
        shifted = lows[:, axis] - mode
        shift[axis] = mode + np.floor(shifted.min() / gridStep + 1e-6) * gridStep
    return shift


def import_3mf(data: bytes, library: LibraryIndex, plate: int | None = None) -> ImportResult:
    try:
        package = zipfile.ZipFile(io.BytesIO(data))
        names = set(package.namelist())
        mainName = "3D/3dmodel.model"
        if mainName not in names:
            raise ThreeMfError("not a 3MF file: 3D/3dmodel.model is missing")
        cache: dict[str | None, dict[int, ObjectDef]] = {}

        def load(fileName: str | None) -> dict[int, ObjectDef]:
            if fileName not in cache:
                member = (fileName or mainName).lstrip("/")
                if member not in names:
                    raise ThreeMfError(f"{member} is missing in the package")
                cache[fileName] = parse_objects(package.read(member))[0]
            return cache[fileName]

        objects, build, title = parse_objects(package.read(mainName))
        cache[None] = objects
        config = parse_bambu_config(package.read("Metadata/model_settings.config")) if "Metadata/model_settings.config" in names else BambuConfig()
    except (zipfile.BadZipFile, ElementTree.ParseError, KeyError) as error:
        raise ThreeMfError(f"not a readable 3MF file ({error})")
    if plate is not None:
        wanted = config.plates.get(plate)
        if wanted is None:
            raise ThreeMfError(f"plate {plate} does not exist")
        build = [entry for entry in build if entry[0] in wanted]

    resolved: dict[tuple[str, int], tuple[str | None, str]] = {}
    embedded: dict[str, bytes] = {}
    embeddedPaths: dict[tuple[str, int], str] = {}
    placed: list[dict] = []   # name, path, position (world min corner), rotation
    skipped: list[dict] = []
    counts: Counter = Counter()
    for objectId, matrix, offset in build:
        for leaf in collect_leaves(objectId, matrix, offset, load, config):
            if leaf.key not in resolved:
                resolved[leaf.key] = resolve(leaf, library)
            path, how = resolved[leaf.key]
            label = leaf.name or (Path(path).stem if path else f"object {leaf.definition.id}")  # an instance copy has no name of its own
            u, s, vt = np.linalg.svd(leaf.matrix)
            if abs(s - 1).max() > 0.01 or np.linalg.det(leaf.matrix) < 0:
                skipped.append({"name": label, "matchedBy": "skipped", "path": "", "count": 1,
                                "note": "scaled or mirrored (a primitive or modifier): not a library part"})
                continue
            world = leaf.definition.vertices @ leaf.matrix + leaf.offset
            if path is None:                      # no file in the library: keep the 3MF's own geometry with the document
                if leaf.key not in embeddedPaths:
                    stl = mesh_to_stl(leaf.definition.vertices, leaf.definition.triangles)
                    embeddedPaths[leaf.key] = f"embedded:{hashlib.sha1(stl).hexdigest()}.stl"
                    embedded[embeddedPaths[leaf.key]] = stl
                path, how = embeddedPaths[leaf.key], "embedded"
            placed.append({"name": label, "path": path, "matchedBy": how, "low": world.min(axis=0), "rotation": quaternion((u @ vt).T)})
            counts[(label, placed[-1]["path"], placed[-1]["matchedBy"])] += 1
    if not placed:
        raise ThreeMfError("the 3MF has no parts that can be placed in a document")

    shift = grid_shift(np.array([part["low"] for part in placed]))
    items = []
    for index, part in enumerate(placed):
        position = part["low"] - shift
        items.append({
            "id": str(uuid.uuid4()), "path": part["path"], "name": stl_label(part["name"]) if part["matchedBy"] == "embedded" else Path(part["path"]).stem, "color": itemColors[index % len(itemColors)],
            "position": [round(float(v), 4) + 0.0 for v in position], "rotation": part["rotation"],
            "muted": False, "centered": False, "noExport": False,
        })
    report = [{"name": name, "path": path, "matchedBy": how, "count": count} for (name, path, how), count in counts.items()] + skipped
    return ImportResult(title or "Imported 3MF", items, report, embedded)
