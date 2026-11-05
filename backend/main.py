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
import asyncio
import threading
import uuid
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import uvicorn
import appconfig
import blenderexport
import images
import versions
import export3mf
import import3mf
import svgexport
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, Field
from rf_library import LibraryConfig, create_router
import fusionfind

_paths = appconfig.resolve_paths(os.environ, Path(__file__).resolve().parent.parent, Path.home(), appconfig.is_frozen(), appconfig.bundle_dir())
libraryRoot = _paths["libraryRoot"]
apiPort = int(os.environ.get("PORT", "8100"))
frontendDist = _paths["frontendDist"]
documentsRoot = _paths["documentsRoot"]
backupRoot = _paths["backupRoot"]  # originals of renamed library files (rf_library/ops.py)
if appconfig.is_frozen() and not os.environ.get("RF_DOCS"):
    appconfig.seed_documents(documentsRoot, (appconfig.bundle_dir() or Path(".")) / "seed_documents")

app = FastAPI(title="RASTERFASTER API")


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


class DocumentItemRender(BaseModel):
    """What Render mode changes for one part (all optional: a part without them is drawn as in Design mode)."""
    color: int | None = Field(default=None, ge=0, le=0xFFFFFF)  # the render colour; none: the part's design colour
    finish: Literal["satin", "metal", "glass", "mirror", "pei"] | None = None  # none: satin (PLA, as renders always were)
    hidden: bool = False  # left out of Render mode: not in the view, the render or the Blender file


class DocumentItem(BaseModel):
    id: str = Field(max_length=64)
    path: str = Field(max_length=1024)
    name: str = Field(max_length=256)
    color: int
    position: tuple[float, float, float]
    rotation: tuple[float, float, float, float]
    muted: bool = False  # dimmed in the editor and ignored by clicks; still part of BOM and exports
    centered: bool = False  # keep the footprint centre on the middle of a grid cell when moved
    noRender: bool = False  # kept in the Blender scene (to focus or aim a light on) but not drawn there
    noExport: bool = False  # mock part (e.g. a component model): left out of the 3MF and SVG exports
    scale: tuple[float, float, float] | None = None  # scale along the part's own X, Y and Z axes, applied before the rotation (None: 1, 1, 1)
    origin: tuple[float, float, float] | None = None  # origin point set by the user, in the part's own STL coordinates (None: the STL's own 0, 0, 0)
    groupId: str | None = Field(default=None, max_length=64)  # the group of the document this part belongs to (moved, turned and scaled together)
    render: DocumentItemRender | None = None  # Render mode's own colour, finish and visibility of this part


class DocumentGroup(BaseModel):
    id: str = Field(max_length=64)
    name: str = Field(max_length=120)


class DocumentLight(BaseModel):
    """The light source of the \"Shaded with light\" view (also the sun of the Blender export)."""
    direction: tuple[float, float, float]  # from what it shines at towards the light (the frontend keeps it a unit vector)
    target: tuple[float, float, float] | None = None  # the point it shines at (mm); without it and without targetId: the middle of the scene
    targetId: str | None = Field(default=None, max_length=64)  # a part it shines at (it follows the part when that moves); wins over target


class DocumentView(BaseModel):
    """Where the camera of the 3D view was left: the document opens like that again."""
    projection: Literal["ortho", "persp"]
    position: tuple[float, float, float]
    target: tuple[float, float, float]
    zoom: float = Field(gt=0, le=1000)
    radius: float = Field(gt=0, le=1e7)  # the size the frontend gives the scene (it decides the clipping range)


class DocumentSavedView(DocumentView):
    """A view the user saved by name: the camera plus how the scene was shown (all optional: older ones lack them)."""
    id: str = Field(max_length=64)
    name: str = Field(min_length=1, max_length=80)
    mode: str | None = Field(default=None, max_length=32)  # display mode: solid, wireframe ...
    appMode: Literal["design", "render"] | None = None  # Design or Render mode
    light: DocumentLight | None = None
    ground: Literal["none", "grid", "solid"] | None = None
    groundColor: int | None = Field(default=None, ge=0, le=0xFFFFFF)
    grid3d: bool | None = None
    zGrid: str | None = Field(default=None, max_length=32)


class DocumentRenderSettings(BaseModel):
    """What the Render dialog remembers for a document."""
    depthOfField: bool = False  # the Blender scene gets a depth of field
    focusId: str | None = Field(default=None, max_length=64)  # the part it is focused on; none: the part nearest to the camera in the picture
    crop: bool = False  # the picture is as wide as the parts (the height stays)
    background: int | None = Field(default=None, ge=0, le=0xFFFFFF)  # colour of the background in the Blender scene; none: the studio's dark gradient
    ground: int | None = Field(default=None, ge=0, le=0xFFFFFF)  # colour of the ground disc; none: the studio's dark floor
    beam: int = Field(default=1, ge=0, le=4)  # the lamp type: 0 spot ... 4 flood (how soft its shadows are); 1 is the normal one
    lamp: int = Field(default=40, ge=0, le=60)  # strength of the lamp pointed at the part: 40 normal, 10 steps double or halve it
    ambient: int = Field(default=0, ge=0, le=5)  # ambient light preset: 0 none, 1 Soft glow ... 5 Bright studio
    dofStrength: int = Field(default=3, ge=1, le=5)  # 1 subtle ... 5 extreme; 3: what is farthest is unsharp but still recognizable
    aspect: Literal["16:9", "1:1", "4:5", "9:16"] = "16:9"  # the shape of the picture (its width comes from the size, the height follows)
    trackId: str | None = Field(default=None, max_length=64)  # a part the camera follows in a turntable (Camera circles)
    trackPivot: Literal["part", "all", "view"] = "all"  # what Camera circles goes round: the middle of all the objects, the middle of the view, or the tracked part
    lookAt: Literal["part", "all", "view"] | None = None  # what it looks at: the tracked part, the middle of all the objects, or where the view points (none: the part when one is tracked, else the view)
    fx: Literal["none", "cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink"] = "none"  # a style for the picture: none, cartoon, outline, sketch, clay or blueprint
    cut: str = Field(default="z:50:0", pattern=r"^[xyz]:\d{1,3}:[01]$")  # the cut-away section: the axis, how far along the parts (percent) and which side goes (0 or 1)
    reflections: int = Field(default=0, ge=0, le=4)  # what metal, mirror and glass reflect: 0 the dark studio, 1 softbox, 2 daylight, 3 neutral grey
    transparent: bool = False  # no background in the picture (the ground stays invisible, its shadows show)


