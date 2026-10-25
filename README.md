# RASTERFASTER composition tool

Two processes:

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
GET /api/documents/{id}/export.3mf?layout=assembly|print&bed=256
```
- `assembly` – parts exactly as assembled, centred on the plate.
- `print` – every part flat in its library orientation, shelf-packed on a `bed` × `bed` mm plate (overflow continues past the edge; use Arrange in Studio).

Keyboard (Document mode): arrows move X/Y, Shift+↑↓ / PgUp PgDn move Z, Shift+←→ turn about Z, X/Y/Z keys rotate about that axis (Shift = reverse), V dims / shows the selection, Alt = 1 mm steps, ⌘-click centres the view on the clicked point (both modes), ⌘Z/⇧⌘Z undo/redo, ⌘D duplicate, Delete removes.

## Trackpad / mouse

Two-finger scroll pans the view (the scene follows your fingers), pinch zooms towards the cursor, one-finger drag orbits. With a mouse: Option + wheel zooms, plain wheel pans.

## Object context menu

Right-click a part (3D view or document list): **Dim (mute)** turns it into a barely visible ghost that ignores clicks (⌘A skips it too) — handy for working on what's inside a cover. Right-click the ghost (in the 3D view, where a solid part in front takes priority) or its row in the list to bring it back. **Center on grid** is a toggle (✓ when on, ⌖ in the list): it centers the part's footprint in the nearest 20 × 20 cell and keeps it centered while it is dragged, nudged or rotated — handy for bolts, nuts and spacers. Turn it off to move freely again. **Snap to grid…** is a one-time action: handles appear on the corners and side middles of the part (bottom plane), and clicking one puts that point on the nearest 20 mm grid intersection (height unchanged; Esc cancels; a part set to stay centered stops being centered). **Move to ground** drops the part so its lowest point is at z = 0 (several parts keep their heights relative to each other). **Move to…** is a two-step move: first click a corner of the selected part (handles on all 8 corners of its box), then a corner of another part (handles appear on every other part): the selection snaps so the two corners coincide. Esc cancels either pick mode, whatever has keyboard focus.

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

## SVG drawing

```
GET /api/documents/{id}/export.svg
```
Top / front / right view of the assembly: feature lines (sharp edges, silhouette, open boundaries) in each part's colour on a 20 mm grid, numbered legend, overall size; hidden edges are dashed. No occlusion between parts.

## Known issues

- 3MF in Bambu Studio: a problem was reported but not yet described (which layout / what looks wrong). Not verified in Studio yet.
