import { describe, expect, it } from 'vitest';
import { CatalogEntry, displayName, filterCatalog, folderCode, folderCounts, parentFolder, siblingsOf, withoutPaths, folderPaths, cleanFolderPath, sortCatalog, visibleRows } from './catalog.logic';

const entry = (path: string, modified = 1, size = 1): CatalogEntry => {
  const parts = path.split('/');
  return { name: parts[parts.length - 1], path, folder: parts.length > 1 ? parts[0] : '', modified, size };
};
const all = [entry('10.17.FRAME/hook v2.stl', 5, 30), entry('1.4.BOLTS/BOLT_S8.stl', 9, 10), entry('1.4.BOLTS/bolt_m3 old.stl', 1, 20), entry('loose.stl', 3, 5)];

describe('catalog logic', () => {
  it('takes the number of a folder as its code', () => {
    expect(folderCode('10.17.FRAME HANGING SYS')).toBe('10.17');
    expect(folderCode('4-KLANK')).toBe('4');
    expect(folderCode('Antenna')).toBe('Antenna');
    expect(folderCode('')).toBe('—');
  });

  it('drops .stl for the display name', () => {
    expect(displayName('BOLT_S8.stl')).toBe('BOLT_S8');
    expect(displayName('x.STL')).toBe('x');
  });

  it('filters on terms in name and folder, with phrases and exclusions', () => {
    expect(filterCatalog(all, '', null)).toHaveLength(4);
    expect(filterCatalog(all, 'bolt', null).map(e => e.name)).toEqual(['BOLT_S8.stl', 'bolt_m3 old.stl']);
    expect(filterCatalog(all, 'bolt -old', null).map(e => e.name)).toEqual(['BOLT_S8.stl']);
    expect(filterCatalog(all, '"m3 old"', null)).toHaveLength(1);
    expect(filterCatalog(all, 'frame', null).map(e => e.name)).toEqual(['hook v2.stl']); // the folder counts
    expect(filterCatalog(all, 'bolt hook', null)).toHaveLength(0); // every term must match
  });

  it('filters on one folder, and the root with an empty name', () => {
    expect(filterCatalog(all, '', '1.4.BOLTS')).toHaveLength(2);
    expect(filterCatalog(all, '', '').map(e => e.name)).toEqual(['loose.stl']);
  });

  it('sorts by name (natural), date and size, both ways', () => {
    const files = [entry('a10.stl'), entry('a2.stl'), entry('B.stl')];
    expect(sortCatalog(files, 'name', true).map(e => e.name)).toEqual(['a2.stl', 'a10.stl', 'B.stl']);
    expect(sortCatalog(files, 'name', false).map(e => e.name)).toEqual(['B.stl', 'a10.stl', 'a2.stl']);
    expect(sortCatalog(all, 'date', false)[0].name).toBe('BOLT_S8.stl');
    expect(sortCatalog(all, 'size', true)[0].name).toBe('loose.stl');
    expect(files.map(e => e.name)).toEqual(['a10.stl', 'a2.stl', 'B.stl']); // the input is not changed
  });

  it('counts parts per folder', () => {
    expect(folderCounts(all)).toEqual([{ folder: '', count: 1 }, { folder: '1.4.BOLTS', count: 2 }, { folder: '10.17.FRAME', count: 1 }]);
  });

  it('works out the rows to draw', () => {
    expect(visibleRows(100, 1000, 0, 400, 200, 100)).toEqual({ columns: 5, rows: 20, first: 0, last: 6 });
    expect(visibleRows(100, 1000, 1000, 400, 200, 100)).toEqual({ columns: 5, rows: 20, first: 8, last: 16 });
    expect(visibleRows(3, 100, 0, 400, 200, 100).columns).toBe(1); // narrower than a card: one column
    expect(visibleRows(0, 1000, 0, 400, 200, 100).rows).toBe(0);
  });

  it('finds the folder of a path and the other files in it', () => {
    expect(parentFolder('a/b/c.stl')).toBe('a/b');
    expect(parentFolder('c.stl')).toBe('');
    const files = [entry('A/x2.stl'), entry('A/x10.stl'), entry('A/sub/y.stl'), entry('B/x2.stl'), entry('loose.stl')];
    expect(siblingsOf(files, 'A/x2.stl').map(e => e.path)).toEqual(['A/x10.stl']); // not itself, not a subfolder, not another folder
    expect(siblingsOf(files, 'loose.stl')).toEqual([]);
    expect(siblingsOf(files, 'A/sub/y.stl')).toEqual([]);
    expect(siblingsOf([entry('A/b.stl'), entry('A/a.stl'), entry('A/c.stl')], 'A/b.stl').map(e => e.name)).toEqual(['a.stl', 'c.stl']);
  });

  it('leaves out what went to the Trash', () => {
    const files = [entry('A/x.stl'), entry('A/sub/y.stl'), entry('B/z.stl'), entry('AB/w.stl')];
    expect(withoutPaths(files, ['A/x.stl']).map(e => e.path)).toEqual(['A/sub/y.stl', 'B/z.stl', 'AB/w.stl']);
    expect(withoutPaths(files, ['A']).map(e => e.path)).toEqual(['B/z.stl', 'AB/w.stl']); // a folder takes everything in it, not a folder that only starts with its name
    expect(withoutPaths(files, [])).toHaveLength(4);
  });

  it('lists the folders parts can be moved to', () => {
    const files = [entry('B/x.stl'), entry('A/sub/deep/y.stl'), entry('A/z.stl'), entry('root.stl')];
    expect(folderPaths(files)).toEqual(['A', 'A/sub', 'A/sub/deep', 'B']);
    expect(folderPaths([])).toEqual([]);
  });

  it('cleans a typed folder path', () => {
    expect(cleanFolderPath(' a // b/ c ')).toBe('a/b/c');
    expect(cleanFolderPath('')).toBe('');
    expect(cleanFolderPath('a/../b')).toBeNull();
    expect(cleanFolderPath('.hidden')).toBeNull();
  });
});
