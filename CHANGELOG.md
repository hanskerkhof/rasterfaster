# CHANGELOG

Newest first. Every bullet starts with its scope: **FE** (frontend, `frontend/3d-tool`) or **BE** (API, `backend`).

## 2026-10-26 - add several files at once (0.9.1)

### Added
- **FE** (`tree-panel.ts`, `document-scene.ts`, `document.store.ts`, `stl-viewer.ts`, `app.ts`, `app.html`): with several files selected in the file list, **⌘↓**, the **＋ Add N files to document** button and the new **Add N Files to Document** item in the file context menu add all of them as parts in one go (next free slot along +X each, colours cycle, all new parts selected, one undo step). The context menu also has **Add to Document** (⌘↓) for a single file; it is greyed out on a folder. Folders in a selection are skipped.
- **FE** (`object-menu.ts`): the Dim item in the part menu shows its shortcut, **V**.

## 2026-10-26 - selecting several items in the file list (0.9.0)

### Added
- **FE** (`tree-panel.ts`, `tree-selection.ts`, `tree-selection.spec.ts`, `app.ts`, `app.html`, `library.service.ts`): a Finder-style selection in the file list: ⌘-click toggles a row, Shift-click selects the range from the anchor, Shift+↑/↓ extends, ⌘A selects all visible rows, Esc goes back to the focused row (and closes the context menu first); a plain click or plain arrows select one row. Multi-selected rows are highlighted, right-click inside the selection keeps it, and the context menu says "Move N Items to Trash" with Rename greyed out; Rename (Enter/F2) and the slow-click rename need exactly one row. Move to Trash (⌘⌫, menu) acts on the selection: a folder and selected things inside it count as the folder; one confirm when documents use any of it, one Undo for the whole batch ("Moved 3 items to the Trash" puts all back). The selection follows renames and is pruned when rows disappear. The rules (range, toggle, nested folders, pruning) are pure functions with a spec.
- **BE** (`library_ops.py`, `main.py`, `tests/test_library_ops.py`): `POST /api/library/trash-batch {paths}` (`?dryRun=true`): collapses nested paths and duplicates, checks every item first (a bad item moves nothing), moves the rest under one `batchId` (stored in the log entries and the Trash items) and returns `{batchId, results, failed}`; the dry run sums the documents that use the items. Tested in the browser on a throwaway library: ⌘-click, Shift-click, Shift+arrows, ⌘A, Esc, the confirm for used files (with plural wording), moving two items and undoing both, the menu on a selection, and a folder plus its child (only the folder is moved).

## 2026-10-26 - the Trash: delete like the Finder (0.8.0)

### Added
- **BE** (`library_ops.py`, `main.py`, `tests/test_library_ops.py`): `POST /api/library/trash` (`?dryRun=true` reports the documents that use the item), `GET /api/library/trash`, `POST /api/library/trash/{id}/put-back[?onConflict=rename]`, `DELETE /api/library/trash/{id}` (Delete Immediately), `DELETE /api/library/trash` (Empty Trash). Items move to `<backup>/_TRASH/<id>/<name>` with an index entry (original path, kind, time, size and the registry entries of renamed files, which come back with Put Back); Put Back makes missing folders again and answers 409 when the old place is taken (`onConflict=rename` restores as `name (restored).stl`); documents are not rewritten, so their parts work again after Put Back; every step is logged.
- **FE** (`tree-panel.ts`, `trash-dialog.ts`, `library.service.ts`, `app.ts`, `app.html`, `app.scss`): **Move to Trash** in the row's context menu and on **⌘⌫** (no question unless documents use the item), an **Undo** bar after each move, a **🗑 Trash** button under the file list with the item count, and a Trash dialog (Put Back, Put back as "(restored)", Delete Immediately, Empty Trash with a second question). Tested in the browser on a throwaway library: unused file goes straight to the Trash with Undo, a used file asks first, a directory, Put Back into a taken place, Delete Immediately; 103 backend tests.

## 2026-10-26 - a slow second click renames, like the Finder (0.7.4)

### Added
- **FE** (`tree-panel.ts`): clicking a row that is already selected (the list had keyboard focus, plain click, more than 500 ms after the previous click on it) starts the rename after 400 ms, unless a double-click, another click or a key press comes first; a double-click still adds the file to the document. For a folder the first click still selects and opens or closes it, a slow second click on its name renames it without toggling it, and its arrow always toggles. Checked in the browser: select-only click does not edit, a slow second click edits (file and folder, the folder stays open), a double-click on a selected file adds it and does not edit.

## 2026-10-26 - the folder stays open after a rename in the filtered list (0.7.3)

