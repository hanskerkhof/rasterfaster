# File management in the file list: plan

> Superseded for building: see `docs/file-management-handoff.md` (current state, rules, every phase in detail, how to test). This file is the shorter, earlier plan.

The file list (the library tree) becomes a file and directory management tool, in phases. Phase 1 is the first one to build.

## Principles
- **Never lose an original.** Anything that changes or removes a file first leaves a copy or a record in the backup folder (`/Users/hanskerkhof/Documents/3D_BACKUP`, override with `RF_BACKUP` or `backupRoot` in `config.json`).
- **Documents keep working.** Documents refer to library files by path, so every rename or move rewrites the paths in `documents/*.json` and in all `<id>.versions/v*.json` (updating labels that still equal the old file name). Open windows pick the change up through the existing sync.
- **Everything is logged** (one rename/move/delete log), so history and undo are possible.
- **All changes are checked against the library root** (`resolve_inside_root`); nothing outside the library root and the backup folder is touched.
- **A dry run first:** every operation endpoint also answers `?dryRun=true` with what would happen (files touched, documents affected), so the UI can show a preview where it matters (batch operations).

## Data we keep
- **Backup mirror:** `<backupRoot>/<library folder name>/<relative path>`; e.g. `3D_BACKUP/RASTERFASTER/1.4.BOLTS & NUTS/<original name>.stl`.
- **Operation log + registry:** `<backupRoot>/.rasterfaster/log.json` (append-only list: time, kind, from, to) and `registry.json` (library path -> `{originalPath, backedUpAt}`; the entry moves with the file when it is renamed, so "first time only" holds across A -> B -> C).
- **Library metadata (Phase 5):** `<libraryRoot>/.rasterfaster-meta.json`, keyed by library path (and a content hash so an entry can be found again after a rename outside the tool). Not inside the STL files: the format has no place for it (80-byte header ignored by most programs and rewritten by slicers; nothing may follow the triangles).

## Phase 1: rename files and directories (first, with backup) — built in 0.7.0
Backend
- `POST /api/library/rename {path, newName}` (+ `?dryRun=true`).
- Name rules: not empty, no `/`, no leading dot, a file keeps `.stl` (added when missing); an existing target gives 409; case-only renames work.
- File, first rename only: copy to the backup mirror (same relative path, `copy2`, size verified), then rename. A failed backup aborts the rename. Later renames of that file do not back up (registry).
- Directory: nothing is copied (decided: the library is 8 GB); the rename is logged.
- Then rewrite document and version paths and labels, then log the operation; all under the document write lock; document files are written atomically.
- Write the log entry *intent* first, complete it afterwards, so an interrupted rename can be recognised and finished or reverted.

Frontend
- Context menu on tree rows (files and directories) with **Rename…**; Enter (or F2) on a focused row does the same, like the Finder (Enter no longer adds a file to the document; ⌘↓ and double-click do).
- Inline edit in the row, Enter saves, Esc cancels; folder and search results reload; selection and the remembered last file follow; the quick look closes.
- First rename of a file shows where the backup went.

Tests: first rename backs up, second does not, A -> B -> C, directory logs only, collisions, bad names, document and version paths and labels rewritten, backup failure aborts, dry run changes nothing; browser check on a throwaway library and document.

## Phase 2: organise
New folder, **Move to…** (and drag and drop in the tree), Duplicate file, Reveal in Finder, Copy path. Moves use the same path rewriting, log and backup rule as rename (a file moved for the first time is backed up).

## Phase 3: delete safely (the Trash: built in 0.8.0), history and undo
- Built: delete works like the Finder's Trash (Move to Trash, Put Back, Delete Immediately, Empty Trash, an Undo bar; items live in `3D_BACKUP/_TRASH/<id>/`), with a question first only when documents use the item. Not built yet: the history view below.
- **History** view of the log with one-click **Undo** for rename, move and delete (restoring document paths too).

## Phase 4: batch operations
Multi-select in the tree (⌘-click, Shift-click). **Batch rename** with find/replace (optionally regex), prefix/suffix strip (your long `RF1 v245_..._RF1 v218_` names), numbering, and a **preview table** (old -> new, collisions marked) before anything is changed. Batch move and batch delete reuse the single-file rules.

## Phase 5: tags and metadata
Tags, a note and a favourite flag per file (and per directory), kept in the library metadata file (see above), moved along by rename and move. Tag editor in the context menu, tag chips in the tree, filter by tag next to the text filter. Optional mirror to macOS Finder tags (extended attribute) so they show in Finder and Spotlight.

## Phase 6: insight
**Where used** (which documents use a file, from the context menu), **unused files** (in no document), **broken references** report (paths in documents that no longer exist, with a repair by choosing the new file), **duplicates** (same content hash), orphaned backup entries.

## Phase 7: import and previews
Add STL files from disk by dropping them into the tree (into the folder under the cursor), thumbnails (a small cached render per file) in the tree and the quick look, columns for size, triangle count and bounding box, sort by them.

## Phase 8: backup browser and maintenance
Browse the backup mirror, restore a file from it (to its old path or elsewhere), integrity check (backup copies exist for every registry entry), cleanup of old backups and log, switching the library root.

## Open points
- Whether the log and registry should also be copied somewhere that is not inside the backup folder (a second safety net).
- Names with characters macOS does not allow (`:`) and very long names: validated per rule in Phase 1.
- Clipboard (local storage) can hold old paths after a rename: it simply fails to load a missing file, as it does today.
