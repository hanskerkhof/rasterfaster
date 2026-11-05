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

/** The folder a library path is in (`a/b/c.stl` -> `a/b`, '' at the root). */
export function parentFolder(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** The other files in the same folder as `path` (not in the folders below it), by name; the part itself is left out. */
export function siblingsOf(entries: readonly CatalogEntry[], path: string): CatalogEntry[] {
  const folder = parentFolder(path);
  return sortCatalog(entries.filter(entry => entry.path !== path && parentFolder(entry.path) === folder), 'name', true);
}

/** The entries that are left after these library paths (files, or folders with everything in them) have gone to the Trash. */
export function withoutPaths(entries: readonly CatalogEntry[], gone: readonly string[]): CatalogEntry[] {
  if (!gone.length) return [...entries];
  const files = new Set(gone);
  return entries.filter(entry => !files.has(entry.path) && !gone.some(path => entry.path.startsWith(path + '/')));
}

/** Every folder that has a part in it, or in a folder below it (`a`, `a/b`), in natural order: where a part can be moved to. */
export function folderPaths(entries: readonly CatalogEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    for (let folder = parentFolder(entry.path); folder; folder = parentFolder(folder)) found.add(folder);
  }
  return [...found].sort(naturalCompare);
}

/** What a typed folder path means for a move: tidy slashes, no empty parts, none of `.` or `..`; null when it is not usable. */
export function cleanFolderPath(text: string): string | null {
  const parts = text.trim().split('/').map(part => part.trim()).filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  return parts.join('/');
}

/** A group of identical files (`/api/catalog/duplicates`): their library paths and the size they all have. */
export interface DuplicateGroup {
  paths: string[];
  size: number;
}

/** Looks like a leftover: a folder or file name with old, backup, bak or copy as a word of its own (`_old`, `x copy`, `Model.bak`), or a number in brackets (`(1)`). */
export function isOldPath(path: string): boolean {
  const word = /(^|[\s_.\-([])(old|oud|backup|bak|copy|kopie|archive)($|[\s_.\-)\]])/i;
  return path.split('/').some(part => word.test(part.replace(/\.stl$/i, '')) || /\(\d+\)/.test(part));
}

/** The groups as lists of the catalog's entries, each by path (no copy is preferred over another: that is for the user to decide). A path that is no longer in the catalog is left out; a group with fewer than two copies is no group. */
export function groupCopies(entries: readonly CatalogEntry[], groups: readonly DuplicateGroup[]): CatalogEntry[][] {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  return groups
    .map(group => group.paths.map(path => byPath.get(path)).filter((entry): entry is CatalogEntry => !!entry).sort((x, y) => naturalCompare(x.path, y.path)))
    .filter(copies => copies.length > 1);
}

/** Where a path went after the renames and moves `moves` (`from` / `to` of a file, or of a folder: everything below it follows). */
export function remapPath(path: string, moves: readonly { from: string; to: string; kind?: string }[]): string {
  for (const move of moves) {
    if (path === move.from) return move.to;
    if (path.startsWith(move.from + '/')) return move.to + path.slice(move.from.length);
  }
  return path;
}

/** The documents in a dry run's `{document file: parts}` (a working copy `id.json` or a version `id.versions/v3.json`): one per document, with their parts. */
export function documentsOf(files: Record<string, number>): { ids: string[]; parts: number } {
  const ids = new Set(Object.keys(files).map(file => file.replace(/\.versions\/.*$/, '').replace(/\.json$/, '')));
  return { ids: [...ids].sort(naturalCompare), parts: Object.values(files).reduce((sum, n) => sum + n, 0) };
}

/** The path of a folder as crumbs, the library first: `a/b` -> LIBRARY, a, a/b. */
export function crumbsOf(folder: string): { name: string; path: string }[] {
  const parts = folder.split('/').filter(Boolean);
  return [{ name: 'LIBRARY', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))];
}

/** The folders directly in `folder` ('' is the library) that have parts in them or below them, with how many parts that is. */
export function childFolders(entries: readonly CatalogEntry[], folder: string): { name: string; path: string; count: number }[] {
  const prefix = folder ? folder + '/' : '';
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut > 0) counts.set(rest.slice(0, cut), (counts.get(rest.slice(0, cut)) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, path: prefix + name, count })).sort((a, b) => naturalCompare(a.name, b.name));
}

/** The parts directly in `folder` (not in the folders below it), by name. */
export function filesIn(entries: readonly CatalogEntry[], folder: string): CatalogEntry[] {
  return sortCatalog(entries.filter(entry => parentFolder(entry.path) === folder), 'name', true);
}

