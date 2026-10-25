# CHANGELOG

Newest first. Every bullet starts with its scope: **FE** (frontend, `frontend/3d-tool`) or **BE** (API, `backend`).

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
