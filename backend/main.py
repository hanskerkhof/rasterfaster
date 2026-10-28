"""Read-only file API for the RASTERFASTER library.

    GET /api/list?path=<relative dir>   -> [{name, path, type: 'dir'|'file'}]
    GET /api/search?q=<text>&mode=any|all -> matching dirs/.stl files plus their ancestor dirs (several terms: any / all; "phrase"; -exclude)
    GET /api/file?path=<relative file>  -> raw .stl bytes
    GET/POST /api/documents, GET/PUT/DELETE /api/documents/{id}   -> assembly documents (JSON files)
    GET /...                            -> the built Angular app (a PWA), when frontend/3d-tool/dist exists (override: RF_FRONTEND)
    POST /api/runtime/restart           -> re-exec this process in place (picks up code edits, same PID)

Run: .venv1/bin/python main.py   (env: RF_ROOT, PORT)
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import uvicorn
import appconfig
import blenderexport
import versions
import export3mf
import import3mf
import library_ops
import searchterms
import svgexport
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, Field

_paths = appconfig.resolve_paths(os.environ, Path(__file__).resolve().parent.parent, Path.home(), appconfig.is_frozen(), appconfig.bundle_dir())
libraryRoot = _paths["libraryRoot"]
apiPort = int(os.environ.get("PORT", "8100"))
frontendDist = _paths["frontendDist"]
documentsRoot = _paths["documentsRoot"]
backupRoot = _paths["backupRoot"]  # originals of renamed library files (library_ops.py)
if appconfig.is_frozen() and not os.environ.get("RF_DOCS"):
    appconfig.seed_documents(documentsRoot, (appconfig.bundle_dir() or Path(".")) / "seed_documents")

app = FastAPI(title="RASTERFASTER API")


class LibraryEntry(BaseModel):
    name: str
    path: str
    type: Literal["dir", "file"]
    modified: float
    match: bool = True


def resolve_inside_root(relativePath: str) -> Path:
    absolutePath = (libraryRoot / relativePath).resolve()
    if absolutePath != libraryRoot and libraryRoot not in absolutePath.parents:
        raise HTTPException(status_code=403, detail="forbidden")
    return absolutePath


embeddedPattern = re.compile(r"^embedded:([0-9a-f]{40})\.stl$")


def resolve_part(path: str) -> Path:
    """The STL of a document part: a library file, or geometry kept from an imported 3MF (`embedded:<sha1>.stl`, stored next to the documents)."""
    found = embeddedPattern.match(path)
    if found:
        return documentsRoot / "_embedded" / f"{found.group(1)}.stl"
    return resolve_inside_root(path)


def natural_key(name: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


@app.get("/api/health")
def health():
    """Cheap liveness check; the frontend polls it to show an offline banner. `documents` is the newest modification time of any
    document: when it changes the frontend checks whether the open document was changed by another window."""
    stamp = 0.0
    for file in documentsRoot.glob("*.json") if documentsRoot.is_dir() else []:
        try:
            stamp = max(stamp, file.stat().st_mtime)
        except OSError:
            pass
    return {"status": "ok", "documents": stamp}


class RenameRequest(BaseModel):
    path: str = Field(max_length=1024)
    newName: str = Field(max_length=300)


@app.post("/api/library/rename")
def rename_library_entry(body: RenameRequest, dryRun: bool = False) -> dict:
    """Renames a library file or directory (see library_ops.py): the first rename of a file keeps a copy of the original in the backup folder, the
    documents that use it follow. `dryRun=true` only reports what would happen."""
    with documentWriteLock:
        try:
            return library_ops.rename(libraryRoot, backupRoot, documentsRoot, body.path, body.newName, dryRun)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


class TrashRequest(BaseModel):
    path: str = Field(max_length=1024)


@app.post("/api/library/trash")
def move_library_entry_to_trash(body: TrashRequest, dryRun: bool = False) -> dict:
    """Moves a library file or directory to the Trash (like the Finder); `dryRun=true` reports the documents that use it."""
    with documentWriteLock:
        try:
            return library_ops.move_to_trash(libraryRoot, backupRoot, documentsRoot, body.path, dryRun)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


class TrashBatchRequest(BaseModel):
    paths: list[str] = Field(max_length=2000)


@app.post("/api/library/trash-batch")
def move_library_entries_to_trash(body: TrashBatchRequest, dryRun: bool = False) -> dict:
    """Moves several library items to the Trash as one action (a folder and things inside it count as the folder). `dryRun=true` lists them
    and the documents that use them."""
    with documentWriteLock:
        try:
            return library_ops.trash_batch(libraryRoot, backupRoot, documentsRoot, body.paths, dryRun)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.post("/api/library/delete-batch")
def delete_library_entries(body: TrashBatchRequest, dryRun: bool = False) -> dict:
    """Deletes several library items for good, without the Trash (⌥⌘⌫ in the file list). `dryRun=true` lists them and the documents that use them."""
    with documentWriteLock:
        try:
            return library_ops.delete_batch(libraryRoot, backupRoot, documentsRoot, body.paths, dryRun)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


class PathsRequest(BaseModel):
    paths: list[str] = Field(max_length=5000)


@app.post("/api/library/missing")
def library_missing(body: PathsRequest) -> dict:
    """Which of these library paths are not files in the library (moved to the Trash, renamed or deleted outside the app, or outside the library):
    the parts list marks the document parts that use them."""
    missing = []
    for path in dict.fromkeys(body.paths):
        try:
            found = resolve_part(path).is_file() if embeddedPattern.match(path) else library_ops.inside_library(libraryRoot, path).is_file()
        except library_ops.LibraryError:
            found = False
        if not found:
            missing.append(path)
    return {"missing": missing}


@app.get("/api/library/root")
def library_root() -> dict:
    """Where the STL library is on this machine (the file list builds full paths for Copy Path from it)."""
    return {"root": str(libraryRoot)}


class MoveRequest(BaseModel):
    paths: list[str] = Field(max_length=2000)
    targetDir: str = Field(max_length=1024)


@app.post("/api/library/move")
def move_library_entries(body: MoveRequest, dryRun: bool = False) -> dict:
    """Moves files and directories into one library directory (the first move of a file keeps a copy of the original in the backup folder, the
    documents follow). `dryRun=true` only reports what would happen."""
    with documentWriteLock:
        try:
            return library_ops.move_batch(libraryRoot, backupRoot, documentsRoot, body.paths, body.targetDir, dryRun)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


class NewFolderRequest(BaseModel):
    parent: str = Field(max_length=1024)
    name: str = Field(max_length=300)


@app.post("/api/library/new-folder")
def new_library_folder(body: NewFolderRequest) -> dict:
    with documentWriteLock:
        try:
            return library_ops.make_folder(libraryRoot, backupRoot, body.parent, body.name)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.post("/api/library/remove-empty-folder")
def remove_empty_library_folder(body: TrashRequest) -> dict:
    """Removes an empty folder (Esc right after New Folder cancels the new folder)."""
    with documentWriteLock:
        try:
            return library_ops.remove_empty_folder(libraryRoot, backupRoot, body.path)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.post("/api/library/duplicate")
def duplicate_library_file(body: TrashRequest) -> dict:
    with documentWriteLock:
        try:
            return library_ops.duplicate(libraryRoot, backupRoot, body.path)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.post("/api/library/reveal")
def reveal_library_entry(body: TrashRequest) -> dict:
    """Shows a library item in the Finder (`open -R`); only works on the Mac that runs the API."""
    try:
        target = library_ops.inside_library(libraryRoot, body.path)
    except library_ops.LibraryError as error:
        raise HTTPException(status_code=error.status, detail=str(error))
    if sys.platform != "darwin":
        raise HTTPException(status_code=501, detail="Reveal in Finder only works on macOS")
    subprocess.run(["open", "-R", str(target)], check=False)
    return {"path": body.path, "absolute": str(target)}


@app.get("/api/library/trash")
def list_library_trash() -> list[dict]:
    return library_ops.list_trash(backupRoot)


@app.post("/api/library/trash/{itemId}/put-back")
def put_back_from_trash(itemId: str, onConflict: Literal["ask", "rename"] = "ask") -> dict:
    with documentWriteLock:
        try:
            return library_ops.put_back(libraryRoot, backupRoot, itemId, onConflict)
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.delete("/api/library/trash/{itemId}")
def delete_from_trash(itemId: str) -> dict:
    """"Delete Immediately": removes one item from the Trash for good."""
    with documentWriteLock:
        try:
            return {"removed": library_ops.delete_immediately(backupRoot, itemId)}
        except library_ops.LibraryError as error:
            raise HTTPException(status_code=error.status, detail=str(error))


@app.delete("/api/library/trash")
def empty_library_trash() -> dict:
    """"Empty Trash": removes everything in the Trash for good."""
    with documentWriteLock:
        return {"removed": library_ops.delete_immediately(backupRoot, None)}


@app.get("/api/list", response_model=list[LibraryEntry])
def list_directory(path: str = "") -> list[LibraryEntry]:
    directory = resolve_inside_root(path)
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")
    entries = [
        LibraryEntry(
            name=child.name,
            path=child.relative_to(libraryRoot).as_posix(),
            type="dir" if child.is_dir() else "file",
            modified=child.stat().st_mtime,
        )
        for child in directory.iterdir()
        if not child.name.startswith(".") and (child.is_dir() or child.suffix.lower() == ".stl")
    ]
    entries.sort(key=lambda entry: (entry.type != "dir", natural_key(entry.name)))
    return entries


maxSearchResults = 2000


def make_entry(path: Path, match: bool) -> LibraryEntry:
    return LibraryEntry(
        name=path.name,
        path=path.relative_to(libraryRoot).as_posix(),
        type="dir" if path.is_dir() else "file",
        modified=path.stat().st_mtime,
        match=match,
    )


@app.get("/api/search", response_model=list[LibraryEntry])
def search(q: str, mode: Literal["any", "all"] = "any") -> list[LibraryEntry]:
    """Files and folders whose name contains the terms of `q` (see searchterms.py): any of them, or with `mode=all` every one."""
    include, exclude = searchterms.parse_query(q)
    if not include:
        return []
    found: dict[str, LibraryEntry] = {}
    matchCount = 0
    for directory, dirNames, fileNames in os.walk(libraryRoot):
        dirNames[:] = [name for name in dirNames if not name.startswith(".")]
        names = dirNames + [name for name in fileNames if name.lower().endswith(".stl") and not name.startswith(".")]
        for name in names:
            if not searchterms.name_matches(name, include, exclude, mode):
                continue
            path = Path(directory) / name
            found[path.relative_to(libraryRoot).as_posix()] = make_entry(path, True)
            for ancestor in path.parents:
                if ancestor == libraryRoot:
                    break
                found.setdefault(ancestor.relative_to(libraryRoot).as_posix(), make_entry(ancestor, False))
            matchCount += 1
        if matchCount >= maxSearchResults:
            break
    return list(found.values())


@app.get("/api/file")
def get_file(path: str) -> FileResponse:
    file = resolve_part(path)
    if file.suffix.lower() != ".stl":
        raise HTTPException(status_code=400, detail="only .stl")
    if not file.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(file, media_type="model/stl")


class DocumentItem(BaseModel):
    id: str = Field(max_length=64)
    path: str = Field(max_length=1024)
    name: str = Field(max_length=256)
    color: int
    position: tuple[float, float, float]
    rotation: tuple[float, float, float, float]
    muted: bool = False  # dimmed in the editor and ignored by clicks; still part of BOM and exports
    centered: bool = False  # keep the footprint centre on the middle of a grid cell when moved
    noExport: bool = False  # mock part (e.g. a component model): left out of the 3MF and SVG exports


class DocumentBody(BaseModel):
    name: str = Field(default="Untitled", min_length=1, max_length=120)
    items: list[DocumentItem] = Field(default_factory=list, max_length=2000)


class DocumentOut(DocumentBody):
    id: str
    modified: float
    version: int = 0  # the newest saved version (v1, v2, ...); 0 when none was saved yet
    changedSinceVersion: bool = True  # the working copy differs from that version


class VersionSummary(BaseModel):
    version: int
    savedAt: float
    name: str
    itemCount: int


class VersionOut(VersionSummary):
    created: bool = True  # False: nothing changed since the newest version, so no new one was made


class VersionDetail(VersionSummary):
    items: list[DocumentItem]


class DocumentSummary(BaseModel):
    id: str
    name: str
    itemCount: int
    modified: float


documentIdPattern = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


def document_file(documentId: str) -> Path:
    if not documentIdPattern.match(documentId):
        raise HTTPException(status_code=404, detail="document not found")
    return documentsRoot / f"{documentId}.json"


def read_document(documentId: str) -> DocumentOut:
    file = document_file(documentId)
    try:
        body = DocumentBody.model_validate(json.loads(file.read_text(encoding="utf-8")))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="document not found")
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=500, detail=f"document unreadable: {error}")
    directory = versions.versions_dir(documentsRoot, documentId)
    newest = versions.latest(directory)
    latestData = versions.read(directory, newest) if newest else None
    changed = latestData is None or not versions.same_content(latestData, body.model_dump())
    return DocumentOut(id=documentId, modified=file.stat().st_mtime, version=newest, changedSinceVersion=changed, **body.model_dump())


def write_document(documentId: str, body: DocumentBody) -> DocumentOut:
    """Atomic write (temp file + rename) so a crash never leaves a half-written document."""
    documentsRoot.mkdir(parents=True, exist_ok=True)
    file = document_file(documentId)
    temporary = file.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(body.model_dump(), indent=2), encoding="utf-8")
    os.replace(temporary, file)
    return read_document(documentId)


def new_document_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "document"
    return f"{slug}-{secrets.token_hex(3)}"


@app.get("/api/documents", response_model=list[DocumentSummary])
def list_documents() -> list[DocumentSummary]:
    summaries = []
    for file in documentsRoot.glob("*.json") if documentsRoot.is_dir() else []:
        try:
            body = DocumentBody.model_validate(json.loads(file.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            continue  # skip files that aren't ours / are corrupt rather than failing the whole list
        summaries.append(DocumentSummary(id=file.stem, name=body.name, itemCount=len(body.items), modified=file.stat().st_mtime))
    return sorted(summaries, key=lambda summary: summary.modified, reverse=True)


@app.post("/api/documents", response_model=DocumentOut, status_code=201)
def create_document(body: DocumentBody | None = None) -> DocumentOut:
    body = body or DocumentBody()
    return write_document(new_document_id(body.name), body)


@app.get("/api/documents/{documentId}", response_model=DocumentOut)
def get_document(documentId: str) -> DocumentOut:
    return read_document(documentId)


documentWriteLock = threading.Lock()


@app.put("/api/documents/{documentId}", response_model=DocumentOut)
def update_document(documentId: str, body: DocumentBody, baseModified: float | None = None) -> DocumentOut:
    """Replaces the document. With `baseModified` (the `modified` the client last saw) the write is refused with 409 when the document
    was changed since (another window, an edited file): the response carries the current document so the client can offer to load it."""
    with documentWriteLock:
        if not document_file(documentId).is_file():
            raise HTTPException(status_code=404, detail="document not found")
        if baseModified is not None:
            current = read_document(documentId)
            if abs(current.modified - baseModified) > 1e-3:
                raise HTTPException(status_code=409, detail={"message": "the document was changed elsewhere", "current": current.model_dump()})
        return write_document(documentId, body)


@app.get("/api/documents/{documentId}/versions", response_model=list[VersionSummary])
def list_versions(documentId: str) -> list[dict]:
    read_document(documentId)  # 404 for an unknown document
    return versions.listing(versions.versions_dir(documentsRoot, documentId))


@app.post("/api/documents/{documentId}/versions", response_model=VersionOut)
def save_version(documentId: str) -> dict:
    """Snapshots the working copy as the next version (v1, v2, ...); a no-op when nothing changed since the newest one."""
    with documentWriteLock:
        document = read_document(documentId)
        directory = versions.versions_dir(documentsRoot, documentId)
        if document.version and not document.changedSinceVersion:
            return {**versions.summary(versions.read(directory, document.version)), "created": False}
        return {**versions.summary(versions.save(directory, {"name": document.name, "items": [i.model_dump() for i in document.items]})), "created": True}


@app.get("/api/documents/{documentId}/versions/{number}", response_model=VersionDetail)
def get_version(documentId: str, number: int) -> dict:
    read_document(documentId)
    data = versions.read(versions.versions_dir(documentsRoot, documentId), number)
    if not data:
        raise HTTPException(status_code=404, detail="version not found")
    return {**versions.summary(data), "items": data["items"]}


@app.delete("/api/documents/{documentId}/versions/{number}", status_code=204)
def delete_version(documentId: str, number: int) -> Response:
    """Removes one saved version, the newest too (the previous one, or "no version", is then the base the working copy is compared with; the
    next version takes the freed number)."""
    with documentWriteLock:
        read_document(documentId)
        directory = versions.versions_dir(documentsRoot, documentId)
        if not versions.delete(directory, number):
            raise HTTPException(status_code=404, detail="version not found")
    return Response(status_code=204)


@app.delete("/api/documents/{documentId}/versions", response_model=list[VersionSummary])
def delete_older_versions(documentId: str) -> list[dict]:
    """Removes every saved version except the newest."""
    with documentWriteLock:
        read_document(documentId)
        directory = versions.versions_dir(documentsRoot, documentId)
        newest = versions.latest(directory)
        for number in versions.numbers(directory):
            if number != newest:
                versions.delete(directory, number)
        return versions.listing(directory)


@app.post("/api/documents/{documentId}/versions/{number}/promote", response_model=DocumentOut)
def promote_version(documentId: str, number: int) -> DocumentOut:
    """Makes an older version the working copy again and saves it as a new, latest version (the older versions stay as they are)."""
    with documentWriteLock:
        read_document(documentId)
        directory = versions.versions_dir(documentsRoot, documentId)
        data = versions.read(directory, number)
        if not data:
            raise HTTPException(status_code=404, detail="version not found")
        body = DocumentBody(name=data["name"], items=data["items"])
        write_document(documentId, body)
        versions.save(directory, body.model_dump())
        return read_document(documentId)


documentFileFormat = "rasterfaster-document"


class StoredVersion(BaseModel):
    version: int = Field(ge=1, le=100000)
    savedAt: float
    name: str = Field(min_length=1, max_length=120)
    items: list[DocumentItem] = Field(default_factory=list, max_length=2000)


class DocumentFile(BaseModel):
    """What a document looks like in a saved file: the document itself plus its whole version history."""
    format: Literal["rasterfaster-document"]
    formatVersion: int = Field(ge=1, le=1)
    exportedAt: float | None = None
    appVersion: str | None = None
    id: str = Field(max_length=81)
    name: str = Field(min_length=1, max_length=120)
    items: list[DocumentItem] = Field(default_factory=list, max_length=2000)
    versions: list[StoredVersion] = Field(default_factory=list, max_length=1000)


@app.get("/api/documents/{documentId}/export.rasterfaster")
def export_document_file(documentId: str) -> Response:
    """The document and all its versions as one JSON file (import it again with POST /api/documents/import)."""
    document = read_document(documentId)
    directory = versions.versions_dir(documentsRoot, documentId)
    history = [data for number in versions.numbers(directory) if (data := versions.read(directory, number))]
    payload = DocumentFile(format=documentFileFormat, formatVersion=1, exportedAt=time.time(), id=documentId, name=document.name,
                           items=document.items, versions=history)
    label = (f"-v{document.version}" + ("-edited" if document.changedSinceVersion else "")) if document.version else ""  # e.g. Name-v3 (or Name-v3-edited: the working copy is ahead of v3)
    filename = re.sub(r"[^\w.-]+", "_", document.name) + label + ".rasterfaster.json"
    return Response(payload.model_dump_json(indent=2), media_type="application/json", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/api/documents/import", response_model=DocumentOut, status_code=201)
def import_document(file: DocumentFile, onConflict: Literal["ask", "replace", "copy"] = "ask") -> DocumentOut:
    """Recovers a saved document file. A document with that id that does not exist is restored as it was (same id, all versions).
    If it exists: `onConflict=replace` overwrites it (working copy and versions), `copy` imports it under a new id, and the default answers 409."""
    if not documentIdPattern.match(file.id):
        raise HTTPException(status_code=422, detail="the file has an invalid document id")
    documentId = file.id
    with documentWriteLock:
        exists = document_file(documentId).is_file()
        if exists and onConflict == "ask":
            raise HTTPException(status_code=409, detail={"message": "a document with this id already exists", "existing": read_document(documentId).model_dump(include={"id", "name", "modified", "version"})})
        if exists and onConflict == "copy":
            documentId = new_document_id(file.name)
        stored = [{"version": v.version, "savedAt": v.savedAt, "name": v.name, "items": [i.model_dump() for i in v.items]} for v in sorted(file.versions, key=lambda v: v.version)]
        if len({v["version"] for v in stored}) != len(stored):
            raise HTTPException(status_code=422, detail="the file has duplicate version numbers")
        write_document(documentId, DocumentBody(name=file.name, items=file.items))
        versions.replace_all(versions.versions_dir(documentsRoot, documentId), stored)
        return read_document(documentId)


class Import3mfReportLine(BaseModel):
    name: str
    path: str
    matchedBy: str  # path | name | name-shape | name-ambiguous | shape | none (placeholder) | skipped
    count: int
    note: str = ""


class Import3mfOut(BaseModel):
    document: DocumentOut
    report: list[Import3mfReportLine]


@app.post("/api/documents/import-3mf", response_model=Import3mfOut, status_code=201)
async def import_document_3mf(request: Request, name: str | None = None, plate: int | None = None) -> Import3mfOut:
    """A new document from a 3MF (the raw file as the body): our own export or a Bambu Studio project. The parts are linked to the library's STL
    files (see import3mf.py); what has no file becomes a placeholder part. `plate` imports only that Bambu plate."""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="empty file")
    try:
        result = await run_in_threadpool(lambda: import3mf.import_3mf(data, import3mf.index_library(libraryRoot), plate))
    except import3mf.ThreeMfError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if result.embedded:
        folder = documentsRoot / "_embedded"
        folder.mkdir(parents=True, exist_ok=True)
        for path, stl in result.embedded.items():
            target = folder / path.split(":", 1)[1]
            if not target.exists():
                target.write_bytes(stl)
    title = f"{((name or result.name).strip() or '3MF')[:100]} (imported)"
    document = write_document(new_document_id(title), DocumentBody(name=title, items=[DocumentItem(**item) for item in result.items[:2000]]))
    return Import3mfOut(document=document, report=[Import3mfReportLine(**line) for line in result.report])


@app.get("/api/documents/{documentId}/export.3mf")
def export_document_3mf(documentId: str, bed: float = 256.0) -> Response:
    """3MF of the assembly for Bambu Studio: the parts exactly as assembled, centred on a plate of `bed` mm."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        data = export3mf.build_3mf(document.model_dump(), stlBytes.__getitem__, bed)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", f"{document.name}-assembly") + ".3mf"
    return Response(data, media_type="model/3mf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def exportable(document: DocumentOut) -> DocumentOut:
    """The document without the parts marked "Do not export" (their STL files aren't even looked for)."""
    kept = [item for item in document.items if not item.noExport]
    if document.items and not kept:
        raise HTTPException(status_code=422, detail='every part is set to "Do not export"')
    return document.model_copy(update={"items": kept})


def load_document_stls(document: DocumentOut) -> dict[str, bytes]:
    stlBytes: dict[str, bytes] = {}
    missing = []
    for path in dict.fromkeys(item.path for item in document.items):
        try:
            stlBytes[path] = resolve_part(path).read_bytes()
        except (OSError, HTTPException):
            missing.append(path)
    if missing:
        raise HTTPException(status_code=422, detail=f"STL files not found: {', '.join(missing)}")
    return stlBytes


def parsed_view(view: str | None):
    """The camera of the app's 3D view as passed by the frontend (see blenderexport.parse_view); None gives the isometric Home view."""
    try:
        return blenderexport.parse_view(view) if view else None
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))


