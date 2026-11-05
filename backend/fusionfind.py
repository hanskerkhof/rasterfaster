"""Find a library part in the user's Fusion 360 files, with scripts/f3dsearch.py (it reads the component and body names inside .f3d files without Fusion).

    GET  /api/fusion/status                 the folder, how many designs are indexed, how many files are new or changed since
    POST /api/fusion/index                  (re)index in the background: the Fusion cache, the remembered folders and the Fusion folder (RF_FUSION, default
                                            ~/Documents/FUSION360); only new or changed files are read
    GET  /api/fusion/find?path=<library path of the part>
                                            in which designs the part's name is a component or body, and where in the design it sits
    POST /api/fusion/reveal                 shows one of the indexed files in the Finder

The name of an STL exported from Fusion is the design and the component joined (`1.4.BOLTS & NUTS_RF1 v245_BOLT_S3_BLIND.stl`): the component is what is looked for.
"""
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

scriptsDir = Path(__file__).resolve().parent.parent / "scripts"
if scriptsDir.is_dir() and str(scriptsDir) not in sys.path:
    sys.path.insert(0, str(scriptsDir))
import f3dsearch  # noqa: E402 - after the path above (in the packaged app it is bundled)

maxDesigns = 30
maxNames = 20
defaultFolder = Path.home() / "Documents" / "FUSION360"


def fusion_folder() -> Path:
    return Path(os.environ.get("RF_FUSION") or defaultFolder).expanduser()


def index_folders(index: dict) -> list[Path]:
    """The folders the index covers: the Fusion cache, the folders given to `f3dsearch.py index`, and the Fusion folder."""
    folders = list(f3dsearch.cache_folders()) + [Path(p) for p in index.get("folders", [])] + [fusion_folder()]
    seen, found = set(), []
    for folder in folders:
        key = str(folder)
        if key not in seen and folder.is_dir():
            seen.add(key)
            found.append(folder)
    return found


def pending(index: dict, folders: list[Path]) -> int:
    """How many .f3d files are new or changed since they were indexed (or gone): what an index run would do."""
    seen, count = set(), 0
    for folder in folders:
        for file in f3dsearch.f3d_files(folder):
            key = str(file)
            seen.add(key)
            try:
                stat = file.stat()
            except OSError:
                continue
            known = index["files"].get(key)
            sidecar = f3dsearch.sidecar_for(file)
            treeMtime = int(sidecar.stat().st_mtime) if sidecar.exists() else None
            if not known or known["size"] != stat.st_size or known["mtime"] != int(stat.st_mtime) or known.get("treeMtime") != treeMtime:
                count += 1
    return count + sum(1 for key in index["files"] if key not in seen)


# ---- the name of a part -> what to look for -------------------------------------------------------------------------------------------------

levelMarker = re.compile(r"^(?P<above>.*?)_RF\d+[^_]*?\bv\d+_(?P<component>.+)$")


def queries_for(fileName: str) -> list[str]:
    """What to look for, the most specific first: the component an exported STL is named after (`<design>_RF1 v245_<component>`: the deepest one first),
    then the shallower ones, then the whole name. Numbers in brackets and `copy` at the end (`... (2)`) are left off."""
    stem = re.sub(r"\.stl$", "", fileName.strip(), flags=re.IGNORECASE)
    stem = re.sub(r"(\s*\(\d+\))+\s*$", "", stem)
    stem = re.sub(r"[\s_-]*copy(\s+\d+)?\s*$", "", stem, flags=re.IGNORECASE).strip()
    found: list[str] = []
    rest = stem
    while True:
        match = levelMarker.match(rest)
        if not match:
            break
        found.append(match.group("component").strip())
        rest = match.group("component")
    queries = [*reversed(found), stem]  # the deepest component first, the whole name last
    unique: list[str] = []
    for query in queries:
        if query and query.lower() not in [u.lower() for u in unique]:
            unique.append(query)
    return unique


def normal(name: str) -> str:
    return re.sub(r":\d+$", "", name.strip()).lower()


