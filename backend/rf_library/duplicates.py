"""Identical files in the library (and files with the same shape, however they are triangulated): first by size (two files of different sizes cannot be the same, and reading is the expensive part), then by
the SHA-1 of the content of the files that share a size. A hash is remembered by path, size and modified time, so a second scan only reads
what changed. Empty files are left out (they are all "the same" and say nothing)."""
import hashlib
import itertools
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
    """Measurements of the shape that do not depend on where the part sits, on the header, on the normals, on the order of the triangles or on
    how the surface is divided into triangles: [box x, y, z, volume, surface area, centre of mass x, y, z, the spread of the mass about its centre (the
    second moments xx, yy, zz, xy, xz, yz) and its lopsidedness (the third moments xxx, yyy, zzz)], all relative to the box. The spread and the
    lopsidedness tell a part from its mirror image, which the other numbers cannot. The same part exported again (or with another triangulation, or at
    another place of an assembly) gives the same numbers."""
    triangles = read_triangles(file)
    if len(triangles) == 0:
        raise ValueError("no triangles")
    low = triangles.reshape(-1, 3).min(axis=0)
    moved = triangles - low  # the part moved to the origin: its place is gone
    size = moved.reshape(-1, 3).max(axis=0)
    a, b, c = moved[:, 0], moved[:, 1], moved[:, 2]
    signed = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0  # the volume of the tetrahedron of each triangle with the origin
    volume = float(signed.sum())
    area = float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum()) / 2.0
    if abs(volume) <= 1e-9:  # an open surface has no volume: the middle of its corners, and no moments
        return [*map(float, size), 0.0, area, *map(float, moved.reshape(-1, 3).mean(axis=0)), 0, 0, 0, 0, 0, 0, 0, 0, 0]
    total = a + b + c
    first = ((total / 4.0) * signed[:, None]).sum(axis=0)  # the integral of x, y, z over the solid
    second = np.empty((3, 3))
    for i in range(3):
        for j in range(i, 3):  # the integral of x_i x_j: a tetrahedron's V/20 (a_i a_j + b_i b_j + c_i c_j + S_i S_j)
            second[i, j] = second[j, i] = (signed / 20.0 * (a[:, i] * a[:, j] + b[:, i] * b[:, j] + c[:, i] * c[:, j] + total[:, i] * total[:, j])).sum()
    third = np.empty(3)
    for i in range(3):  # the integral of x_i^3: V/20 (sum of the cubes + sum of v^2 w over the ordered pairs + the product of the three)
        p, q, r = a[:, i], b[:, i], c[:, i]
        pairs = p * p * q + p * p * r + q * q * p + q * q * r + r * r * p + r * r * q
        third[i] = (signed / 20.0 * (p ** 3 + q ** 3 + r ** 3 + pairs + p * q * r)).sum()
    centre = first / volume
    spread = second / volume - np.outer(centre, centre)  # the second moments about the centre of mass
    lopsided = third / volume - 3 * centre * np.diag(second) / volume + 2 * centre ** 3  # the third central moments (diagonal)
    return [*map(float, size), abs(volume), area, *map(float, centre), float(spread[0, 0]), float(spread[1, 1]), float(spread[2, 2]),
            float(spread[0, 1]), float(spread[0, 2]), float(spread[1, 2]), float(lopsided[0]), float(lopsided[1]), float(lopsided[2])]


boxTolerance = 0.05  # mm, for the box and the centre of mass
volumeTolerance = 1e-3  # relative
areaTolerance = 1.5e-3  # relative


def _proper_rotations() -> list[tuple[tuple[int, int, int], tuple[int, int, int]]]:
    """The 24 ways to turn a part by quarter turns about its axes, as (which axis each new axis was, whether it is flipped): the signed permutations that are no mirroring."""
    rotations = []
    for perm in itertools.permutations(range(3)):
        parity = 1 if sum(1 for i in range(3) for j in range(i + 1, 3) if perm[i] > perm[j]) % 2 == 0 else -1
        for signs in itertools.product((1, -1), repeat=3):
            if parity * signs[0] * signs[1] * signs[2] == 1:
                rotations.append((perm, signs))
    return rotations


_rotations = _proper_rotations()


momentTolerance = 2e-3  # relative to the size of the box


def same_shape(first: list[float], second: list[float]) -> bool:
    """Do two sets of measurements describe the same shape? The volume within 0.1 % and the surface within 0.15 %, and the box, the centre of mass and the
    spread and lopsidedness of the mass: as exported, or with one of the parts turned by quarter turns about its axes (a part lying flat is the same part
    standing up). A mirror image is not the same shape (a LEFT and a RIGHT part are two parts), unless the part is symmetric."""
    if abs(first[3] - second[3]) > volumeTolerance * max(first[3], second[3], 1.0) or abs(first[4] - second[4]) > areaTolerance * max(first[4], second[4], 1.0):
        return False
    box, centre = second[0:3], second[5:8]
    spread = [[second[8], second[11], second[12]], [second[11], second[9], second[13]], [second[12], second[13], second[10]]]
    lopsided = second[14:17]
    for perm, signs in _rotations:
        turnedBox = [box[perm[i]] for i in range(3)]
        if any(abs(x - y) > boxTolerance for x, y in zip(first[0:3], turnedBox)):
            continue
        turnedCentre = [centre[perm[i]] if signs[i] > 0 else box[perm[i]] - centre[perm[i]] for i in range(3)]
        if any(abs(x - y) > boxTolerance for x, y in zip(first[5:8], turnedCentre)):
            continue
        size = first[0:3]
        mine = [[first[8], first[11], first[12]], [first[11], first[9], first[13]], [first[12], first[13], first[10]]]
        if any(abs(mine[i][j] - signs[i] * signs[j] * spread[perm[i]][perm[j]]) > momentTolerance * size[i] * size[j] + 1e-6 for i in range(3) for j in range(3)):
            continue
        if all(abs(first[14 + i] - signs[i] * lopsided[perm[i]]) <= momentTolerance * size[i] ** 3 + 1e-6 for i in range(3)):
            return True
    return False


