# File manager: handoff

For whoever builds the next phases (a new session or a developer). It describes what exists, how it is built, the rules every operation follows, and every phase that was imagined, with enough detail to start. `docs/file-management-plan.md` is the earlier, shorter plan; this file supersedes it.

## 1. Goal and status

The file list (the library tree on the left) is becoming a **file and directory management tool** for the STL library (`~/Documents/3D/RASTERFASTER`, 8 GB, ~thousands of long-named files), in phases. The user wants it to feel like the **macOS Finder** and never to lose an original file.

| Phase | What | Status |
|---|---|---|
| 1 | Rename files and directories, first-time backup, documents follow | built (0.7.x) |
| 3a | Trash: Move to Trash, Undo bar, Put Back, Delete Immediately, Empty Trash | built (0.8.0) |
| 2a | Multi-select in the tree, Trash for the whole selection | built (0.9.0) |
| 2b | New folder, Move to… (drag and drop), Duplicate, Reveal in Finder, Copy path | **next** |
| 3b | History view of the log with Undo | planned |
| 4 | Batch rename (preview), batch move/delete | planned |
| 5 | Tags and metadata | planned |
| 6 | Insight: where used, unused, broken references, duplicates | planned |
| 7 | Import by drop, thumbnails, size/triangle columns | planned |
| 8 | Backup browser and maintenance | planned |

## 2. Where things are

**Backend** (`backend/`, FastAPI, Python 3.13, venv `.venv1`)
- `library_ops.py`: all library changes. `rename`, `move_to_trash`, `put_back`, `delete_immediately`, `list_trash`, the document rewriting (`rewrite_documents`, `documents_using`, `map_library_path`), registry and log helpers (`atomic_write_json`, `append_log`, `finish_log`, `rewrite_registry_paths`), `LibraryError(message, status)`.
- `main.py`: the endpoints (below); they all run under `documentWriteLock` and turn `LibraryError` into `HTTPException(status)`.
- `appconfig.py`: `resolve_paths` returns `libraryRoot`, `documentsRoot`, `frontendDist`, `backupRoot` (env `RF_BACKUP`, `config.json` key `backupRoot`, default `~/Documents/3D_BACKUP`).
- Tests: `tests/test_library_ops.py` (fixture `world` = temp library + backup + documents; `client` fixture patches `main.libraryRoot/documentsRoot/backupRoot`), `tests/test_appconfig.py`.

**Frontend** (`frontend/3d-tool/src/app/`, Angular 22, signals, standalone components)
- `tree-panel.ts`: the tree: rows from `rows()`, focus (`focused`), keyboard (`onKey`), context menu (`menu`), rename (`renaming`, `startRename`, `commitRename`, `followRename`), slow second click (`onClick`, constants `doubleClickMs` 500 / `renameDelayMs` 400), Move to Trash (`requestTrash`, `pendingTrash`, `doTrash`), `reload()` (re-reads every listed folder), outputs `fileSelected`, `add`, `renamed`, `trashed`.
- `trash-dialog.ts`: the Trash dialog. `library.service.ts`: HTTP calls, `trashCount`, `refreshTrash()`.
- `app.ts` / `app.html` / `app.scss`: `onRenamed`, `onTrashed`, `undoMoveToTrash`, `onTrashChanged`, the Trash button and the undo bar, search (`onFilter` -> `runSearch`).
- `document.store.ts`: `announce(message, ms)` shows the short notice at the bottom; `checkRemote()` reloads open documents after the server changed them.

**Endpoints** (all under `/api/library/`)
- `POST rename {path,newName}[?dryRun=true]`
- `POST trash {path}[?dryRun=true]`, `GET trash`, `POST trash/{id}/put-back[?onConflict=rename]`, `DELETE trash/{id}`, `DELETE trash`
- The older read endpoints: `GET /api/list?path=`, `GET /api/search?q=`, `GET /api/file?path=`.

## 3. On-disk layout and formats

```
<libraryRoot>/…                               the STL library (only .stl files and directories are listed; dot names are hidden)
<backupRoot>/<library folder name>/<relative path>        backup copy of a file's original (first rename only)
<backupRoot>/_TRASH/<id>/<name>                           trashed file or directory (id = YYYYMMDD-HHMMSS-<6 hex>)
<backupRoot>/.rasterfaster/log.json                       operation log (list)
<backupRoot>/.rasterfaster/registry.json                  {current library path: {originalPath, backupPath, backedUpAt}}
<backupRoot>/.rasterfaster/trash.json                     list of {id,name,originalPath,kind,deletedAt,size,registry}
<documentsRoot>/<id>.json, <id>.versions/v<n>.json        documents and their version snapshots (items[].path = library path)
```

