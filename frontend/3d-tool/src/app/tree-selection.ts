/**
 * Selection rules of the file list (the Finder's): pure functions on the list of visible row paths, so they can be tested without the tree.
 */

/** The paths from `anchor` to `target` in row order, both included (a Shift-click or Shift-arrow). Without a usable anchor: just `target`. */
export function rangeBetween(rows: readonly string[], anchor: string | null, target: string): string[] {
  const to = rows.indexOf(target);
  const from = anchor === null ? -1 : rows.indexOf(anchor);
  if (to < 0) return [];
  if (from < 0) return [target];
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** A ⌘-click: `path` in or out of the selection. */
export function toggled(selection: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selection);
  if (!next.delete(path)) next.add(path);
  return next;
}

/**
 * What an action acts on: a folder and things inside it that are both selected count as the folder only; the order of the rows is kept.
 * Paths are library paths (`a/b/c.stl`), a folder `a` contains `a/...` but not `ab/...`.
 */
export function actedOn(rows: readonly string[], selection: ReadonlySet<string>): string[] {
  const chosen = rows.filter(path => selection.has(path));
  return chosen.filter(path => !chosen.some(other => other !== path && path.startsWith(other + '/')));
}

/** Drops selected paths that are no longer visible (after a reload or another filter). */
export function pruned(rows: readonly string[], selection: ReadonlySet<string>): Set<string> {
  const visible = new Set(rows);
  return new Set([...selection].filter(path => visible.has(path)));
}