@app.get("/api/documents/{documentId}/export.glb")
def export_document_glb(documentId: str, camera: bool = True, colours: bool = False, view: str | None = None) -> Response:
    """glTF for Blender: the parts as placed in the document (Z up, metres) in Black PLA (or the document's colours with `colours=true`), plus, unless `camera` is false, a camera placed like the app's 3D view (`view`, see blenderexport.parse_view; default: the isometric Home view)."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        data = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, camera, colours, parsed_view(view))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".glb"
    return Response(data, media_type="model/gltf-binary", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/documents/{documentId}/export.blend")
def export_document_blend(documentId: str, colours: bool = False, studio: bool = True, view: str | None = None) -> Response:
    """A native .blend (made by running Blender in the background): the glTF export with the camera set up as the scene camera. Needs Blender on this machine (set BLENDER to its path if it is not found)."""
    blender = blenderexport.find_blender()
    if not blender:
        raise HTTPException(status_code=503, detail="Blender was not found on this machine (set the BLENDER environment variable to its path)")
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        glb = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, True, colours, parsed_view(view))
        data = blenderexport.build_blend(glb, blender, studio)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(status_code=500, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".blend"
    return Response(data, media_type="application/x-blender", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/documents/{documentId}/export.svg")
def export_document_svg(documentId: str) -> Response:
    """Top / front / right drawing of the assembly (feature lines, 20 mm grid, numbered legend)."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        svg = svgexport.build_svg(document.model_dump(), stlBytes.__getitem__)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".svg"
    return Response(svg, media_type="image/svg+xml", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.delete("/api/documents/{documentId}", status_code=204)
def delete_document(documentId: str) -> None:
    file = document_file(documentId)
    try:
        file.unlink()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="document not found")
    shutil.rmtree(versions.versions_dir(documentsRoot, documentId), ignore_errors=True)


