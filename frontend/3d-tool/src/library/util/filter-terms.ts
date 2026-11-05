/**
 * The text of the filter box: several terms (the same rules as backend/searchterms.py, which does the searching):
 *   PANEL S2        two terms, separated by spaces
 *   "PANEL MOUNT"   a phrase in quotes is one term
 *   -copy           leaves out names that contain it (also -"a phrase")
 * Case does not matter. The terms that count are highlighted in the list.
 */
const token = /(-?)"([^"]*)"?|(-?)(\S+)/g;

export function parseTerms(query: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const match of query.matchAll(token)) {
    const minus = match[1] || match[3];
    const text = (match[2] !== undefined ? match[2] : match[4]).trim().toLowerCase();
    if (!text || text === '-') continue; // a lone minus is the start of an exclusion that is still being typed
    (minus ? exclude : include).push(text);
  }
  return { include, exclude };
}

/** The text cut in pieces, those that are (part of) one of the terms marked as hits; overlapping and touching hits become one. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const { include } = parseTerms(query);
  if (!include.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const term of include) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) found.push([at, at + term.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const parts: { text: string; hit: boolean }[] = [];
  let done = 0;
  for (const [start, end] of merged) {
    if (start > done) parts.push({ text: text.slice(done, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    done = end;
  }
  if (done < text.length) parts.push({ text: text.slice(done), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}
