"""The RASTERFASTER library API: browse, search and serve the STL files, and manage them (rename, move, duplicate, new folder, Trash).

A host application builds the router with `create_router(LibraryConfig(...))`; the library knows nothing of documents except through the
paths it is given (the document files are updated when a library file is renamed, moved or trashed: see ops.py).
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from . import duplicates, ops, searchterms


@dataclass
class LibraryConfig:
    """Where things are. The roots are functions, read at every request, so a host (or a test) can change them while the app runs."""
    library_root: Callable[[], Path]  # the STL library
    backup_root: Callable[[], Path]  # originals of renamed files and the Trash (ops.py)
    documents_root: Callable[[], Path]  # the host's document files, updated when a library file is renamed, moved or trashed
    write_lock: object  # held while files are changed (a threading.Lock shared with the host's document writes)
    resolve_part: Callable[[str], Path] | None = None  # the host's way to find a file by path (it may know more than the library); default: inside the library
    is_embedded: Callable[[str], bool] = field(default=lambda path: False)  # paths the host keeps outside the library (they are not "missing")


class CatalogEntry(BaseModel):
    """One STL of the library, for the catalog: `folder` is the top-level folder it is in (empty for a file at the root)."""
    name: str
    path: str
    folder: str
    modified: float
    size: int
    drawn: bool = False  # a current thumbnail drawing is in the cache
    thumbVersion: int | None = None  # its look (the browser draws it again when this is not the version it makes)
    dims: list[float] | None = None  # width, depth, height of the STL (mm), known once it was drawn
    volume: float | None = None  # mm³


class ThumbBody(BaseModel):
    """A thumbnail the browser drew: the SVG, the file's `modified` it was drawn from, and what was measured on the way."""
    modified: float
    version: int = 1  # the look of the drawing, chosen by the browser that made it
    svg: str = Field(max_length=6_000_000)
    dims: list[float] = Field(min_length=3, max_length=3)
    volume: float


unsafeSvg = re.compile(r"<\s*(script|foreignObject|iframe|object|embed)|\bon\w+\s*=|javascript:", re.IGNORECASE)
cacheFolderName = ".catalog-cache"  # inside the documents folder: hidden, so it never shows in the document list


class LibraryEntry(BaseModel):
    name: str
    path: str
    type: Literal["dir", "file"]
    modified: float
    match: bool = True