class DocumentCameraModes(BaseModel):
    """The camera mode (orthographic, perspective or perspective with orthographic faces) of Design mode and of Render mode, each on its own."""
    design: Literal["orthographic", "perspective", "perspective-ortho-faces"] | None = None
    render: Literal["orthographic", "perspective", "perspective-ortho-faces"] | None = None


class DocumentBody(BaseModel):
    name: str = Field(default="Untitled", min_length=1, max_length=120)
    items: list[DocumentItem] = Field(default_factory=list, max_length=2000)
    groups: list[DocumentGroup] = Field(default_factory=list, max_length=500)
    views: list[DocumentSavedView] = Field(default_factory=list, max_length=200)  # views saved by name
    light: DocumentLight | None = None  # none: the default light
    view: DocumentView | None = None  # the camera of the 3D view; none: the document is fitted into the view
    render: DocumentRenderSettings | None = None  # the settings of the Render dialog; none: the defaults
    cameraModes: DocumentCameraModes | None = None  # the camera mode of Design mode and of Render mode; none: the browser's last choice


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
    groups: list[DocumentGroup] = Field(default_factory=list)
    views: list[DocumentSavedView] = Field(default_factory=list)


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
    temporary.write_text(json.dumps(body.model_dump(exclude_none=True), indent=2), encoding="utf-8")
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
app.include_router(fusionfind.create_router())  # find a part in the Fusion 360 files (scripts/f3dsearch.py)
app.include_router(create_router(LibraryConfig(
    library_root=lambda: libraryRoot, backup_root=lambda: backupRoot, documents_root=lambda: documentsRoot, write_lock=documentWriteLock,
    resolve_part=lambda path: resolve_part(path), is_embedded=lambda path: bool(embeddedPattern.match(path)))))  # the library API (rf_library): paths are read at every request


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
    return {**versions.summary(data), "items": data["items"], "groups": data.get("groups", []), "views": data.get("views", [])}


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
        body = DocumentBody(name=data["name"], items=data["items"], groups=data.get("groups", []), views=data.get("views", []))
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
    groups: list[DocumentGroup] = Field(default_factory=list, max_length=500)
    views: list[DocumentSavedView] = Field(default_factory=list, max_length=200)
    light: DocumentLight | None = None
    view: DocumentView | None = None
    render: DocumentRenderSettings | None = None
    cameraModes: DocumentCameraModes | None = None
    versions: list[StoredVersion] = Field(default_factory=list, max_length=1000)


@app.get("/api/documents/{documentId}/export.rasterfaster")
def export_document_file(documentId: str) -> Response:
    """The document and all its versions as one JSON file (import it again with POST /api/documents/import)."""
    document = read_document(documentId)
    directory = versions.versions_dir(documentsRoot, documentId)
    history = [data for number in versions.numbers(directory) if (data := versions.read(directory, number))]
    payload = DocumentFile(format=documentFileFormat, formatVersion=1, exportedAt=time.time(), id=documentId, name=document.name,
                           items=document.items, groups=document.groups, views=document.views, light=document.light, view=document.view, render=document.render, cameraModes=document.cameraModes, versions=history)
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
        write_document(documentId, DocumentBody(name=file.name, items=file.items, groups=file.groups, views=file.views, light=file.light, view=file.view, render=file.render, cameraModes=file.cameraModes))
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


def render_view(document: DocumentOut) -> DocumentOut:
    """The document as a render and the Blender file see it: parts hidden in Render mode left out, render colours in place of design colours
    (the finishes ride along in each part's `render`). The 3MF, SVG and BOM never use this: they keep the design colours."""
    items = [item for item in document.items if not (item.render and item.render.hidden)]
    if document.items and not items:
        raise HTTPException(status_code=422, detail="every part is hidden in Render mode")
    return document.model_copy(update={"items": [item.model_copy(update={"color": item.render.color}) if item.render and item.render.color is not None else item for item in items]})


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
def export_document_glb(documentId: str, camera: bool = True, colours: bool = True, view: str | None = None) -> Response:
    """glTF for Blender: the parts as placed in the document (Z up, metres) in the document's colours (or all in Black PLA with `colours=false`), plus, unless `camera` is false, a camera placed like the app's 3D view (`view`, see blenderexport.parse_view; default: the isometric Home view)."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        data = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, camera, colours, parsed_view(view))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".glb"
    return Response(data, media_type="model/gltf-binary", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def resolve_render_settings(document: DocumentOut, dof: bool | None = None, focus: str | None = None, strength: int | None = None, crop: bool | None = None, ambient: int | None = None,
                            lamp: int | None = None, background: int | None = None, ground: int | None = None, beam: int | None = None,
                            aspect: str | None = None, transparent: bool | None = None, track: str | None = None, track_pivot: str | None = None, look_at: str | None = None, reflections: int | None = None, fx: str | None = None, cut: str | None = None) -> dict:
    """The render settings of a call: what it brings, else what the document remembers, else the defaults."""
    render = document.render
    focusId = focus if focus is not None else (render.focusId if render else None)
    if focusId is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", focusId):
        raise HTTPException(status_code=422, detail="focus must be the id of a part")
    return {
        "depthOfField": dof if dof is not None else bool(render and render.depthOfField),
        "focusId": focusId,
        "dofStrength": strength if strength is not None else (render.dofStrength if render else 3),
        "crop": crop if crop is not None else bool(render and render.crop),
        "lamp": lamp if lamp is not None else (render.lamp if render else 40),
        "background": background if background is not None else (render.background if render else None),
        "ground": ground if ground is not None else (render.ground if render else None),
        "beam": beam if beam is not None else (render.beam if render else 1),
        "ambient": ambient if ambient is not None else (render.ambient if render else 0),
        "aspect": aspect if aspect is not None else (render.aspect if render else "16:9"),
        "transparent": transparent if transparent is not None else bool(render and render.transparent),
        "reflections": reflections if reflections is not None else (render.reflections if render else 0),
        "fx": fx if fx is not None else (render.fx if render else "none"),
        "cut": cut if cut is not None else (render.cut if render else "z:50:0"),
        "trackId": track if track is not None else (render.trackId if render else None),
        "trackPivot": track_pivot if track_pivot is not None else (render.trackPivot if render else "all"),
        "lookAt": look_at if look_at is not None else ((render.lookAt if render and render.lookAt else None) or ("part" if (track if track is not None else (render.trackId if render else None)) else "view")),
    }


def parse_saved_view(text: str | None) -> dict | None:
    """The view a picture was made from as the frontend captured it (camera, display, light, ground), checked like a saved view; None when it is not one."""
    if not text:
        return None
    try:
        saved = DocumentSavedView.model_validate({"id": "image", "name": "Image", **json.loads(text)})
    except (ValueError, TypeError):
        return None
    return saved.model_dump(exclude={"id", "name"}, exclude_none=True)


def render_note(document: DocumentOut, view: str | None, settings: dict, light: str | None = None, saved_view: dict | None = None) -> dict:
    """What is kept with a picture in the image library: the render settings in words a person can read back, with the focus part's name."""
    focus = ("centre of the objects" if settings["focusId"] == "_centre" else next((item.name for item in document.items if item.id == settings["focusId"]), None)) if settings["depthOfField"] else None
    try:
        projection = blenderexport.parse_view(view)["projection"] if view else "persp"
    except (ValueError, KeyError, TypeError):
        projection = None
    # the camera and light of the call ride along, so the picture can be rendered again at another size
    tracked = next((item.name for item in document.items if item.id == settings.get("trackId")), None)
    return {**settings, "focus": focus, "track": tracked, "projection": projection, "view": view, "light": light, **({"savedView": saved_view} if saved_view else {})}


