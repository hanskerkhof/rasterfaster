import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { vi } from 'vitest';
import { DocItem, DocumentStore } from './document.store';

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