def find_part(index: dict, fileName: str) -> dict:
    """Which designs have a component or body with the part's name: the first query that finds something."""
    queries = queries_for(fileName)
    for query in queries:
        hits = f3dsearch.search(index, query.split())
        if not hits:
            continue
        designs = []
        for name, key, matching, note in hits[:maxDesigns]:
            entry = index["files"][key]
            places = entry.get("places", {})
            matches = [{"name": found, "places": places.get(found, [])[:6], "exact": normal(found) == normal(query)} for found in matching[:maxNames]]
            matches.sort(key=lambda m: (not m["exact"], m["name"].lower()))
            designs.append({"design": name, "path": key, "folder": str(Path(key).parent), "source": "fusion cache" if str(f3dsearch.fusionCache) in key else "local",
                            "matches": matches, "moreMatches": max(0, len(matching) - maxNames), "exact": any(m["exact"] for m in matches), "note": note,
                            "size": entry["size"], "modified": entry["mtime"]})
        designs.sort(key=lambda d: (not d["exact"], d["design"].lower()))
        return {"found": True, "query": query, "queries": queries, "designs": designs, "moreDesigns": max(0, len(hits) - maxDesigns), "indexed": len(index["files"])}
    return {"found": False, "query": queries[0] if queries else "", "queries": queries, "designs": [], "moreDesigns": 0, "indexed": len(index["files"])}


# ---- the index job and the API ----------------------------------------------------------------------------------------------------------------

class RevealRequest(BaseModel):
    path: str = Field(max_length=2048)


def create_router() -> APIRouter:
    router = APIRouter()
    lock = threading.Lock()
    job = {"state": "idle", "done": 0, "total": 0, "current": "", "error": ""}

    @router.get("/api/fusion/status")
    def status() -> dict:
        index = f3dsearch.load_index()
        folders = index_folders(index)
        return {"folder": str(fusion_folder()), "folderExists": fusion_folder().is_dir(), "folders": [str(f) for f in folders], "indexed": len(index["files"]),
                "pending": pending(index, folders), "state": job["state"], "done": job["done"], "total": job["total"], "current": job["current"], "error": job["error"],
                "zstandard": f3dsearch.zstandard is not None}

    @router.post("/api/fusion/index")
    def start_index() -> dict:
        """Starts reading the new and changed .f3d files in the background. Does nothing while a run is going."""
        with lock:
            if job["state"] == "running":
                return {"state": "running"}
            job.update(state="running", done=0, total=0, current="", error="")

        def work() -> None:
            try:
                index = f3dsearch.load_index()
                if fusion_folder().is_dir() and str(fusion_folder()) not in index.get("folders", []):
                    index["folders"] = sorted(set(index.get("folders", [])) | {str(fusion_folder())})  # remembered, like `f3dsearch.py index <folder>`
                folders = index_folders(index)
                job["total"] = pending(index, folders)

                def report(text: str) -> None:
                    if text.startswith(("indexed", "skipped", "hierarchy")):
                        job["done"] += 1
                    job["current"] = text[:120]
                f3dsearch.update_index(index, folders, report)
                f3dsearch.save_index(index)
                job.update(state="done", done=job["total"])
            except Exception as error:  # noqa: BLE001 - shown on the page instead of waiting for ever
                job.update(state="error", error=str(error))
        threading.Thread(target=work, name="fusion-index", daemon=True).start()
        return {"state": "running"}

    @router.get("/api/fusion/find")
    def find(path: str) -> dict:
        """In which Fusion designs the part has a component or body of its name (the newest version of each design with a match)."""
        index = f3dsearch.load_index()
        if not index["files"]:
            raise HTTPException(status_code=409, detail="no Fusion files are indexed yet")
        return find_part(index, Path(path).name)

    @router.post("/api/fusion/reveal")
    def reveal(body: RevealRequest) -> dict:
        index = f3dsearch.load_index()
        if body.path not in index["files"] or not Path(body.path).is_file():
            raise HTTPException(status_code=404, detail="that is not an indexed Fusion file")
        if sys.platform != "darwin":
            raise HTTPException(status_code=501, detail="Reveal in Finder only works on macOS")
        subprocess.run(["open", "-R", body.path], check=False)
        return {"path": body.path}

    return router
