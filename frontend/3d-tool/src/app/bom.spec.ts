import { bomToCsv, buildBom } from './bom';
import type { DocItem } from './document.store';

const item = (id: string, path: string, extra: Partial<DocItem> = {}): DocItem => ({
  id, path, name: path, color: 1, position: [0, 0, 0], rotation: [0, 0, 0, 1], ...extra,
});

describe('buildBom', () => {
  it('counts how often each file is used', () => {
    const rows = buildBom([item('1', 'a.stl'), item("2", 'b.stl'), item('3', 'a.stl')], {});
    expect(rows.map(r => [r.path, r.quantity])).toEqual([['a.stl', 2], ['b.stl', 1]]);
  });

  it('keeps parts marked do-not-export out of the main list and puts them in their own section', () => {
    const items = [item('1', 'a.stl'), item('2', 'mock.stl', { noExport: true }), item('3', 'a.stl', { noExport: true }), item('4', 'mock.stl', { noExport: true })];
    expect(buildBom(items, {}).map(r => [r.path, r.quantity])).toEqual([['a.stl', 1]]);
    expect(buildBom(items, {}, true).map(r => [r.path, r.quantity])).toEqual([['a.stl', 1], ['mock.stl', 2]]);
  });
});

describe('bomToCsv', () => {
  it('writes the exported parts with a TOTAL, then the not-exported section without one', () => {
    const items = [item('1', 'a.stl'), item('2', 'mock.stl', { noExport: true })];
    const csv = bomToCsv(buildBom(items, {}), buildBom(items, {}, true));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toContain('Part,Qty');
    expect(lines[1]).toBe('a.stl,1,,,,,,a.stl');
    expect(lines[2].startsWith('TOTAL,1')).toBe(true);
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('NOT EXPORTED');
    expect(lines[5]).toContain('Part,Qty');
    expect(lines[6]).toBe('mock.stl,1,,,,,,mock.stl');
    expect(lines).toHaveLength(7); // no total for the mock section
  });

  it('has no extra section when nothing is excluded', () => {
    const csv = bomToCsv(buildBom([item('1', 'a.stl')], {}));
    expect(csv).not.toContain('NOT EXPORTED');
  });
});