/** Whether `folder` is `ancestor` itself or lies below it (whole folder names; '' is the library: everything). */
export function isWithin(folder: string, ancestor: string): boolean {
  return !ancestor || folder === ancestor || folder.startsWith(ancestor + '/');
}

/**
 * The filename convention for parts that belong together: names that are the same except for one of these pairs of words (whole words, any case)
 * are companions, e.g. `3.43 USB-C FEMALE FRONT` and `3.43 USB-C FEMALE BACK`, `CORNER LEFT 3h` and `CORNER RIGHT 3h`, or the four of `TOP LEFT`,
 * `TOP RIGHT`, `BOTTOM LEFT`, `BOTTOM RIGHT`. They stay separate parts; the page of a part can show them together.
 */
export const pairWords: { id: string; words: string[] }[] = [
  { id: 'side', words: ['LEFT', 'RIGHT'] },
  { id: 'height', words: ['TOP', 'BOTTOM'] },
  { id: 'depth', words: ['FRONT', 'BACK'] },
  { id: 'level', words: ['UPPER', 'LOWER'] },
];

const pairPattern = new RegExp(`(?<![A-Za-z])(${pairWords.flatMap(pair => pair.words).join('|')})(?![A-Za-z])`, 'gi');

/**
 * The second filename convention, alternatives: `ALT I`, `ALT II` ... (also `ALTI`, `ALT_II`, `alt-III`; a roman numeral) marks an alternative of the base
 * model, which is the same name without ALT. A slot has the base or any one of its alternatives, never several at once (`3.43 USB-C FEMALE BACK`, `... BACK ALT I`).
 */
const altPattern = /(?<![A-Za-z])ALT[\s_-]*([IVX]+)(?![A-Za-z])/i;

/** The value of a roman numeral up to XXIX (`III` -> 3), or null when it is not one. */
function romanValue(text: string): number | null {
  const upper = text.toUpperCase();
  if (!/^(X{0,2})(IX|IV|V?I{0,3})$/.test(upper) || !upper) return null;
  const digits: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < upper.length; i++) { const v = digits[upper[i]], next = digits[upper[i + 1]] ?? 0; total += v < next ? -v : v; }
  return total;
}

/** The alternative number of a name (`... ALT II` -> 2); 0 for the base (a name without ALT). */
export function altLevel(name: string): number {
  const match = altPattern.exec(stemOf(name));
  return (match && romanValue(match[1])) || 0;
}

/** A name without its ALT mark: what the alternatives of one slot have in common. An `ALT` that is not followed by a roman numeral is left alone. */
function withoutAlt(stem: string): string {
  let found = false;
  const stripped = stem.replace(altPattern, (whole, roman: string) => (romanValue(roman) === null ? whole : (found = true, ' ')));
  return found ? stripped.replace(/ {2,}/g, ' ').trim() : stem;
}

/** The key of a slot: the name without the ALT mark, lower case, separators ignored (`3.43 USB-C FEMALE BACK ALT I` and `3.43 USB-C FEMALE BACK` share it). */
export function altKey(name: string): string {
  return withoutAlt(stemOf(name)).toLowerCase().replace(/[\s_]+/g, ' ').replace(/[\s-]+$/, '').trim();
}

/** `BASE` or `ALT II` for the button of an alternative. */
export function altLabel(name: string): string {
  const level = altLevel(name);
  return level ? 'ALT ' + (altPattern.exec(stemOf(name))![1].toUpperCase()) : 'BASE';
}

/** The base and the alternatives of this part (itself included), in its own folder: same slot, base first, then ALT I, II ... Empty when it has none. */
export function alternativesOf(entries: readonly CatalogEntry[], path: string): CatalogEntry[] {
  const self = entries.find(entry => entry.path === path);
  if (!self) return [];
  const key = altKey(self.name), folder = parentFolder(path);
  const found = entries.filter(entry => parentFolder(entry.path) === folder && altKey(entry.name) === key);
  return found.length > 1 ? found.sort((a, b) => altLevel(a.name) - altLevel(b.name) || naturalCompare(a.name, b.name)) : [];
}

/** A name with its pair words replaced by their pair (`3.43 USB-C FEMALE {depth}`): parts with the same key belong together. Null when the name has no pair word. */
export function companionKey(name: string): string | null {
  const stem = withoutAlt(name.replace(/\.stl$/i, ''));
  let found = false;
  const key = stem.replace(pairPattern, word => {
    found = true;
    return `{${pairWords.find(pair => pair.words.includes(word.toUpperCase()))!.id}}`;
  });
  return found ? key.toLowerCase() : null;
}

/** A part number in a name: `P1`, `P2` ... on its own between separators (spaces, underscores, hyphens) or at the ends (`Screw-Terminal-P5.08` is a pitch, not a part number). */
const partNumberPattern = /(?<=^|[\s_-])P(\d+)(?=[\s_-]|$)/gi;

