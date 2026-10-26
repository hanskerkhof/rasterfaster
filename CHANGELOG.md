# CHANGELOG

Newest first. Every bullet starts with its scope: **FE** (frontend, `frontend/3d-tool`) or **BE** (API, `backend`).

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
