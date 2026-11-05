import { describe, expect, it } from 'vitest';
import { CatalogEntry, displayName, filterCatalog, folderCode, folderCounts, parentFolder, siblingsOf, withoutPaths, folderPaths, cleanFolderPath, isOldPath, groupCopies, remapPath, documentsOf, crumbsOf, childFolders, filesIn, isWithin, companionKey, companionsOf, sortCatalog, visibleRows } from './catalog.logic';

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

  it('recognizes old-looking paths', () => {
    for (const old of ['_V-TWIN_OLD/models/x.stl', 'A/backup/x.stl', 'A/part copy.stl', 'A/part_old.stl', 'A/Model.bak.stl', '2x3 BP EXTENDER (1) (1).stl', 'A/oud/x.stl']) expect(isOldPath(old)).toBe(true);
    for (const fine of ['A/BOLT_S8.stl', 'Gold/x.stl', 'A/copyright.stl', 'A/boldly.stl', 'A/Holder v2.stl', '1.4.BOLTS & NUTS/x.stl']) expect(isOldPath(fine)).toBe(false);
  });

  it('lists the copies of identical files by path, without preferring one', () => {
    const files = [entry('B/p.stl', 9), entry('A/p.stl', 5), entry('_old/p.stl', 20), entry('C/q.stl', 1), entry('D/q.stl', 2), entry('E/solo.stl', 1)];
    const groups = [{ paths: ['B/p.stl', 'A/p.stl', '_old/p.stl'], size: 1 }, { paths: ['C/q.stl', 'D/q.stl'], size: 2 }, { paths: ['E/solo.stl', 'gone.stl'], size: 3 }];
    expect(groupCopies(files, groups).map(g => g.map(e => e.path))).toEqual([['_old/p.stl', 'A/p.stl', 'B/p.stl'], ['C/q.stl', 'D/q.stl']]); // a group left with one copy is dropped
  });

  it('follows renames and moves of files and folders', () => {
    const moves = [{ from: 'A/x.stl', to: 'B/x.stl' }, { from: 'old', to: 'archive/old', kind: 'directory' }];
    expect(remapPath('A/x.stl', moves)).toBe('B/x.stl');
    expect(remapPath('old/deep/y.stl', moves)).toBe('archive/old/deep/y.stl');
    expect(remapPath('older/y.stl', moves)).toBe('older/y.stl'); // only whole folder names
    expect(remapPath('C/z.stl', moves)).toBe('C/z.stl');
  });

  it('names the documents of a dry run once', () => {
    expect(documentsOf({ 'kiosk-1.json': 2, 'kiosk-1.versions/v3.json': 1, 'kiosk-1.versions/v4.json': 1, 'dada-2.json': 1 })).toEqual({ ids: ['dada-2', 'kiosk-1'], parts: 5 });
    expect(documentsOf({})).toEqual({ ids: [], parts: 0 });
  });

  it('makes crumbs of a folder path', () => {
    expect(crumbsOf('')).toEqual([{ name: 'LIBRARY', path: '' }]);
    expect(crumbsOf('A/b c/d')).toEqual([{ name: 'LIBRARY', path: '' }, { name: 'A', path: 'A' }, { name: 'b c', path: 'A/b c' }, { name: 'd', path: 'A/b c/d' }]);
  });

  it('lists the folders and files of one folder', () => {
    const files = [entry('A/x.stl'), entry('A/B/y.stl'), entry('A/B/z.stl'), entry('A/B/C/w.stl'), entry('A/D/v.stl'), entry('AB/u.stl'), entry('root.stl')];
    expect(childFolders(files, '')).toEqual([{ name: 'A', path: 'A', count: 5 }, { name: 'AB', path: 'AB', count: 1 }]);
    expect(childFolders(files, 'A')).toEqual([{ name: 'B', path: 'A/B', count: 3 }, { name: 'D', path: 'A/D', count: 1 }]);
    expect(childFolders(files, 'A/D')).toEqual([]);
    expect(filesIn(files, 'A').map(e => e.path)).toEqual(['A/x.stl']);
    expect(filesIn(files, '').map(e => e.path)).toEqual(['root.stl']);
    expect(filesIn(files, 'A/B').map(e => e.path)).toEqual(['A/B/y.stl', 'A/B/z.stl']);
  });

  it('knows whether a folder is within another', () => {
    expect(isWithin('A/B', 'A')).toBe(true);
    expect(isWithin('A', 'A')).toBe(true);
    expect(isWithin('AB', 'A')).toBe(false);
    expect(isWithin('A', 'A/B')).toBe(false);
    expect(isWithin('anything', '')).toBe(true);
  });

  it('knows which parts belong together by their names', () => {
    expect(companionKey('3.43 USB-C FEMALE FRONT.stl')).toBe('3.43 usb-c female {depth}');
    expect(companionKey('3.43 USB-C FEMALE BACK.stl')).toBe('3.43 usb-c female {depth}');
    expect(companionKey('CORNER left 3h')).toBe(companionKey('Corner RIGHT 3h.stl'));
    expect(companionKey('BOLT_S3_BLIND.stl')).toBeNull();
    expect(companionKey('TOPLESS bar.stl')).toBeNull(); // whole words only
    expect(companionKey('x BOTTOM LEFT.stl')).toBe(companionKey('x TOP RIGHT.stl')); // a name with two pairs: the four corners belong together
    expect(companionKey('x TOP.stl')).not.toBe(companionKey('x TOP LEFT.stl')); // but not a part that has one pair only
  });

  it('finds the companions of a part in its own folder', () => {
    const files = [entry('M/3.43 USB-C FEMALE FRONT.stl'), entry('M/3.43 USB-C FEMALE BACK.stl'), entry('M/3.43 USB-C FEMALE BACK (1).stl'), entry('N/3.43 USB-C FEMALE BACK.stl'), entry('M/other.stl'),
      entry('M/c TOP LEFT.stl'), entry('M/c TOP RIGHT.stl'), entry('M/c BOTTOM LEFT.stl'), entry('M/c BOTTOM RIGHT.stl')];
    expect(companionsOf(files, 'M/3.43 USB-C FEMALE FRONT.stl').map(e => e.name)).toEqual(['3.43 USB-C FEMALE BACK.stl']); // not the "(1)" copy, not another folder
    expect(companionsOf(files, 'M/c TOP LEFT.stl').map(e => e.name)).toEqual(['c BOTTOM LEFT.stl', 'c BOTTOM RIGHT.stl', 'c TOP RIGHT.stl']);
    expect(companionsOf(files, 'M/other.stl')).toEqual([]);
    expect(companionsOf(files, 'M/missing.stl')).toEqual([]);
  });
});