### Fixed
- **FE** (`tree-panel.ts`): with a filter active, a rename refreshed the search results and every refresh forgot which folders were open (and the focused row), so the folder of the renamed file collapsed. The open folders and the focus are now only forgotten when the filter text itself changes; refreshing the results of the same filter keeps them. Checked on a throwaway library with the filter `GOOD`: the folder stayed expanded and listed the new name.

## 2026-10-26 - Enter renames, like the Finder (0.7.2)

### Changed
- **FE** (`tree-panel.ts`, `quick-look.ts`): Enter on a focused row in the file list starts the rename (file or directory); Enter again without typing, or Esc, cancels; Enter after typing saves. Enter no longer adds the file to the document (⌘↓, the button and a double-click still do). F2 still works. The context menu shows the key as ↵; the quick look footer no longer mentions Enter.

## 2026-10-26 - rename: stale rows no longer fail with "not found" (0.7.1)

### Fixed
- **FE** (`tree-panel.ts`): renaming a row whose name was out of date failed with "not found". The server side was fine (the same rename as a dry run on the real library succeeds); the list had sent a path that no longer existed. The list was only partly refreshed after a rename (`reload()` re-read the root and the folders opened while browsing, not the folders opened while a filter was active), and the listings below a renamed directory kept the old directory's name. Now `reload()` re-reads every folder that was listed, a rename drops the listings of the old directory name and lists the open folders under their new names, and the filter's open folders follow a rename too.
- **FE** (`tree-panel.ts`): before the rename field opens, the folder the row is in is listed; if the file is no longer there (renamed or moved outside the tool), the list is refreshed and a note says so. A 404 from the server is handled the same way, instead of leaving an error under the field. Checked by moving a file on disk behind the app's back and pressing F2 on its old row.

## 2026-10-26 - file management phase 1: rename with a first-time backup (0.7.0)

### Added
- **BE** (`library_ops.py`, `main.py`, `appconfig.py`, `tests/test_library_ops.py`, `tests/test_appconfig.py`): `POST /api/library/rename` (`?dryRun=true`). A first rename of a file copies the original to `<backup>/<library folder name>/<old relative path>` (size verified, never overwrites a backup, a failed backup aborts the rename); a registry in `<backup>/.rasterfaster/registry.json` follows the file, so later renames are not backed up again; directory renames copy nothing; all renames are logged (`log.json`, pending then done/failed). Document items and version snapshots that use the file (or sit below the directory) get the new path, and labels equal to the old file name follow it; a failed document update puts the file back. Name rules: not empty, no leading dot, no `/ \ :`, `.stl` kept, collisions give 409, nothing outside the library. Backup folder: `RF_BACKUP`, `backupRoot` in `config.json`, default `~/Documents/3D_BACKUP`.
- **FE** (`tree-panel.ts`, `library.service.ts`, `app.ts`, `app.html`, `document.store.ts`): right-click context menu on file list rows with **Rename…** (F2), in-place rename field with the reason shown on errors, the tree keeps open folders and focus, the selection and remembered file follow, open documents reload, and a notice says where the original was kept. Tested in the browser on a throwaway library: file rename (backup in the mirrored hierarchy), second rename (no new backup), collision, directory rename, and the documents' paths and labels.

### Fixed
- **FE** (`tree-panel.ts`): the tree's output was called `select`, which is also a DOM event name: selecting the text in the rename field fired it and put an event object into the app's selection. It is now `fileSelected`.

## 2026-10-26 - silhouette edges for curved walls, behind a setting (0.6.0)

### Added
- **FE** (`silhouette.ts`, `model-render.ts`, `document-scene.ts`, `quick-look.ts`, `stl-viewer.ts`, `silhouette.spec.ts`): in the hidden-line views cylinders, cones and tapered feet had no side lines: `EdgesGeometry(geometry, 25)` only draws edges where triangles bend by more than 25 degrees, and the facets of a curved wall bend by about 2.5 degrees. `buildSilhouetteGeometry` collects the smooth edges (0.5 to 25 degrees) with both triangle normals; a vertex shader draws one only while one triangle faces the camera and the other faces away (constant direction for the orthographic camera, per edge for the perspective one). Works for dimmed parts too (faint, in their draw order). The shared crease angle is `creaseDegrees` (25). The feature is isolated in `silhouette.ts` and behind the **Silhouette edges** item of the view cube's right-click menu (default on, stored as `rasterfaster.silhouetteEdges`), so the old look is one click away. Checked on `spacers_RF1 v236_20.stl` in the quick look (rings only with the setting off, rings plus side contour with it on), in the main view, and the menu toggle redraws at once; unit tests for the edge selection (cylinder: one smooth edge per segment, box: none).

