# PyInstaller spec for Rasterfaster.app. Build with scripts/build-app.sh (it builds the Angular app and the icon first).
import json
import os

from PyInstaller.utils.hooks import collect_submodules

here = os.path.abspath(os.path.dirname(SPEC))
frontend = os.environ.get("RF_FRONTEND_BUILD", os.path.join(here, "..", "frontend", "3d-tool", "dist", "3d-tool", "browser"))
seed = os.path.join(here, "..", "documents")
version = json.load(open(os.path.join(here, "..", "frontend", "3d-tool", "package.json")))["version"]

analysis = Analysis(
    ["app.py"],
    pathex=[here],
    datas=[(frontend, "frontend")] + ([(seed, "seed_documents")] if os.path.isdir(seed) else []),
    hiddenimports=collect_submodules("uvicorn") + ["blenderexport", "export3mf", "svgexport", "appconfig"],
    excludes=["pytest", "tkinter"],
)
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="Rasterfaster", console=False)
collected = COLLECT(exe, analysis.binaries, analysis.datas, name="Rasterfaster")
app = BUNDLE(
    collected,
    name="Rasterfaster.app",
    icon=os.path.join(here, "Rasterfaster.icns"),
    bundle_identifier="nl.netmatic.rasterfaster",
    version=version,
    info_plist={"CFBundleDisplayName": "Rasterfaster", "NSHighResolutionCapable": True},
)
