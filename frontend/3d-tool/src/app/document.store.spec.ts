import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { vi } from 'vitest';
import { DocItem, DocumentStore, Vec3, cellCenteredPosition } from './document.store';

const part = (position: [number, number, number] = [0, 0, 0]): Omit<DocItem, 'id'> => ({
  path: 'a.stl', name: 'a', color: 0xff0000, position, rotation: [0, 0, 0, 1],
});

describe('DocumentStore history (mutate, gestures, undo)', () => {
  let store: DocumentStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore); // no document id: nothing is saved to the API
  });

  afterEach(() => vi.restoreAllMocks());

  const positions = () => store.doc().items.map(i => i.position);

  it('one mutation is one undo step, and undo / redo walk it back and forth', () => {
    const { id } = store.addItem(part());
    expect(store.canUndo()).toBe(true);
    store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]));
    expect(positions()).toEqual([[20, 0, 0]]);
    store.undo();
    expect(positions()).toEqual([[0, 0, 0]]);
    store.undo();
    expect(store.doc().items).toEqual([]);
    expect(store.canUndo()).toBe(false);
    store.redo();
    store.redo();
    expect(positions()).toEqual([[20, 0, 0]]);
    expect(store.canRedo()).toBe(false);
  });

  it('a change that changes nothing makes no undo step', () => {
    const { id } = store.addItem(part([20, 0, 0]));
    store.undo();
    store.redo(); // history: [empty] <- now
    const before = store.canRedo();
    expect(store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]))).toBe(false);
    expect(store.mutate('same', d => d)).toBe(false);
    expect(store.canRedo()).toBe(before); // redo history untouched too
    store.undo();
    expect(store.doc().items).toEqual([]); // the very next undo reverts the real edit, not an empty one
  });

  it('a new edit clears the redo history', () => {
    const { id } = store.addItem(part());
    store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]));
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.updateItems('Move', new Map([[id, { position: [40, 0, 0] }]]));
    expect(store.canRedo()).toBe(false);
  });

  it('a gesture shows every change live but is ONE undo step', () => {
    const { id } = store.addItem(part());
    store.beginGesture('Move');
    for (const x of [20, 40, 60, 80]) {
      store.updateItems('Move', new Map([[id, { position: [x, 0, 0] }]]));
      expect(positions()).toEqual([[x, 0, 0]]); // live
    }
    store.endGesture();
    store.undo();
    expect(positions()).toEqual([[0, 0, 0]]); // one undo undoes the whole drag
    store.undo();
    expect(store.doc().items).toEqual([]);
  });

  it('abortGesture puts everything back and writes no undo step', () => {
    const { id } = store.addItem(part());
    store.undo();
    store.redo();
    store.beginGesture('Move');
    store.updateItems('Move', new Map([[id, { position: [100, 0, 0] }]]));
    store.abortGesture();
    expect(positions()).toEqual([[0, 0, 0]]);
    expect(store.gestureOpen).toBe(false);
    store.undo();
    expect(store.doc().items).toEqual([]); // the aborted drag left nothing in the history
  });

  it('a gesture in which nothing moved leaves the history alone', () => {
    store.addItem(part());
    store.undo();
    store.redo();
    store.beginGesture('Move');
    store.endGesture();
    expect(store.canRedo()).toBe(false);
    store.undo();
    expect(store.doc().items).toEqual([]);
  });

  it('starting a gesture while one is open finishes the open one first', () => {
    const { id } = store.addItem(part());
    store.beginGesture('first');
    store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]));
    store.beginGesture('second'); // the first never got its end
    store.updateItems('Move', new Map([[id, { position: [40, 0, 0] }]]));
    store.endGesture();
    store.undo();
    expect(positions()).toEqual([[20, 0, 0]]);
    store.undo();
    expect(positions()).toEqual([[0, 0, 0]]);
  });

  it('a gesture that stayed open far too long is closed by the next change', () => {
    const { id } = store.addItem(part());
    const now = Date.now();
    store.beginGesture('stuck drag');
    store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]));
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    store.updateItems('Move', new Map([[id, { position: [40, 0, 0] }]])); // stale gesture is committed, this edit is its own step
    expect(store.gestureOpen).toBe(false);
    store.undo();
    expect(positions()).toEqual([[20, 0, 0]]);
    store.undo();
    expect(positions()).toEqual([[0, 0, 0]]);
  });
});