## 2026-10-26 - muted parts hide their own back edges (0.5.3)

### Changed
- **FE** (`model-render.ts`): in the hidden-line views (Hidden lines removed / dashed) a muted (dimmed) part now hides its own back edges: it is drawn after everything else with a depth-only fill (no colour), so the fill only hides edges drawn later, that is its own back edges, and what lies behind the ghost stays visible. Each ghost gets its own draw order, so ghosts do not hide each other's edges (a later ghost's edges can still be hidden by an earlier ghost's fill). Hidden dashed mode shows the part's own hidden edges dashed. Checked in the browser on a throwaway document with a muted part and parts behind it (edge opacity raised for the check, document deleted afterwards).

## 2026-10-26 - README: the build and release flow

### Changed
- **README**: "Shipping a change (the flow)" under the Rasterfaster Server.app section (test, bump version and changelog, `scripts/build-app.sh --install`, restart the API, update the PWA, commit); the top of the README points to the app for using it and keeps the two dev processes for developing.

## 2026-10-26 - toolbar file name removed (0.5.2)

### Removed
- **FE** (`app.html`, `app.scss`): the selected library file's path in the toolbar (the `.name` span, "Select an .stl file"): the tree, quick look and the document list already show it.

## 2026-10-26 - only the Assembly 3MF is left (0.5.1)

### Removed
- **FE** (`document-panel.ts`): the **Print plate** and **Fusion** export buttons. The export row is now Assembly, Blender and SVG.
- **BE** (`export3mf.py`, `main.py`, `tests/test_export3mf.py`): the `print` and `fusion` layouts and their logic (`place_print`, the `layout` parameter of `GET /api/documents/{id}/export.3mf`, the plate-packing constants and their tests). The 3MF is now always the assembly, named `<name>-assembly.3mf`; `bed` still sets the plate size it is centred on.
- **README**: the "Known issues" note about the 3MF problem in Bambu Studio (the assembly 3MF imports fine) and the layout descriptions.

## 2026-10-26 - version in the document file name

### Changed
- **BE** (`main.py`, `tests/test_api.py`): the saved document file is named `<name>-v<n>.rasterfaster.json`, with `-edited` added when the working copy is ahead of the newest version (no suffix before the first version).

## 2026-10-26 - save a document as a file, restore it (0.5.0)

### Added
- **BE** (`main.py`, `versions.py`, `tests/test_api.py`): `GET /api/documents/{id}/export.rasterfaster` (one JSON file: the document and all its versions, `format: rasterfaster-document`) and `POST /api/documents/import[?onConflict=replace|copy]`: restores the document with its id and history; an existing id gives 409 unless `replace` (working copy and history replaced) or `copy` (new id). Invalid files (wrong format or version, bad id, duplicate version numbers) give 422.
- **FE** (`document-panel.ts`, `document.store.ts`, `document.api.ts`): "Document file" row with **Save file** and **Open file…** and an inline Replace / Import as copy / Cancel choice when the id exists. The restored document is opened; the two-window sync shows it in other windows. Tested against a throwaway API: delete a document with 2 versions and a working copy ahead of v2, import the file (same id, 3 parts, versions 2 and 1, changes since v2 kept), importing again asks, copy gives a second document, a damaged file is rejected, and replacing a document that was open in a second window updated that window. Version 0.5.0.

## 2026-10-26 - document versions v1, v2, ... (0.4.0)

### Added
- **BE** (`versions.py`, `main.py`, `tests/test_api.py`): immutable numbered snapshots of a document in `documents/<id>.versions/v<n>.json`. `POST /api/documents/{id}/versions` snapshots the working copy as the next version (no new one when nothing changed), `GET .../versions` lists them (newest first), `GET .../versions/{n}` reads one, `POST .../versions/{n}/promote` makes an old version the working copy and the new latest. Documents report `version` and `changedSinceVersion`; deleting a document deletes its versions.
- **FE** (`document.store.ts`, `document.api.ts`, `versions-dialog.ts`, `document-panel.ts`, `app.ts`, `app.html`, `app.scss`): a version pill next to the document name (`v3`, `v3 •` with changes since), ⌘S saves a new version, a versions dialog (view read-only, promote, back to the working copy) and a blue "Viewing vN (read-only)" bar; the store ignores edits and autosave while an older version is shown. Tested against a throwaway API: save v1, change, ⌘S gives v2, view v1 (read-only, name field disabled, working copy untouched on the server), promote gives v3 with v1's content. Version 0.4.0.

## 2026-10-26 - two windows on one document no longer overwrite each other (0.3.4)

