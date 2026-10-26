"""Changing the STL library (file management): rename and the Trash now, moves in a later phase.

Rules (see docs/file-management-plan.md):
- the first time a *file* is renamed, a copy of the original goes to `<backupRoot>/<library folder name>/<old relative path>`; later renames of
  that file are not backed up again (the registry follows the file); renaming a directory only logs it;
- documents (and their versions) refer to library files by path, so their paths are rewritten, and labels that still equal the old file name
  follow the new one;
- every operation is logged in `<backupRoot>/.rasterfaster/log.json`, written as "pending" before anything changes and "done" afterwards;
- delete works like the Finder's Trash: "Move to Trash" moves a file or directory to `<backupRoot>/_TRASH/<id>/<name>` and remembers where it came
  from (`trash.json`), "Put Back" returns it (with its registry entries), "Delete Immediately" and "Empty Trash" remove it for good. Documents are
  not rewritten when something is trashed: their parts keep the path, so they work again after Put Back.
"""
import json
import os
import shutil
import time
from pathlib import Path

stateDirName = ".rasterfaster"
forbiddenNameCharacters = '/\\:\0'  # a slash would move the file, a colon is not allowed on macOS


class LibraryError(Exception):
    """An operation that cannot be done; `status` is the HTTP status the API answers with."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def clean_name(name: str, isFile: bool) -> str:
    name = name.strip()
    if not name or name in (".", ".."):
        raise LibraryError("the name is empty")
    if name.startswith("."):
        raise LibraryError("a name cannot start with a dot")
    if any(character in name for character in forbiddenNameCharacters) or any(ord(character) < 32 for character in name):
        raise LibraryError("a name cannot contain / \\ : or control characters")
    if len(name.encode("utf-8")) > 255:
        raise LibraryError("the name is too long")
    if isFile and not name.lower().endswith(".stl"):
        name += ".stl"
    return name


def atomic_write_json(file: Path, data) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, file)


def read_json(file: Path, default):
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def state_dir(backupRoot: Path) -> Path:
    return backupRoot / stateDirName


def backup_path(backupRoot: Path, libraryRoot: Path, relative: str) -> Path:
    """Where the original of `relative` is (to be) kept: the same hierarchy under the backup root, below a folder named like the library."""
    return backupRoot / libraryRoot.name / relative


def free_backup_path(target: Path) -> Path:
    """`target`, or `name (2).stl`, `name (3).stl`... when something else already sits there: a backup never overwrites a backup."""
    if not target.exists():
        return target
    number = 2
    while True:
        candidate = target.with_name(f"{target.stem} ({number}){target.suffix}")
        if not candidate.exists():
            return candidate
        number += 1


def rewrite_registry_paths(registry: dict, old: str, new: str, isDirectory: bool) -> dict:
    """The registry key follows the file: `old` (or everything below `old/`) becomes `new` (below `new/`)."""
    result = {}
    for key, value in registry.items():
        if key == old:
            result[new] = value
        elif isDirectory and key.startswith(old + "/"):
            result[new + key[len(old):]] = value
        else:
            result[key] = value
    return result


def map_library_path(path: str, old: str, new: str, isDirectory: bool) -> str | None:
    """The new library path of `path` after `old` became `new`, or None when `path` is not affected."""
    if path == old:
        return new
    if isDirectory and path.startswith(old + "/"):
        return new + path[len(old):]
    return None


def document_files(documentsRoot: Path):
    """The working copies and all version snapshots of every document."""
    if not documentsRoot.is_dir():
        return
    for file in sorted(documentsRoot.glob("*.json")):
        yield file
    for directory in sorted(documentsRoot.glob("*.versions")):
        if directory.is_dir():
            yield from sorted(directory.glob("v*.json"))


def rewrite_documents(documentsRoot: Path, old: str, new: str, isDirectory: bool, dryRun: bool = False) -> dict[str, int]:
    """Points every document item at the renamed file. Returns {file name: items changed} (what a dry run would change)."""
    oldLabel = Path(old).stem
    newLabel = Path(new).stem
    changed: dict[str, int] = {}
    for file in document_files(documentsRoot):
        data = read_json(file, None)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            continue
        count = 0
        for item in data["items"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                continue
            mapped = map_library_path(item["path"], old, new, isDirectory)
            if mapped is None:
                continue
            item["path"] = mapped
            if not isDirectory and item.get("name") == oldLabel:
                item["name"] = newLabel  # the label still was the file's name: it follows the file
            count += 1
        if count:
            changed[file.relative_to(documentsRoot).as_posix()] = count
            if not dryRun:
                atomic_write_json(file, data)
    return changed


def rename(libraryRoot: Path, backupRoot: Path, documentsRoot: Path, relative: str, newName: str, dryRun: bool = False) -> dict:
    """Renames a file or directory inside the library (see the module docstring). Returns what happened (or, for a dry run, what would)."""
    source = (libraryRoot / relative).resolve()
    if not relative or source == libraryRoot or libraryRoot not in source.parents:
        raise LibraryError("this is not inside the library", 403)
    if not source.exists():
        raise LibraryError("not found", 404)
    isFile = source.is_file()
    if isFile and source.suffix.lower() != ".stl":
        raise LibraryError("only .stl files and directories can be renamed here")
    name = clean_name(newName, isFile)
    target = source.with_name(name)
    newRelative = target.relative_to(libraryRoot).as_posix()
    result = {"kind": "file" if isFile else "directory", "from": relative, "to": newRelative, "dryRun": dryRun,
              "backup": None, "backedUp": False, "documents": {}}
    if name == source.name:
        raise LibraryError("that is already the name")
    sameFile = target.exists() and source.samefile(target)  # a change of case only: the same file on a case-insensitive disk
    if target.exists() and not sameFile:
        raise LibraryError("something with that name already exists here", 409)

    registryFile = state_dir(backupRoot) / "registry.json"
    registry = read_json(registryFile, {})
    needsBackup = isFile and relative not in registry
    backup = free_backup_path(backup_path(backupRoot, libraryRoot, relative)) if needsBackup else None
    result["backup"] = str(backup) if backup else None
    result["documents"] = rewrite_documents(documentsRoot, relative, newRelative, not isFile, dryRun=True)
    if dryRun:
        return result

    logFile = state_dir(backupRoot) / "log.json"
    log = read_json(logFile, [])
    entry = {"time": time.time(), "kind": f"rename-{result['kind']}", "from": relative, "to": newRelative, "backup": result["backup"], "status": "pending"}
    log.append(entry)
    atomic_write_json(logFile, log)
    try:
        if backup:
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, backup)
            if backup.stat().st_size != source.stat().st_size:
                raise LibraryError("the backup copy is incomplete, nothing was renamed", 500)
            result["backedUp"] = True
        os.rename(source, target)
        try:
            result["documents"] = rewrite_documents(documentsRoot, relative, newRelative, not isFile)
        except Exception:
            os.rename(target, source)  # the documents could not follow: put the file back
            raise
        registry = rewrite_registry_paths(registry, relative, newRelative, not isFile)
        if backup:
            registry[newRelative] = {"originalPath": relative, "backupPath": str(backup), "backedUpAt": time.time()}
        atomic_write_json(registryFile, registry)
    except LibraryError:
        entry["status"] = "failed"
        atomic_write_json(logFile, log)
        raise
    except Exception as error:
        entry["status"] = "failed"
        entry["error"] = str(error)
        atomic_write_json(logFile, log)
        raise LibraryError(f"the rename failed and was undone: {error}", 500)
    entry.update(status="done", documentsUpdated=sum(result["documents"].values()))
    atomic_write_json(logFile, log)
    return result


# --- the Trash -------------------------------------------------------------------------------------------------------------------

trashDirName = "_TRASH"


def trash_dir(backupRoot: Path) -> Path:
    return backupRoot / trashDirName


def tree_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def documents_using(documentsRoot: Path, relative: str, isDirectory: bool) -> dict[str, int]:
    """{document file: parts} that point at the file (or at anything below the directory): what would be left without a file."""
    found: dict[str, int] = {}
    for file in document_files(documentsRoot):
        data = read_json(file, None)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            continue
        count = sum(1 for item in data["items"] if isinstance(item, dict) and isinstance(item.get("path"), str)
                    and map_library_path(item["path"], relative, relative, isDirectory) is not None)
        if count:
            found[file.relative_to(documentsRoot).as_posix()] = count
    return found


def read_trash_index(backupRoot: Path) -> list[dict]:
    return read_json(state_dir(backupRoot) / "trash.json", [])


def write_trash_index(backupRoot: Path, items: list[dict]) -> None:
    atomic_write_json(state_dir(backupRoot) / "trash.json", items)


def append_log(backupRoot: Path, entry: dict) -> list[dict]:
    logFile = state_dir(backupRoot) / "log.json"
    log = read_json(logFile, [])
    log.append(entry)
    atomic_write_json(logFile, log)
    return log


def finish_log(backupRoot: Path, entry: dict, status: str, **extra) -> None:
    """Marks the last written log entry (found by its time and kind) done or failed."""
    logFile = state_dir(backupRoot) / "log.json"
    log = read_json(logFile, [])
    for existing in reversed(log):
        if existing.get("time") == entry["time"] and existing.get("kind") == entry["kind"]:
            existing.update(status=status, **extra)
            break
    atomic_write_json(logFile, log)


def trash_item_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(3).hex()


def list_trash(backupRoot: Path) -> list[dict]:
    """The Trash, newest first; items whose files vanished from the folder are marked `missing`."""
    items = read_trash_index(backupRoot)
    for item in items:
        item["missing"] = not (trash_dir(backupRoot) / item["id"] / item["name"]).exists()
    return sorted(items, key=lambda item: -item["deletedAt"])


def move_to_trash(libraryRoot: Path, backupRoot: Path, documentsRoot: Path, relative: str, dryRun: bool = False) -> dict:
    """Moves a library file or directory to the Trash (nothing is copied or rewritten). Returns what happened, or what would."""
    source = (libraryRoot / relative).resolve()
    if not relative or source == libraryRoot or libraryRoot not in source.parents:
        raise LibraryError("this is not inside the library", 403)
    if not source.exists():
        raise LibraryError("not found", 404)
    isFile = source.is_file()
    if isFile and source.suffix.lower() != ".stl":
        raise LibraryError("only .stl files and directories can be moved to the Trash here")
    result = {"kind": "file" if isFile else "directory", "path": relative, "name": source.name, "dryRun": dryRun, "id": None,
              "documents": documents_using(documentsRoot, relative, not isFile)}
    if dryRun:
        return result
    itemId = trash_item_id()
    destination = trash_dir(backupRoot) / itemId / source.name
    entry = {"time": time.time(), "kind": f"trash-{result['kind']}", "from": relative, "to": str(destination), "status": "pending"}
    append_log(backupRoot, entry)
    try:
        size = tree_size(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
        registryFile = state_dir(backupRoot) / "registry.json"
        registry = read_json(registryFile, {})
        kept = {key: value for key, value in registry.items() if map_library_path(key, relative, relative, not isFile) is None}
        taken = {key: value for key, value in registry.items() if key not in kept}  # remembered with the item, for Put Back
        if taken:
            atomic_write_json(registryFile, kept)
        write_trash_index(backupRoot, read_trash_index(backupRoot) + [
            {"id": itemId, "name": source.name, "originalPath": relative, "kind": result["kind"], "deletedAt": time.time(), "size": size, "registry": taken}])
    except Exception as error:
        finish_log(backupRoot, entry, "failed", error=str(error))
        if destination.exists() and not source.exists():
            shutil.move(str(destination), str(source))  # put it back where it was
        raise LibraryError(f"moving to the Trash failed: {error}", 500)
    finish_log(backupRoot, entry, "done", id=itemId)
    result["id"] = itemId
    return result


def free_library_name(target: Path) -> Path:
    """`name (restored).stl`, `name (restored 2).stl`...: for a Put Back whose place is taken."""
    number = 1
    while True:
        suffix = " (restored)" if number == 1 else f" (restored {number})"
        candidate = target.with_name(f"{target.stem}{suffix}{target.suffix}")
        if not candidate.exists():
            return candidate
        number += 1


def put_back(libraryRoot: Path, backupRoot: Path, itemId: str, onConflict: str = "ask") -> dict:
    """Returns an item to its old place (missing folders are made again). If something is there now: `onConflict=rename` restores it as
    `name (restored)`, otherwise 409."""
    items = read_trash_index(backupRoot)
    item = next((i for i in items if i["id"] == itemId), None)
    if not item:
        raise LibraryError("not in the Trash", 404)
    stored = trash_dir(backupRoot) / itemId / item["name"]
    if not stored.exists():
        raise LibraryError("the file is no longer in the Trash folder", 404)
    original = (libraryRoot / item["originalPath"]).resolve()
    if libraryRoot not in original.parents:
        raise LibraryError("the old place is not inside the library", 403)
    if original.exists():
        if onConflict != "rename":
            raise LibraryError("something with that name is in its old place now", 409)
        original = free_library_name(original)
    target = original
    entry = {"time": time.time(), "kind": "put-back", "from": str(stored), "to": target.relative_to(libraryRoot).as_posix(), "status": "pending"}
    append_log(backupRoot, entry)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(stored), str(target))
        newRelative = target.relative_to(libraryRoot).as_posix()
        if item.get("registry"):
            registryFile = state_dir(backupRoot) / "registry.json"
            registry = read_json(registryFile, {})
            for key, value in item["registry"].items():
                registry[map_library_path(key, item["originalPath"], newRelative, item["kind"] == "directory") or key] = value
            atomic_write_json(registryFile, registry)
        write_trash_index(backupRoot, [i for i in items if i["id"] != itemId])
        shutil.rmtree(trash_dir(backupRoot) / itemId, ignore_errors=True)
    except Exception as error:
        finish_log(backupRoot, entry, "failed", error=str(error))
        raise LibraryError(f"Put Back failed: {error}", 500)
    finish_log(backupRoot, entry, "done")
    return {"id": itemId, "path": newRelative, "kind": item["kind"], "name": target.name, "renamed": newRelative != item["originalPath"]}


def delete_immediately(backupRoot: Path, itemId: str | None) -> int:
    """Removes one item from the Trash for good (or everything when `itemId` is None). Returns how many items went."""
    items = read_trash_index(backupRoot)
    doomed = [i for i in items if itemId is None or i["id"] == itemId]
    if itemId is not None and not doomed:
        raise LibraryError("not in the Trash", 404)
    entry = {"time": time.time(), "kind": "empty-trash" if itemId is None else "delete-immediately", "from": itemId or "*", "to": None, "status": "pending"}
    append_log(backupRoot, entry)
    for item in doomed:
        shutil.rmtree(trash_dir(backupRoot) / item["id"], ignore_errors=True)
    write_trash_index(backupRoot, [i for i in items if i not in doomed])
    finish_log(backupRoot, entry, "done", removed=len(doomed))
    return len(doomed)
