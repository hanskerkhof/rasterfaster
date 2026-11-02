"""The image library of a document: finished renders kept next to it in `<id>.images/` as `<imageId>.png` with a `<imageId>.json` note
(name, size, render settings, the document version it was made from) and an optional `<imageId>.thumb.jpg` the browser makes."""
import json
import os
import re
import secrets
import shutil
import struct
import time
from pathlib import Path

imageNote = re.compile(r"^([0-9a-f]{12})\.json$")
imageId = re.compile(r"^[0-9a-f]{12}$")


def images_dir(documentsRoot: Path, documentId: str) -> Path:
    return documentsRoot / f"{documentId}.images"


def png_size(data: bytes) -> tuple[int, int] | None:
    """Width and height from the PNG header, or None when it is not a PNG."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])  # type: ignore[return-value]


def add(directory: Path, png: bytes, *, name: str, kind: str, samples: int, elapsed: float, version: int, edited: bool, settings: dict | None = None) -> dict:
    """Stores a picture and returns its note."""
    size = png_size(png)
    if size is None:
        raise ValueError("not a PNG picture")
    directory.mkdir(parents=True, exist_ok=True)
    identifier = secrets.token_hex(6)
    note = {"id": identifier, "name": name[:120] or "Render", "kind": kind, "created": time.time(), "width": size[0], "height": size[1],
            "samples": samples, "elapsed": round(elapsed, 1), "version": version, "edited": edited, "settings": settings or {}}
    (directory / f"{identifier}.png").write_bytes(png)
    write_note(directory, note)
    return note


def write_note(directory: Path, note: dict) -> None:
    temporary = directory / f"{note['id']}.json.tmp"
    temporary.write_text(json.dumps(note, indent=2), encoding="utf-8")
    os.replace(temporary, directory / f"{note['id']}.json")


def read_note(directory: Path, identifier: str) -> dict | None:
    if not imageId.match(identifier):
        return None
    try:
        note = json.loads((directory / f"{identifier}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not (directory / f"{identifier}.png").is_file():
        return None
    note["thumb"] = (directory / f"{identifier}.thumb.jpg").is_file()
    note["bytes"] = (directory / f"{identifier}.png").stat().st_size
    return note


def listing(directory: Path) -> list[dict]:
    """All pictures, newest first."""
    if not directory.is_dir():
        return []
    notes = [note for file in directory.iterdir() if (match := imageNote.match(file.name)) and (note := read_note(directory, match.group(1)))]
    return sorted(notes, key=lambda note: note["created"], reverse=True)


def delete(directory: Path, identifier: str) -> bool:
    if not imageId.match(identifier) or not (directory / f"{identifier}.json").is_file():
        return False
    for suffix in (".png", ".json", ".thumb.jpg"):
        try:
            (directory / f"{identifier}{suffix}").unlink()
        except FileNotFoundError:
            pass
    return True


def delete_matching(directory: Path, *, before_version: int | None = None, kind: str | None = None) -> int:
    """Deletes the pictures made from a version older than `before_version` (an edited copy of v5 counts as v5) and / or of a kind. Returns how many."""
    count = 0
    for note in listing(directory):
        if before_version is not None and note["version"] >= before_version:
            continue
        if kind is not None and note["kind"] != kind:
            continue
        count += delete(directory, note["id"])
    return count


def remove_all(directory: Path) -> None:
    shutil.rmtree(directory, ignore_errors=True)
