# RASTERFASTER composition tool

Development: two processes (to just use the app, build and install **Rasterfaster Server.app**, see [below](#rasterfaster-serverapp-api--dock-icon-opens-the-pwa)):

```bash
# 1. API (FastAPI; first time: /opt/homebrew/bin/python3.13 -m venv .venv1 && .venv1/bin/pip install -r requirements.txt): lists / serves .stl files from ~/Documents/3D/RASTERFASTER (override with RF_ROOT, PORT)
cd backend && .venv1/bin/python main.py

# 2. Angular UI (proxies /api to :8100)
cd frontend/3d-tool && npm start      # http://localhost:4200
```

Tests: `cd backend && .venv1/bin/python -m pytest`

Pick up backend code changes without killing the process (re-execs in place, same PID):

```bash
curl -sS -X POST http://127.0.0.1:8100/api/runtime/restart -H 'Content-Type: application/json' -d '{"reason":"code change"}'
```

Tree keyboard (Finder-style): ↑/↓ move, → expand / step into folder, ← collapse / go to parent, Home/End.

## Documents (assemblies)

Saved as JSON in `documents/` (override with `RF_DOCS`). The UI autosaves ~0.4 s after each edit.

```
GET    /api/documents        list   [{id, name, itemCount, modified}]
POST   /api/documents        create {name?, items?}  -> 201 + document
GET    /api/documents/{id}   read
PUT    /api/documents/{id}   replace {name, items}   (404 if it doesn't exist)
DELETE /api/documents/{id}   delete -> 204
```

## 3MF export (Bambu Studio)

```
GET /api/documents/{id}/export.3mf?bed=256
```
The **Assembly** button: the parts exactly as assembled, centred on a `bed` × `bed` mm plate; import the file in Bambu Studio and work with it there. Parts set to Do not export are left out.

Copy / paste: ⌘C copies the selected parts, ⌘X cuts them, ⌘V pastes at the view centre (the copied group's lowest corner snaps to the nearest grid intersection, heights and spacing are kept, parts set to Center on grid are re-centered). One paste is one undo step and the pasted parts become the selection. The clipboard holds content only (file, rotation, color, dimmed/centered flags, offsets), never ids, and is kept in local storage, so it survives reloads and works across documents and tabs. The part context menu has Copy / Cut / Paste too.

Keyboard: arrows move X/Y, Shift+↑↓ / PgUp PgDn move Z, Shift+←→ turn about Z, X/Y/Z keys rotate about that axis (Shift = reverse), V dims / shows the selection, Alt = 1 mm steps, Esc during a drag puts the part back, ⌘-click centres the view on the clicked point (both modes), ⌘Z/⇧⌘Z undo/redo, ⌘D duplicate, Delete removes.

## Trackpad / mouse

Two-finger scroll pans the view (the scene follows your fingers), pinch zooms towards the cursor, one-finger drag orbits. With a mouse: Option + wheel zooms, plain wheel pans.

## Object context menu

Right-click a part (3D view or document list): **Dim (mute)** turns it into a barely visible ghost that ignores clicks (⌘A skips it too; in the hidden-line views its own back edges are hidden, what is behind it stays visible) — handy for working on what's inside a cover. Right-click the ghost (in the 3D view, where a solid part in front takes priority) or its row in the list to bring it back. **Center on grid** is a toggle (✓ when on, ⌖ in the list): it centers the part's footprint in the nearest 20 × 20 cell and keeps it centered while it is dragged, nudged or rotated — handy for bolts, nuts and spacers. Turn it off to move freely again. **Snap to grid…** is a one-time action: handles appear on the corners and side middles of the part (bottom plane), and clicking one puts that point on the nearest 20 mm grid intersection (height unchanged; Esc cancels; a part set to stay centered stops being centered). **Move to ground** drops the part so its lowest point is at z = 0, **Move to base (6 mm)** puts it on top of the 6 mm baseplate (z = 6); several parts keep their heights relative to each other. **Do not export** (toggle) marks a mock part that is not printed: it stays in the document but is left out of the 3MF and SVG exports; the BOM lists it in its own "Not exported" section (also in the CSV, without a total). **Move to…** is a two-step move: first click a corner of the selected part (handles on all 8 corners of its box), then a corner of another part (handles appear on every other part): the selection snaps so the two corners coincide. Esc cancels either pick mode, whatever has keyboard focus.

## Searching inside Fusion 360 files (f3dsearch)

Opening big cloud designs in Fusion to find one component takes ages. `scripts/f3dsearch.py` finds component and body names inside `.f3d` files without Fusion:

```
backend/.venv1/bin/pip install -r scripts/requirements-f3dsearch.txt     # once (zstandard)
backend/.venv1/bin/python scripts/f3dsearch.py index                    # the designs Fusion cached on this Mac (~/Library/Application Support/Autodesk/Autodesk Fusion 360/<id>/W.login/F)
backend/.venv1/bin/python scripts/f3dsearch.py index ~/Documents/Fusion-exports   # and a folder of exported .f3d files (remembered next time)
backend/.venv1/bin/python scripts/f3dsearch.py search ESP32 "ALT IV"    # components whose name contains every word, per design (only its newest version; --all-versions shows all)
backend/.venv1/bin/python scripts/f3dsearch.py list
```

Only designs that are on this Mac can be searched: the cache holds the designs you opened in Fusion; for the others export them (File > Export > Fusion Archive, or Download in the Data Panel) into a folder and index that. The first index reads every file (about 15 s for 6.5 GB), later runs only the new or changed ones; searching is instant. Versions and copies of one design (`RF14_v3`, `RF14 v4`, `RF14`, the cache's `_RF14`) count as one design: a search shows the newest version with a match and says how many older versions are hidden, and when an older one has matching names the newest lacks (a removed component). `search --all-versions` and `list --all-versions` show every file. The index is `~/Library/Application Support/Rasterfaster/f3d-index.json`. The names are read as text, not with a real parser of Fusion's format.

## Fusion 360 add-in: local .f3d files (AddInRasterfasterLocalF3D)

For working without the Fusion cloud (the free Personal Use plan allows 10 active documents): `fusion-addin/AddInRasterfasterLocalF3D` adds three commands to Fusion's Utilities tab > Add-Ins panel:

- **Save Local Copy**: exports the open design into the local folder (default `~/Documents/FUSION360`). With **Add version** ticked (the default) the file is `<name>_v<N>.f3d` with N one above the highest version of that name in the folder (`RF14_v2` and `RF14 v4` are versions of `RF14`), so each save is a new file; without it the file is `<name>.f3d` and an existing one is replaced after a question. It writes a hidden temporary file first and then moves it over the old copy, so a failed export never damages the file that is there. A design opened with **Open Local File** saves back to the file it came from.
- **Open Local File**: imports a local `.f3d` as a new, unsaved document. It is not in the cloud unless you save it there; when you close it choose *Don't save*.
- **Local Folder**: picks another folder (remembered in `localf3d.json` next to the add-in).

The full install and usage guide is in [fusion-addin/README.md](fusion-addin/README.md). In short, to add it to Fusion once: Utilities > Add-Ins > Scripts and Add-Ins, click **+** (Script or add-in from device) and choose the folder `fusion-addin/AddInRasterfasterLocalF3D`; Fusion keeps working from that folder, so a change in the repo is live after you stop and run the add-in again (tick *Run on Startup* to keep it running). Do not also copy it into Fusion's AddIns folder: Fusion would list it twice. Assign keyboard shortcuts to the three commands in Fusion's preferences. Exports of big designs take a while and Fusion is busy meanwhile. After saving, run `scripts/f3dsearch.py index` to update the name index.

## Install as an app (PWA)

The production build (served by the API on http://localhost:8100 after `ng build`) is an installable PWA: manifest, icons and an Angular service worker that caches the app shell (the `/api` calls are never cached). In Chrome use *Install Rasterfaster*. When a new build is deployed an **Update** button appears in the header; click it to reload into the new version. The service worker is off in `ng serve`.

## Rasterfaster Server.app (API + Dock icon, opens the PWA)

```bash
scripts/build-app.sh               # builds dist/Rasterfaster Server.app (about 40 MB: Python, the API and the Angular app inside) and copies it to /Applications (replacing an older Rasterfaster.app / Rasterfaster Server.app)
scripts/build-app.sh --no-install  # ... only builds it
```

Click **Rasterfaster Server**: it starts the API (which also serves the web app on http://localhost:8100/) and opens the installed **Rasterfaster PWA**; it has no Dock icon of its own while the PWA is its window. **Closing the PWA window (or quitting the PWA) stops the API** a few seconds later and the server app ends too, so the backend only runs while you use the app. The PWA is the real Chrome app, so browser storage (sort order, filter, panel width, last mode), copy/paste, the dev tools and updates all work as in Chrome. Clicking "Rasterfaster Server" again while it runs just brings the PWA forward. Pin "Rasterfaster Server" to the Dock (or find it in Launchpad / Spotlight) as the one icon to click; the PWA's own icon alone does not start a backend (you would see the red offline banner).

One-time setup: install the PWA from the *production* address: start the server app, open http://localhost:8100/ in Chrome and use *Install Rasterfaster* (uninstall the old one that was installed from http://localhost:4200/ first; that is the `ng serve` dev address). Without an installed PWA the server app opens http://localhost:8100/ in Chrome instead and keeps a Dock icon (Quit stops the API); it also keeps its Dock icon if the PWA never shows up within a minute. After a new build the PWA shows the "Update available" button.

Paths in the packaged app (`backend/appconfig.py`): documents in `~/Library/Application Support/Rasterfaster/documents` (the documents that exist at build time are copied there on the first run, nothing is overwritten), the STL library from `config.json` in that folder (`libraryRoot`, default `~/Documents/3D/RASTERFASTER`), `RF_ROOT` / `RF_DOCS` / `RF_FRONTEND` / `PORT` still override. If an API already answers on port 8100 (for example `python main.py`), the app uses that one and does not start a second; if something else holds the port it picks a free one (the PWA then has a different address). The app is unsigned: the first time, open it with right-click > Open. Blender export needs Blender installed (found at /Applications/Blender.app).

Development is unchanged: `cd backend && .venv1/bin/python main.py` and `cd frontend/3d-tool && npm start -- --open`. The build uses its own `backend/.venv-app` (PyInstaller and the macOS Cocoa bindings, see `backend/requirements-app.txt`). `python app.py` (in that venv) runs the same server app without packaging. If the STL library folder does not exist on another machine, put its path in `~/Library/Application Support/Rasterfaster/config.json` as `{"libraryRoot": "/path"}`.

### Shipping a change (the flow)

1. Develop with the two dev processes above (backend changes: `POST /api/runtime/restart` re-execs the running API in place).
2. Test: `cd backend && .venv1/bin/python -m pytest` and `cd frontend/3d-tool && npm test`.
3. Bump the version and write the changelog: `cd frontend/3d-tool && npm run bump:version -- X.Y.Z` (updates `package.json`, `src/app/build-info.ts` and the service worker's `appData.version`, so the PWA's update button shows the new number) and add a dated entry to `CHANGELOG.md` (FE / BE bullets with file paths).
4. Build and install the app: `scripts/build-app.sh` (builds the Angular app, the icon and `dist/Rasterfaster Server.app`, copies it to /Applications). Restart the API you have running so it has the new backend code (`POST /api/runtime/restart`), because an old API ignores new endpoints.
5. Open the app: click **Rasterfaster Server**; the PWA shows the green **Update available vX.Y.Z · reload** button within a minute; click it.
6. Commit and push to `main`.

## Document versions (v1, v2, ...)

Like Fusion 360: the document is autosaved as ever (the working copy), and a **version** is a numbered, immutable snapshot of it. The pill next to the document name shows the newest version (`v3`), with a dot (`v3 •`) while the working copy has changes since; **⌘S** saves a new version (nothing is created when nothing changed), and clicking the pill opens the versions list: **View** shows an older version read-only (a blue bar says so; edits are off), **Promote** makes it the working copy again and saves it as the newest version (older versions are never rewritten), and **Back to the working copy** leaves the old version. Versions live next to the document as `documents/<id>.versions/v1.json`, `v2.json`, ... (deleted with the document). API: `GET/POST /api/documents/{id}/versions`, `GET /api/documents/{id}/versions/{n}`, `POST /api/documents/{id}/versions/{n}/promote`; a document now also reports `version` and `changedSinceVersion`.

## Saving a document as a file and restoring it

In the document panel, **Document file → Save file** downloads the open document as `<name>-v<n>.rasterfaster.json` (`v<n>` is the newest saved version, `-edited` is added when the working copy has changes since it, and there is no suffix before the first version): the parts and everything about them (colour, position, rotation, dimmed, centered, do-not-export) plus **all its versions**. **Open file…** restores such a file: a document that does not exist (any more) comes back exactly as it was, with the same id, its version history and its working copy, and is opened; if a document with that id exists you choose **Replace it** (working copy and history become the file's), **Import as a copy** (new id, the existing one stays) or Cancel. Other windows pick the restored or replaced document up through the normal sync (up to 5 s). API: `GET /api/documents/{id}/export.rasterfaster`, `POST /api/documents/import[?onConflict=replace|copy]` (409 when the id exists and no choice was given; 422 for files that are not documents). The library STL files themselves are not in the file: they are found by their library path.

## Two windows on the same document

The app polls `/api/health` every 5 s; it carries the newest modification time of any document. When that changes, a window checks whether the open document was saved by another window (the dev app on :4200 and the PWA on :8100 share the same API and documents): without unsaved edits it reloads silently ("Updated from another window"); with unsaved edits it shows an orange banner: **Load the other version** (drops your unsaved edits) or **Keep mine (overwrite)**. Saves send the `modified` time they are based on (`PUT /api/documents/{id}?baseModified=...`) and the API answers **409** with the current document when it is older, so a stale window can never silently overwrite a newer save. Without `baseModified` the API still overwrites, as before. The delay is up to 5 s.

## Offline detection and versions

The app polls `GET /api/health` every 5 s (and when the browser reports a network change). After two failed checks a red **Offline** banner appears at the bottom of the view; when the API answers again it disappears and the file list reloads. The document recovers too: if the app was started while the API was down, the document loads as soon as the API answers; edits made while it was down are saved again (they are never replaced by what is on disk). The installed PWA keeps working with its cached shell while the API is down, but nothing is saved. The version (`package.json`, shown as `vX.Y.Z` in the panel header and on the **Update available** button) is bumped with `npm run bump:version -- X.Y.Z` in `frontend/3d-tool`; that also rewrites `src/app/build-info.ts` and `ngsw-config.json` (`appData.version`). Bump it, add a CHANGELOG entry and rebuild whenever you ship a change you want installed PWAs to pick up.

## Renaming library files and directories (file management, phase 1)

Right-click a row in the file list → **Rename…**, press **Enter** (or F2) on a focused row, or click a row that is already selected, wait a moment and the name becomes editable (a slow second click, like in the Finder; a double-click still adds a file to the document, and a folder's arrow still opens and closes it): the row becomes a text field (a file without its `.stl`, which is added again); Enter again without typing or Esc cancels, Enter after typing saves; a name that is empty, starts with a dot, contains `/ \ :` or already exists is refused with the reason shown under the field. The API is `POST /api/library/rename` (`{path, newName}`, `?dryRun=true` only reports what would happen), implemented in `backend/library_ops.py`.

- **Backup of the original, the first time only:** the first time a *file* is renamed, a copy of the original goes to the backup folder with the same hierarchy: renaming `<library>/1.4.BOLTS & NUTS/old name.stl` keeps `3D_BACKUP/RASTERFASTER/1.4.BOLTS & NUTS/old name.stl` (the folder is named like the library folder). If the copy fails, nothing is renamed. Renaming the same file again (A, B, C) is not backed up again: a registry follows the file (`<backup folder>/.rasterfaster/registry.json`). A backup never overwrites another one (`name (2).stl`).
- **Directories:** renaming a directory copies nothing; it is only logged.
- **Documents follow:** every part in `documents/*.json` and in their versions that points at the renamed file (or below the renamed directory) gets the new path; a part label that still equals the old file name becomes the new name (your own labels stay). Open windows reload through the two-window sync.
- **Log:** every rename is recorded in `<backup folder>/.rasterfaster/log.json` (pending first, then done, or failed).
- **Backup folder:** default `/Users/hanskerkhof/Documents/3D_BACKUP` (`~/Documents/3D_BACKUP`); change it with `RF_BACKUP` or `backupRoot` in `~/Library/Application Support/Rasterfaster/config.json`.
- Plan for the next phases (move, batch rename, tags, insight, import, backup browser): `docs/file-management-plan.md`.

### Selecting several items (file management, phase 2a)

Like in the Finder: a plain click selects one row; **⌘-click** adds or removes a row; **Shift-click** selects everything from the last clicked row to this one; **Shift+↑/↓** grows or shrinks the selection; **⌘A** selects all visible rows; **Esc** goes back to the focused row alone. A selected folder swallows the selected things inside it (an action acts on the folder only). **Move to Trash** (menu or ⌘⌫) acts on the whole selection as one action: one question at most (when documents use any of it), one **Undo** that puts everything back, and the items are stored in the Trash under one batch id. Right-clicking inside the selection keeps it (the menu then says "Move N Items to Trash" and Rename is greyed out); Rename needs exactly one row (Enter or F2 with several selected says so). API: `POST /api/library/trash-batch` (`{paths}`, `?dryRun=true` sums the documents that use them; everything is checked before anything moves).

### The Trash (delete, like the Finder)

Right-click a row → **Move to Trash**, or **⌘⌫** on a focused row (a file or a directory): no question is asked, the row goes to the Trash and an **Undo** bar (10 seconds) offers to put it back. When documents use it, you are asked first: those parts keep their path and show as missing until the file is put back (documents are not rewritten). The **🗑 Trash** button under the file list (with the number of items) opens the Trash: **Put Back** (a directory comes back whole, missing folders are made again; if something sits in the old place you can put it back as `name (restored).stl`), **Delete Immediately** and **Empty Trash…** (both remove for good, Empty asks once more). The Trash lives in the backup folder as `_TRASH/<id>/<name>` with an index in `.rasterfaster/trash.json` (original place, time, size, the registry entries of renamed files so they stay registered); everything is in the log (`trash-file`, `trash-directory`, `put-back`, `delete-immediately`, `empty-trash`). API: `POST /api/library/trash` (`{path}`, `?dryRun=true` lists the documents that use it), `GET /api/library/trash`, `POST /api/library/trash/{id}/put-back[?onConflict=rename]`, `DELETE /api/library/trash/{id}`, `DELETE /api/library/trash`.

## Looking at a library file

There is one view: the document. Click a file in the tree to select it, press **Space** for a quick look (a floating, resizable preview: drag the bottom-right corner, the size is remembered; switch between Solid, Wireframe, Hidden removed and Hidden dashed, remembered), and add it to the document with **＋ Add to document**, ⌘↓, the context menu's **Add to Document** or a double-click (with several files selected, ⌘↓, the button and the menu add all of them at once) (Enter renames, see below; drag the selection onto a folder to move it, and the right-click menu also has New Folder, Duplicate, Reveal in Finder and Copy Path); adding a part (any of these ways) closes the quick look. ↑ ↓ browse files while it is open.

## File list

⌘B or the icon in the RASTERFASTER header hides and shows the panel (it slides, and the choice is remembered). Drag the right edge of the panel to resize it (double-click resets, ← → with the handle focused); the width is remembered.

The reload button (⟳ next to Sort) re-reads the library from disk: the root and every open folder, and the search when a filter is active. The filter text is remembered across reloads.

## Silhouette edges (hidden-line views)

In *Hidden lines removed* and *Hidden lines dashed* (main view, quick look and dimmed parts) the sharp edges of a part are drawn, plus, since 0.6.0, the **contour of its smooth walls**: a cylinder, a cone or a tapered foot used to show only its top and bottom rings, because an edge was only drawn where two triangles meet at more than 25°. Silhouette edges (`silhouette.ts`) are the smooth edges between 0.5° and 25°, drawn by a small shader only where one of the two triangles faces the camera and the other faces away, so the contour follows the camera (both camera types). Switch it on or off in the view cube's right-click menu (**Silhouette edges**, remembered, default on) to compare; the hidden contour in *Hidden lines dashed* is drawn solid in the dashed colour. Flat parts (boxes) look the same either way. To remove the feature: delete `silhouette.ts` and its spec and the `silhouette` lines in `model-render.ts`, `document-scene.ts`, `quick-look.ts` and `stl-viewer.ts`.

## Camera

Right-click the view cube → **Camera**: Orthographic (default), Perspective, or Perspective with ortho faces (orthographic only while looking straight at a face of the cube, like Fusion 360). Remembered across reloads.

## Fly-around

The ▶ button next to Home (document view only; also in the view cube's right-click menu) starts a slow camera flight around the assembly: about one turn per 70 s, with the camera rising and falling, breathing in and out, and its centre drifting, so over time the assembly is shown from the sides, the top and a low angle. Zooming (scroll, pinch) keeps working while flying, so you can zoom out to see the path and back in; the 🔍 button next to ⏸ resets the zoom to the flight's default. Dragging the view or pressing ⏸ stops it. **Show camera path** (view cube right-click menu, remembered) draws the path as an amber line around the assembly, with a Blender-style camera outline at the camera's current spot on it: the whole closed loop (the flight repeats every 280 s), otherwise a preview from the current view direction. Zoom out to see it.

## 3D grid

Right-click the view cube → **3D grid** switches the ground grid to a full lattice: horizontal 20 mm grids at every height level (0, 2, 6, 10, …) up to just above the parts, plus vertical lines through every node. The choice is remembered.

## Rotating around the selection

With parts selected, rotating the view (dragging empty space, or dragging/clicking the view cube) pivots around the centre of the selection: the view glides to centre it first. Right-click the view cube → **Rotate around selection** turns this on or off (default on, remembered).

## Height grid (grid mode)

X/Y snap to 20 mm. Height snaps to levels that depend on the **Grid mode** (right-click the view cube → Grid mode, remembered):

- **Fine: every 2 mm** — 0, 2, 4, 6, 8 … (for 2 mm thick parts)
- **Baseplate: 2 mm, then 4 mm** — 0, 2, 6, 10, 14 … (default; the top of a 6 mm baseplate is a level)
- **Coarse: every 4 mm** — 0, 4, 8, 12 …

Shift+↑↓ / PgUp PgDn move the selection one level (the lowest selected part decides, the rest keeps its offsets) and Shift+drag snaps to the nearest level; Alt gives 1 mm steps. The 3D grid follows the mode. Modes are defined in `frontend/3d-tool/src/app/z-levels.ts`.

## Work area

Parts stay inside a 100 × 100 cell area (±1000 mm in X/Y, −200…1000 mm in Z); drags, keys, rotations and typed values are clamped to it, and the grid never draws beyond it. Documents with corrupt or out-of-range positions are repaired when opened.

## Blender export

**Blender** in the document panel downloads a native `.blend` (API: `GET /api/documents/{id}/export.blend`); double-click it to open it in Blender. The API makes it by running Blender in the background, so Blender must be installed on the machine that runs the API (found automatically at `/Applications/Blender.app` or on the PATH; set `BLENDER` to its path otherwise; without it the button reports "Blender was not found"). You get one object per part (named like the part, all sharing one **Black PLA** material: satin black with a thin glossy coat; add `?colours=true` to the API call to keep the document colours instead; flat shaded) exactly as placed in the document, Z up, in metres (a 20 mm cell is 0.02 m); parts marked **Do not export** are left out. The `.blend` also has a **studio setup** so a render works straight away: a dark matte floor (solid from above, invisible from below, so a camera under the ground sees through it), a dark gradient world and four area lights (warm key, cool fill, magenta rim, and a soft cool light from below), Cycles with 96 samples, AgX colour (add `?studio=false` to leave it out). The scene camera, **App view camera**, sits where the 3D view is when you press the button (same direction, centre and zoom; orthographic or perspective like the view, including the narrower field of view of a zoomed-in perspective view, so the perspective looks the same; the picture is 16:9 with the same visible height, so the sides may show more or less than the app's window). Without a view (a plain API call) it is the isometric Home view with the whole assembly in frame; pass `?view=dx,dy,dz;tx,ty,tz;height;persp|ortho[;fov]` (direction centre to camera, centre in mm, visible height in mm, vertical field of view in degrees for `persp`, default 35) to place it yourself. There is no camera animation or camera path in the export. Checked with Blender 5.0.

The same scene as glTF, without needing Blender: `GET /api/documents/{id}/export.glb` (add `?camera=false` for parts only); import it with *File > Import > glTF 2.0*.

## SVG drawing

```
GET /api/documents/{id}/export.svg
```
Top / front / right view of the assembly: feature lines (sharp edges, silhouette, open boundaries) in each part's colour on a 20 mm grid, numbered legend, overall size; hidden edges are dashed. No occlusion between parts.