def blender_scene(documentId: str, colours: bool, view: str | None, light: str | None, dof: bool | None = None, focus: str | None = None, strength: int | None = None, crop: bool | None = None, ambient: int | None = None, lamp: int | None = None, background: int | None = None, ground: int | None = None, beam: int | None = None, aspect: str | None = None, transparent: bool | None = None, reflections: int | None = None, fx: str | None = None, cut: str | None = None):
    """What both Blender endpoints build from: the glTF of the document and the key light (the call's own, else the light saved in the document)."""
    blender = blenderexport.find_blender()
    if not blender:
        raise HTTPException(status_code=503, detail="Blender was not found on this machine (set the BLENDER environment variable to its path)")
    document = render_view(exportable(read_document(documentId)))  # a render shows Render mode: render colours, finishes, hidden parts left out
    stlBytes = load_document_stls(document)
    try:
        glb = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, True, colours, parsed_view(view))
        saved = document.light  # the light placed in the document is the key light unless the call brings its own
        sun = blenderexport.parse_light(light) if light else (blenderexport.parse_light(
            ",".join(str(v) for v in saved.direction) + ";" + (f"part:{saved.targetId}" if saved.targetId else ",".join(str(v) for v in saved.target) if saved.target else "")) if saved else None)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    settings = resolve_render_settings(document, dof, focus, strength, crop, ambient, lamp, background, ground, beam, aspect, transparent, reflections=reflections, fx=fx, cut=cut)
    on, focusId, level, cropped = settings["depthOfField"], settings["focusId"], settings["dofStrength"], settings["crop"]
    lamp_level, beam_level, light_level = settings["lamp"], settings["beam"], settings["ambient"]
    bg_text = f"{settings['background']:06x}" if settings["background"] is not None else ""
    floor_text = f"{settings['ground']:06x}" if settings["ground"] is not None else ""
    return document, blender, glb, sun, ("0" if not on else f"1|{level}|{focusId or ''}") + f"#{light_level},{lamp_level},{bg_text},{floor_text},{beam_level},{settings['aspect']},{1 if settings['transparent'] else 0},{settings['reflections']},{settings['fx']},{settings['cut']},{focusId or ''}", cropped  # the ambient preset rides along after the "#"