class RuntimeRestartRequest(BaseModel):
    reason: str | None = None
    delay_ms: int | None = None


class RuntimeRestartResponse(BaseModel):
    ok: bool = True
    service: str = "rasterfaster-api"
    action: str = "runtime_restart_scheduled"
    reason: str
    delay_ms: int
    utc: str


def schedule_runtime_restart(delayMs: int) -> None:
    """os.execv replaces the process image: same PID and terminal/IDE run window, new source from disk."""

    def restart_worker() -> None:
        try:
            time.sleep(delayMs / 1000.0)
            # uvicorn marks its listening socket inheritable; close it across exec so the new image can rebind the port.
            for fileDescriptor in range(3, 256):
                try:
                    os.set_inheritable(fileDescriptor, False)
                except OSError:
                    pass
            # frozen (packaged app): sys.argv[0] is the executable already
            os.execv(sys.executable, sys.argv if appconfig.is_frozen() else [sys.executable] + sys.argv)
        except Exception:
            os._exit(1)

    threading.Thread(target=restart_worker, name="rasterfaster-runtime-restart", daemon=True).start()


@app.post("/api/runtime/restart", response_model=RuntimeRestartResponse)
def runtime_restart(body: RuntimeRestartRequest | None = None) -> RuntimeRestartResponse:
    reason = (body.reason if body else None) or "manual_runtime_restart"
    delayMs = max(100, min(5000, (body.delay_ms if body else None) or 400))
    schedule_runtime_restart(delayMs)
    return RuntimeRestartResponse(reason=reason, delay_ms=delayMs, utc=datetime.now(timezone.utc).isoformat())


