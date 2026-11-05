"""Identical files in the library (and files with the same shape): first by size (two files of different sizes cannot be the same, and reading is the expensive part), then by
the SHA-1 of the content of the files that share a size. A hash is remembered by path, size and modified time, so a second scan only reads
what changed. Empty files are left out (they are all "the same" and say nothing)."""
import hashlib
import json
import os
import re
import struct
from pathlib import Path
from typing import Callable

import numpy as np


def natural_key(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def sha1_of(file: Path) -> str:
    digest = hashlib.sha1()
    with open(file, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_cache(cacheFile: Path) -> dict[str, dict]:
    try:
        data = json.loads(cacheFile.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_cache(cacheFile: Path, cache: dict[str, dict]) -> None:
    cacheFile.parent.mkdir(parents=True, exist_ok=True)
    temporary = cacheFile.with_suffix(".tmp")
    temporary.write_text(json.dumps(cache), encoding="utf-8")
    os.replace(temporary, cacheFile)


maxShapeBytes = 60 * 1024 * 1024  # bigger files are not read for their shape (they would take minutes)
shapeDecimals = 3  # vertices are compared to a thousandth of a millimetre


def read_triangles(file: Path) -> np.ndarray:
    """The triangles of an STL file (binary or ASCII) as an array (n, 3, 3) of vertex coordinates."""
    data = file.read_bytes()
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * count:  # a binary STL has exactly this length
            records = np.frombuffer(data, dtype=np.dtype([("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")]), count=count, offset=84)
            return records["vertices"].astype(np.float64)
    numbers = re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data)
    values = np.array([[float(x) for x in vertex] for vertex in numbers], dtype=np.float64)
    if len(values) % 3:
        raise ValueError("not a complete STL file")
    return values.reshape(-1, 3, 3)


def shape_features(file: Path) -> list[float]:
    """Measurements of the shape that do not depend on where the part sits, on the header, on the normals or on the order of the triangles: the
    number of triangles, the size of the box round it, its volume and surface area, and where its centre lies in that box. The same part
    exported again, or at another place of an assembly, gives the same numbers (to the noise of the file's single-precision floats)."""
    triangles = read_triangles(file)
    if len(triangles) == 0:
        raise ValueError("no triangles")
    corners = triangles.reshape(-1, 3)
    low = corners.min(axis=0)
    moved = triangles - low  # the part moved to the origin: its place is gone
    size = moved.reshape(-1, 3).max(axis=0)
    a, b, c = moved[:, 0], moved[:, 1], moved[:, 2]
    volume = abs(float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum())) / 6.0
    area = float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum()) / 2.0
    centre = moved.reshape(-1, 3).mean(axis=0)
    return [float(len(triangles)), *map(float, size), volume, area, *map(float, centre)]


def same_shape(first: list[float], second: list[float]) -> bool:
    """Do two sets of measurements describe the same shape? (the same triangle count; sizes and centres within 0.01 mm; volume and area within 0.01 %)"""
    if first[0] != second[0]:
        return False
    if any(abs(x - y) > 0.01 for x, y in zip(first[1:4], second[1:4])) or any(abs(x - y) > 0.01 for x, y in zip(first[6:9], second[6:9])):
        return False
    return all(abs(x - y) <= 1e-4 * max(abs(x), abs(y), 1.0) for x, y in zip(first[4:6], second[4:6]))


def candidates(root: Path) -> list[tuple[str, int, float]]:
    """(library path, size, modified) of the .stl files that share their size with another one."""
    bySize: dict[int, list[tuple[str, int, float]]] = {}
    for directory, dirNames, fileNames in os.walk(root):
        dirNames[:] = [name for name in dirNames if not name.startswith(".")]
        for name in fileNames:
            if name.startswith(".") or not name.lower().endswith(".stl"):
                continue
            file = Path(directory) / name
            try:
                stat = file.stat()
            except OSError:
                continue
            if stat.st_size > 0:
                bySize.setdefault(stat.st_size, []).append((file.relative_to(root).as_posix(), stat.st_size, stat.st_mtime))
    return [item for items in bySize.values() if len(items) > 1 for item in items]