@app.get("/api/documents/{documentId}/export.blend")
def export_document_blend(documentId: str, colours: bool = True, studio: bool = True, view: str | None = None, light: str | None = None, dof: bool | None = None, focus: str | None = None, strength: int | None = Query(default=None, ge=1, le=5), ambient: int | None = Query(default=None, ge=0, le=5), lamp: int | None = Query(default=None, ge=0, le=60), bg: int | None = Query(default=None, ge=0, le=0xFFFFFF), floor: int | None = Query(default=None, ge=0, le=0xFFFFFF), beam: int | None = Query(default=None, ge=0, le=4), aspect: Literal["16:9", "1:1", "4:5", "9:16"] | None = None, transparent: bool | None = None, reflections: int | None = Query(default=None, ge=0, le=4), fx: Literal["none", "cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink"] | None = None, cut: str | None = Query(default=None, pattern=r"^[xyz]:\d{1,3}:[01]$")) -> Response:
    """A native .blend (made by running Blender in the background): the glTF export with the camera set up as the scene camera. Needs Blender on this machine (set BLENDER to its path if it is not found)."""
    document, blender, glb, sun, depthOfField, _ = blender_scene(documentId, colours, view, light, dof, focus, strength, None, ambient, lamp, bg, floor, beam, aspect, transparent, reflections=reflections, fx=fx, cut=cut)
    try:
        data = blenderexport.build_blend(glb, blender, studio, sun, depthOfField)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(status_code=500, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".blend"
    return Response(data, media_type="application/x-blender", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


quickRuns: dict[str, object] = {}  # token -> the Blender process of a quick render (or True: cancelled before it started)
quickRunsLock = threading.Lock()


def quick_started(token: str | None):
    """The `started` hook of a quick render: remembers its Blender process under the client's token so it can be cancelled."""
    if not token:
        return None

    def started(process) -> None:
        with quickRunsLock:
            if quickRuns.pop(token, None) is True:
                process.kill()  # cancelled while the .blend was still being made
            else:
                quickRuns[token] = process
    return started


@app.post("/api/quick-render/cancel")
def cancel_quick_render(token: str = Query(max_length=64, pattern=r"^[A-Za-z0-9_-]+$")) -> dict:
    """Stops a quick picture or video that is rendering (the dialog's Cancel)."""
    with quickRunsLock:
        process = quickRuns.pop(token, None)
        if process is None:
            quickRuns[token] = True  # not started yet: it stops as soon as it does
            if len(quickRuns) > 50:
                quickRuns.pop(next(iter(quickRuns)))
            return {"cancelled": False}
    process.kill()
    return {"cancelled": True}



@app.get("/api/documents/{documentId}/render.png")
def render_document_png(documentId: str, token: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$"), colours: bool = True, view: str | None = None, light: str | None = None, dof: bool | None = None, focus: str | None = None, strength: int | None = Query(default=None, ge=1, le=5), crop: bool | None = None, ambient: int | None = Query(default=None, ge=0, le=5), lamp: int | None = Query(default=None, ge=0, le=60), bg: int | None = Query(default=None, ge=0, le=0xFFFFFF), floor: int | None = Query(default=None, ge=0, le=0xFFFFFF), beam: int | None = Query(default=None, ge=0, le=4), aspect: Literal["16:9", "1:1", "4:5", "9:16"] | None = None, transparent: bool | None = None,
                        width: int = Query(default=800, ge=160, le=1920), samples: int = Query(default=24, ge=1, le=128), reflections: int | None = Query(default=None, ge=0, le=4), fx: Literal["none", "cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink"] | None = None, cut: str | None = Query(default=None, pattern=r"^[xyz]:\d{1,3}:[01]$")) -> Response:
    """A quick picture of the scene as Blender renders it (Cycles, the studio setup, the app's camera and light): see the light and the colours without opening Blender."""
    document, blender, glb, sun, depthOfField, cropped = blender_scene(documentId, colours, view, light, dof, focus, strength, crop, ambient, lamp, bg, floor, beam, aspect, transparent, reflections=reflections, fx=fx, cut=cut)
    try:
        data = blenderexport.build_render(glb, blender, True, sun, width, samples, dof=depthOfField, crop=cropped, **({"started": quick_started(token)} if token else {}))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(status_code=500, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".png"
    note = render_note(document, view, resolve_render_settings(document, dof, focus, strength, crop, ambient, lamp, bg, floor, beam, aspect, transparent, reflections=reflections, fx=fx, cut=cut), light)
    return Response(data, media_type="image/png", headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store", "X-Render-Settings": json.dumps(note)})


@app.get("/api/documents/{documentId}/render.mp4")
def render_document_mp4(documentId: str, token: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$"), colours: bool = True, view: str | None = None, light: str | None = None, dof: bool | None = None, focus: str | None = None, strength: int | None = Query(default=None, ge=1, le=5), crop: bool | None = None, ambient: int | None = Query(default=None, ge=0, le=5), lamp: int | None = Query(default=None, ge=0, le=60), bg: int | None = Query(default=None, ge=0, le=0xFFFFFF), floor: int | None = Query(default=None, ge=0, le=0xFFFFFF), beam: int | None = Query(default=None, ge=0, le=4), aspect: Literal["16:9", "1:1", "4:5", "9:16"] | None = None, transparent: bool | None = None,
                        width: int = Query(default=640, ge=160, le=960), samples: int = Query(default=8, ge=1, le=48),
                        motion: Literal["orbit", "spin"] = "orbit", seconds: int = Query(default=3, ge=1, le=5), fps: int = Query(default=24, ge=12, le=30), track: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$"), trackPivot: Literal["part", "all", "view"] | None = None, lookAt: Literal["part", "all", "view"] | None = None, reflections: int | None = Query(default=None, ge=0, le=4), fx: Literal["none", "cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink"] | None = None, cut: str | None = Query(default=None, pattern=r"^[xyz]:\d{1,3}:[01]$"), direction: Literal["ccw", "cw"] = "ccw") -> Response:
    """A quick turntable video (one turn in a few seconds, small and with few samples: it takes up to a minute): see the motion without queueing a real render."""
    document, blender, glb, sun, depthOfField, _ = blender_scene(documentId, colours, view, light, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, reflections=reflections, fx=fx, cut=cut)
    try:
        tracked = resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["trackId"] or ""
        data = blenderexport.build_render(glb, blender, True, sun, width, samples, dof=depthOfField, turntable=(seconds * fps, motion, fps), timeout=900, **({"started": quick_started(token)} if token else {}), track=tracked, track_pivot=resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["trackPivot"], look_at=resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["lookAt"], direction=direction)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HTTPException(status_code=500, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + "-quick.mp4"
    note = {**render_note(document, view, resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut), light), "turntable": {"motion": motion, "seconds": seconds, "fps": fps, "direction": direction}}
    return Response(data, media_type="video/mp4", headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store", "X-Render-Settings": json.dumps(note)})


# What the steps of a full-size render took the last time (seconds; the render step per megapixel and sample, the last step per megapixel),
# to estimate the steps that have not started. The first guesses are for a typical machine.
phaseHistory = {"prepare": 12.0, "load": 4.0, "render": 0.45, "finish": 1.5}
renderPhases = ["prepare", "load", "render", "finish"]  # making the scene, opening it again, the samples, denoising and saving


def aspect_ratio(text: str) -> float:
    """"16:9" as a number."""
    width, height = text.split(":")
    return int(width) / int(height)


class RenderJob:
    """A full-size render running in the background: Blender runs in a thread, its progress is read from its output."""

    def __init__(self, name: str, width: int, samples: int, documentId: str = "", version: int = 0, edited: bool = True, settings: dict | None = None, aspect: float = 16 / 9, turntable: tuple[int, str, int] | None = None):
        self.id = uuid.uuid4().hex[:12]
        self.name, self.width, self.samples = name, width, samples
        self.settings = settings or {}  # the render settings, kept with the picture
        self.documentId, self.version, self.edited = documentId, version, edited  # what it is made from: kept with the picture in the image library
        self.imageId: str | None = None  # the picture's id in the library once it is done
        self.state = "queued"  # queued | running | done | error | cancelled
        self.progress = 0.0
        self.created = time.time()
        self.started = self.created  # when it began to run (it waits in the queue before that)
        self.finished: float | None = None
        self.png: bytes | None = None
        self.preview: bytes | None = None  # a small preliminary picture (a short quick video for a turntable), made just before a full-size render starts (the gallery shows it while the render runs)
        self.previewMedia = "png"  # "png" or "mp4"
        self.previewStarted = False  # a waiting render gets its preview at once (see make_preview), so the gallery has something to show while it waits
        self.previewDone = threading.Event()
        self.error = ""
        self.process: object | None = None
        self.marks: dict[str, list[float | None]] = {}  # per step: when it began and ended (seconds since the job began)
        self.step: str | None = None
        self.track = ""  # the item id of the part a turntable follows
        self.track_pivot = "all"
        self.look_at = "view"
        self.direction = "ccw"  # the way a turntable goes round (seen from above)
        self.turntable = turntable  # (frames, "orbit" | "spin", fps) for a turntable video, else None
        self.aspect = aspect
        self.dimensions = (width, round(width / aspect))  # of one picture or video frame
        self.megapixels = width * width / aspect / 1e6 * (turntable[0] if turntable else 1)  # all the frames of a turntable: the time estimate scales with them

    def begin(self) -> None:
        """The job leaves the queue: the clock starts and the first step begins."""
        self.state = "running"
        self.started = time.time()
        self.enter("prepare")

    def enter(self, name: str) -> None:
        """The next step of the render begins (the one before it ends)."""
        now = time.time() - self.started
        if self.step and self.marks[self.step][1] is None:
            self.marks[self.step][1] = now
        self.step = name
        self.marks.setdefault(name, [now, None])

    def close(self) -> None:
        """The job is over: the last step ends, and what the steps took becomes the estimate for the next job."""
        now = time.time() - self.started
        if self.step and self.marks[self.step][1] is None:
            self.marks[self.step][1] = now
        if self.state == "done":
            took = {name: (mark[1] - mark[0]) for name, mark in self.marks.items() if mark[1] is not None and mark[0] is not None}
            if "prepare" in took: phaseHistory["prepare"] = took["prepare"]
            if "load" in took: phaseHistory["load"] = took["load"]
            if "render" in took: phaseHistory["render"] = took["render"] / max(self.megapixels * self.samples, 1e-6)
            if "finish" in took: phaseHistory["finish"] = took["finish"] / max(self.megapixels, 1e-6)

    def estimate(self, name: str) -> float:
        """How long a step is expected to take, in seconds."""
        if name == "render":
            return phaseHistory["render"] * self.megapixels * self.samples
        if name == "finish":
            return phaseHistory["finish"] * self.megapixels
        return phaseHistory[name]

    def phases(self) -> list[dict]:
        return [{"name": name, "start": (self.marks.get(name) or [None, None])[0], "end": (self.marks.get(name) or [None, None])[1], "estimate": round(self.estimate(name), 1)} for name in renderPhases]

    def frame_info(self) -> dict:
        """For a turntable video: the frame it is on, how long a frame takes (measured since the first frame began) and how long is left (null until a frame is in)."""
        if not self.turntable:
            return {}
        frames = self.turntable[0]
        begun = (self.marks.get("render") or [None])[0]
        done = self.progress * frames  # frames finished, with the part of the one that runs
        into = self.progress * frames - int(self.progress * frames)  # how far the frame that runs is (its samples)
        info: dict = {"frame": min(frames, int(self.progress * frames) + 1) if self.state == "running" else frames, "sample": round(into * self.samples) if self.state == "running" else 0, "frameSeconds": None, "etaSeconds": None}
        if self.state == "running" and begun is not None and done >= 0.2:
            taken = max(time.time() - self.started - begun, 0.0)
            info["frameSeconds"] = round(taken / done, 1)
            info["etaSeconds"] = round(taken / done * (frames - done) + phaseHistory["finish"] * self.megapixels, 0)
        return info

    def size(self) -> list[int] | None:
        """Width and height of the finished picture (read from the PNG header)."""
        if self.turntable:
            return [self.dimensions[0] - self.dimensions[0] % 2, self.dimensions[1] - self.dimensions[1] % 2] if self.png else None
        if self.png and len(self.png) >= 24 and self.png[:8] == b"\x89PNG\r\n\x1a\n":
            return [int.from_bytes(self.png[16:20], "big"), int.from_bytes(self.png[20:24], "big")]
        return None

    def view(self) -> dict:
        return {"size": self.size(), "phases": self.phases(), "phase": self.step, "id": self.id, "name": self.name, "state": self.state, "progress": round(self.progress, 4), "width": self.width, "samples": self.samples,
                "elapsed": round((self.finished or time.time()) - self.started, 1), "error": self.error,
                "documentId": self.documentId, "imageId": self.imageId, "version": self.version, "preview": self.preview is not None, "previewMedia": self.previewMedia, "aspect": round(self.aspect, 4), **self.frame_info(),
                "kind": "turntable" if self.turntable else "picture", "frames": self.turntable[0] if self.turntable else 1, "motion": self.turntable[1] if self.turntable else None,
                "queue": [{"id": q.id, "name": q.name, "kind": "turntable" if q.turntable else "picture", "width": q.width, "samples": q.samples, "frames": q.turntable[0] if q.turntable else 1,
                           "motion": q.turntable[1] if q.turntable else None, "size": f"{q.width} x {round(q.width / q.aspect)}", "documentId": q.documentId, "aspect": round(q.aspect, 4), "preview": q.preview is not None, "previewMedia": q.previewMedia} for q, _ in renderQueue],
                "waiting": len(renderQueue), "position": next((i + 1 for i, (queued, _) in enumerate(renderQueue) if queued is self), 0), "queueMax": renderQueueMax}


renderJobs: dict[str, RenderJob] = {}
# Full-size renders run one at a time (Cycles uses the whole machine); the others wait here, first in first out, with the scene already built for them.
renderQueue: list[tuple[RenderJob, tuple]] = []
renderQueueMax = max(1, int(os.environ.get("RASTERFASTER_RENDER_QUEUE_MAX", "10") or 10))  # the running job and the waiting ones together
renderLock = threading.Lock()
finishedKept = 3  # finished pictures kept in memory (they are in the image library too)


class Notifier:
    """The open WebSockets (/api/ws): what happens on the server that a page should hear about at once, e.g. a render that is ready."""

    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def broadcast(self, message: dict) -> None:
        for connection in list(self.connections):
            try:
                await connection.send_json(message)
            except Exception:  # noqa: BLE001 - a page that went away
                self.connections.discard(connection)

    def notify(self, message: dict) -> None:
        """Callable from any thread (the render runs in one)."""
        if self.loop and self.connections:
            asyncio.run_coroutine_threadsafe(self.broadcast(message), self.loop)


notifier = Notifier()


def running_render() -> RenderJob | None:
    return next((j for j in renderJobs.values() if j.state == "running"), None)


def latest_render() -> RenderJob | None:
    """What a page that connects should see: the running render, else the newest finished one, else the one that waits first."""
    running = running_render()
    if running:
        return running
    finished = [j for j in renderJobs.values() if j.state in ("done", "error", "cancelled")]
    if finished:
        return max(finished, key=lambda j: j.finished or j.created)
    return renderQueue[0][0] if renderQueue else None


def prune_finished() -> None:
    """Keeps the newest few finished renders; older ones nobody collected are dropped."""
    finished = sorted((j for j in renderJobs.values() if j.state in ("done", "error", "cancelled")), key=lambda j: j.finished or j.created, reverse=True)
    for job in finished[finishedKept:]:
        renderJobs.pop(job.id, None)


def start_next_render() -> None:
    """Starts the first waiting render when none runs (called when a render is queued and when one ends)."""
    with renderLock:
        if running_render() or not renderQueue:
            return
        job, args = renderQueue.pop(0)
        job.begin()
        threading.Thread(target=run_render_job, args=(job, *args), daemon=True).start()
    notifier.notify({"type": "render", **job.view()})


@app.websocket("/api/ws")
async def events(websocket: WebSocket) -> None:
    """Messages for the page: `{type: "render", ...job}` whenever the render changes (and once on connecting, so a page that was closed meanwhile still learns it is ready)."""
    await websocket.accept()
    notifier.loop = asyncio.get_running_loop()
    notifier.connections.add(websocket)
    try:
        job = latest_render()
        await websocket.send_json({"type": "render", **(job.view() if job else {"state": "idle"})})
        while True:
            await websocket.receive_text()  # the page sends nothing; this just notices when it goes away
    except WebSocketDisconnect:
        pass
    finally:
        notifier.connections.discard(websocket)


previewLock = threading.Lock()  # one preview at a time: a long queue does not start a Blender for every waiting render


def make_preview(job: RenderJob, blender: str, glb: bytes, sun: dict | None, dof: str, crop: bool) -> None:
    """A small preliminary picture (for a turntable: a quick draft video of one turn): the gallery shows it, with a spinner, while the real render waits or runs.
    It is made when a render is queued; the render that gets to run first waits for it if it is still being made."""
    if not job.documentId:
        return
    with renderLock:
        mine = not job.previewStarted
        job.previewStarted = True
    if not mine:
        job.previewDone.wait(timeout=900)
        return
    try:
        if job.state in ("cancelled", "error", "done"):
            return
        with previewLock:
            if job.state in ("cancelled", "error", "done"):
                return
            if job.turntable:
                frames, motion, fps = job.turntable
                seconds = max(1, min(round(frames / fps), 5))
                job.preview = blenderexport.build_render(glb, blender, True, sun, 320, 2, None, None, timeout=900, dof=dof, crop=crop, turntable=(seconds * 12, motion, 12),
                                                         track=job.track, track_pivot=job.track_pivot, look_at=job.look_at, direction=job.direction)
                job.previewMedia = "mp4"
            else:
                job.preview = blenderexport.build_render(glb, blender, True, sun, 320, 4, None, None, timeout=300, dof=dof, crop=crop)  # the quick draft render of the dialog
        shown = latest_render() if job.state == "queued" else job  # a waiting render's draft is told in the queue of the one that runs
        if shown:
            notifier.notify({"type": "render", **shown.view()})
    except Exception:  # noqa: BLE001 - the preview is a bonus: the render goes on without it
        job.preview = None
    finally:
        job.previewDone.set()


def run_render_job(job: RenderJob, blender: str, glb: bytes, sun: dict | None, dof: str = "0", crop: bool = False) -> None:
    def started(process: object) -> None:
        job.process = process
        if job.state == "cancelled":  # cancelled before Blender had started
            process.kill()  # type: ignore[attr-defined]

    last = [-1.0, 0, 0.0]  # the last progress, the last frame and the time of the last message

    def progress(value: float) -> None:
        job.progress = value
        frame = int(value * job.turntable[0]) + 1 if job.turntable else 0
        now = time.time()
        # a message per percent is plenty for a picture; a video says it at every new frame (and every 2 seconds), so a long render is seen to be alive
        if (value - last[0] >= 0.01) if not job.turntable else (value > last[0] and (frame != last[1] or now - last[2] >= 2.0)):
            last[0], last[1], last[2] = value, frame, now
            notifier.notify({"type": "render", **job.view()})

    def phase(name: str) -> None:
        job.enter(name)
        notifier.notify({"type": "render", **job.view()})

    try:
        make_preview(job, blender, glb, sun, dof, crop)  # (a render that waited has had it made already)
        job.png = blenderexport.build_render(glb, blender, True, sun, job.width, job.samples, progress, started, timeout=4 * 3600 if job.turntable else 1800, dof=dof, crop=crop, phase=phase,
                                             turntable=job.turntable, track=job.track, track_pivot=job.track_pivot, look_at=job.look_at, direction=job.direction)  # (job.png holds the MP4 of a turntable)
        job.state, job.progress = ("done", 1.0) if job.state == "running" else (job.state, job.progress)
        if job.state == "done" and job.documentId:
            try:  # a finished full-size render goes into the document's image library
                directory = images.images_dir(documentsRoot, job.documentId)
                if job.turntable:
                    width, height = job.size() or job.dimensions
                    job.imageId = images.add_video(directory, job.png, name=job.name, width=width, height=height, samples=job.samples, elapsed=time.time() - job.started,
                                                   version=job.version, edited=job.edited, settings=job.settings)["id"]
                else:
                    job.imageId = images.add(directory, job.png, name=job.name, kind="hd", samples=job.samples,
                                             elapsed=time.time() - job.started, version=job.version, edited=job.edited, settings=job.settings)["id"]
            except (OSError, ValueError) as error:
                print(f"image library: could not keep the render: {error}", file=sys.stderr)  # the library is a bonus: the render itself is still delivered
    except Exception as error:  # noqa: BLE001 - whatever went wrong is reported to the page
        if job.state == "running":
            job.state, job.error = "error", str(error)
    finally:
        job.finished = time.time()
        job.close()
        notifier.notify({"type": "render", **job.view()})
        start_next_render()  # the next waiting render begins


@app.post("/api/documents/{documentId}/render-jobs", status_code=202)
def start_render_job(documentId: str, colours: bool = True, view: str | None = None, light: str | None = None, dof: bool | None = None, focus: str | None = None, strength: int | None = Query(default=None, ge=1, le=5), crop: bool | None = None, ambient: int | None = Query(default=None, ge=0, le=5), lamp: int | None = Query(default=None, ge=0, le=60), bg: int | None = Query(default=None, ge=0, le=0xFFFFFF), floor: int | None = Query(default=None, ge=0, le=0xFFFFFF), beam: int | None = Query(default=None, ge=0, le=4), aspect: Literal["16:9", "1:1", "4:5", "9:16"] | None = None, transparent: bool | None = None,
                     width: int = Query(default=1920, ge=160, le=7680), samples: int = Query(default=96, ge=1, le=1024), savedView: str | None = Query(default=None, max_length=4000),
                     turntable: Literal["orbit", "spin"] | None = None, seconds: int = Query(default=5, ge=1, le=30), fps: int = Query(default=30), track: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$"), trackPivot: Literal["part", "all", "view"] | None = None, lookAt: Literal["part", "all", "view"] | None = None, reflections: int | None = Query(default=None, ge=0, le=4), fx: Literal["none", "cartoon", "outline", "sketch", "clay", "blueprint", "isometric", "xray", "lowpoly", "wireframe", "thermal", "cutaway", "clayrough", "clayroughcolour", "hiddenlines", "fog", "lowfog", "watercolour", "watercolourintense", "watercolourink"] | None = None, cut: str | None = Query(default=None, pattern=r"^[xyz]:\d{1,3}:[01]$"), direction: Literal["ccw", "cw"] = "ccw") -> dict:
    """A full-size render (default 1920 px wide, 96 samples; takes minutes): returns a job to follow with GET /api/render-jobs/{id}. One render runs at a time; the others
    wait in a queue (at most `RASTERFASTER_RENDER_QUEUE_MAX`, default 10, together with the running one)."""
    document, blender, glb, sun, depthOfField, cropped = blender_scene(documentId, colours, view, light, dof, focus, strength, False if turntable else crop, ambient, lamp, bg, floor, beam, aspect, False if turntable else transparent, reflections=reflections, fx=fx, cut=cut)
    if turntable and fps not in (24, 30):
        raise HTTPException(status_code=422, detail="fps must be 24 or 30")
    if turntable and width > 3840:
        raise HTTPException(status_code=422, detail="a turntable video is at most 3840 px wide (4K)")
    with renderLock:
        if (1 if running_render() else 0) + len(renderQueue) >= renderQueueMax:
            raise HTTPException(status_code=409, detail=f"the render queue is full ({renderQueueMax} renders): wait for one to finish or cancel one")
        prune_finished()
        job = RenderJob(document.name, width, samples, documentId, document.version, document.changedSinceVersion,
                        {**render_note(document, view, resolve_render_settings(document, dof, focus, strength, False if turntable else crop, ambient, lamp, bg, floor, beam, aspect, False if turntable else transparent, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut), light, parse_saved_view(savedView)),
                           **({"turntable": {"motion": turntable, "seconds": seconds, "fps": fps, "direction": direction}} if turntable else {})},
                        aspect_ratio(aspect or (document.render.aspect if document.render else "16:9")), (seconds * fps, turntable, fps) if turntable else None)
        job.track = (resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["trackId"] or "") if turntable else ""
        job.track_pivot = resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["trackPivot"]
        job.direction = direction
        job.look_at = resolve_render_settings(document, dof, focus, strength, False, ambient, lamp, bg, floor, beam, aspect, False, track, trackPivot, lookAt, reflections=reflections, fx=fx, cut=cut)["lookAt"]
        renderJobs[job.id] = job
        renderQueue.append((job, (blender, glb, sun, depthOfField, cropped)))
    notifier.notify({"type": "render", **job.view()})
    start_next_render()
    if job.state == "queued":  # it has to wait: its preview is made now, beside the render that runs
        threading.Thread(target=make_preview, args=(job, blender, glb, sun, depthOfField, cropped), daemon=True).start()
    return job.view()


def render_job(jobId: str) -> RenderJob:
    job = renderJobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail="render job not found")
    return job


@app.get("/api/render-estimate")
def render_estimate(width: int = Query(default=1920, ge=160, le=7680), samples: int = Query(default=96, ge=1, le=1024), frames: int = Query(default=1, ge=1, le=2000),
                    aspect: Literal["16:9", "1:1", "4:5", "9:16"] = "16:9") -> dict:
    """About how long a full-size render (frames = 1) or a turntable video takes on this machine, from what the last renders took."""
    job = RenderJob("estimate", width, samples, aspect=aspect_ratio(aspect), turntable=(frames, "orbit", 30) if frames > 1 else None)
    return {"seconds": round(sum(job.estimate(name) for name in renderPhases))}


@app.get("/api/render-jobs/latest")
def latest_render_job() -> dict:
    """The newest render, or `{state: "idle"}`: what the WebSocket says on connecting, for a page that cannot use it."""
    job = latest_render()
    return job.view() if job else {"state": "idle"}


@app.get("/api/render-jobs/{jobId}")
def get_render_job(jobId: str) -> dict:
    return render_job(jobId).view()


@app.get("/api/render-jobs/{jobId}/video.mp4")
def get_render_job_video(jobId: str) -> Response:
    job = render_job(jobId)
    if not job.turntable or job.state != "done" or job.png is None:
        raise HTTPException(status_code=409, detail="there is no finished video")
    filename = re.sub(r"[^\w.-]+", "_", job.name) + f"-{job.width}px.mp4"
    return Response(job.png, media_type="video/mp4", headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store"})


@app.get("/api/render-jobs/{jobId}/preview.png")
@app.get("/api/render-jobs/{jobId}/preview.mp4")
def render_job_preview(jobId: str) -> Response:
    """The small preliminary picture of a render that runs, or the quick draft video of a turntable (404 while there is none)."""
    job = render_job(jobId)
    if job.preview is None:
        raise HTTPException(status_code=404, detail="there is no preview (yet)")
    return Response(job.preview, media_type="video/mp4" if job.previewMedia == "mp4" else "image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/render-jobs/{jobId}/image.png")
def get_render_job_image(jobId: str) -> Response:
    job = render_job(jobId)
    if job.turntable:
        raise HTTPException(status_code=409, detail="this render is a video: see video.mp4")
    if job.state != "done" or job.png is None:
        raise HTTPException(status_code=409, detail=f"the render is {job.state}")
    filename = re.sub(r"[^\w.-]+", "_", job.name) + f"-{job.width}px.png"
    return Response(job.png, media_type="image/png", headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store"})


@app.delete("/api/render-jobs/{jobId}")
def cancel_render_job(jobId: str) -> dict:
    """Stops a running render (Blender is killed) or takes a waiting one out of the queue; a finished job is just forgotten."""
    job = render_job(jobId)
    if job.state == "running":
        job.state = "cancelled"
        if job.process is not None:
            job.process.kill()  # type: ignore[attr-defined]
    elif job.state == "queued":
        with renderLock:
            renderQueue[:] = [(queued, args) for queued, args in renderQueue if queued is not job]
        job.state, job.finished = "cancelled", time.time()
    else:
        renderJobs.pop(job.id, None)
    if job.state == "cancelled":
        notifier.notify({"type": "render", **job.view()})
    else:  # a forgotten picture: the page learns what is going on now (a render may run behind it)
        current = latest_render()
        notifier.notify({"type": "render", **current.view()} if current and current.state in ("running", "queued") else {"type": "render", "state": "idle"})
    return job.view()


@app.delete("/api/render-jobs")
def cancel_all_render_jobs() -> dict:
    """Empties the queue and stops the running render."""
    with renderLock:
        waiting = [job for job, _ in renderQueue]
        renderQueue.clear()
    for job in waiting:
        job.state, job.finished = "cancelled", time.time()
    running = running_render()
    if running:
        running.state = "cancelled"
        if running.process is not None:
            running.process.kill()  # type: ignore[attr-defined]
    last = running or (waiting[-1] if waiting else None)
    notifier.notify({"type": "render", **last.view()} if last else {"type": "render", "state": "idle"})
    return {"cancelled": len(waiting) + (1 if running else 0)}


class ImageNote(BaseModel):
    id: str
    name: str
    kind: Literal["hd", "quick", "turntable", "file"]  # "file": a picture or video the user added
    media: Literal["png", "mp4"] = "png"
    created: float
    width: int
    height: int
    samples: int
    elapsed: float
    version: int  # the document version it was made from (v0: before the first version was saved)
    edited: bool  # the working copy was ahead of that version when it was rendered
    thumb: bool = False
    bytes: int = 0
    settings: dict = Field(default_factory=dict)  # the render settings it was made with


class ImageRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


def image_library(documentId: str) -> Path:
    read_document(documentId)  # 404 for an unknown document
    return images.images_dir(documentsRoot, documentId)


@app.get("/api/documents/{documentId}/images", response_model=list[ImageNote])
def list_images(documentId: str) -> list[dict]:
    """The document's image library, newest first."""
    return images.listing(image_library(documentId))


@app.post("/api/documents/{documentId}/images", response_model=ImageNote, status_code=201)
async def add_image(documentId: str, request: Request, kind: Literal["hd", "quick", "file"] = "quick", name: str | None = Query(default=None, max_length=120),
                    samples: int = Query(default=24, ge=0, le=4096), elapsed: float = Query(default=0, ge=0), settings: str | None = Query(default=None, max_length=4000),
                    width: int | None = Query(default=None, ge=1, le=16384), height: int | None = Query(default=None, ge=1, le=16384)) -> dict:
    """Keeps a picture (the body is the PNG) or a video (the body is an MP4; `width` and `height` say its size) in the document's gallery; it carries the document's version."""
    directory = image_library(documentId)
    document = read_document(documentId)
    data = await request.body()
    if len(data) > 1_000_000_000:
        raise HTTPException(status_code=413, detail="the file is too large")
    try:
        kept = json.loads(settings) if settings else {}
        if not isinstance(kept, dict):
            raise ValueError("settings must be an object")
        if data[4:8] == b"ftyp":  # an MP4
            if not width or not height:
                raise ValueError("a video needs its width and height")
            note = images.add_video(directory, data, name=name or document.name, width=width, height=height, samples=samples, elapsed=elapsed, version=document.version,
                                    edited=document.changedSinceVersion, settings=kept, kind="file" if kind == "file" else "turntable")
        else:
            note = images.add(directory, data, name=name or document.name, kind=kind, samples=samples, elapsed=elapsed, version=document.version, edited=document.changedSinceVersion, settings=kept)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    return images.read_note(directory, note["id"]) or note


def image_note(documentId: str, imageId: str) -> tuple[Path, dict]:
    directory = image_library(documentId)
    note = images.read_note(directory, imageId)
    if not note:
        raise HTTPException(status_code=404, detail="image not found")
    return directory, note


@app.get("/api/documents/{documentId}/images/{imageId}.mp4")
def get_video(documentId: str, imageId: str, download: bool = False) -> Response:
    directory, note = image_note(documentId, imageId)
    if note.get("media") != "mp4":
        raise HTTPException(status_code=404, detail="this is not a video")
    filename = re.sub(r"[^\w.-]+", "_", note["name"]) + f"-{note['width']}px-v{note['version']}.mp4"
    return FileResponse(images.media_file(directory, note), media_type="video/mp4",  # a file response answers range requests, which a video player needs to seek
                        headers={"Content-Disposition": f'{"attachment" if download else "inline"}; filename="{filename}"', "Cache-Control": "no-cache"})


@app.get("/api/documents/{documentId}/images/{imageId}.png")
def get_image(documentId: str, imageId: str, download: bool = False) -> Response:
    directory, note = image_note(documentId, imageId)
    if note.get("media") == "mp4":
        raise HTTPException(status_code=404, detail="this is a video")
    filename = re.sub(r"[^\w.-]+", "_", note["name"]) + f"-{note['width']}px-v{note['version']}.png"
    return Response((directory / f"{imageId}.png").read_bytes(), media_type="image/png",
                    headers={"Content-Disposition": f'{"attachment" if download else "inline"}; filename="{filename}"', "Cache-Control": "no-cache"})


@app.get("/api/documents/{documentId}/images/{imageId}/thumb.jpg")
def get_image_thumb(documentId: str, imageId: str) -> Response:
    directory, _ = image_note(documentId, imageId)
    file = directory / f"{imageId}.thumb.jpg"
    if not file.is_file():
        raise HTTPException(status_code=404, detail="no thumbnail yet")
    return Response(file.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-cache"})


@app.put("/api/documents/{documentId}/images/{imageId}/thumb.jpg", status_code=204)
async def put_image_thumb(documentId: str, imageId: str, request: Request) -> Response:
    """The browser makes the small picture of the gallery (the API has no image library to shrink PNGs with)."""
    directory, _ = image_note(documentId, imageId)
    data = await request.body()
    if not 100 < len(data) <= 2_000_000 or data[:3] != b"\xff\xd8\xff":
        raise HTTPException(status_code=422, detail="not a JPEG thumbnail")
    (directory / f"{imageId}.thumb.jpg").write_bytes(data)
    return Response(status_code=204)


@app.patch("/api/documents/{documentId}/images/{imageId}", response_model=ImageNote)
def rename_image(documentId: str, imageId: str, body: ImageRename) -> dict:
    directory, note = image_note(documentId, imageId)
    note = {key: value for key, value in note.items() if key not in ("thumb", "bytes")}
    note["name"] = body.name.strip()
    images.write_note(directory, note)
    return images.read_note(directory, imageId) or note


@app.delete("/api/documents/{documentId}/images/{imageId}", status_code=204)
def delete_image(documentId: str, imageId: str) -> Response:
    directory, _ = image_note(documentId, imageId)
    images.delete(directory, imageId)
    return Response(status_code=204)


@app.delete("/api/documents/{documentId}/images")
def delete_images(documentId: str, beforeVersion: int | None = Query(default=None, ge=0), kind: Literal["hd", "quick"] | None = None) -> dict:
    """Batch delete: the pictures made from a version older than `beforeVersion` and / or of one kind. Needs at least one of them."""
    if beforeVersion is None and kind is None:
        raise HTTPException(status_code=422, detail="say which pictures: beforeVersion and / or kind")
    return {"deleted": images.delete_matching(image_library(documentId), before_version=beforeVersion, kind=kind)}


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
    images.remove_all(images.images_dir(documentsRoot, documentId))


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
