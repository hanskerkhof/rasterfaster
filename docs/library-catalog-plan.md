# Library catalog ("Parts catalog") — plan

Status: phase 0a (backend) and 0b (frontend folder + barrel) done on branch `library-extract`; the rest is plan only. Inspired by https://bernies.audio/pages/speaker-archive.

## Goal

A near full-screen dialog to browse **every STL in the library** as a catalog of line drawings, with fast filtering and a detail page per part. Browse and add to the document, plus **library management** (rename, move, duplicate, new folder, move to Trash) that can be switched on and off, so the catalog is also the tool for cleaning up doubles and `_old` folders. The library will shrink as it is cleaned up; the ~6,500 files are a starting point, not the target.

## What we learned from the reference

- Dark, monospace, technical-drawing look: thin 1 px grid lines, tiny uppercase labels, white line art on near-black.
- Header block: title, key/value stats (entries, drawn, pending).
- Filter rows: label on the left, chips with counts on the right (Type, Class, Size, Drawing), then Sort (No., Model, Year, Size) and a Grid/List toggle, then Find (`/` focuses it).
- "Showing 210 / 210" + "Query: …" status line.
- Card: `NO.017` top left, category code top right (`SPK/BKS`), drawing, model name, one-line meta.
- Click opens a detail page: `NO.017 / 210 · SPK/BKS`, `CLOSE [ESC]`; big drawing (`FIG. 017`) left, key/value spec table right, `← 016 718A` / `018 815A →` footer. Deep link by hash (`#altec-755-8-ball`).

## Decisions (answered)

| Question | Decision |
|---|---|
| Entry | Every STL file (~6,500; 114 at root, most 2–3 folders deep) |
| Thumbnails | Line drawings generated in the browser with the existing hidden-lines-removed renderer, cached by the API |
| Filters v1 | Find, Folder/project, Sort + Grid/List |
| Click | Detail page inside the dialog |

## Data

No new metadata store in v1; everything is derived.

- **Entry list**: one call returning all STLs: `path`, `name`, `folder` (top-level), `modified`, `size`. New endpoint `GET /api/catalog` (a flat `os.walk`, same filters as `/api/list`: skip dot files, `.stl` only). Fast enough for 6.5k files; cached server side until the library changes (the app already knows when it changes: trash, rename, move, Put Back).
- **Number (`NO.001`)**: position in the current sort order over the whole library (stable by natural path order), not stored.
- **Code (`SPK/BKS` analogue)**: top-level folder number, e.g. `10.17` (folders are named `10.17.FRAME HANGING SYS`); root files get `—`.
- **Meta line**: `W × D × H mm · volume · modified`. The bounding box needs the STL header/vertices, so it comes from the thumbnail pass (below) and is stored in the thumbnail cache index; shows `…` until known.
- **Used in**: which documents contain the part (the API already finds these for Trash: reuse for the detail page).

## Thumbnails

**Decided order:** thumbnails come before management (phase 2 before phase 4).