def scan(root: Path, cacheFile: Path, progress: Callable[[int, int], None] | None = None, mode: str = "exact") -> list[dict]:
    """Groups of identical files: [{"paths": [...], "size": bytes}], each group sorted by path, the groups by their first path.
    `mode` "exact": the same bytes. `mode` "shape": the same shape (see `shape_features`: a re-exported or moved copy of a part counts); only
    files of the same size are compared, and files over `maxShapeBytes` are left out."""
    found = candidates(root)
    if mode == "shape":
        found = [item for item in found if item[1] <= maxShapeBytes]
    cache = read_cache(cacheFile)
    key = "features" if mode == "shape" else "sha1"
    measured: dict[str, object] = {}
    changed = False
    for done, (path, size, modified) in enumerate(found, start=1):
        record = cache.get(path)
        if not record or key not in record or record.get("size") != size or abs(record.get("modified", 0) - modified) > 1e-3:
            try:
                value = shape_features(root / path) if mode == "shape" else sha1_of(root / path)
            except (OSError, ValueError, struct.error):
                continue  # unreadable or not an STL: it is in no group
            record = {"size": size, "modified": modified, key: value}
            cache[path] = record
            changed = True
        measured[path] = record[key]
        if progress:
            progress(done, len(found))
    if changed:
        write_cache(cacheFile, {path: record for path, record in cache.items() if (root / path).is_file()})  # forget what is gone
    sizes = {path: size for path, size, _ in found}
    groups: list[dict] = []
    if mode == "shape":
        bySize: dict[int, list[str]] = {}
        for path in measured:
            bySize.setdefault(sizes[path], []).append(path)
        for size, paths in bySize.items():
            parent = {path: path for path in paths}  # files that are the same shape as one another, joined (union-find)

            def root_of(path: str) -> str:
                while parent[path] != path:
                    parent[path] = parent[parent[path]]
                    path = parent[path]
                return path
            for i, first in enumerate(paths):
                for second in paths[i + 1:]:
                    if same_shape(measured[first], measured[second]):  # type: ignore[arg-type]
                        parent[root_of(second)] = root_of(first)
            joined: dict[str, list[str]] = {}
            for path in paths:
                joined.setdefault(root_of(path), []).append(path)
            groups += [{"paths": sorted(group, key=natural_key), "size": size} for group in joined.values() if len(group) > 1]
    else:
        byHash: dict[tuple[int, str], list[str]] = {}
        for path, value in measured.items():
            byHash.setdefault((sizes[path], value), []).append(path)  # type: ignore[arg-type]
        groups = [{"paths": sorted(paths, key=natural_key), "size": size} for (size, _), paths in byHash.items() if len(paths) > 1]
    groups.sort(key=lambda group: natural_key(group["paths"][0]))
    return groups


def matches(root: Path, relative: str, exactCache: Path, shapeCache: Path) -> dict:
    """What in the library is the same as one part: files with exactly its content, and files with its shape (not counting the identical ones).
    Only the files of the same size are looked at, so this is quick; what is read is remembered in the same caches as the scans use."""
    target = root / relative
    stat = target.stat()
    size = stat.st_size
    others = [item for item in candidates_of_size(root, size) if item[0] != relative]
    exact, shape = read_cache(exactCache), read_cache(shapeCache)
    changed = {"exact": False, "shape": False}

    def value(cache: dict, kind: str, key: str, path: str, fileSize: int, modified: float, compute):
        record = cache.get(path)
        if not record or key not in record or record.get("size") != fileSize or abs(record.get("modified", 0) - modified) > 1e-3:
            record = {"size": fileSize, "modified": modified, key: compute(root / path)}
            cache[path] = record
            changed[kind] = True
        return record[key]

    mine = value(exact, "exact", "sha1", relative, size, stat.st_mtime, sha1_of)
    try:
        myShape = value(shape, "shape", "features", relative, size, stat.st_mtime, shape_features) if 0 < size <= maxShapeBytes else None
    except (ValueError, struct.error):
        myShape = None  # not a readable STL: it can still have exact copies
    identical: list[str] = []
    sameShape: list[str] = []
    for path, fileSize, modified in others:
        try:
            if value(exact, "exact", "sha1", path, fileSize, modified, sha1_of) == mine:
                identical.append(path)
            elif myShape is not None and same_shape(myShape, value(shape, "shape", "features", path, fileSize, modified, shape_features)):
                sameShape.append(path)
        except (OSError, ValueError, struct.error):
            continue
    for kind, cache, file in (("exact", exact, exactCache), ("shape", shape, shapeCache)):
        if changed[kind]:
            write_cache(file, {path: record for path, record in cache.items() if (root / path).is_file()})
    return {"identical": sorted(identical, key=natural_key), "sameShape": sorted(sameShape, key=natural_key), "compared": len(others)}


def candidates_of_size(root: Path, size: int) -> list[tuple[str, int, float]]:
    """(library path, size, modified) of the .stl files that have exactly this size."""
    found: list[tuple[str, int, float]] = []
    for directory, dirNames, fileNames in os.walk(root):
        dirNames[:] = [name for name in dirNames if not name.startswith(".")]
        for name in fileNames:
            if name.startswith(".") or not name.lower().endswith(".stl"):
                continue
            file = Path(directory) / name
            try:
                stat = file.stat()
            except OSError:
                continue
            if stat.st_size == size:
                found.append((file.relative_to(root).as_posix(), stat.st_size, stat.st_mtime))
    return found
