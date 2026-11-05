/** Parts that belong together are shown in one scene, each in a colour of its own (the app's own eight, in turn). */
export const companionColors = [0x6fa8dc, 0x93c47d, 0xf6b26b, 0xc27ba0, 0x8e7cc3, 0xe06666, 0x76a5af, 0xffd966];

const boundary = /[\s_\-.()[\]]/;

/**
 * Short names for a group of file names: what is left when the start and the end they have in common are taken off, cut at word boundaries
 * (`3.43 USB-C FEMALE BACK` and `3.43 USB-C FEMALE FRONT` -> `BACK`, `FRONT`; `X LEFT 3h`, `X RIGHT 3h` -> `LEFT`, `RIGHT`). A name with nothing
 * left of it keeps its whole name.
 */
export function distinctLabels(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const first = names[0];
  let start = 0;
  while (start < first.length && names.every(name => name[start] === first[start])) start++;
  while (start > 0 && !boundary.test(first[start - 1])) start--; // not in the middle of a word
  let end = 0; // how many characters at the end are common
  while (end < first.length - start && names.every(name => name.length - end - 1 >= start && name[name.length - end - 1] === first[first.length - end - 1])) end++;
  while (end > 0 && !boundary.test(first[first.length - end])) end--; // the common end starts at a word boundary
  return names.map(name => name.slice(start, name.length - end).trim() || name);
}