### Added
- **BE** (`main.py`, `tests/test_api.py`): `PUT /api/documents/{id}?baseModified=<modified>` refuses with 409 (and the current document in `detail.current`) when the stored document is newer than the client's base; writes are serialised with a lock. `/api/health` now also returns `documents`, the newest modification time of any document. Without `baseModified` nothing changes.
- **FE** (`document.store.ts`, `document.api.ts`, `api-status.ts`, `app.ts`, `app.html`, `app.scss`): the store remembers the `modified` time it is based on and sends it with every save. When the health stamp changes, `checkRemote()` reloads the open document if another window saved it (notice "Updated from another window"), or, with unsaved local edits (or on a 409), shows a banner to load the other version or keep mine. Tested with two windows against a throwaway API: silent reload, conflict banner, keep mine (saved) and load theirs (saved state, other version shown). Version 0.3.4.

## 2026-10-26 - adding a part closes the quick look (0.3.3)

### Changed
- **FE** (`app.ts`, `tree-panel.ts`, `quick-look.ts`): every way of adding a part to the document (＋ Add to document, ⌘↓, Enter, double-click) closes the quick look popover; the "Added to document" flash is gone. Checked in the browser with a throwaway document (deleted afterwards).

## 2026-10-26 - quick look: always inside the window, solid view lit (0.3.2)

### Fixed
- **FE** (`quick-look.ts`): the quick look card is never larger than the free space in the window, however big the remembered size is (it keeps 12 px from the edges, shifts left on very small windows and follows window resizes); the remembered size itself is kept and applies again when the window is big enough. The corner handle therefore always stays reachable. Checked with a stored size of 3000x2500 and windows down to 480x360.
- **FE** (`quick-look.ts`): the solid view in the quick look was black because its scene had no lights. It now has an ambient light and a key light that follows the camera, so details show whichever way you orbit.

## 2026-10-26 - no more Preview mode (0.3.0, quick look size remembered in 0.3.1)

### Changed
- **FE** (`app.html`, `app.ts`, `quick-look.ts`): the Preview / Document switch is gone; the app is always the document. A file is looked at with the Space quick look, which now has its own view-mode switch (Solid, Wireframe, Hidden removed, Hidden dashed; stored as `rasterfaster.quickLookMode`) and can be resized by dragging its bottom-right corner (the size is remembered in local storage as `rasterfaster.quickLookSize`). Selecting a file in the tree no longer loads it into the 3D view. The old Preview code paths in `stl-viewer.ts` are unused and still there (to be removed later).

## 2026-10-26 - the API lives and dies with the PWA

### Changed
- **BE** (`app.py`, `requirements-app.txt`, `rasterfaster.spec`, `tests/test_appconfig.py`): Rasterfaster Server starts the API, opens the PWA and watches it: once the PWA window is closed (or the PWA quits) for 6 seconds the API stops, the PWA app is quit and the server app ends; it has no Dock icon in between. Without an installed PWA (or if it never opens) it keeps a Dock icon with Quit. `PwaWatch` holds the decision logic (tested with a fake clock); the window check uses Quartz (`pyobjc-framework-Quartz`).
- A launchd background service was tried and dropped: the backend should only run while the app is open.

## 2026-10-26 - Rasterfaster Server: the PWA is the UI

### Changed
- **BE** (`app.py`, `rasterfaster.spec`, `scripts/build-app.sh`, `tests/test_appconfig.py`): the packaged app is now **Rasterfaster Server.app**: it starts the API, shows a Dock icon (reopen opens the PWA, Quit stops the API) and opens the Rasterfaster PWA installed from the same address (found in `~/Applications/Chrome Apps.localized`), or the address in Chrome. The native pywebview window is removed (it ran in private mode, so localStorage was wiped on every start and no document showed): `pywebview` and its folder dialog are gone, `requirements-app.txt` now needs `pyobjc-framework-Cocoa` for the Dock icon; a missing library folder is set in `config.json` (see README).

## 2026-10-26 - Rasterfaster.app

### Added
- **BE** (`app.py`, `appconfig.py`, `main.py`, `rasterfaster.spec`, `requirements-app.txt`, `tests/test_appconfig.py`): a launcher that starts the API in a thread and shows the UI in a native pywebview window; `appconfig.resolve_paths` keeps the source layout when run normally and uses the bundle, `~/Library/Application Support/Rasterfaster` (documents, `config.json`) and a first-run seed of the existing documents when packaged. The restart endpoint works in the packaged app.
- `scripts/build-app.sh`: builds the Angular app, the icon (from the PWA icon) and `dist/Rasterfaster.app` with PyInstaller (`--install` copies it to /Applications). Tested: the built app serves the UI and API from its bundle, seeds and lists documents, loads the library, produces 3MF, SVG, glTF and .blend exports, restarts itself, and opens a 1440x900 window.

