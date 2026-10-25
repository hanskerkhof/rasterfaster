"""Read-only file API for the RASTERFASTER library.

    GET /api/list?path=<relative dir>   -> [{name, path, type: 'dir'|'file'}]
    GET /api/search?q=<text>            -> matching dirs/.stl files plus their ancestor dirs
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
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import uvicorn
import blenderexport
import export3mf
import svgexport
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, Field

libraryRoot = Path(os.environ.get("RF_ROOT", "/Users/hanskerkhof/Documents/3D/RASTERFASTER")).resolve()
apiPort = int(os.environ.get("PORT", "8100"))
frontendDist = Path(os.environ.get("RF_FRONTEND", Path(__file__).resolve().parent.parent / "frontend" / "3d-tool" / "dist" / "3d-tool" / "browser")).resolve()
documentsRoot = Path(os.environ.get("RF_DOCS", Path(__file__).resolve().parent.parent / "documents")).resolve()

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


def natural_key(name: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


@app.get("/api/health")
def health():
    """Cheap liveness check; the frontend polls it to show an offline banner."""
    return {"status": "ok"}


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
def search(q: str) -> list[LibraryEntry]:
    needle = q.strip().lower()
    if not needle:
        return []
    found: dict[str, LibraryEntry] = {}
    matchCount = 0
    for directory, dirNames, fileNames in os.walk(libraryRoot):
        dirNames[:] = [name for name in dirNames if not name.startswith(".")]
        names = dirNames + [name for name in fileNames if name.lower().endswith(".stl") and not name.startswith(".")]
        for name in names:
            if needle not in name.lower():
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
    file = resolve_inside_root(path)
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
    return DocumentOut(id=documentId, modified=file.stat().st_mtime, **body.model_dump())


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


@app.put("/api/documents/{documentId}", response_model=DocumentOut)
def update_document(documentId: str, body: DocumentBody) -> DocumentOut:
    if not document_file(documentId).is_file():
        raise HTTPException(status_code=404, detail="document not found")
    return write_document(documentId, body)


@app.get("/api/documents/{documentId}/export.3mf")
def export_document_3mf(documentId: str, layout: Literal["assembly", "print", "fusion"] = "assembly", bed: float = 256.0) -> Response:
    """3MF for Bambu Studio / Fusion 360. `assembly` keeps the assembled positions centred on the plate; `print` lays each part out flat on a plate of `bed` mm; `fusion` keeps the document coordinates."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        data = export3mf.build_3mf(document.model_dump(), stlBytes.__getitem__, layout, bed)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", f"{document.name}-{layout}") + ".3mf"
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
            stlBytes[path] = resolve_inside_root(path).read_bytes()
        except (OSError, HTTPException):
            missing.append(path)
    if missing:
        raise HTTPException(status_code=422, detail=f"STL files not found: {', '.join(missing)}")
    return stlBytes


@app.get("/api/documents/{documentId}/export.glb")
def export_document_glb(documentId: str, camera: bool = True) -> Response:
    """glTF for Blender: the parts as placed in the document (Z up, metres) plus, unless `camera` is false, a camera animated along the fly-around path and the path as a line."""
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        data = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, camera)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    filename = re.sub(r"[^\w.-]+", "_", document.name) + ".glb"
    return Response(data, media_type="model/gltf-binary", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/documents/{documentId}/export.blend")
def export_document_blend(documentId: str) -> Response:
    """A native .blend (made by running Blender in the background): the glTF export with the camera set up as the scene camera. Needs Blender on this machine (set BLENDER to its path if it is not found)."""
    blender = blenderexport.find_blender()
    if not blender:
        raise HTTPException(status_code=503, detail="Blender was not found on this machine (set the BLENDER environment variable to its path)")
    document = exportable(read_document(documentId))
    stlBytes = load_document_stls(document)
    try:
        glb = blenderexport.build_glb(document.model_dump(), stlBytes.__getitem__, True)
        data = blenderexport.build_blend(glb, blender)
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
            os.execv(sys.executable, [sys.executable] + sys.argv)
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
