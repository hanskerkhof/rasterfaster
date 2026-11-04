"""Identical files in the library: first by size (two files of different sizes cannot be the same, and reading is the expensive part), then by
the SHA-1 of the content of the files that share a size. A hash is remembered by path, size and modified time, so a second scan only reads
what changed. Empty files are left out (they are all "the same" and say nothing)."""
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Callable


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


def scan(root: Path, cacheFile: Path, progress: Callable[[int, int], None] | None = None) -> list[dict]:
    """Groups of identical files: [{"paths": [...], "size": bytes}], each group sorted by path, the groups by their first path."""
    found = candidates(root)
    cache = read_cache(cacheFile)
    byHash: dict[tuple[int, str], list[str]] = {}
    changed = False
    for done, (path, size, modified) in enumerate(found, start=1):
        record = cache.get(path)
        if not record or record.get("size") != size or abs(record.get("modified", 0) - modified) > 1e-3:
            try:
                record = {"size": size, "modified": modified, "sha1": sha1_of(root / path)}
            except OSError:
                continue
            cache[path] = record
            changed = True
        byHash.setdefault((size, record["sha1"]), []).append(path)
        if progress:
            progress(done, len(found))
    if changed:
        write_cache(cacheFile, {path: record for path, record in cache.items() if (root / path).is_file()})  # forget what is gone
    groups = [{"paths": sorted(paths, key=natural_key), "size": size} for (size, _), paths in byHash.items() if len(paths) > 1]
    groups.sort(key=lambda group: natural_key(group["paths"][0]))
    return groups