## 2026-10-26 - recover the document when the API comes back (0.2.6)

### Fixed
- **FE** (`document.store.ts` `recover()`, `api-status.ts` `checks`, `app.ts`): when the app was started while the API was down, the file list reloaded once the API came up but the document did not. On every successful API check the app now loads the document if none is loaded, or retries a failed save (unsaved edits are never overwritten by the stored version). Tested in the browser with the API simulated as down: a missing document loaded again, and a rename made while down was saved after reconnecting. Version 0.2.6.

## 2026-10-25 - Blender camera keeps the app's perspective (0.2.5)

### Fixed
- **FE** (`stl-viewer.ts` `viewParam`), **BE** (`blenderexport.py`, `tests/test_blenderexport.py`): a zoomed-in perspective view in the app has a narrow field of view (the camera zoom), but the export always used 35 degrees at the matching distance, so the Blender render looked much closer and more wide-angle than the app. The export now carries the view's effective vertical field of view (`view=...;persp;fov`) and the camera sits at the matching distance, so framing and perspective match; the lens in Blender is therefore not a fixed 35 mm any more but follows the view. Version 0.2.5.

## 2026-10-25 - Blender studio floor is see-through from below

### Changed
- **BE** (`blenderexport.py`): the studio floor in the .blend export is transparent when seen from below (backface mix with a transparent shader), so a camera below the floor plane sees the parts instead of a grey ground; it still catches shadows from above. Added a soft cool "Under fill" light so the underside of the parts is not black. Verified by exporting STROZZI with a camera below the floor and rendering it in Blender 5.0; a view from above still shows the floor and shadows.

## 2026-10-25 - Blender export: camera where the app's view is (0.2.4)

### Changed
- **BE** (`blenderexport.py`, `main.py`, `tests/test_blenderexport.py`): the Blender export no longer contains the fly-around animation or the "Camera path" line. Its camera ("App view camera") is a single static camera placed from `?view=dx,dy,dz;tx,ty,tz;height;persp|ortho` (orthographic or perspective, same visible height at the centre), or at the isometric Home view when no view is given. Bad `view` values give a 422.
- **FE** (`stl-viewer.ts` `viewParam`, `document-panel.ts`, `app.html`): the **Blender** button sends the 3D view's current camera, so the exported camera matches what you see. Version 0.2.4.

## 2026-10-25 - studio lighting in the .blend export

### Added
- **BE** (`blenderexport.py`, `main.py`): the `.blend` export now includes a studio setup: a dark matte floor under the parts, a dark gradient world, three area lights (warm key, cool fill, magenta rim), Cycles (96 samples, denoising) with AgX colour; the camera path line is hidden from renders. `?studio=false` gives the plain scene. Verified by exporting the STROZZI document through the API and rendering it headless in Blender 5.0.

## 2026-10-25 - Black PLA in the Blender export (0.2.3)

### Changed
- **BE** (`blenderexport.py`, `main.py`, `tests/test_blenderexport.py`): in the glTF / .blend export every part now uses one shared "Black PLA" material (near-black base colour, roughness 0.42, clearcoat 0.12 via `KHR_materials_clearcoat`) instead of the document colours. `?colours=true` on `export.glb` / `export.blend` keeps the document colours. Verified in Blender 5.0: one material, base colour, roughness and coat imported as set.

## 2026-10-25 - native .blend export (0.2.2)

### Added
- **BE** (`blenderexport.py`, `main.py`, `tests/test_blenderexport.py`): `GET /api/documents/{id}/export.blend` returns a real .blend, made by running Blender in the background on the glTF export (camera set as scene camera, frame range 0-6720, 1080p). Blender is found via `$BLENDER`, the PATH or the default install location; 503 when missing.

### Changed
- **FE** (`document-panel.ts`): the **Blender** button downloads the .blend (a .glb does not open in Blender by double-click). The glTF stays available from the API.

## 2026-10-25 - export buttons wrap (0.2.1)

### Fixed
- **FE** (`document-panel.ts`): the Blender and SVG export buttons were cut off at the right edge of the document panel; the export buttons now wrap onto a second line. Version 0.2.1.

## 2026-10-25 - Blender export (0.2.0)