def walk_stl(root: Path):
    """(library path, size, modified) of every .stl of the library (dot files and folders left out)."""
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
            yield file.relative_to(root).as_posix(), stat.st_size, stat.st_mtime


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
    if mode == "shape":
        found = [item for item in walk_stl(root) if 0 < item[1] <= maxShapeBytes]  # any size: another triangulation of a part is another size
    else:
        found = candidates(root)
    cache = read_cache(cacheFile)
    key = "moments" if mode == "shape" else "sha1"
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
        order = sorted(measured, key=lambda path: measured[path][3])  # by volume: files of the same shape lie next to one another
        parent = {path: path for path in order}  # files that are the same shape as one another, joined (union-find)

        def root_of(path: str) -> str:
            while parent[path] != path:
                parent[path] = parent[parent[path]]
                path = parent[path]
            return path
        for i, first in enumerate(order):
            for second in order[i + 1:]:
                if measured[second][3] - measured[first][3] > volumeTolerance * max(measured[second][3], 1.0):  # type: ignore[index]
                    break
                if same_shape(measured[first], measured[second]):  # type: ignore[arg-type]
                    parent[root_of(second)] = root_of(first)
        joined: dict[str, list[str]] = {}
        for path in order:
            joined.setdefault(root_of(path), []).append(path)
        groups = [{"paths": sorted(group, key=natural_key), "size": max(sizes[path] for path in group)} for group in joined.values() if len(group) > 1]
    else:
        byHash: dict[tuple[int, str], list[str]] = {}
        for path, value in measured.items():
            byHash.setdefault((sizes[path], value), []).append(path)  # type: ignore[arg-type]
        groups = [{"paths": sorted(paths, key=natural_key), "size": size} for (size, _), paths in byHash.items() if len(paths) > 1]
    groups.sort(key=lambda group: natural_key(group["paths"][0]))
    return groups


sizeWindow = 0.30  # a part exported again may be 30 % bigger or smaller as a file
maxShapeCandidates = 4000
maxShapeCandidateBytes = 500 * 1024 * 1024  # what one check may read at most (the closest in size first)


def matches(root: Path, relative: str, exactCache: Path, shapeCache: Path) -> dict:
    """What in the library is the same as one part: files with exactly its content (the files of its size are read), and files with its shape
    (another triangulation, another place, another header: the files of about its size, within 30 %, are measured). Quick: what is read is remembered
    in the same caches as the scans use."""
    target = root / relative
    stat = target.stat()
    size = stat.st_size
    everything = [item for item in walk_stl(root) if item[0] != relative]
    exactCandidates = [item for item in everything if item[1] == size]
    nearest = sorted((item for item in everything if abs(item[1] - size) <= sizeWindow * size and item[1] <= maxShapeBytes), key=lambda item: abs(item[1] - size))
    shapeCandidates, readBytes = [], 0
    for item in nearest[:maxShapeCandidates]:
        if readBytes + item[1] > maxShapeCandidateBytes:
            break
        shapeCandidates.append(item)
        readBytes += item[1]
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
        myShape = value(shape, "shape", "moments", relative, size, stat.st_mtime, shape_features) if 0 < size <= maxShapeBytes else None
    except (ValueError, struct.error):
        myShape = None  # not a readable STL: it can still have exact copies
    identical: list[str] = []
    for path, fileSize, modified in exactCandidates:
        try:
            if value(exact, "exact", "sha1", path, fileSize, modified, sha1_of) == mine:
                identical.append(path)
        except OSError:
            continue
    sameShape: list[str] = []
    if myShape is not None:
        known = {path: (fileSize, modified) for path, fileSize, modified in everything}
        near = {path for path, _, _ in shapeCandidates}
        for path, fileSize, modified in shapeCandidates:
            if path in identical:
                continue
            try:
                if same_shape(myShape, value(shape, "shape", "moments", path, fileSize, modified, shape_features)):
                    sameShape.append(path)
            except (OSError, ValueError, struct.error):
                continue
        for path, record in list(shape.items()):  # what a library-wide check has measured already is compared whatever its size: no reading needed
            if path in near or path in identical or path == relative or path not in known or "moments" not in record:
                continue
            if record.get("size") == known[path][0] and abs(record.get("modified", 0) - known[path][1]) <= 1e-3 and same_shape(myShape, record["moments"]):
                sameShape.append(path)
    for kind, cache, file in (("exact", exact, exactCache), ("shape", shape, shapeCache)):
        if changed[kind]:
            write_cache(file, {path: record for path, record in cache.items() if (root / path).is_file()})
    return {"identical": sorted(identical, key=natural_key), "sameShape": sorted(sameShape, key=natural_key), "compared": len(set(path for path, _, _ in exactCandidates) | set(path for path, _, _ in shapeCandidates))}
