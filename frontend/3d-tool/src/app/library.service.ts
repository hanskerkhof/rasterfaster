import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface LibraryEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  modified: number;
  match?: boolean;
  children?: LibraryEntry[];
}

export interface RenameResult {
  kind: 'file' | 'directory';
  from: string;
  to: string;
  /** Where the copy of the original went (only for the first rename of a file). */
  backup: string | null;
  backedUp: boolean;
  /** Document files (and versions) whose paths were updated, with the number of parts changed. */
  documents: Record<string, number>;
}

export interface MoveBatchResult {
  dryRun: boolean;
  results: RenameResult[];
  failed: { path: string; error: string }[];
}

export interface TrashResult {
  kind: 'file' | 'directory';
  path: string;
  name: string;
  /** The Trash item (null for a dry run). */
  id: string | null;
  /** Document files (and versions) with parts that use it, and how many parts. */
  documents: Record<string, number>;
}

export interface TrashBatchResult {
  batchId: string | null;
  dryRun: boolean;
  results: TrashResult[];
  failed: { path: string; error: string }[];
  /** Dry run only: the document files that use any of the items, with the number of parts. */
  documents?: Record<string, number>;
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  kind: 'file' | 'directory';
  deletedAt: number;
  size: number;
  missing: boolean;
}

export type SortKey = 'name' | 'date';

const sortStorageKey = 'rasterfaster.sort';

function readStoredSort(): { key: SortKey; ascending: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(sortStorageKey) ?? 'null');
    if ((stored?.key === 'name' || stored?.key === 'date') && typeof stored.ascending === 'boolean') return stored;
  } catch { /* storage unavailable or corrupt: use defaults */ }
  return { key: 'name', ascending: true };
}

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly http = inject(HttpClient);

  private readonly storedSort = readStoredSort();
  readonly sortKey = signal<SortKey>(this.storedSort.key);
  readonly sortAscending = signal(this.storedSort.ascending);

  constructor() {
    effect(() => {
      const value = JSON.stringify({ key: this.sortKey(), ascending: this.sortAscending() });
      try { localStorage.setItem(sortStorageKey, value); } catch { /* storage unavailable */ }
    });
  }

  list(path: string) {
    return this.http.get<LibraryEntry[]>('/api/list', { params: { path } });
  }

  /** Renames a library file or directory; the first rename of a file keeps a copy of the original in the backup folder. */
  rename(path: string, newName: string) {
    return this.http.post<RenameResult>('/api/library/rename', { path, newName });
  }

  /** Moves files and directories into the library directory `targetDir` ('' is the library root); the documents follow. */
  move(paths: string[], targetDir: string) {
    return this.http.post<MoveBatchResult>('/api/library/move', { paths, targetDir });
  }

  newFolder(parent: string, name: string) {
    return this.http.post<{ path: string }>('/api/library/new-folder', { parent, name });
  }

  /** Copies a file next to itself as `name copy.stl`. */
  duplicate(path: string) {
    return this.http.post<{ from: string; path: string }>('/api/library/duplicate', { path });
  }

  /** Shows the item in the Finder of the Mac that runs the API. */
  reveal(path: string) {
    return this.http.post<{ path: string; absolute: string }>('/api/library/reveal', { path });
  }

  /** Moves a file or directory to the Trash (like the Finder); `dryRun` only reports the documents that use it. */
  trash(path: string, dryRun = false) {
    return this.http.post<TrashResult>('/api/library/trash', { path }, { params: dryRun ? { dryRun: true } : {} });
  }

  /** Moves several items to the Trash as one action (a folder and things inside it count as the folder). */
  trashBatch(paths: string[], dryRun = false) {
    return this.http.post<TrashBatchResult>('/api/library/trash-batch', { paths }, { params: dryRun ? { dryRun: true } : {} });
  }

  trashList() {
    return this.http.get<TrashItem[]>('/api/library/trash');
  }

  putBack(id: string, onConflict?: 'rename') {
    return this.http.post<{ id: string; path: string; name: string; kind: string; renamed: boolean }>(`/api/library/trash/${id}/put-back`, {}, { params: onConflict ? { onConflict } : {} });
  }

  deleteImmediately(id: string) {
    return this.http.delete<{ removed: number }>(`/api/library/trash/${id}`);
  }

  emptyTrash() {
    return this.http.delete<{ removed: number }>('/api/library/trash');
  }

  /** How many items the Trash holds (shown next to the Trash button). */
  readonly trashCount = signal(0);

  async refreshTrash() {
    try { this.trashCount.set((await firstValueFrom(this.trashList())).length); } catch { /* offline: keep the old number */ }
  }

  search(q: string) {
    return this.http.get<LibraryEntry[]>('/api/search', { params: { q } });
  }

  fileUrl(path: string) {
    return `/api/file?path=${encodeURIComponent(path)}`;
  }

  loadStl(path: string) {
    return this.http.get(this.fileUrl(path), { responseType: 'arraybuffer' });
  }

  /** Clicking the active key flips direction; a new key starts with its natural direction. */
  setSort(key: SortKey) {
    if (this.sortKey() === key) {
      this.sortAscending.update(v => !v);
    } else {
      this.sortKey.set(key);
      this.sortAscending.set(key === 'name'); // date: newest first
    }
  }

  sorted(entries: LibraryEntry[]): LibraryEntry[] {
    const sign = this.sortAscending() ? 1 : -1;
    const byDate = this.sortKey() === 'date';
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      const order = byDate ? a.modified - b.modified : a.name.localeCompare(b.name, undefined, { numeric: true });
      return sign * order || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }

  /** Nests the flat search result (matches + ancestor dirs) into a tree. */
  nest(flat: LibraryEntry[]): LibraryEntry[] {
    const nodes = new Map(flat.map(e => [e.path, { ...e, children: [] as LibraryEntry[] }]));
    const roots: LibraryEntry[] = [];
    for (const node of nodes.values()) {
      const slash = node.path.lastIndexOf('/');
      const parent = slash < 0 ? undefined : nodes.get(node.path.slice(0, slash));
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }
}