### Added
- **BE** (`blenderexport.py`, `main.py`, `tests/test_blenderexport.py`): `GET /api/documents/{id}/export.glb` builds a glTF binary for Blender: one node per part with its colour, in document coordinates (Z up, metres), parts used several times sharing a mesh, "Do not export" parts left out. Unless `camera=false` it also holds a perspective camera animated (every 0.5 s, 280 s, closed loop) along the same path as the fly-around, framing the whole assembly, and the path as a line object. Verified by importing into Blender 5.0.
- **FE** (`document-panel.ts`): **Blender** export button.
- **FE** (`package.json`, `build-info.ts`, `ngsw-config.json`): version 0.2.0.

## 2026-10-25 - view cube labels

### Changed
- **FE** (`view-cube.ts`): the RIGHT label on the view cube is turned 90° counter-clockwise and the BACK label (which was upside down) is turned 180°.

## 2026-10-25 - API offline detection and versioning (0.1.0)

### Added
- **BE** (`main.py`, `tests/test_api.py`): `GET /api/health` liveness endpoint.
- **FE** (`api-status.ts`, `app.ts`, `app.html`, `app.scss`): offline detection, like uberflussigen: the API is polled every 5 s and on browser online/offline events; after two failures a red "Offline" banner shows, and when the API is back it hides and the file list reloads.
- **FE** (`scripts/version-metadata.mjs`, `scripts/bump-version.mjs`, `package.json`, `src/app/build-info.ts`, `ngsw-config.json`): versioning. `npm run bump:version -- X.Y.Z` updates package.json, `build-info.ts` and the service worker `appData.version`. The version (now 0.1.0) is shown in the panel header and on the "Update available" button.

## 2026-10-25 - fly-around loops

### Changed
- **FE** (`stl-viewer.ts`): the fly-around path is now a closed loop of 280 s (4 turns): each of its slow sine movements was nudged to a whole multiple of the loop frequency (at most about 5 % different in speed), so the end joins the start and the camera repeats seamlessly. The camera path line shows the whole closed loop.

## 2026-10-25 - view cube spacing

### Changed
- **FE** (`view-cube.ts`, `stl-viewer.ts`, `app.scss`): the view cube and the document panel below it sit 30 px lower, and the Home, fly-around and zoom reset buttons are 12 px further from it, so they no longer crowd the cube.

### Fixed
- **FE** (`stl-viewer.ts`): the fly-around zoom reset button was stretched across the view because its class name clashed with the rotate panel's Reset button.

## 2026-10-25 - fly-around zoom and camera outline

### Added
- **FE** (`stl-viewer.ts`): the fly-around keeps zooming (wheel / pinch): the zoom you add is a factor on top of the flight's own zoom. A new button next to the play/pause button (shown while flying) resets that factor.
- **FE** (`stl-viewer.ts`): with **Show camera path** on, a Blender-style camera outline (pyramid, frame, "up" triangle) is drawn at the camera's current point on the path.

### Changed
- **FE** (`stl-viewer.ts`): scrolling no longer stops the fly-around (dragging the view still does).

## 2026-10-25 - fly-around

### Added
- **FE** (`stl-viewer.ts`): **Show camera path** option in the view cube menu (saved in local storage) draws the fly-around path as an amber line around the assembly (next 140 s while flying, a preview from the current direction otherwise).
- **FE** (`stl-viewer.ts`): fly-around toggle (▶/⏸ button beside Home in document view, and an item in the view cube menu). The camera eases onto a wandering path around the assembly (azimuth sweep, elevation 12-72°, zoom relative to the fit for the current direction, drifting centre). Dragging or scrolling the view stops it. Works with both cameras.

## 2026-10-25 - BOM section for parts that are not exported

### Changed
- **FE** (`bom.ts`, `bom-dialog.ts`, `object-menu.ts`, `document-panel.ts`, `bom.spec.ts`): parts set to **Do not export** are now in the BOM, in a separate "Not exported" section below the main table (no total). The CSV has the same second section. The main list and its total still only count exported parts.

## 2026-10-25 - PWA

### Added
- **FE** (`public/manifest.webmanifest`, `public/icons/`, `public/apple-touch-icon.png`, `public/favicon.ico`, `ngsw-config.json`, `index.html`, `angular.json`, `app.config.ts`, `app.ts`, `app.html`, `app.scss`): installable PWA with manifest, icons (192, 512, maskable), theme colour and an Angular service worker (production only). An **Update** button appears when a new version is ready.
- **BE** (`main.py`, `tests/test_frontend.py`): the API serves the built frontend (SPA fallback) at `/`, with no-cache headers for the app shell and service worker files.

## 2026-10-25 - perspective camera