describe('DocumentStore older versions', () => {
  it('ignore edits while an older version is being looked at', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const store = TestBed.inject(DocumentStore);
    store.addItem(part());
    expect(store.doc().items).toHaveLength(1);
    store.viewing.set(1); // what viewVersion() does after loading v1
    expect(store.mutate('Edit', d => ({ ...d, name: 'changed' }))).toBe(false);
    expect(store.doc().name).not.toBe('changed');
    store.viewing.set(null);
    expect(store.mutate('Edit', d => ({ ...d, name: 'changed' }))).toBe(true);
  });
});

describe('DocumentStore.addParts', () => {
  it('adds several parts as one undo step, selects them all and continues the colour cycle', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const store = TestBed.inject(DocumentStore);
    store.addItem(part());
    const before = store.doc().items.length;
    const created = store.addParts([
      { path: 'a.stl', name: 'a', position: [20, 0, 0], rotation: [0, 0, 0, 1] },
      { path: 'b.stl', name: 'b', position: [40, 0, 0], rotation: [0, 0, 0, 1] },
      { path: 'c.stl', name: 'c', position: [60, 0, 0], rotation: [0, 0, 0, 1] },
    ]);
    expect(store.doc().items.length).toBe(before + 3);
    expect(new Set(created.map(c => c.color)).size).toBe(3); // different colours
    expect(store.selectedIds()).toEqual(created.map(c => c.id));
    store.undo(); // one step takes all three away
    expect(store.doc().items.length).toBe(before);
    expect(store.addParts([])).toEqual([]);
  });
});


describe('Center on grid (X, Y and Z)', () => {
  const upright: Vec3 = [15.31, 15.301, 44];    // BOLT_S8 standing up
  const lying: Vec3 = [44, 15.31, 15.301];      // the same bolt on its side

  it('centres X and Y on a 20 mm cell as before, and Z only when a Z grid mode is given', () => {
    expect(cellCenteredPosition([0, 0, 0], upright)).toEqual([2.345, 2.35, 0]);               // no Z mode: z untouched
    expect(cellCenteredPosition([0, 0, 3], upright)).toEqual([2.345, 2.35, 3]);
  });

  it('puts the centre of the box on the nearest Z level of the grid mode', () => {
    // baseplate levels 0, 2, 6, 10 ...: the 44 mm bolt's centre (22) already is a level, the lying bolt's centre (7.65) goes to 6
    expect(cellCenteredPosition([0, 0, 0], upright, 'baseplate')[2]).toBe(0);
    expect(cellCenteredPosition([0, 0, 0], lying, 'baseplate')[2]).toBe(-1.65);               // 6 - 15.301 / 2 = -1.65
    expect(cellCenteredPosition([0, 0, 0], lying, 'fine')[2]).toBeCloseTo(0.35, 2);           // levels every 2 mm: the centre 7.65 goes to 8, 8 - 7.65 = 0.35
    expect(cellCenteredPosition([0, 0, 0], lying, 'coarse')[2]).toBeCloseTo(0.35, 2);         // levels every 4 mm: 8 as well
  });

  it('is stable: centring a centred part changes nothing', () => {
    const once = cellCenteredPosition([13, 41, 5], lying, 'baseplate');
    expect(cellCenteredPosition(once, lying, 'baseplate')).toEqual(once);
  });

  describe('in the store', () => {
    let store: DocumentStore;

    beforeEach(() => {
      localStorage.clear();
      TestBed.configureTestingModule({ providers: [provideHttpClient()] });
      store = TestBed.inject(DocumentStore);
      store.sizeOf = () => lying;
      store.zMode = () => 'baseplate';
    });

    it('setCentered centres all three axes in one undo step and remembers it', () => {
      const { id } = store.addItem(part([0, 0, 0]));
      store.setCentered([id], true);
      const item = store.doc().items[0];
      expect(item.centered).toBe(true);
      expect(item.position[0]).toBe(8);                                                       // the 44 mm length centres at x = 30 (a cell middle)
      expect(item.position[1]).toBeCloseTo(2.345, 2);                                         // the 15.31 mm width centres at y = 10
      expect(item.position[2]).toBe(-1.65);
      store.undo();
      expect(store.doc().items[0].position).toEqual([0, 0, 0]);
      expect(store.doc().items[0].centered).toBeFalsy();
    });
  });
});
