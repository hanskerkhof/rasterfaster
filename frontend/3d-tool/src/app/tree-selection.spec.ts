import { actedOn, pruned, rangeBetween, toggled } from './tree-selection';

const rows = ['a', 'a/one.stl', 'a/two.stl', 'ab', 'ab/x.stl', 'b.stl', 'c.stl'];

describe('tree selection', () => {
  it('a range goes from the anchor to the target, in either direction, both included', () => {
    expect(rangeBetween(rows, 'a/one.stl', 'ab')).toEqual(['a/one.stl', 'a/two.stl', 'ab']);
    expect(rangeBetween(rows, 'ab', 'a/one.stl')).toEqual(['a/one.stl', 'a/two.stl', 'ab']);
    expect(rangeBetween(rows, 'b.stl', 'b.stl')).toEqual(['b.stl']);
  });

  it('without a usable anchor a range is just the target; an unknown target gives nothing', () => {
    expect(rangeBetween(rows, null, 'c.stl')).toEqual(['c.stl']);
    expect(rangeBetween(rows, 'gone', 'c.stl')).toEqual(['c.stl']);
    expect(rangeBetween(rows, 'a', 'gone')).toEqual([]);
  });

  it('toggling adds and removes and never changes the old set', () => {
    const base = new Set(['a']);
    const added = toggled(base, 'b.stl');
    expect([...added]).toEqual(['a', 'b.stl']);
    expect([...toggled(added, 'a')]).toEqual(['b.stl']);
    expect([...base]).toEqual(['a']);
  });

  it('a selected folder swallows the selected things inside it (but not a folder that only starts with its name)', () => {
    expect(actedOn(rows, new Set(['a/one.stl', 'a', 'ab/x.stl', 'c.stl']))).toEqual(['a', 'ab/x.stl', 'c.stl']);
    expect(actedOn(rows, new Set(['a/two.stl', 'a/one.stl']))).toEqual(['a/one.stl', 'a/two.stl']); // row order
    expect(actedOn(rows, new Set())).toEqual([]);
  });

  it('pruning drops what is no longer visible', () => {
    expect([...pruned(['a', 'b.stl'], new Set(['a', 'gone.stl', 'b.stl']))]).toEqual(['a', 'b.stl']);
  });
});
