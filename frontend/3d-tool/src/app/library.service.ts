import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';

export interface LibraryEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  modified: number;
  match?: boolean;
  children?: LibraryEntry[];
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
