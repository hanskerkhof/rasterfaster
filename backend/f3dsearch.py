#!/usr/bin/env python3
"""Searches the component names inside Fusion 360 design files (.f3d) without opening Fusion.

An .f3d is a zip file whose entries are zstd-compressed (zip method 93, which the standard zipfile module cannot read). The names of the
components and bodies are stored as UTF-16 text in `<asset>/Design1/BulkStream.dat` (`FusionDesignSegmentType1/` in newer files); this tool decompresses that one entry, pulls the text
out and keeps what looks like a name. The result is cached in an index (re-read only when a file changed), so a search takes a moment.

    f3dsearch.py index [folder ...]       index the Fusion cache and the given folders of exported .f3d files (remembered for next time)
    f3dsearch.py search WORD [WORD ...]   components whose name contains every word (case-insensitive), grouped by design
    f3dsearch.py list                     the indexed designs

Needs `zstandard` (backend/requirements-tools.txt). The names are extracted as text, not read by a real parser of Fusion's format: now and then
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


def update_index(index: dict, folders: list[Path], report=print) -> dict:
    """Reads every .f3d in the folders that is new or changed; forgets the ones that are gone."""
    seen = set()
    for folder in folders:
        for file in sorted(folder.rglob("*.f3d")):
            if file.name.startswith("."):
                continue
            key = str(file)
            seen.add(key)
            stat = file.stat()
            known = index["files"].get(key)
            if known and known["size"] == stat.st_size and known["mtime"] == int(stat.st_mtime):
                continue
            started = time.time()
            try:
                names = design_names(file)
            except Exception as error:
                report(f"skipped {file.name}: {error}")
                continue
            index["files"][key] = {"name": display_name(file), "size": stat.st_size, "mtime": int(stat.st_mtime), "names": names}
            report(f"indexed {display_name(file)}: {len(names)} names, {stat.st_size / 1e6:.0f} MB, {time.time() - started:.1f} s")
    for key in [k for k in index["files"] if k not in seen]:
        del index["files"][key]
    return index


def search(index: dict, words: list[str]) -> list[tuple[str, str, list[str]]]:
    wanted = [w.lower() for w in words]
    hits = []
    for key, entry in index["files"].items():
        found = [n for n in entry["names"] if all(w in n.lower() for w in wanted)]
        if found:
            hits.append((entry["name"], key, found))
    hits.sort(key=lambda h: (-len(h[2]), h[0].lower()))
    return hits


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Search component names inside Fusion 360 .f3d files.")
    commands = parser.add_subparsers(dest="command", required=True)
    indexing = commands.add_parser("index", help="index the Fusion cache and folders of exported .f3d files")
    indexing.add_argument("folders", nargs="*", type=Path)
    finding = commands.add_parser("search", help="find components whose name contains all the words")
    finding.add_argument("words", nargs="+")
    finding.add_argument("--limit", type=int, default=15, help="names shown per design (default 15)")
    finding.add_argument("--paths", action="store_true", help="show the file path of each design")
    commands.add_parser("list", help="show the indexed designs")
    args = parser.parse_args(argv)

    index = load_index()
    if args.command == "index":
        folders = [folder.expanduser().resolve() for folder in args.folders]
        index["folders"] = sorted({str(f) for f in [Path(p) for p in index.get("folders", [])] + folders})
        update_index(index, cache_folders() + [Path(p) for p in index["folders"]])
        save_index(index)
        print(f"{len(index['files'])} designs, {sum(len(e['names']) for e in index['files'].values())} names in {indexFile}")
    elif args.command == "search":
        if not index["files"]:
            print("The index is empty: run `f3dsearch.py index` first.")
            return 1
        hits = search(index, args.words)
        for name, key, found in hits:
            source = "Fusion cache" if "/W.login/" in key else Path(key).parent.name  # the same design can be in the cache and in an export folder
            print(f"{name}  ({len(found)})  [{source}]" + (f"  {key}" if args.paths else ""))
            for n in found[:args.limit]:
                print(f"    {n}")
            if len(found) > args.limit:
                print(f"    ... {len(found) - args.limit} more")
        if not hits:
            print("nothing found (the index only knows the designs that were indexed; run `index` again after exporting or opening more designs)")
    else:
        for entry in sorted(index["files"].values(), key=lambda e: e["name"].lower()):
            print(f"{entry['name']}  {len(entry['names'])} names  {entry['size'] / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
