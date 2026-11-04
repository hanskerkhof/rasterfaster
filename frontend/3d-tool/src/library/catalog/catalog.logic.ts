import { parseTerms } from '../util/filter-terms';

/** One STL of the library as the catalog shows it (the API's `/api/catalog`). `folder` is the top-level folder ('' for a file at the root). */
export interface CatalogEntry {
  name: string;
  path: string;
  folder: string;
  modified: number;
  size: number;
  /** A current drawing is in the cache (`/api/catalog/thumb`). */
  drawn?: boolean;
  /** The look of the cached drawing (older ones are drawn again). */
  thumbVersion?: number | null;
  /** Width, depth and height of the STL in mm, known once it was drawn. */
  dims?: number[] | null;
  /** Volume in mm³, known once it was drawn. */
  volume?: number | null;
}

export type CatalogSortKey = 'name' | 'date' | 'size';

/** The number in front of a folder name (`10.17.FRAME HANGING SYS` -> `10.17`); the whole name when it has none, `—` at the root. */
export function folderCode(folder: string): string {
  if (!folder) return '—';
  return /^\d+(?:\.\d+)*/.exec(folder)?.[0] ?? folder;
}

/** What is left of the file name for the card: no `.stl`. */
export function displayName(name: string): string {
  return name.replace(/\.stl$/i, '');
}

/** The entries whose name or folder contains every term of `query` (same syntax as the file list: "phrase", -exclude), in one folder or in all (`folder` null). */
export function filterCatalog(entries: readonly CatalogEntry[], query: string, folder: string | null): CatalogEntry[] {
  const { include, exclude } = parseTerms(query);
  return entries.filter(entry => {
    if (folder !== null && entry.folder !== folder) return false;
    if (!include.length && !exclude.length) return true;
    const text = `${entry.folder}/${entry.name}`.toLowerCase();
    return include.every(term => text.includes(term)) && !exclude.some(term => text.includes(term));
  });
}

function naturalKey(text: string): (string | number)[] {
  return text.toLowerCase().split(/(\d+)/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
}

function naturalCompare(a: string, b: string): number {
  const x = naturalKey(a), y = naturalKey(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (typeof x[i] === typeof y[i]) return x[i] < y[i] ? -1 : 1;
    return typeof x[i] === 'number' ? -1 : 1;
  }
  return x.length - y.length;
}

/** A sorted copy: by name (natural, so `a2` before `a10`; the path breaks ties), by date or by file size. */
export function sortCatalog(entries: readonly CatalogEntry[], key: CatalogSortKey, ascending: boolean): CatalogEntry[] {
  const direction = ascending ? 1 : -1;
  const by = (a: CatalogEntry, b: CatalogEntry) =>
    key === 'date' ? a.modified - b.modified : key === 'size' ? a.size - b.size : naturalCompare(a.name, b.name);
  return [...entries].sort((a, b) => direction * by(a, b) || naturalCompare(a.path, b.path));
}

/** The folders of the entries with how many parts each has, in natural order of their names. */
export function folderCounts(entries: readonly CatalogEntry[]): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.folder, (counts.get(entry.folder) ?? 0) + 1);
  return [...counts].map(([folder, count]) => ({ folder, count })).sort((a, b) => naturalCompare(a.folder, b.folder));
}

/** How many cards fit in a row of `width` px, and the first and last row to draw for a window of `height` px scrolled by `top` (plus `buffer` rows). */
export function visibleRows(total: number, width: number, top: number, height: number, cardWidth: number, rowHeight: number, buffer = 2) {
  const columns = Math.max(1, Math.floor(width / cardWidth));
  const rows = Math.ceil(total / columns);
  const first = Math.max(0, Math.floor(top / rowHeight) - buffer);
  const last = Math.min(rows, Math.ceil((top + height) / rowHeight) + buffer);
  return { columns, rows, first, last };
}
