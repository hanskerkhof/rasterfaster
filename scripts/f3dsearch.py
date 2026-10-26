#!/usr/bin/env python3
"""Searches the component names inside Fusion 360 design files (.f3d) without opening Fusion.

An .f3d is a zip file whose entries are zstd-compressed (zip method 93, which the standard zipfile module cannot read). The names of the
components and bodies are stored as UTF-16 text in `<asset>/Design1/BulkStream.dat` (`FusionDesignSegmentType1/` in newer files); this tool decompresses that one entry, pulls the text
out and keeps what looks like a name. The result is cached in an index (re-read only when a file changed), so a search takes a moment.

    f3dsearch.py index [folder ...]       index the Fusion cache and the given folders of exported .f3d files (remembered for next time);
                                          a subfolder called VERSIONS (older versions) is skipped unless you give that folder itself
    f3dsearch.py search WORD [WORD ...]   components whose name contains every word (case-insensitive), grouped by design
    f3dsearch.py tree DESIGN [--bodies]   the hierarchy of a design (components, bodies), from the sidecar the Fusion add-in writes
    f3dsearch.py diff DESIGN | FROM TO    what changed between two versions: components and bodies added, removed, moved (needs the hierarchy files)
    f3dsearch.py list                     the indexed designs

Needs `zstandard` (scripts/requirements-f3dsearch.txt). The names are extracted as text, not read by a real parser of Fusion's format: now and then
a stray string slips in, and a design file that is older than the cloud version has older names.
"""
import argparse
import json
import os
import re
import struct
import sys
import time
import zlib
from collections import Counter
from pathlib import Path

try:
    import zstandard
except ImportError:  # pragma: no cover
    zstandard = None

home = Path.home()
fusionCache = home / "Library" / "Application Support" / "Autodesk" / "Autodesk Fusion 360"
indexFile = home / "Library" / "Application Support" / "Rasterfaster" / "f3d-index.json"
indexVersion = 3  # bump when the extraction changes: older indexes are read again
chunkSize = 16 * 1024 * 1024
tailSize = 4096  # a name never is longer than this: carried over to the next chunk so a name split between two chunks is not lost

utf16Text = re.compile(rb"(?:[\x20-\x7e]\x00){3,}")
trailingText = re.compile(rb"(?:[\x20-\x7e]\x00)*[\x20-\x7e]?\Z")
metaDirName = ".meta"
treeSuffix = ".tree.json"  # the Fusion add-in writes the hierarchy of every saved design into .meta next to it: RF14_v6.f3d -> .meta/RF14_v6.tree.json
archiveDirName = "VERSIONS"  # the add-in moves older versions here: not searched unless this folder is given to `index` itself
versionSuffix = re.compile(r"[\s_]+v(\d+)$", re.IGNORECASE)
guidLike = re.compile(r"^[0-9a-fA-F-]{20,}[$+]?$")


def looks_like_a_name(text: str) -> bool:
    if len(text) > 200 or "_Post2015" in text or guidLike.match(text):
        return False
    return len(re.findall(r"[A-Za-z]", text)) >= 3