def natural_key(name: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


class RenameRequest(BaseModel):
    path: str = Field(max_length=1024)
    newName: str = Field(max_length=300)


class TrashRequest(BaseModel):
    path: str = Field(max_length=1024)


class TrashBatchRequest(BaseModel):
    paths: list[str] = Field(max_length=2000)


class PathsRequest(BaseModel):
    paths: list[str] = Field(max_length=5000)


class MoveRequest(BaseModel):
    paths: list[str] = Field(max_length=2000)
    targetDir: str = Field(max_length=1024)


class NewFolderRequest(BaseModel):
    parent: str = Field(max_length=1024)
    name: str = Field(max_length=300)


maxSearchResults = 2000


def create_router(config: LibraryConfig) -> APIRouter:
    router = APIRouter()

    def resolve_inside_root(relativePath: str) -> Path:
        root = config.library_root()
        absolutePath = (root / relativePath).resolve()
        if absolutePath != root and root not in absolutePath.parents:
            raise HTTPException(status_code=403, detail="forbidden")
        return absolutePath

    if config.resolve_part is None:
        config.resolve_part = resolve_inside_root

    cacheLock = threading.Lock()
    cacheIndexes: dict[Path, dict[str, dict]] = {}  # per cache folder: library path -> {modified, size, dims, volume} of the drawings it holds

    scans: dict[Path, dict] = {}  # per library: the state of the scan for identical files

    def scan_state() -> dict:
        return scans.setdefault(config.library_root(), {"state": "idle", "scanned": 0, "total": 0, "groups": [], "error": ""})

    def cache_dir() -> Path:
        return config.documents_root() / cacheFolderName

    def cache_key(path: str) -> str:
        return hashlib.sha1(path.encode("utf-8")).hexdigest()

    def cache_index() -> dict[str, dict]:
        """The drawings in the cache folder, read once from the small .json next to every .svg and then kept up to date by the PUTs."""
        directory = cache_dir()
        with cacheLock:
            if directory not in cacheIndexes:
                found: dict[str, dict] = {}
                for sidecar in directory.glob("*.json") if directory.is_dir() else []:
                    try:
                        record = json.loads(sidecar.read_text(encoding="utf-8"))
                        if sidecar.with_suffix(".svg").is_file():
                            found[record["path"]] = record
                    except (OSError, ValueError, KeyError):
                        pass
                cacheIndexes[directory] = found
            return cacheIndexes[directory]

    @router.post("/api/library/rename")
    def rename_library_entry(body: RenameRequest, dryRun: bool = False) -> dict:
        """Renames a library file or directory (see ops.py): the first rename of a file keeps a copy of the original in the backup folder, the
        documents that use it follow. `dryRun=true` only reports what would happen."""
        with config.write_lock:
            try:
                return ops.rename(config.library_root(), config.backup_root(), config.documents_root(), body.path, body.newName, dryRun)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/trash")
    def move_library_entry_to_trash(body: TrashRequest, dryRun: bool = False) -> dict:
        """Moves a library file or directory to the Trash (like the Finder); `dryRun=true` reports the documents that use it."""
        with config.write_lock:
            try:
                return ops.move_to_trash(config.library_root(), config.backup_root(), config.documents_root(), body.path, dryRun)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/trash-batch")
    def move_library_entries_to_trash(body: TrashBatchRequest, dryRun: bool = False) -> dict:
        """Moves several library items to the Trash as one action (a folder and things inside it count as the folder). `dryRun=true` lists them
        and the documents that use them."""
        with config.write_lock:
            try:
                return ops.trash_batch(config.library_root(), config.backup_root(), config.documents_root(), body.paths, dryRun)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/delete-batch")
    def delete_library_entries(body: TrashBatchRequest, dryRun: bool = False) -> dict:
        """Deletes several library items for good, without the Trash (⌥⌘⌫ in the file list). `dryRun=true` lists them and the documents that use them."""
        with config.write_lock:
            try:
                return ops.delete_batch(config.library_root(), config.backup_root(), config.documents_root(), body.paths, dryRun)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/missing")
    def library_missing(body: PathsRequest) -> dict:
        """Which of these library paths are not files in the library (moved to the Trash, renamed or deleted outside the app, or outside the library):
        the parts list marks the document parts that use them."""
        missing = []
        for path in dict.fromkeys(body.paths):
            try:
                found = config.resolve_part(path).is_file() if config.is_embedded(path) else ops.inside_library(config.library_root(), path).is_file()
            except ops.LibraryError:
                found = False
            if not found:
                missing.append(path)
        return {"missing": missing}


    @router.get("/api/library/root")
    def library_root() -> dict:
        """Where the STL library is on this machine (the file list builds full paths for Copy Path from it)."""
        return {"root": str(config.library_root())}


    @router.post("/api/library/move")
    def move_library_entries(body: MoveRequest, dryRun: bool = False) -> dict:
        """Moves files and directories into one library directory (the first move of a file keeps a copy of the original in the backup folder, the
        documents follow). `dryRun=true` only reports what would happen."""
        with config.write_lock:
            try:
                return ops.move_batch(config.library_root(), config.backup_root(), config.documents_root(), body.paths, body.targetDir, dryRun)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/new-folder")
    def new_library_folder(body: NewFolderRequest) -> dict:
        with config.write_lock:
            try:
                return ops.make_folder(config.library_root(), config.backup_root(), body.parent, body.name)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/remove-empty-folder")
    def remove_empty_library_folder(body: TrashRequest) -> dict:
        """Removes an empty folder (Esc right after New Folder cancels the new folder)."""
        with config.write_lock:
            try:
                return ops.remove_empty_folder(config.library_root(), config.backup_root(), body.path)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/duplicate")
    def duplicate_library_file(body: TrashRequest) -> dict:
        with config.write_lock:
            try:
                return ops.duplicate(config.library_root(), config.backup_root(), body.path)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.post("/api/library/reveal")
    def reveal_library_entry(body: TrashRequest) -> dict:
        """Shows a library item in the Finder (`open -R`); only works on the Mac that runs the API."""
        try:
            target = ops.inside_library(config.library_root(), body.path)
        except ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))
        if sys.platform != "darwin":
            raise HTTPException(status_code=501, detail="Reveal in Finder only works on macOS")
        subprocess.run(["open", "-R", str(target)], check=False)
        return {"path": body.path, "absolute": str(target)}


    @router.get("/api/library/trash")
    def list_library_trash() -> list[dict]:
        return ops.list_trash(config.backup_root())


    @router.post("/api/library/trash/{itemId}/put-back")
    def put_back_from_trash(itemId: str, onConflict: Literal["ask", "rename"] = "ask") -> dict:
        with config.write_lock:
            try:
                return ops.put_back(config.library_root(), config.backup_root(), itemId, onConflict)
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.delete("/api/library/trash/{itemId}")
    def delete_from_trash(itemId: str) -> dict:
        """"Delete Immediately": removes one item from the Trash for good."""
        with config.write_lock:
            try:
                return {"removed": ops.delete_immediately(config.backup_root(), itemId)}
            except ops.LibraryError as error:
                raise HTTPException(status_code=error.status, detail=str(error))


    @router.delete("/api/library/trash")
    def empty_library_trash() -> dict:
        """"Empty Trash": removes everything in the Trash for good."""
        with config.write_lock:
            return {"removed": ops.delete_immediately(config.backup_root(), None)}


    @router.get("/api/list", response_model=list[LibraryEntry])
    def list_directory(path: str = "") -> list[LibraryEntry]:
        directory = resolve_inside_root(path)
        if not directory.is_dir():
            raise HTTPException(status_code=404, detail="not a directory")
        entries = [
            LibraryEntry(
                name=child.name,
                path=child.relative_to(config.library_root()).as_posix(),
                type="dir" if child.is_dir() else "file",
                modified=child.stat().st_mtime,
            )
            for child in directory.iterdir()
            if not child.name.startswith(".") and (child.is_dir() or child.suffix.lower() == ".stl")
        ]
        entries.sort(key=lambda entry: (entry.type != "dir", natural_key(entry.name)))
        return entries



    def make_entry(path: Path, match: bool) -> LibraryEntry:
        return LibraryEntry(
            name=path.name,
            path=path.relative_to(config.library_root()).as_posix(),
            type="dir" if path.is_dir() else "file",
            modified=path.stat().st_mtime,
            match=match,
        )


    @router.get("/api/catalog", response_model=list[CatalogEntry])
    def catalog() -> list[CatalogEntry]:
        """Every .stl in the library (dot files and folders left out), in natural path order, for the catalog dialog."""
        root = config.library_root()
        entries: list[CatalogEntry] = []
        drawings = cache_index()
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
                relative = file.relative_to(root)
                path = relative.as_posix()
                drawing = drawings.get(path)
                current = drawing if drawing and abs(drawing["modified"] - stat.st_mtime) < 1e-3 else None  # a changed file needs a new drawing
                entries.append(CatalogEntry(name=name, path=path, folder=relative.parts[0] if len(relative.parts) > 1 else "", modified=stat.st_mtime, size=stat.st_size,
                                            drawn=current is not None, thumbVersion=current.get("version", 1) if current else None, dims=current["dims"] if current else None, volume=current["volume"] if current else None))
        entries.sort(key=lambda entry: natural_key(entry.path))
        return entries

    @router.get("/api/catalog/thumb")
    def get_thumb(path: str, v: str = "") -> Response:
        """The drawing of one part (an SVG). `v` is only there to make the URL change when the file does, so the browser can keep it for good."""
        resolve_inside_root(path)
        file = cache_dir() / f"{cache_key(path)}.svg"
        if path not in cache_index() or not file.is_file():
            raise HTTPException(status_code=404, detail="no drawing")
        return Response(file.read_bytes(), media_type="image/svg+xml", headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})  # an SVG opened on its own cannot run anything

    @router.put("/api/catalog/thumb", status_code=204)
    def put_thumb(path: str, body: ThumbBody) -> None:
        file = resolve_inside_root(path)
        if file.suffix.lower() != ".stl" or not file.is_file():
            raise HTTPException(status_code=404, detail="not an STL of the library")
        if not body.svg.lstrip().startswith(("<svg", "<?xml")) or unsafeSvg.search(body.svg):
            raise HTTPException(status_code=400, detail="not a plain SVG drawing")
        directory = cache_dir()
        directory.mkdir(parents=True, exist_ok=True)
        key = cache_key(path)
        record = {"path": path, "modified": body.modified, "size": file.stat().st_size, "dims": body.dims, "volume": body.volume, "version": body.version}
        index = cache_index()
        with cacheLock:
            temporary = directory / f"{key}.svg.tmp"
            temporary.write_text(body.svg, encoding="utf-8")
            os.replace(temporary, directory / f"{key}.svg")
            sidecar = directory / f"{key}.json.tmp"
            sidecar.write_text(json.dumps(record), encoding="utf-8")
            os.replace(sidecar, directory / f"{key}.json")
            index[path] = record

    @router.post("/api/catalog/duplicates/scan")
    def start_duplicate_scan() -> dict:
        """Starts looking for identical files in the background (size first, then a content hash; hashes are remembered). Does nothing while a scan runs."""
        state = scan_state()
        root, cacheFile = config.library_root(), cache_dir() / "hashes.json"
        with cacheLock:
            if state["state"] == "running":
                return {key: state[key] for key in ("state", "scanned", "total")}
            state.update(state="running", scanned=0, total=0, groups=[], error="")

        def work() -> None:
            def progress(done: int, total: int) -> None:
                state["scanned"], state["total"] = done, total
            try:
                groups = duplicates.scan(root, cacheFile, progress)
                state.update(state="done", groups=groups)
            except Exception as error:  # noqa: BLE001 - the page shows it instead of waiting for ever
                state.update(state="error", error=str(error))
        threading.Thread(target=work, name="duplicate-scan", daemon=True).start()
        return {"state": "running", "scanned": 0, "total": 0}

    @router.get("/api/catalog/duplicates")
    def get_duplicates() -> dict:
        """The state of the scan and, when it is done, the groups of identical files: {paths, size}."""
        state = scan_state()
        return {"state": state["state"], "scanned": state["scanned"], "total": state["total"], "error": state["error"],
                "groups": state["groups"] if state["state"] == "done" else []}

    @router.get("/api/catalog/used")
    def get_used_paths() -> dict:
        """Every library path that a document (or one of its versions) uses."""
        return {"paths": ops.used_paths(config.documents_root())}

    @router.get("/api/search", response_model=list[LibraryEntry])
    def search(q: str, mode: Literal["any", "all"] = "any") -> list[LibraryEntry]:
        """Files and folders whose name contains the terms of `q` (see searchterms.py): any of them, or with `mode=all` every one."""
        include, exclude = searchterms.parse_query(q)
        if not include:
            return []
        found: dict[str, LibraryEntry] = {}
        matchCount = 0
        for directory, dirNames, fileNames in os.walk(config.library_root()):
            dirNames[:] = [name for name in dirNames if not name.startswith(".")]
            names = dirNames + [name for name in fileNames if name.lower().endswith(".stl") and not name.startswith(".")]
            for name in names:
                if not searchterms.name_matches(name, include, exclude, mode):
                    continue
                path = Path(directory) / name
                found[path.relative_to(config.library_root()).as_posix()] = make_entry(path, True)
                for ancestor in path.parents:
                    if ancestor == config.library_root():
                        break
                    found.setdefault(ancestor.relative_to(config.library_root()).as_posix(), make_entry(ancestor, False))
                matchCount += 1
            if matchCount >= maxSearchResults:
                break
        return list(found.values())


    @router.get("/api/file")
    def get_file(path: str) -> FileResponse:
        file = config.resolve_part(path)
        if file.suffix.lower() != ".stl":
            raise HTTPException(status_code=400, detail="only .stl")
        if not file.is_file():
            raise HTTPException(status_code=404, detail="not found")
        # no-cache = always revalidate with the ETag, so a file overwritten on disk shows up at once instead of the browser's heuristic cached copy
        return FileResponse(file, media_type="model/stl", headers={"Cache-Control": "no-cache"})

    return router