### Added
- **FE** (`stl-viewer.ts`, `document-scene.ts`): camera choice like Fusion 360, in the view cube's right-click menu under **Camera**: **Orthographic** (default), **Perspective**, and **Perspective with ortho faces** (perspective, but orthographic while the view looks straight at a cube face). Switching keeps the viewing direction and the apparent size at the view centre, so the model does not jump. Selecting, dragging, snapping handles (which keep their on-screen size), two-finger pan, pinch zoom, ⌘-click centering and rotating around the selection all work with both cameras. The choice is remembered in local storage.

## 2026-10-25 - page title

### Changed
- **FE** (`frontend/3d-tool/src/index.html`): the browser tab title is "Rasterfaster" (it was "3dTool").

## 2026-10-25 - part menu layout

### Changed
- **FE** (`object-menu.ts`): **Do not export** is the last item of the part context menu, below a divider (the order is now Copy / Cut / Paste, divider, Dim, Center on grid, Snap to grid…, Move to…, Move to ground, Move to base, divider, Do not export).

### Fixed
- **FE** (`object-menu.ts`): the part menu is kept inside the window (it moves up / left near the bottom / right edge and scrolls if the window is very short) instead of running off the bottom when opened low in the list.

## 2026-10-25 - Do not export

### Added
- **FE/BE** (`object-menu.ts`, `document.store.ts`, `bom.ts`, `backend/main.py`): part context menu item **Do not export** (toggle, ✓ when on) for mock models that are not printed. The flag is saved with the part (`noExport`); flagged parts get a ⊘ mark in the list and are left out of the 3MF exports (assembly, print plate, Fusion), the SVG drawing and the BOM (the BOM dialog notes how many parts were left out). The exporter does not even look for their STL files, so a mock without a file no longer blocks an export. An export where every part is flagged is refused with a clear message. Copy / paste keeps the flag.
- **BE** (`tests/test_export3mf.py`) and **FE** (`bom.spec.ts`, `clipboard.spec.ts`): tests for the flag in the exports, the BOM and the clipboard.

## 2026-10-25 - Home fits tighter

### Changed
- **FE** (`stl-viewer.ts`): Home (and the first fit of a document or model) zooms in closer. It now fits the box of the parts as seen from the current viewing direction, using the window's aspect ratio, instead of their bounding sphere: the model fills about 73 % of the limiting side of the view (`fitMargin` = 1.35) instead of about 55 %.

## 2026-10-25 - hide / show the file panel, Home button in the cube corner

### Added
- **FE** (`app.ts`, `app.html`, `app.scss`): the file panel can be hidden and shown with an icon button in the RASTERFASTER header or with **⌘B**; while it is hidden the same icon appears at the left end of the toolbar. The panel slides out and in (160 ms, the content keeps its width and is cropped instead of squeezed), the 3D view takes the freed width, the hidden panel is inert (no focus or tab stops inside) and the choice is remembered in local storage. The animation only runs for the toggle, so drag-resizing the panel stays instant.

### Changed
- **FE** (`stl-viewer.ts`, `app.scss`): the Home button is a small house icon in the top-left corner of the view cube's area (like Fusion 360) instead of a wide bar below the cube; the document panel moved up into the freed space.

## 2026-10-25 - black band at the bottom

### Fixed
- **FE** (`app.scss`): a black band showed below the app in Chrome (it survived reloads). The layout grid had an automatic row that only grew to its content, so the panel and the 3D view ended where the file list ended (found by measuring in real Chrome: root 963 px, main 562 px). The grid now has one explicit full-height row (`grid-template-rows: minmax(0, 1fr)`), and the invisible context-menu component (`app-object-menu`) no longer takes part in the grid (`display: contents`), where it had created a second, empty row.

## 2026-10-25 - resizable file panel, viewport fit

### Added
- **FE** (`app.ts`, `app.html`, `app.scss`): the file panel's right edge is a drag handle (like the sound library panel in Überflüssigen): drag to resize, double-click or Home for the default width (360 px), ← → with the handle focused (Shift: 100 px). The width stays between 240 px and 70 % of the window and is remembered in local storage. This replaces the browser's small native resize grip.

### Changed
- **FE** (`app.scss`): the app fills the viewport with `position: fixed; inset: 0` instead of `height: 100vh`, so it follows the viewport size the browser reports (100vh can go stale, e.g. around DevTools docking). Checked at 1912 × 989 and 1300 × 700.

## 2026-10-25 - one choke point for edits, drag cleanup

### Changed
- **FE** (`document.store.ts`): every change to a document now goes through one function, `mutate(label, change)`. It applies the change, skips it when nothing changed (no undo step, no save), writes the undo step and triggers the autosave. `patch`, `patchMany` and `commit` are gone or private, so an action can no longer change a document without being undoable and saved; `updateItems(label, changes)` is the helper for changing parts. All store actions, the scene (nudge, rotate, drag) and the position fields use it.
- **FE** (`document.store.ts`, `document-scene.ts`): a drag is a *gesture* (`beginGesture` / `endGesture` / `abortGesture`): every pointer move changes the document live, but only one undo step is written, when the gesture ends.