def entries(file: Path):
    """(name, method, data offset, compressed size) of every entry of a zip file, read from its central directory."""
    with open(file, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 70000))
        tail = handle.read()
        end = tail.rfind(b"PK\x05\x06")
        if end < 0:
            raise ValueError("not a zip file")
        count, directorySize, directoryOffset = struct.unpack("<HII", tail[end + 10:end + 20])
        if directoryOffset == 0xFFFFFFFF or count == 0xFFFF:  # zip64
            locator = tail.rfind(b"PK\x06\x07")
            (record,) = struct.unpack("<Q", tail[locator + 8:locator + 16])
            handle.seek(record)
            header = handle.read(56)
            count, directorySize, directoryOffset = struct.unpack("<QQQ", header[32:56])
        handle.seek(directoryOffset)
        directory = handle.read(directorySize)
        found, at = [], 0
        while at < len(directory) and directory[at:at + 4] == b"PK\x01\x02":
            method, = struct.unpack("<H", directory[at + 10:at + 12])
            compressed, = struct.unpack("<I", directory[at + 20:at + 24])
            nameLength, extraLength, commentLength = struct.unpack("<HHH", directory[at + 28:at + 34])
            localOffset, = struct.unpack("<I", directory[at + 42:at + 46])
            name = directory[at + 46:at + 46 + nameLength].decode("utf-8", "replace")
            extra = directory[at + 46 + nameLength:at + 46 + nameLength + extraLength]
            uncompressed, = struct.unpack("<I", directory[at + 24:at + 28])
            if 0xFFFFFFFF in (compressed, uncompressed, localOffset):  # zip64: the real values are in the extra field (id 1), in this order
                position = 0
                while position + 4 <= len(extra):
                    fieldId, fieldSize = struct.unpack("<HH", extra[position:position + 4])
                    if fieldId == 1:
                        values = list(struct.unpack("<" + "Q" * (fieldSize // 8), extra[position + 4:position + 4 + fieldSize // 8 * 8]))
                        if uncompressed == 0xFFFFFFFF and values:
                            values.pop(0)
                        if compressed == 0xFFFFFFFF and values:
                            compressed = values.pop(0)
                        if localOffset == 0xFFFFFFFF and values:
                            localOffset = values.pop(0)
                    position += 4 + fieldSize
            handle.seek(localOffset)
            local = handle.read(30)
            localName, localExtra = struct.unpack("<HH", local[26:30])
            dataOffset = localOffset + 30 + localName + localExtra
            found.append((name, method, dataOffset, compressed))
            at += 46 + nameLength + extraLength + commentLength
    return found


def chunks(file: Path, method: int, offset: int, size: int):
    """The decompressed bytes of one entry, piece by piece."""
    with open(file, "rb") as handle:
        handle.seek(offset)
        if method == 0:
            left = size
            while left > 0:
                piece = handle.read(min(chunkSize, left))
                if not piece:
                    break
                left -= len(piece)
                yield piece
            return
        if method == 93:
            if zstandard is None:
                raise SystemExit("this needs the zstandard package: pip install -r backend/requirements-tools.txt")
            reader = zstandard.ZstdDecompressor().stream_reader(handle.read(size) if size < 256 * 1024 * 1024 else _limited(handle, size))
        elif method == 8:
            decompressor = zlib.decompressobj(-15)
            left = size
            while left > 0:
                piece = handle.read(min(chunkSize, left))
                left -= len(piece)
                yield decompressor.decompress(piece)
            return
        else:
            raise ValueError(f"unknown compression method {method}")
        while True:
            piece = reader.read(chunkSize)
            if not piece:
                break
            yield piece


class _limited:
    """A file object that stops after `size` bytes (for entries too big to read at once)."""

    def __init__(self, handle, size):
        self.handle, self.left = handle, size

    def read(self, count=-1):
        count = self.left if count < 0 else min(count, self.left)
        data = self.handle.read(count)
        self.left -= len(data)
        return data


def names_in(stream) -> set[str]:
    """The name-like UTF-16 strings in a stream of bytes (given in pieces)."""
    names: set[str] = set()
    carry = b""
    for piece in stream:
        buffer = carry + piece
        # a text run that reaches the end of the piece may go on in the next one (even when it is still shorter than a name): carry it over
        cut = max(0, len(buffer) - tailSize) + trailingText.search(buffer[-tailSize:]).start()
        for match in utf16Text.finditer(buffer[:cut]):
            text = match.group().decode("utf-16le")
            if looks_like_a_name(text):
                names.add(text)
        carry = buffer[cut:]
    for match in utf16Text.finditer(carry):
        text = match.group().decode("utf-16le")
        if looks_like_a_name(text):
            names.add(text)
    return names


def design_names(file: Path) -> list[str]:
    names: set[str] = set()
    for name, method, offset, size in entries(file):
        if name.endswith("/BulkStream.dat") and "Design" in name.rsplit("/", 2)[-2]:  # Design1/ in older files, FusionDesignSegmentType1/ in newer ones
            names |= names_in(chunks(file, method, offset, size))
    return sorted(names, key=str.lower)


def display_name(file: Path) -> str:
    """`_RF4.0174a662-....f3d` -> `_RF4` (the cache names carry the design's id)."""
    return re.sub(r"\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.f3d$", "", file.name, flags=re.I).removesuffix(".f3d")


def load_index() -> dict:
    try:
        index = json.loads(indexFile.read_text())
        if index.get("version") == indexVersion:
            return index
        return {"version": indexVersion, "folders": index.get("folders", []), "files": {}}
    except (OSError, ValueError):
        return {"version": indexVersion, "folders": [], "files": {}}


def save_index(index: dict) -> None:
    indexFile.parent.mkdir(parents=True, exist_ok=True)
    temporary = indexFile.with_suffix(".tmp")
    temporary.write_text(json.dumps(index))
    os.replace(temporary, indexFile)


def cache_folders() -> list[Path]:
    return sorted(fusionCache.glob("*/W.login/F")) if fusionCache.is_dir() else []


def sidecar_for(file: Path) -> Path:
    return file.parent / metaDirName / (file.stem + treeSuffix)


def read_sidecar(file: Path) -> dict | None:
    """The hierarchy file the add-in wrote next to the design, or None."""
    try:
        data = json.loads(sidecar_for(file).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) and isinstance(data.get("tree"), dict) else None
    except (OSError, ValueError):
        return None


def places_in(tree: dict) -> dict[str, list[str]]:
    """{name: where it is}: for every component and body the components it sits in, e.g. NERO -> ['14.2.NERO_BIANCO_CONTROL › letters']."""
    found: dict[str, list[str]] = {}

    def add(name: str, place: str):
        name = name.removeprefix("[mesh] ")
        if place not in found.setdefault(name, []):
            found[name].append(place)

    def walk(node: dict, path: list[str]):
        here = " › ".join(path) if path else "(root)"
        for body in node.get("bodies", []):
            add(body, here)
        for child in node.get("children", []):
            add(child.get("component") or child["name"], here)
            walk(child, path + [child.get("component") or child["name"]])

    walk(tree, [])
    return found


def f3d_files(folder: Path):
    """The .f3d files in a folder and its subfolders, except those in a folder called VERSIONS (unless the VERSIONS folder is the one given)."""
    skip = folder.name.lower() != archiveDirName.lower()
    for root, directories, files in os.walk(folder):
        directories[:] = sorted(d for d in directories if not d.startswith(".") and not (skip and d.lower() == archiveDirName.lower()))
        for name in sorted(files):
            if name.lower().endswith(".f3d") and not name.startswith("."):
                yield Path(root) / name


def update_index(index: dict, folders: list[Path], report=print) -> dict:
    """Reads every .f3d in the folders that is new or changed; forgets the ones that are gone."""
    seen = set()
    for folder in folders:
        for file in f3d_files(folder):
            key = str(file)
            seen.add(key)
            stat = file.stat()
            known = index["files"].get(key)
            sidecar = sidecar_for(file)
            tree_mtime = int(sidecar.stat().st_mtime) if sidecar.exists() else None
            if known and known["size"] == stat.st_size and known["mtime"] == int(stat.st_mtime):
                if known.get("treeMtime") != tree_mtime:  # only the hierarchy file changed: the big .f3d is not read again
                    data = read_sidecar(file)
                    known["places"], known["treeMtime"] = (places_in(data["tree"]) if data else {}), tree_mtime
                    report(f"hierarchy of {display_name(file)}: {'read' if data else 'removed'}")
                continue
            started = time.time()
            try:
                names = design_names(file)
            except Exception as error:
                report(f"skipped {file.name}: {error}")
                continue
            data = read_sidecar(file)
            index["files"][key] = {"name": display_name(file), "size": stat.st_size, "mtime": int(stat.st_mtime), "names": names,
                                   "places": places_in(data["tree"]) if data else {}, "treeMtime": tree_mtime}
            report(f"indexed {display_name(file)}: {len(names)} names, {stat.st_size / 1e6:.0f} MB, {time.time() - started:.1f} s")
    for key in [k for k in index["files"] if k not in seen]:
        del index["files"][key]
    return index


def design_key(name: str) -> tuple[str, int]:
    """(the design a file belongs to, its version): `RF14_v3`, `RF14 v4` and the cache's `_RF14` are all the design `rf14` (version 3, 4 and 0)."""
    found = versionSuffix.search(name)
    base = versionSuffix.sub("", name).strip()
    return base.lstrip("_ ").lower(), int(found.group(1)) if found else 0


def designs(index: dict) -> dict[str, list[tuple[str, dict]]]:
    """The indexed files grouped per design, newest first (the highest version, then the most recently changed file)."""
    groups: dict[str, list[tuple[str, dict]]] = {}
    for key, entry in index["files"].items():
        groups.setdefault(design_key(entry["name"])[0], []).append((key, entry))
    for members in groups.values():
        members.sort(key=lambda m: (design_key(m[1]["name"])[1], m[1]["mtime"]), reverse=True)
    return groups


def searchable_names(entry: dict, raw: bool = False) -> list[str]:
    """The names to search in a design: the components and bodies of its hierarchy file when it has one (clean: no sketches, expressions or other
    strings of the binary), else every name-like string in the .f3d. `raw` always takes the strings of the .f3d."""
    if not raw and entry.get("places"):
        return sorted(entry["places"], key=str.lower)
    return entry["names"]


def search(index: dict, words: list[str], all_versions: bool = False, raw: bool = False) -> list[tuple[str, str, list[str], str]]:
    """Per design the newest version that has a matching name: (file name, path, matching names, note). `all_versions` lists every file with a match."""
    wanted = [w.lower() for w in words]
    hits = []
    for members in designs(index).values():
        matching = []
        for key, entry in members:
            found = [n for n in searchable_names(entry, raw) if all(w in n.lower() for w in wanted)]
            if found:
                matching.append((key, entry, found))
        if not matching:
            continue
        if all_versions:
            hits.extend((entry["name"], key, found, "") for key, entry, found in matching)
            continue
        key, entry, found = matching[0]
        notes = []
        if members[0][0] != key:
            notes.append(f"the newest version, {members[0][1]['name']}, has no match")
        older = [e["name"] for k, e, _ in matching[1:]]
        if older:
            only_older = {n for _, _, f in matching[1:] for n in f} - set(found)
            notes.append(f"{len(older)} older version{'s' if len(older) > 1 else ''} with a match hidden: {', '.join(older[:4])}" + (" ..." if len(older) > 4 else ""))
            if only_older:
                notes.append(f"{len(only_older)} matching name{'s' if len(only_older) > 1 else ''} only in older versions, e.g. {sorted(only_older, key=str.lower)[0]}")
        hits.append((entry["name"], key, found, "; ".join(notes)))
    hits.sort(key=lambda h: (-len(h[2]), h[0].lower()))
    return hits


def find_design(index: dict, query: str):
    """The design whose name is `query` (or contains it), as (its files newest first). None when nothing matches, a list of names when several do."""
    wanted = query.lower().lstrip("_ ")
    groups = designs(index)
    exact = [m for base, m in groups.items() if base == design_key(wanted)[0] or base == wanted]
    if exact:
        return exact[0]
    partial = {base: m for base, m in groups.items() if wanted in base}
    if len(partial) == 1:
        return next(iter(partial.values()))
    return sorted(partial) if partial else None


def render_tree(node: dict, bodies: bool, depth: int, limit: int, prefix: str = "", level: int = 0) -> list[str]:
    """The hierarchy as text lines: components with their body count, optionally the bodies."""
    lines = []
    name = node.get("component") or node["name"]
    count = len(node.get("bodies", []))
    if level == 0:
        lines.append(f"{node['name']}" + (f"   [{count} bodies]" if count else ""))
    items = []
    if bodies:
        shown = node.get("bodies", [])[:limit]
        items += [("body", b) for b in shown]
        if count > limit:
            items.append(("more", f"... {count - limit} more bodies"))
    if depth is None or level < depth:
        items += [("component", c) for c in node.get("children", [])]
    for i, (kind, item) in enumerate(items):
        last = i == len(items) - 1
        branch = "└─ " if last else "├─ "
        extension = "   " if last else "│  "
        if kind == "component":
            n = len(item.get("bodies", []))
            sub = len(item.get("children", []))
            lines.append(f"{prefix}{branch}▸ {item.get('component') or item['name']}   [{n} bodies" + (f", {sub} sub-components" if sub else "") + "]")
            lines += render_tree(item, bodies, depth, limit, prefix + extension, level + 1) if level + 1 <= (depth if depth is not None else 10**6) else []
        elif kind == "body":
            lines.append(f"{prefix}{branch}· {item}")
        else:
            lines.append(f"{prefix}{branch}{item}")
    return lines


def flatten(tree: dict) -> list[tuple[str, str, str]]:
    """Every component and body of a hierarchy as (kind, where it sits, name)."""
    items: list[tuple[str, str, str]] = []

    def walk(node: dict, path: list[str]):
        here = " › ".join(path) if path else "(root)"
        for body in node.get("bodies", []):
            items.append(("body", here, body.removeprefix("[mesh] ")))
        for child in node.get("children", []):
            name = child.get("component") or child["name"]
            items.append(("component", here, name))
            walk(child, path + [name])

    walk(tree, [])
    return items


def compare_trees(before: dict, after: dict) -> dict[str, list]:
    """What changed from one hierarchy to the next: {added, removed, moved} (moved: the same name, now in another component)."""
    old, new = Counter(flatten(before)), Counter(flatten(after))
    removed, added = list((old - new).elements()), list((new - old).elements())
    moved = []
    free: dict[tuple[str, str], list[str]] = {}
    for kind, place, name in added:
        free.setdefault((kind, name), []).append(place)
    still_removed = []
    for kind, place, name in removed:
        targets = free.get((kind, name))
        if targets:
            moved.append((kind, name, place, targets.pop(0)))
        else:
            still_removed.append((kind, place, name))
    still_added = [(kind, place, name) for (kind, name), places in free.items() for place in places]
    key = lambda item: (item[2].lower(), item[1].lower())
    return {"added": sorted(still_added, key=key), "removed": sorted(still_removed, key=key), "moved": sorted(moved, key=lambda m: (m[1].lower(), m[2]))}


def entry_for_name(index: dict, name: str):
    """(path, entry) of the indexed file with exactly this name (the newest one that has a hierarchy file when several do), or None."""
    matches = [(k, e) for k, e in index["files"].items() if e["name"].lower() == name.lower()]
    matches.sort(key=lambda m: (bool(m[1].get("places")), m[1]["mtime"]), reverse=True)
    return matches[0] if matches else None


def render_changes(changes: dict[str, list], limit: int) -> list[str]:
    def where(place):
        return f"   in {place}"

    def section(title, rows):
        lines = [f"{title} ({len(rows)})"] if rows else []
        for row in rows[:limit]:
            lines.append("   " + row)
        if len(rows) > limit:
            lines.append(f"   ... {len(rows) - limit} more")
        return lines

    mark = lambda kind: "▸" if kind == "component" else "·"
    lines = []
    lines += section("+ added", [f"{mark(k)} {n}{where(p)}" for k, p, n in changes["added"]])
    lines += section("- removed", [f"{mark(k)} {n}{where(p)}" for k, p, n in changes["removed"]])
    lines += section("~ moved", [f"{mark(k)} {n}   {a} → {b}" for k, n, a, b in changes["moved"]])
    return lines or ["no difference in components and bodies"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Search component names inside Fusion 360 .f3d files.")
    commands = parser.add_subparsers(dest="command", required=True)
    indexing = commands.add_parser("index", help="index the Fusion cache and folders of exported .f3d files")
    indexing.add_argument("folders", nargs="*", type=Path)
    finding = commands.add_parser("search", help="find components whose name contains all the words")
    finding.add_argument("words", nargs="+")
    finding.add_argument("--limit", type=int, default=15, help="names shown per design (default 15)")
    finding.add_argument("--paths", action="store_true", help="show the file path of each design")
    finding.add_argument("--all-versions", action="store_true", help="list every version of a design (default: only the newest one with a match)")
    finding.add_argument("--raw", action="store_true", help="also search the other strings of the .f3d (sketches, expressions ...) even when a design has a hierarchy file")
    showing = commands.add_parser("tree", help="show the hierarchy (components and bodies) of a design, from the sidecar the Fusion add-in wrote")
    showing.add_argument("design", help="the design's name (or part of it)")
    showing.add_argument("--bodies", action="store_true", help="also list the bodies in each component")
    showing.add_argument("--depth", type=int, default=None, help="show only this many levels of sub-components")
    showing.add_argument("--limit", type=int, default=12, help="bodies shown per component with --bodies (default 12)")
    comparing = commands.add_parser("diff", help="what changed between two versions of a design (components and bodies added, removed, moved)")
    comparing.add_argument("designs", nargs="+", help="a design's name (compares its two newest versions that have a hierarchy file), or two file names: FROM TO, e.g. RF14_v6 RF14_v7")
    comparing.add_argument("--limit", type=int, default=25, help="lines per section (default 25)")
    listing = commands.add_parser("list", help="show the indexed designs")
    listing.add_argument("--all-versions", action="store_true", help="list every file (default: the newest version of each design)")
    args = parser.parse_args(argv)

    index = load_index()
    if args.command == "index":
        folders = [folder.expanduser().resolve() for folder in args.folders]
        # the folders are remembered for the next run, except a VERSIONS folder: that one is searched only in the run where it is asked for
        remembered = [Path(p) for p in index.get("folders", []) if Path(p).name.lower() != archiveDirName.lower()]
        index["folders"] = sorted({str(f) for f in remembered + [f for f in folders if f.name.lower() != archiveDirName.lower()]})
        once = [f for f in folders if f.name.lower() == archiveDirName.lower()]
        update_index(index, cache_folders() + [Path(p) for p in index["folders"]] + once)
        save_index(index)
        print(f"{len(index['files'])} designs, {sum(len(e['names']) for e in index['files'].values())} names in {indexFile}")
    elif args.command == "search":
        if not index["files"]:
            print("The index is empty: run `f3dsearch.py index` first.")
            return 1
        hits = search(index, args.words, args.all_versions, args.raw)
        for name, key, found, note in hits:
            source = "Fusion cache" if "/W.login/" in key else Path(key).parent.name  # the same design can be in the cache and in an export folder
            print(f"{name}  ({len(found)})  [{source}]" + (f"  {key}" if args.paths else ""))
            places = index["files"][key].get("places", {})
            for n in found[:args.limit]:
                where = places.get(n.removeprefix("[mesh] "))
                print(f"    {n}" + (f"   in {where[0]}" + (f" (+{len(where) - 1} more places)" if len(where) > 1 else "") if where else ""))
            if len(found) > args.limit:
                print(f"    ... {len(found) - args.limit} more")
            if note:
                print(f"    ({note}; --all-versions shows them)")
        if not hits:
            print("nothing found (the index only knows the designs that were indexed; run `index` again after exporting or opening more designs)")
    elif args.command == "diff":
        if len(args.designs) > 2:
            print("Give a design name, or two file names: FROM TO.")
            return 1
        if len(args.designs) == 2:
            pair = [entry_for_name(index, n) for n in args.designs]
            missing = [n for n, p in zip(args.designs, pair) if p is None]
            if missing:
                print(f"Not indexed: {', '.join(missing)} (names as `list --all-versions` shows them; a version that was moved to a VERSIONS folder is only indexed when you give that folder to `index`).")
                return 1
        else:
            design = find_design(index, args.designs[0])
            if design is None or (design and isinstance(design[0], str)):
                print("No design called that" + (f". Did you mean: {', '.join(design)}?" if design else " is indexed."))
                return 1
            with_tree = [m for m in design if m[1].get("places")]
            if len(with_tree) < 2:
                print(f"{design[0][1]['name']} has {len(with_tree)} version{'s' if len(with_tree) != 1 else ''} with a hierarchy file: a comparison needs two (save or open the versions with the Fusion add-in).")
                return 1
            pair = [with_tree[1], with_tree[0]]  # older -> newer
        trees = []
        for key, entry in pair:
            data = read_sidecar(Path(key))
            if not data:
                print(f"No hierarchy is stored for {entry['name']}: save it with the Fusion add-in or open it with Open Local File.")
                return 1
            trees.append(data)
        (_, before), (_, after) = pair
        print(f"{before['name']} → {after['name']}   (components {trees[0].get('components', '?')} → {trees[1].get('components', '?')}, bodies {trees[0].get('bodies', '?')} → {trees[1].get('bodies', '?')})")
        print("\n".join(render_changes(compare_trees(trees[0]["tree"], trees[1]["tree"]), args.limit)))
        return 0
    elif args.command == "tree":
        design = find_design(index, args.design)
        if design is None or (design and isinstance(design[0], str)):
            print("No design called that" + (f". Did you mean: {', '.join(design)}?" if design else " is indexed."))
            return 1
        for key, entry in design:  # newest first: the first one that has a hierarchy file
            data = read_sidecar(Path(key))
            if data:
                print(f"{entry['name']}   ({sidecar_for(Path(key)).name}: {data.get('components', '?')} components, {data.get('bodies', '?')} bodies, saved {data.get('savedAt', '?')})")
                print("\n".join(render_tree(data["tree"], args.bodies, args.depth, args.limit)))
                return 0
        print(f"No hierarchy is stored for {design[0][1]['name']}: save it with the Fusion add-in (Save Local Copy) or open it with Open Local File, which writes {treeSuffix}.")
        return 1
    else:
        for members in sorted(designs(index).values(), key=lambda m: m[0][1]["name"].lower()):
            shown = members if args.all_versions else members[:1]
            for key, entry in shown:
                extra = f"  (+{len(members) - 1} older)" if not args.all_versions and len(members) > 1 else ""
                tree = "  [hierarchy]" if entry.get("places") else ""
                print(f"{entry['name']}  {len(entry['names'])} names  {entry['size'] / 1e6:.0f} MB{tree}{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
