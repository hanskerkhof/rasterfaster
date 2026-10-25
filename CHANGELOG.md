# CHANGELOG

Newest first. Every bullet starts with its scope: **FE** (frontend, `frontend/3d-tool`) or **BE** (API, `backend`).

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