### Fixed
- **FE** (`document-scene.ts`): a drag that never got its pointerup no longer leaves the drag stuck. A cancelled pointer or **Esc** puts the part back where it was (no undo step); losing window focus or switching tabs ends the drag and keeps what was moved as one undo step. A gesture open for more than 30 s is closed by the next change.
- **FE** (`document-scene.ts`): Esc during a drag only cancels the drag, it no longer also deselects.

### Added
- **FE** (`document.store.spec.ts`): 8 unit tests for the history: one undo step per change, no-op changes, redo cleared by a new edit, gestures (live, one step, abort, nothing moved, a new gesture while one is open, a stale gesture).

## 2026-10-25 - copy / cut / paste

### Added
- **FE** (`clipboard.ts`, `document.store.ts`, `document-scene.ts`, `object-menu.ts`): ⌘C copies, ⌘X cuts and ⌘V pastes the selected parts; Copy / Cut / Paste are in the part context menu too. The clipboard holds content only (file, rotation, color, dimmed / centered flags, offsets from the group's lowest corner), never ids, and is kept in local storage so it survives reloads and works across documents and tabs. Paste lands at the view centre (lowest corner on the nearest grid intersection, heights and spacing kept, Center on grid parts re-centered), is one undo step and selects the pasted parts.
- **FE** (`clipboard.spec.ts`): unit tests for the copy / paste logic.

### Changed
- **FE** (`app.spec.ts`): removed the leftover "should render title" test from project creation.

### Fixed
- **FE** (`quick-look.ts`, `stl-viewer.ts`): after about 16 Space previews the 3D view turned white ("Too many active WebGL contexts"). The preview and the viewer now release their WebGL context when they are destroyed.

## 2026-10-25 - object actions, grid modes, view settings

### Added
- **FE** (`object-menu.ts`, `document.store.ts`): part context menu (right-click in the 3D view or the document list) with Dim (mute), Center on grid (toggle: keeps the footprint centered while dragged, nudged or rotated), Snap to grid… (pick a corner or side), Move to… (two-step corner-to-corner move) and Move to ground / Move to base (6 mm). Esc cancels the pick modes whatever has keyboard focus. Dimmed parts are barely visible, ignore clicks and can be brought back from the 3D view or the list; **V** dims or shows the selection.
- **FE** (`z-levels.ts`, `stl-viewer.ts`): height grid modes in the view cube's right-click menu (Grid mode): Fine (every 2 mm), Baseplate (2 mm, then 4 mm; default) and Coarse (every 4 mm), with unit tests. Shift+↑↓, PgUp / PgDn and Shift+drag follow the mode.
- **FE** (`stl-viewer.ts`, `view-cube.ts`): view cube right-click menu with **3D grid** (a lattice at every height level) and **Rotate around selection** (default on: rotating the view or dragging the cube pivots around the selected parts).
- **FE** (`app.ts`, `tree-panel.ts`): reload button for the file list (re-reads the root and the open folders, redoes the search) and the filter text is remembered.
- **FE** (`stl-viewer.ts`): trackpad like Fusion 360: two-finger scroll pans, pinch zooms towards the cursor; ⌘-click centers the view, double-click in the document list centers on that part.
- **FE** (`document.store.ts`, `document-scene.ts`): multi-select with ⌘-click and ⌘A, group move / rotate / duplicate / delete, 100 × 100 cell work area with a safety clamp and repair of corrupt positions.

### Fixed
- **FE** (`document-scene.ts`): a drag at a grazing camera angle could throw a part to Y = 6e16 and crash the grid; such moves are now ignored and the grid is capped.

## 2026-10-25 - initial import

### Added
- **BE** (`backend/main.py`): FastAPI app: library listing, search and STL streaming; document create / read / update / delete as JSON files in `documents/`; restart in place (`POST /api/runtime/restart`).
- **BE** (`backend/export3mf.py`, `backend/svgexport.py`): 3MF export (assembly, print plate and Fusion layouts) and SVG top / front / right drawing.
- **FE** (`frontend/3d-tool`): Angular app with the library tree (sort, filter with highlight, Finder-style keys, ⌘↓ adds, Space quick-look preview), STL viewer (solid / wireframe / hidden lines, view cube, 20 mm ground grid), document editor (grid snapping, rotate, undo / redo, BOM with CSV).
