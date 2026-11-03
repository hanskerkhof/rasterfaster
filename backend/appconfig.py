"""Where the API finds its files: the library, the saved documents, the built frontend and the backup folder of renamed files.

From source (`python main.py`) the frontend is the repo's frontend/3d-tool/dist and the library is under ~/Documents. The documents, with their
images, videos, versions and notes, live in ~/Documents/RASTERFASTER_APP, in the packaged app too. In the packaged macOS app (PyInstaller sets
`sys.frozen`) the frontend comes from inside the bundle and the settings live in ~/Library/Application Support/Rasterfaster. The environment variables RF_ROOT, RF_DOCS and RF_FRONTEND win in both cases.
"""
import json
import shutil
import sys
from pathlib import Path
from typing import Mapping

appName = "Rasterfaster"


def support_dir(home: Path) -> Path:
    return home / "Library" / "Application Support" / appName


def dataDir(home: Path) -> Path:
    """Where the documents are kept, with everything that belongs to them: images, videos, versions and notes."""
    return home / "Documents" / "RASTERFASTER_APP"


def config_file(home: Path) -> Path:
    return support_dir(home) / "config.json"


def read_config(home: Path) -> dict:
    try:
        data = json.loads(config_file(home).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_library_root(home: Path, libraryRoot: Path) -> None:
    config = read_config(home)
    config["libraryRoot"] = str(libraryRoot)
    config_file(home).parent.mkdir(parents=True, exist_ok=True)
    config_file(home).write_text(json.dumps(config, indent=2) + "\n")


def resolve_paths(env: Mapping[str, str], repoDir: Path, home: Path, frozen: bool = False, bundleDir: Path | None = None) -> dict[str, Path]:
    """`repoDir` is the repository root (the folder holding backend/, frontend/ and documents/); `bundleDir` the PyInstaller data folder."""
    defaultLibrary = home / "Documents" / "3D" / "RASTERFASTER"
    configuredBackup = read_config(home).get("backupRoot")
    backup = env.get("RF_BACKUP") or configuredBackup or str(home / "Documents" / "3D_BACKUP")  # originals of renamed files, see library_ops.py
    if frozen:
        configured = read_config(home).get("libraryRoot")
        library = env.get("RF_ROOT") or configured or str(defaultLibrary)
        frontend = env.get("RF_FRONTEND") or str((bundleDir or Path(".")) / "frontend")
        documents = env.get("RF_DOCS") or str(dataDir(home))
    else:
        library = env.get("RF_ROOT") or str(defaultLibrary)
        frontend = env.get("RF_FRONTEND") or str(repoDir / "frontend" / "3d-tool" / "dist" / "3d-tool" / "browser")
        documents = env.get("RF_DOCS") or str(dataDir(home))
    return {"libraryRoot": Path(library).resolve(), "frontendDist": Path(frontend).resolve(), "documentsRoot": Path(documents).resolve(), "backupRoot": Path(backup).resolve()}


def seed_documents(documentsRoot: Path, seedDir: Path | None) -> int:
    """First run of the packaged app: copy the documents that were bundled into the (new) documents folder. Never overwrites anything."""
    if not seedDir or not seedDir.is_dir() or documentsRoot.exists():
        return 0
    documentsRoot.mkdir(parents=True, exist_ok=True)
    count = 0
    for file in seedDir.glob("*.json"):
        shutil.copy2(file, documentsRoot / file.name)
        count += 1
    return count


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path | None:
    meipass = getattr(sys, "_MEIPASS", None)
    return Path(meipass) if meipass else None
