# OBJ import: plan

Status: plan only, nothing built. Written 2026-11-10 after the excalibur test (`RF14.5 THE SWORD/excalibur sword`).

## Why

Models from SketchUp and others arrive as `.obj` with a `.mtl` and texture images. The app only knows STL (and 3MF). Today an OBJ has to be split by hand,
one STL per material (done once for the sword with a throw-away script). We want the app to do it.

## What the test showed

- The OBJ is in **inches**, with the same axes as the existing STL (blade along Z). Only a scale of 25.4 and a shift of the minimum to 0 were needed.
- 47 objects, 2,818 triangles, 5 materials. 4 have a texture image and UVs (2,553 triangles), 1 (`material`, 265 triangles) has no UVs.
- The `.mtl` was missing (the OBJ names `excalibur.mtl`); without it Blender renders everything grey. A hand-written `.mtl` fixed that.
- Splitting by material gave 5 STLs that line up exactly with the original (bounding box 28.18 × 2.14 × 149.49 mm).
- Everything downstream (document items, 3MF, SVG, BOM, Blender/glTF export, the render) loads parts as **STL bytes by `path`**
  (`backend/main.py: load_document_stls`, `export3mf.read_stl`, `blenderexport.build_glb`, `stl-viewer.ts` / `document-scene.ts` through `STLLoader`).
  That is why a split into STLs needs no change in those places, and real textures need changes in all of them.

## Phase 1 (recommended first): OBJ becomes plain parts, one colour per material

Goal: import an OBJ and get one part per material, in the right size and position, with a colour taken from the material. No texture.

1. **Backend converter** (`backend/importobj.py`, next to `import3mf.py`, numpy only, same style):
   - parse `v`, `f` (triangulate quads and n-gons as a fan), `usemtl`, `mtllib`; ignore `vt`, `vn`, `l` (lines) and `o`/`g` names beyond what is needed;
   - group triangles by material, drop empty groups (the 18 line-only objects vanish);
   - units: assume inches only when told to (see Open questions); apply scale, optional Y-up to Z-up turn, shift the minimum to 0;
   - write one binary STL per material, named `<file> - <material>.stl`, into a folder `<file>/` next to the OBJ in the library (like my `split` folder);
   - read `Kd` from the `.mtl` (when present) as the suggested colour; fall back to the app's palette.
2. **Where it runs**: an API endpoint (`POST /api/library/import-obj` with the library path) and a catalog context menu item on `.obj` files, *Convert to STL parts…*.
   The result is ordinary STL files, so they appear in the file list and can be added to a document like any part (the document item gets the colour).
3. **Catalog / file list**: show `.obj` files in the list (they are hidden today), with the menu item above. Quick Look of an OBJ: not in phase 1.
4. **Add as a group**: when converted from the menu, offer *Add all to the document* so the parts land as one group (documents already have groups), same position.
5. **Tests**: unit tests for the parser and converter with a tiny OBJ (two materials, one quad, one missing `.mtl`), checking triangle counts, bounding box and file names.
6. **Docs**: README section, CHANGELOG, version bump (the repo's usual rules); do not commit the user's sword files.

Size: small to moderate; one new backend module, one endpoint, one menu item, tests. No change to documents, exports or the renderer.

## Phase 2 (only if wanted): textured parts end to end

Goal: show the texture images in the 3D view and use them in the Blender render.

- **Storage**: keep the textured parts as a new kind of library item (not STL): a converted package with mesh + UVs + images, e.g. a `.glb` or an own folder format.
  The document item needs a way to say which kind it is (`DocumentItem.path` is an STL path everywhere today).
- **Frontend**: load the package with Three.js (`GLTFLoader`, or `OBJLoader` + `MTLLoader`); the document scene, selection, snapping, Render mode and the
  Quick Look use bare `BufferGeometry` with their own materials, so textured parts need their own material path and Render mode finishes must decide what they do
  with a texture.
- **Backend**: `read_stl` users (3MF, SVG, BOM, STL zip) need a geometry-only read of the package; the 3MF export cannot carry the texture (it would export geometry
  and the part colour only).
- **Blender export** (`blenderexport.py`): today `build_glb` writes positions and indices only with no normals; it must also write `TEXCOORD_0`, images and a
  `baseColorTexture` per material, and the Blender script must keep them (the finish code for metal, glass and PEI replaces materials by name).
- **Tests and size**: JPG sizes (hilt 417 KB) in documents and the glTF; limits on image size.

Size: large. It touches the loader, the scene, all exports and the render. Worth it only if textured models are going to be common.

## Open questions

1. Units: how does the app know an OBJ is in inches or millimetres? Options: ask at import (mm / cm / inch / m), guess from the size, or remember a default per folder.
2. Up axis: Y-up (most OBJ files) or Z-up; ask once, default Z-up since the sword already was.
3. Several objects of one material: merge into one STL (phase 1 as written, simplest) or keep one part per OBJ object (47 parts for the sword, usually too many)?
4. Missing `.mtl`: warn and use palette colours, or offer to write one from the textures found next to the file?
5. Phase 2: is a textured part going to be needed in documents, or is a good render of an OBJ (done in Blender directly) enough?

## Not in scope

- Writing OBJ files (export), vertex colours, normals and smoothing groups, quad-preserving meshes.
- Changing the existing STL or 3MF paths.