function stemOf(name: string): string {
  return name.replace(/\.stl$/i, '');
}

/** The part number of a name (`3.21 P2 USBA TOP` -> 2), or null. */
export function partNumber(name: string): number | null {
  const found = [...stemOf(name).matchAll(partNumberPattern)];
  return found.length ? Number(found[0][1]) : null;
}

/**
 * The second way for parts to belong together: numbered parts `P1`, `P2`, `P3` of one set. What makes two names the same set is their text without
 * the part number and without the position words (LEFT, TOP ...: each numbered part says where it sits), separators ignored: `3.21 P1 USBA BOTTOM ALT III EIGHT`,
 * `3.21 USBA TOP_P2_ALT III  EIGHT` and `3.21 P3 USBA FRONT ALT III EIGHT` are one set. Null when the name has no part number.
 */
export function setKey(name: string): string | null {
  const stem = withoutAlt(stemOf(name));
  if (!partNumberPattern.test(stem)) { partNumberPattern.lastIndex = 0; return null; }
  partNumberPattern.lastIndex = 0;
  return stem.replace(partNumberPattern, ' ').replace(pairPattern, ' ').toLowerCase().replace(/[\s_]+/g, ' ').trim();
}

/** A short name for the legend of the together view: the part number and the position words of the name (`P1 BOTTOM`), or null when it has neither. */
export function companionLabel(name: string): string | null {
  const stem = stemOf(name);
  const number = partNumber(name);
  const words = [...stem.matchAll(pairPattern)].map(match => match[1].toUpperCase());
  const label = [...(number === null ? [] : [`P${number}`]), ...words].join(' ');
  return label || null;
}

/** The parts that belong together with this one, in its own folder: the same name but for LEFT / RIGHT, TOP / BOTTOM ... (`companionKey`), or the same set of numbered parts P1, P2 ... (`setKey`). Empty when there are none. By part number, then name. */
export function companionsOf(entries: readonly CatalogEntry[], path: string): CatalogEntry[] {
  const self = entries.find(entry => entry.path === path);
  if (!self) return [];
  const pairKey = companionKey(self.name), numbered = setKey(self.name);
  if (pairKey === null && numbered === null) return [];
  const folder = parentFolder(path);
  const slot = altKey(self.name), level = altLevel(self.name);
  const candidates = entries.filter(entry => entry.path !== path && parentFolder(entry.path) === folder && altKey(entry.name) !== slot
    && ((pairKey !== null && companionKey(entry.name) === pairKey) || (numbered !== null && setKey(entry.name) === numbered)));
  // a companion that has alternatives counts once: the one with the same ALT as this part, else the base, else the first alternative
  const bySlot = new Map<string, CatalogEntry>();
  const rank = (entry: CatalogEntry) => (altLevel(entry.name) === level ? 0 : altLevel(entry.name) === 0 ? 1 : 2 + altLevel(entry.name));
  for (const entry of candidates) { const key = altKey(entry.name), had = bySlot.get(key); if (!had || rank(entry) < rank(had)) bySlot.set(key, entry); }
  return [...bySlot.values()].sort((a, b) => (partNumber(a.name) ?? Infinity) - (partNumber(b.name) ?? Infinity) || naturalCompare(a.name, b.name));
}

/**
 * For every part that belongs together with others (by `companionKey` or `setKey`, in its own folder): how many parts the set has, itself included. The same
 * number as `companionsOf(...).length + 1`, for all parts at once (the cards of the catalog and the tiles of a part's page show it as a badge).
 */
export function companionCounts(entries: readonly CatalogEntry[]): Map<string, number> {
  const byPair = new Map<string, string[]>(), bySet = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string) => { const list = map.get(key); if (list) list.push(path); else map.set(key, [path]); };
  for (const entry of entries) {
    const folder = parentFolder(entry.path);
    const pair = companionKey(entry.name), numbered = setKey(entry.name);
    if (pair !== null) add(byPair, `${folder}\0${pair}`, entry.path);
    if (numbered !== null) add(bySet, `${folder}\0${numbered}`, entry.path);
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const folder = parentFolder(entry.path);
    const pair = companionKey(entry.name), numbered = setKey(entry.name);
    const members = new Set([...(pair !== null ? byPair.get(`${folder}\0${pair}`) ?? [] : []), ...(numbered !== null ? bySet.get(`${folder}\0${numbered}`) ?? [] : [])]);
    const slots = new Set([...members].map(path => altKey(path.split('/').pop()!)));
    if (slots.size > 1) counts.set(entry.path, slots.size);
  }
  return counts;
}