class SpaStaticFiles(StaticFiles):
    """The built app, with the single-page fallback: an unknown route (no file extension) gets index.html. Never for /api/."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as error:
            isRoute = error.status_code == 404 and not path.startswith("api/") and "." not in Path(path).name
            if isRoute:
                return await super().get_response("index.html", scope)
            raise


# Files the service worker / browser must always re-check, or a new build would not be noticed.
revalidatedFiles = {"index.html", "ngsw.json", "ngsw-worker.js", "safety-worker.js", "manifest.webmanifest"}


def mount_frontend(application: FastAPI, directory: Path) -> bool:
    """Serves the built frontend at / (mounted last, so the /api routes win). Returns whether there was a build to serve."""
    if not (directory / "index.html").is_file():
        return False

    @application.middleware("http")
    async def revalidate_app_shell(request, call_next):
        response = await call_next(request)
        if request.method == "GET" and not request.url.path.startswith("/api/") and (request.url.path == "/" or request.url.path.rsplit("/", 1)[-1] in revalidatedFiles):
            response.headers["Cache-Control"] = "no-cache"
        return response

    application.mount("/", SpaStaticFiles(directory=directory, html=True), name="frontend")
    return True


mount_frontend(app, frontendDist)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=apiPort, timeout_graceful_shutdown=2)
