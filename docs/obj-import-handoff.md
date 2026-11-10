# OBJ import: handoff

For whoever picks this up later (a new session or a developer). `docs/obj-import-plan.md` has the plan and the open questions; this file has what was learned, where things are and how to start. Nothing of this is built. Written 2026-11-10.

## 1. Goal and status

Models from SketchUp and similar tools come as `.obj` + `.mtl` + texture images. The app only reads STL and 3MF, so today an OBJ has to be converted by hand.
Wanted: import an OBJ and get parts in a document, first as plain parts (one colour per material, phase 1), later maybe with the textures (phase 2).

| Phase | What | Status |
|---|---|---|
| 1 | Convert an OBJ into one STL per material (colour from the `.mtl`), via a catalog menu item | planned, not started |
| 2 | Textured parts in the 3D view and in the Blender render | planned, only if wanted |

Open questions for the user (also in the plan): units (inch/mm), up axis, one part per material or per object, missing `.mtl`, and whether textures are needed in documents at all.

## 2. The test case

Folder: `/Users/hanskerkhof/Documents/3D/RASTERFASTER/RF14.5 THE SWORD/excalibur sword/` (the user's files, do not commit them).

- `excalibur.obj` (SketchUp export, 2020): inches, same axes as `excalibur.stl` (blade along Z), 47 objects, 2,818 triangles, 2,911 vertices, 1,904 `vt`, 1,552 `vn`; 18 objects are line-only (no faces).
- 5 materials: `Metal_Aluminum_Anodized` 1,320 triangles, `excalibur_hilt` 511, `__Metal_Silver_1` 424, `Leather_Blue` 298 (these four have UVs, values about -22 to +25, i.e. tiled), and `material` 265 (no UVs). The faces use `v/vt/vn`; the `material` faces use `v//vn`.
- `excalibur/` holds 4 JPGs named like the materials (hilt 417 KB, the rest 4-56 KB).
- The OBJ names `excalibur.mtl` but it was missing. **I wrote one** (`newmtl` per material, `map_Kd excalibur/<name>.jpg`, flat grey for `material`) and put it next to the OBJ. With it Blender imports the sword textured; without it everything renders grey.
- `split/` holds the 5 STLs made by a throw-away script: scaled x25.4, minimum shifted to 0, no rotation, named `excalibur - <material>.stl`. Their combined bounding box is 28.18 x 2.14 x 149.49 mm, the same as `excalibur.stl`, so they line up with it. The user imported them into a document called "THE SWORD TEST" (5 parts, all one orange colour, no colours set yet).
- The throw-away script (not in the repo) was at `/private/tmp/claude-501/-Users-hanskerkhof-rasterfaster/3296e6a3-9b9e-41e8-8688-333d1835620b/scratchpad/split_obj.py`; it is about 40 lines: parse `v`, `f`, `usemtl`, fan-triangulate, group by material, scale, shift, write binary STL with computed normals. The scratchpad may be gone; the logic is in the plan.
- A Blender test render (textured) worked and the user approved it: import with `bpy.ops.wm.obj_import(global_scale=0.0254, forward_axis='Y', up_axis='Z')` gives the sword upright at 149.5 mm. The "Excalibur" scene may still be open in the user's Blender; it was never saved.

## 3. Where things are in the code

- Documents refer to parts by **STL `path`** (`DocumentItem.path` in `backend/main.py`); everything downstream loads STL bytes: `load_document_stls` (`main.py`), `export3mf.read_stl` / `build_3mf` / `place_assembly`, `svgexport.py`, the BOM, `blenderexport.build_glb`.
- `blenderexport.build_glb` writes positions and indices only (no normals, no UVs, no images) and one material per colour/finish (`colour_material`, `black_pla`). The Blender script then replaces materials by finish name (`_glass`, `_pei`, `_metal`, `_mirror`), so textures would also have to survive that.
- Frontend: parts load through `STLLoader` (`stl-viewer.ts`, `document-scene.ts` via `loadGeometry(path)`); scene, selection, snapping and Render mode work on bare `BufferGeometry` with their own materials. There is no OBJ/MTL loader in the app today.
- Similar existing code to copy the style from: `backend/import3mf.py` (a converter, numpy only), `backend/rf_library/` (library package), the catalog context menu in `frontend/3d-tool/src/library/catalog/catalog-menu.ts` and the file list menu in `frontend/3d-tool/src/library/tree/tree-panel.ts` (it already has Copy Name, Open in catalog, Quick Look).
- Library changes (rename, trash, backup) go through `backend/library_ops.py` and its rules; a converter that writes files into the library should respect the same backup and log rules (see `docs/file-management-handoff.md`).

## 4. How to start phase 1

1. Answer the open questions with the user (units and up axis at least; the defaults I would take: ask at import, remember per folder; Z-up).
2. `backend/importobj.py`: parser + converter (see the plan, section Phase 1); tests in `backend/tests/test_importobj.py` with a tiny OBJ.
3. Endpoint under `/api/library/` that takes the OBJ path and writes the STLs into a folder next to it; reuse `LibraryError` and the write lock like the other library endpoints.
4. Catalog / file list: show `.obj` files and add *Convert to STL parts...*; optional *Add all to the document* as one group.
5. README, CHANGELOG, version bump; commit only when the user asks. Restart the API after backend changes through the runtime restart endpoint (see the user's memory notes), never by killing it.

## 5. Things to watch

- OBJ indices can be negative (relative) and faces can be quads or n-gons; `f a//n` has no UV; a material can be used by many objects.
- `.mtl` and texture paths are relative to the OBJ, may use backslashes, may be missing or wrong (like here).
- Do not write into the user's folders without being asked; the sword folder now has `excalibur.mtl` and `split/` that the user asked for.
- Hidden or tiny things in the OBJ: line-only objects (18 here) must not become empty STLs.