- **Log entry:** `{time, kind, from, to, backup?, status: pending|done|failed, error?, documentsUpdated?, id?, removed?}`; written as `pending` before anything changes and finished afterwards. Kinds so far: `rename-file`, `rename-directory`, `trash-file`, `trash-directory`, `put-back`, `delete-immediately`, `empty-trash`.
- **Registry:** a file counts as "already backed up" when its current path is a key. The key moves with the file on rename (and on directory rename, by prefix); it is stored with a trash item and restored by Put Back.
- All JSON is written atomically (`atomic_write_json`: temp file + `os.replace`).

## 4. Rules every operation follows (keep these)

1. **Never lose an original.** The first rename of a *file* copies it to the backup mirror first (size verified, never overwrites another backup: `name (2).stl`); a failed backup aborts the operation. Directories are not copied (decided: too large). Delete goes to the Trash, never straight to nothing.
2. **Documents keep working.** Rename and move rewrite `items[].path` in every document **and every version snapshot** (prefix replace for directories); a part label that still equals the old file name follows it (the user's own labels stay). Trash does *not* rewrite: parts keep the path and work again after Put Back; the UI asks first when documents use the item.
3. **Journal first.** Log `pending`, do the work, log `done`/`failed`; if a later step fails, undo the earlier step (rename puts the file back when the documents cannot follow).
4. **Dry run.** Every operation answers `?dryRun=true` with what would happen (documents affected, backup path) and changes nothing.
5. **Safety checks.** Resolve the path and require it to stay inside `libraryRoot` (403); not the root itself; only `.stl` files and directories; names: not empty, no leading dot, no `/ \ :` or control characters, max 255 bytes, `.stl` is kept/added, collisions give 409; a case-only rename is allowed (same file).
6. **One lock.** Run under `documentWriteLock` (it also serialises document saves). Open windows pick up rewritten documents through the existing two-window sync (`/api/health` carries `documents`, the newest mtime; the app polls it every 5 s).
7. **Errors:** `LibraryError(message, status)`: 403 outside/root, 404 not found, 409 conflict, 422 bad input, 500 failure.

## 5. UI conventions (match them)

- Finder behaviour: Enter on a focused row renames (F2 too; Enter again without typing or Esc cancels; Enter after typing saves); a slow second click on the selected row renames; ⌘⌫ moves to the Trash; ⌘↓ and double-click add a file to the document (Enter no longer does); Space opens the quick look.
- Feedback patterns already in place: `listNotice` (yellow strip above the list), the inline confirm bar (`pendingTrash`), the bottom notice (`store.announce`), the Undo bar (`undoTrash`), the context menu (`menu`), the inline rename field.
- After any change: `reload()` the tree (it re-reads every listed folder), refresh the search if a filter is active (`onFilter(filterText())`), keep open folders open (open/closed state is remapped in `followRename`), move selection and the remembered last file (`rasterfaster.lastStl`) with the item.

## 6. The phases

### Phase 2a: multi-select (built in 0.9.0: selection model in `tree-panel.ts`, pure rules in `tree-selection.ts`, `POST /api/library/trash-batch`)
Why first: Move, Trash, Duplicate, tags and batch rename all act on a selection.
- **Model:** a `selection` set of paths in `tree-panel.ts` next to the focused row (the anchor). Plain click selects only that row; ⌘-click toggles; Shift-click selects the range between the anchor and the row; Shift-↑/↓ extends; ⌘A selects all visible rows; Esc clears.
- **Finder rules:** selecting a folder does not select its contents; if a folder and something inside it are both selected, operations apply to the folder only; rename needs exactly one selected row; the quick look and the document "selected file" follow the focused row.
- **Actions on the selection:** context menu and ⌘⌫ move all selected to the Trash (one request per item or one batch endpoint, one Undo bar for the lot: Undo puts every item back); the slow-click rename only when that single row is the whole selection.
- **Backend:** a batch form of trash: `POST /api/library/trash {paths:[…]}` (also with `dryRun`) returning a list of results; one log entry per item is fine, plus a shared `batchId` so Undo can reverse all.
- **Tests:** selection logic as a pure function (range, toggle, collapse parent/child) with a vitest spec; backend batch trash; browser check on a throwaway library.

### Phase 2b: organise
- **New folder** (context menu on a folder or the empty area; the new folder opens in rename mode).
- **Move to…** and **drag and drop** of the selection onto a folder (drop target highlight, auto-expand on hover). Backend: `POST /api/library/move {paths, targetDir}` (+ dryRun). Same rules as rename: first move of a *file* is backed up (registry!), documents and versions rewritten (prefix map), collisions give 409 with a per-item report, log `move-file`/`move-directory`. Refuse moving a folder into itself or its descendants.
- **Duplicate:** copy to `name copy.stl` (`name copy 2.stl`…); the copy is a new file: not in the registry (no backup needed, it is a copy).
- **Reveal in Finder** (needs the API to run `open -R <abs path>`; only on the machine that runs the API, guard it), **Copy path** (relative or absolute, to the clipboard).

### Phase 3b: history and undo
- A **History** dialog from the log: newest first, kind, from → to, time, status (failed/pending shown).
- **Undo** per entry or "Undo last": rename (rename back, rewrite documents back, registry key back; the backup stays), move (move back), trash (Put Back), put-back (trash again). Undo is itself an operation (logged, journaled). Refuse when the world changed (target taken, file gone) with a clear message.
- Pending entries found at startup mean an interrupted operation: report them in the History dialog with a "check" action (is the file at `from` or at `to`?).

### Phase 4: batch operations
- **Batch rename** dialog for the selection: find/replace (plain or regex), strip a prefix/suffix (the user's long `RF1 v245_…_RF1 v218_` names), add prefix/suffix, numbering (`name 01`), case change. A **preview table** (old → new, collisions and no-ops marked) before anything changes; applies as one batch with one log `batchId` and one Undo.
- Backend: `POST /api/library/batch-rename {items:[{path,newName}]}` with `dryRun`; validates the whole batch first (duplicates inside the batch, collisions with existing files and with each other, swap cases like A↔B need a temp name), then renames item by item with the usual backup/registry/document rules; on failure it reports which items were done.
- Batch move and batch trash reuse the single-item rules (they already exist from 2a/2b).

### Phase 5: tags and metadata
- STL cannot hold metadata (80-byte header is ignored/rewritten by slicers; nothing may follow the triangles; our reader requires `84 + 50·n` bytes). So: a **library metadata file** `<libraryRoot>/.rasterfaster-meta.json`: `{path: {tags:[…], note:"", favourite:false, hash:"<sha1 of the content, optional>"}}`.
- Rename, move, trash and Put Back must carry the entry along (reuse the registry-style key rewriting in `library_ops.py`); the hash lets an entry be found again after changes made outside the tool (Phase 6/8 repair).
- UI: tag editor in the context menu, tag chips in the rows, filter by tag next to the text filter (a `#tag` syntax in the filter box is the cheapest start), favourites first option. Optional mirror to macOS Finder tags (extended attribute `com.apple.metadata:_kMDItemUserTags`) so they show in Finder and Spotlight; lost when files are zipped or copied to another file system.

### Phase 6: insight
- **Where used** (context menu): documents and parts that use the file/folder (the code exists: `documents_using`).
- **Unused files:** files no document or version uses.
- **Broken references:** document parts whose path no longer exists, grouped by document, with **Repair** (pick the new file; uses the same path rewriting; offer a match by file name and by content hash).
- **Duplicates:** same content (size first, then hash), keep one and Trash the others (documents rewritten to the kept one).
- **Orphaned backups/trash:** registry entries whose file is gone, trash items whose folder is missing (`list_trash` already flags `missing`).

### Phase 7: import and previews
- **Import:** drop `.stl` files from Finder onto the tree (into the folder under the cursor) or an **Add file…** button; upload endpoint with a size limit, name rules and collision handling (never overwrite: `name (2).stl`); a log entry `import`.
- **Thumbnails:** small cached renders per file (render in the browser with the existing three.js code, store PNGs in `<backupRoot>/.rasterfaster/thumbs/<hash>.png` or in the browser cache), shown in the tree and the quick look.
- **Columns** size, triangle count, bounding box (read the STL header/stream once, cache keyed by path+mtime), sortable.

### Phase 8: backup browser and maintenance
- Browse the backup mirror (`<backupRoot>/<library name>/…`), restore a file to its old path (or elsewhere), compare with the current file (size/date).
- Integrity check: every registry entry has its backup copy, every log entry's files exist, trash index vs folder.
- Cleanup tools (old backups, empty trash, log rotation) with dry runs; switching the library root (a settings dialog writing `libraryRoot`/`backupRoot` to `config.json`).
- Open point: a second copy of `log.json`/`registry.json` outside the backup folder as a safety net.

## 7. Cross-cutting guidance for new operations

- Add the operation to `library_ops.py` as a pure function taking `libraryRoot, backupRoot, documentsRoot` (testable with the `world` fixture), journal it, give it a dry run, then add the thin endpoint in `main.py` (`with documentWriteLock`).
- Reuse `rewrite_documents` / `map_library_path` for anything that changes a path; extend `rewrite_registry_paths` and the trash item's `registry` field for anything that moves files.
- Tests to write each time: the happy path, dry run changes nothing, collisions/bad names/outside paths, failure in the middle leaves a consistent state (monkeypatch `shutil` or `rewrite_documents` to raise), registry and log content, documents and versions rewritten.
- Frontend: put state in signals inside `tree-panel.ts` (or a new component for dialogs, like `trash-dialog.ts`), emit an output for the app to react (selection, search refresh, notice), call `reload()`.

## 8. Gotchas learned

- An Angular output named `select` collides with the DOM `select` event (selecting text in the rename field fired it): the tree's output is `fileSelected`. Avoid output names that are DOM event names.
- In filter (search) mode the tree rows come from `results()` and the children of a matching folder from the browse `cache`; `reload()` must re-read **every cached folder**, and a changed search result must not reset open folders unless the filter text changed (`resultsFilter`).
- After renames in the UI always verify the row still exists before editing (`startRename` lists the parent folder first) and treat a 404 as "list out of date".
- The notice from `store.announce` is shared with "Updated from another window": await `checkRemote()` before announcing your own message.
- A rename whose documents cannot be rewritten must put the file back (done in `library_ops.rename`); keep that pattern.
- macOS: the file system is case-insensitive (`Foo` → `foo` must use `samefile`), and `:` is not allowed in names.

## 9. How to verify a change without touching real data

**Never rename, move or trash anything in the real library or edit the real documents when testing.** Use a throwaway setup:

```bash
S=<scratch folder>
mkdir -p "$S/rlib/Folder" "$S/rdocs"            # copy a few STL files in, write a document JSON that uses them
cd backend && RF_ROOT=$S/rlib RF_DOCS=$S/rdocs RF_BACKUP=$S/rbak PORT=8110 .venv1/bin/python main.py &
```
- Open `http://localhost:8110` in the browser pane; **unregister the service worker and clear caches first** (`navigator.serviceWorker.getRegistrations()`, `caches.keys()`), or an old bundle is served. That production build has no `ng` debug helpers; the dev server on 4200 does (`window.ng.getComponent`) but talks to the user's **real** API on 8100, so only read from it.
- `ng build` output is served by that API from `frontend/3d-tool/dist/3d-tool/browser`; run `npx ng build` before testing.
- Stop the test API afterwards and delete the scratch folders. Run `cd backend && .venv1/bin/python -m pytest -q` and `cd frontend/3d-tool && npx ng test --watch=false`.

## 10. Working conventions in this repo

- Every change: a dated entry in `CHANGELOG.md` (newest first; bullets prefixed **FE**/**BE** with file paths), README updated, version bumped with `cd frontend/3d-tool && npm run bump:version -- X.Y.Z` (features: minor, fixes: patch).
- Commit only when asked; end commit messages with the co-author line; never commit the user's own documents under `documents/` unless told to.
- The user's API on port 8100 is theirs: never kill it; pick up backend changes with `POST /api/runtime/restart`. After a backend change they need that restart, and `scripts/build-app.sh --install` to update the installed app.
- Ask before destructive moves on real data; prefer dry runs and the Trash.

## 11. Open decisions

- Second copy of the log and registry outside the backup folder (Phase 8).
- Whether Undo (3b) should also reverse the documents' label changes made by a rename (today labels follow the file name only when they equalled it).
- Thumbnail storage: backup folder cache vs browser cache (Phase 7).
- Whether Duplicate (2b) of a registered (backed-up) file should copy its registry entry (current thinking: no, a copy is a new file).