- Render in the browser with `buildParts(…, 'hidden-removed', …)` from `model-render.ts` + `silhouette.ts`, isometric, white 1 px lines on transparent, a shared offscreen WebGL renderer (one canvas for all cards, 256 px).
- **Lazy**: only for cards in or near the viewport (IntersectionObserver), a queue of 1–2 at a time so the UI stays smooth.
- **Cache**: `PUT /api/catalog/thumb?path=…` stores an SVG or PNG next to the app data (**decided:** the hidden folder `~/Documents/RASTERFASTER_APP/.catalog-cache/`, so it never shows in the document list; keyed by path + mtime); `GET` serves it. Second visit is instant; a changed file (mtime) re-renders. Also stores the bounding box and volume in a small JSON index.
- **Decided:** SVG first (the hidden-line SVG exporter `svgexport.py` or the browser's own line data: crisp at any size, tiny); fall back to PNG from the canvas if SVG is too slow or too big.
- **Decided: large files are skipped.** An STL over a size cap (start at ~20 MB, adjustable in one constant) is not drawn automatically: its card stays `PENDING` with the note `LARGE FILE` and a **Draw anyway** button.
- Placeholder while pending: the card frame with `PENDING` marker, like the reference's Drawing filter.
- Option for later phase: a "Draw all" button that fills the cache in the background.

## UI

New standalone component `catalog-dialog.ts` inside the library package (`projects/rf-library/src/lib/catalog/`, exported as `RfCatalogDialog`; same pattern as `trash-dialog.ts`), opened from a **Catalog** button near the Trash button in the app shell, key `⌘K`-style shortcut TBD. The endpoints named in this plan (`/api/catalog`, thumbnails) are routes of the `rf_library` router.

```
┌ PARTS CATALOG ─────────────────────────── 6 476 parts · 325 folders ┐
│ FOLDER  [ALL 6476] [1.4 BOLTS & NUTS 312] [10.17 FRAME … 88] …      │
│ SORT    NAME · DATE · SIZE  |  GRID · LIST                           │
│ FIND    > name, folder …                                  [ / ]     │
│ SHOWING 6 476 / 6 476                              QUERY: ALL       │
│ ┌──────┬──────┬──────┬──────┐                                        │
│ │NO.001│      │      │      │   cards: drawing, name, meta           │
│ └──────┴──────┴──────┴──────┘  (virtual scroll)                      │
└─────────────────────────────────────────────────────────────────────┘
```

- Dialog ~ `calc(100vw - 32px) × calc(100vh - 32px)`, backdrop, Esc closes (reuse `escape-close.ts`), focus returns to the tree.
- **Grid**: CSS grid, `auto-fill, minmax(220px, 1fr)`, **virtual scrolling** (only visible rows exist in the DOM; Angular CDK `cdk-virtual-scroll` or a small hand-rolled row window — decide in step 1 based on whether CDK is already a dependency).
- **List**: one row per part: no., name, folder, size, modified, small drawing.
- **Folder chips**: the top-level folders with counts, multi-select off in v1 (one folder or all); horizontally scrollable, wraps on narrow widths.
- **Find**: reuse `searchterms` syntax (`-exclude`, any/all) via the same logic as `filter-terms.ts`, client-side over the in-memory list (6.5k names: instant).
- **Sort**: name (natural), date modified, size (bounding box, once known; unknown last). State remembered in local storage like `rasterfaster.sort`.
- **Detail page** (inside the dialog): `NO.017 / 6476 · 10.17` + `CLOSE [ESC]`; large drawing left with an orbitable Quick-Look-style 3D toggle (reuse `app-quick-look` internals); right: key/value table (NAME, FOLDER, PATH, SIZE W×D×H, VOLUME, MODIFIED, USED IN, ID); actions **Add to document**, **Find in browser**, **Reveal in Finder**; `← prev` / `next →` footer, ←/→ keys; deep link `#catalog=<path>` so the browser Back button works.
- Theme: the reference's dark mono style; follow the app's existing colours and font tokens, so it fits (the app is dark already).

## Management (CRUD, switchable)

**Switch.** One **Manage** switch, and it belongs to the **library only**. The library is one thing, shown by its file browser (tree/list) and its catalog; the switch is a property of that library, not of two screens. Off: the library is read-only everywhere it appears (no checkboxes, rename, move, drag-and-drop, New Folder, Duplicate, Trash or delete; their menu entries and the ⌘⌫ / ⌥⌘⌫ shortcuts are hidden or ignored). On: all of those are available. Browsing, selecting, adding a part to the document, Find in browser, Reveal and opening the Trash dialog work in both states.

Nothing outside the library is affected: documents, the parts list, the document panel, versions, images and exports ignore the switch. The `ManageService` is owned by the library package (see "Library separation"); the app shell only renders the toggle in its top bar. It is remembered in local storage (`rasterfaster.manage`) and **on by default**, so nothing changes for you until you turn it off. Document in the README and CHANGELOG.

**Reuse, no new file logic.** All operations go through the existing library API and `library_ops.py`, so the safety (backups, document path updates, dry runs) stays in one place:

| CRUD | Catalog action | Existing endpoint |
|---|---|---|
| Create | New folder; Duplicate a part | `/api/library/new-folder`, `/api/library/duplicate` |
| Read | The catalog itself | new `/api/catalog` (+ `/api/list`, `/api/file`) |
| Update | Rename; Move to folder (drag onto a folder chip, or a Move… picker) | `/api/library/rename`, `/api/library/move` |
| Delete | **Move to Trash** (same Trash as the app: put back, delete for good) | `/api/library/trash-batch` (with `dryRun` first) |

Permanent delete stays in the Trash dialog only; the catalog never deletes for good.

**Selection.** Manage mode adds a checkbox on every card/row, Shift-click for ranges, ⌘A for all in the current filter, and a bar at the bottom: `N selected · Move… · Move to Trash · Clear`. Same keyboard as the file list (⌘⌫ to Trash). The detail page gets the same buttons for its one part.

**Safe trashing.** A dry run first (the API already reports the documents that use the files); the confirm dialog lists "used in N documents" and the parts keep working via the existing missing-file warning (⚠) and Put Back. One Trash batch per action, so a single Put Back undoes it.

**Cleanup helpers** (the reason for management mode):
- **Doubles filter**: group parts with identical content (size, then a hash computed by the API once and cached with the thumbnail index). Chip `DUPLICATES n`; cards of a group are shown together, with the newest or the one used in documents marked, and a one-click "Trash all but this one".
- **Old-folder filter**: chip `_OLD n` for paths with a folder or name containing `_old`, `old`, `backup`, `copy`, `(1)` (list editable in the code, not in the UI for v1).
- **Unused filter**: parts that no document uses (from the same documents scan), handy before trashing.
- Count in the header (`6 476 parts`) updates live, so progress of the cleanup is visible.

**Refresh.** After any change the catalog list, the tree, and the document missing-file checks are refreshed by the same event the tree already uses (`onRenamed`, `onMoved`, `onTrashed`); the thumbnail cache entry follows a renamed/moved file (key by path+mtime, with a rename map) and is dropped for trashed files.

**Tests.** Backend: the catalog reflects changes after trash/rename/move; duplicate grouping and the cache index. Frontend: selection logic (range, all, clear) as pure functions with specs, and the Manage toggle hides every mutating control when off.

## Library separation (publishable on its own)

Goal: everything about "the library" (browse, tree, catalog, thumbnails, quick look, trash, management) lives in one self-contained unit with a small public API, so it can be published separately (an npm package, and/or the Python part as its own service/package) and used by the app as just another consumer. The app depends on the library, never the reverse.

### Today (what is already library code)

Frontend, all in `src/app/` and mixed with the document code: `library.service.ts`, `tree-panel.ts`, `delete-dialog.ts`, `trash-dialog.ts`, `quick-look.ts`, `model-render.ts`, `silhouette.ts`, `filter-terms.ts`, `tree-selection.ts`, `escape-close.ts` (+ specs). They only import each other (checked), except that `tree-panel` is wired into `app.ts`/`app.html` with document-specific outputs (`add`, `relink`, `reveal`, …). Backend: `library_ops.py`, `searchterms.py` and the `/api/list|search|file|library/*` routes inside the 1,500-line `main.py`.

### Angular structure (Angular 22: standalone, no NgModules)

Angular no longer needs NgModules; the "module" is a **workspace library** with a public API barrel:

```
frontend/3d-tool/
  projects/
    rf-library/                  # the publishable library (ng-packagr)
      ng-package.json  package.json   (name e.g. @rasterfaster/library)
      src/public-api.ts            # the ONLY import surface
      src/lib/
        core/       library.service, library.config (tokens), manage.service, models
        tree/       tree-panel, tree-selection, delete-dialog, trash-dialog
        catalog/    catalog-dialog, catalog-grid, catalog-detail, filters, sort
        preview/    quick-look, thumbnail renderer + queue, model-render, silhouette
        util/       filter-terms, escape-close
  src/app/                         # the app (documents, 3D scene, render, …) imports '@rasterfaster/library'
```

- **Public API** (`public-api.ts`): `provideRfLibrary(config)`, `RfCatalogDialog`, `RfLibraryTree`, `RfQuickLook`, `RfTrashDialog`, `LibraryService`, `ManageService`, and the types (`LibraryEntry`, …). Everything else is internal (not exported).
- **No document knowledge inside.** Things the library needs from the host come through DI tokens/outputs, never by importing app code:
  - `RF_LIBRARY_CONFIG`: `{ apiBase: '/api', manageStorageKey, readOnly?: boolean, features: {...} }` (replaces the hard-coded `/api` paths).
  - `RF_LIBRARY_HOST` (optional adapter): `usedInDocuments(paths)`, `onPartsMissing(...)`, `addToDocument(entry)` — the app provides it; the catalog's "Used in" / "Add to document" / the missing-file ⚠ checks call it and hide themselves when it is not provided. A published stand-alone catalog therefore works without documents.
  - Outputs on components (`(addPart)`, `(relink)`) stay, as they are now.
- **ManageService lives in the library**; the app only renders the toggle (`<rf-manage-toggle>` exported by the library) in its top bar. `readOnly: true` in the config forces Manage off and hides the toggle (for a published/read-only catalog).
- **Dependency rule enforced**: path alias `@rasterfaster/library` → `projects/rf-library/src/public-api.ts`; an ESLint `no-restricted-imports` (or ng-packagr's own boundary: the library cannot import from `src/app`) so the library never reaches into the app; and the library cannot deep-import its own internals from outside (only the barrel).
- Third-party: `three` becomes a `peerDependency` of the library; `@angular/core` etc. likewise. Styles: the library ships its own SCSS with CSS custom properties (`--rf-bg`, `--rf-fg`, `--rf-line`) with app-matching defaults, so a host can theme it.
- Tests move with the code (`projects/rf-library/**/*.spec.ts`); the app's `bom`/`document` specs stay.

### Backend structure

```
backend/
  rf_library/                 # importable package (own pyproject later)
    __init__.py               # create_router(config) -> fastapi.APIRouter
    router.py                 # /api/list, /search, /file, /library/*, /catalog, /catalog/thumb
    ops.py                    # was library_ops.py
    searchterms.py
    catalog.py                # scan, hashing, thumbnail/index cache
    config.py                 # LibraryConfig(root, cache_dir, trash_dir, read_only, on_change hook)
  main.py                     # builds the app, mounts rf_library.create_router(...) + documents, render, ws
```

- The library router takes its settings explicitly (`root`, `cache_dir`, `trash_dir`, `read_only`) instead of the module globals in `main.py` (`libraryRoot`, …). `read_only=True` rejects every mutating route (403), matching the frontend Manage-off state: the safety is on the server too, not only in the UI.
- The only coupling to documents is an optional callback `on_paths_changed(renames, trashed)` that `main.py` supplies to update document files (what rename/move/trash do now through `library_ops`), and `documents_using(paths)` for the dry run. Without them the library works alone.
- Behaviour stays identical: this is a move-and-wire refactor with the existing API tests (`test_library_ops`, `test_api`, `test_searchterms`) as the safety net, run before and after.

### Two ways "publish separately" can be used (supported by the same design)

1. **The code**: `@rasterfaster/library` on npm (or a private registry) and `rf-library` on PyPI, used by other apps.
2. **The parts themselves** (like Bernie's archive): a read-only build of the catalog for the web. Because the catalog is just the library component with `readOnly: true` and no host adapter, a small static export (`catalog.json` + the cached thumbnails and the STLs) can be served without the Python API: the library service gets a second implementation behind the same interface (`StaticLibraryBackend` reading `catalog.json`). Not in v1, but nothing in the design blocks it.

### Order of work

The separation is done **before** the catalog is built, so the catalog is written in the right place from the start:

0. **Extract** (no behaviour change, tests after each step): (a) backend: `backend/rf_library` with the router, `ops.py` and `searchterms.py`, config passed in by `main.py`; (b) frontend (done: `src/library/` with `public-api.ts`, alias `@rasterfaster/library`, `RF_LIBRARY_CONFIG` for the API base, and `npm run check:boundaries`; the app's generic helpers `escape-close`, `model-render`, `silhouette` and `tree-selection` are library exports): the library files into one folder with the barrel `public-api.ts`, the tokens/config, and the lint rule that keeps the dependency one way; (c) only when publishing: promote that folder to an ng-packagr workspace library (`projects/rf-library`).
Then phases 1–6 below add to the library package.

## Phases

0. **Extract the library** (see above), in three steps: (a) backend router split, (b) frontend folder + barrel + lint rule, (c) ng-packagr package only when publishing; no behaviour change, tests after each.
1. **Skeleton**: `GET /api/catalog` + test; dialog shell, button, Esc, grid with names only, Find, folder chips, sort. (Everything works without pictures.)
2. **Thumbnails**: shared offscreen renderer + queue, cache endpoints + tests, cards show drawings, bounding box/volume in the index, size sort.
3. **Detail page**: layout, prev/next, deep link, Add to document / Find in browser / Reveal.
4. **Management**: Manage toggle in the top bar (one library-owned switch; specs that every control that changes the library is hidden when it is off), selection and bottom bar, Move to Trash (dry run + confirm), Rename, Move…, New folder, Duplicate on the existing endpoints; refresh events. This can come right after phase 1 if cleaning up matters more than pictures.
5. **Cleanup helpers**: content hash + Doubles filter, `_OLD` and Unused filters, "Trash all but this one".
6. **List mode and polish**: List view, remembered state, empty states, keyboard (`/` focuses Find, arrows move the card focus), performance pass on 6.5k, README + CHANGELOG + version.

Each phase ships on its own and is testable.

## Tests

- Backend: catalog endpoint (skips dot files and non-STL, top-level folder, root files), thumbnail cache (put/get, mtime invalidation, path traversal rejected).
- Frontend: filter + sort logic as pure functions with specs (like `filter-terms.spec.ts`), numbering stability.
- Manual: scroll through all 6.5k in grid; thumbnails fill in without jank; Esc/focus behaviour.

## Risks to the existing app

Ranked by how much they could hurt what works today. Phase 0 carries most of the risk.

**High**

1. **Phase 0 touches working code.** It moves about ten frontend files and splits the library routes out of `main.py`; that code does renames, moves and Trash, which also rewrite document paths and make backups. A slip means a broken import, a route that no longer matches, or documents whose paths stop updating. Run the existing tests before and after, and change no behaviour in the same step.
2. **Build and packaging.** The Angular workspace goes from one project to two (`angular.json`, tsconfig paths, `proxy.conf.json`, the PWA service worker config, `bump-version.mjs`). The new `rf_library` package must be picked up by `rasterfaster.spec` (PyInstaller) and `build-app.sh`; it can work in dev and be missing from **Rasterfaster Server.app**. Also check `dev_stack.py` and `test_frontend.py`.
3. **Real library data.** Management mode with a doubles filter and bulk selection can trash thousands of files at once. A wrong "keep this one" choice trashes a part documents use (they show the ⚠ warning; Put Back fixes it). Develop and test against a throwaway copy of the library via `RF_ROOT`, never the real one.

**Medium**

4. **The tree is entangled with the app** (`app.ts`: relink, Find in browser, reveal paths, filtering, the missing-file check). A host adapter between them can quietly break one of those flows.
5. **Manage defaults to on but gates existing controls and shortcuts.** If the gating misses a case, a shortcut such as ⌘⌫ stops working or a menu entry disappears (for example in relink mode).
6. **Performance next to renders.** Thumbnail fetches, content hashing and the library scan share one API process with Blender renders and the websocket; the catalog adds a third WebGL context beside the main 3D view and Quick Look. Mitigations: low-priority background hashing, one shared renderer, a queue limit, a per-file size cap.
7. **Settings and keys.** Local storage keys such as `rasterfaster.sort` keep their names, or remembered settings reset. The same applies to the `rasterfaster.manage` default.
8. **Dialogs and keyboard.** A near-full-screen dialog must cooperate with the existing Esc handling, focus return and global shortcuts (Esc in the catalog must not also deselect or close something behind it).

**Low**

9. **Cache location.** The thumbnail cache lives next to the documents in `RASTERFASTER_APP`: keep it out of the document list and out of the repo; drop entries on rename, move and Trash.
10. **Housekeeping.** Version bump, changelog and README for each shipped phase; restart the API through the restart endpoint, never kill it.

### How to reduce the risk

- Do phase 0 in small steps, running the tests after each:
  1. Backend: split the library routes into the `rf_library` router, no logic change.
  2. Frontend: move the library files into one folder with a barrel (`public-api.ts`) and the lint rule that keeps the app-to-library dependency one way.
  3. Only then the ng-packagr package. It is the most build-fragile step and is only needed when the library is actually published.
- Check the packaged `.app` after every build or packaging change, not just dev mode.
- Ship phase 1 (the names-only catalog) before thumbnails and management, so value shows early and any problem stays small.
- Work on a branch; nothing is committed until you ask.

## Other risks / open points

- **First-open cost**: 6.5k thumbnails is a long render pass; lazy loading and the cache keep it fine, and the library will shrink as you clean up (trashed files drop out of the cache). Very large STLs may take long: add a per-file size cap and a placeholder. Cleaning first with names only is possible, because the management phase does not need pictures.
- **Mass operations**: selecting thousands and trashing them. Mitigation: dry run, Trash (reversible), one batch = one Put Back, and a confirm that names the count and the documents affected.
- **Hashing 6.5k files** for doubles: done once in the background and cached by path+mtime.
- **Large STL download** per thumbnail through `/api/file`: fine on localhost; consider a server-side bounding box (header parse) if slow.
- **Names are the only metadata**: the catalog is as good as the folder naming. Later: tags and notes per part, stored in the app data, not in the library.

## Not in v1

Permanent delete from the catalog (Trash dialog only), importing/uploading new STLs, editing STL content, multi-folder filters, tags/favourites, year/size-class chips, drag from catalog into the 3D view, "Draw all" background job, Projects (folder-level) view.
