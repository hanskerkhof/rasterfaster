/** The name without extension, "(2)" copy numbers and trailing digits or separators: what makes `BOLT_S2` and `BOLT_S20` the same kind of part. */
function stem(name: string): string {
  return name.toLowerCase().replace(/\.stl$/, '').replace(/\(\s*\d+\s*\)/g, ' ').replace(/[\s_.\-]*\d+\s*$/, '').replace(/\s+/g, ' ').trim();
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

/** Share of the names that is the same (0…1), after dropping copy numbers and trailing digits. */
export function nameSimilarity(a: string, b: string): number {
  const x = stem(a), y = stem(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - editDistance(x, y) / longest;
}

/** Names this alike get the same colour. `RF7 CONNECTOR OUT` and `…MID` are 82% alike, so they stay apart. */
export const similarNameThreshold = 0.85;

export function similarNames(a: string, b: string): boolean {
  return nameSimilarity(a, b) >= similarNameThreshold;
}
