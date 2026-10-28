"""Document versions, like Fusion 360's: v1, v2, ... are immutable snapshots of a document, kept next to it in `<id>.versions/v<n>.json`.

The document file itself is the working copy (autosaved as always); saving a version snapshots it as the next number.
"""
import json
import os
import re
import time
from pathlib import Path

versionFile = re.compile(r"^v(\d+)\.json$")


def versions_dir(documentsRoot: Path, documentId: str) -> Path:
    return documentsRoot / f"{documentId}.versions"


def numbers(directory: Path) -> list[int]:
    if not directory.is_dir():
        return []
    return sorted(int(match.group(1)) for file in directory.iterdir() if (match := versionFile.match(file.name)))


def latest(directory: Path) -> int:
    found = numbers(directory)
    return found[-1] if found else 0


def read(directory: Path, number: int) -> dict | None:
    try:
        return json.loads((directory / f"v{number}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def summary(data: dict) -> dict:
    return {"version": data["version"], "savedAt": data["savedAt"], "name": data["name"], "itemCount": len(data["items"])}


def listing(directory: Path) -> list[dict]:
    """Newest first."""
    found = [read(directory, number) for number in numbers(directory)]
    return [summary(data) for data in reversed([d for d in found if d])]


def same_content(a: dict, b: dict) -> bool:
    """Same name and items (compared as JSON, so tuples from the models equal the lists read from disk)."""
    def normal(data: dict):
        return json.loads(json.dumps({"name": data.get("name"), "items": data.get("items")}))

    return normal(a) == normal(b)


def save(directory: Path, body: dict, now: float | None = None) -> dict:
    """Snapshots `body` ({name, items}) as the next version and returns the stored version (with its number and time)."""
    directory.mkdir(parents=True, exist_ok=True)
    number = latest(directory) + 1
    data = {"version": number, "savedAt": now if now is not None else time.time(), "name": body["name"], "items": body["items"]}
    file = directory / f"v{number}.json"
    temporary = file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(temporary, file)
    return data


def delete(directory: Path, number: int) -> bool:
    """Removes one version; False when there is no such version."""
    file = directory / f"v{number}.json"
    if not file.is_file():
        return False
    file.unlink()
    return True


def replace_all(directory: Path, stored: list[dict]) -> None:
    """Makes `stored` (full version dicts) the complete history: used when a document is imported over an existing one."""
    import shutil

    shutil.rmtree(directory, ignore_errors=True)
    if not stored:
        return
    directory.mkdir(parents=True, exist_ok=True)
    for data in stored:
        file = directory / f"v{data['version']}.json"
        temporary = file.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(temporary, file)
