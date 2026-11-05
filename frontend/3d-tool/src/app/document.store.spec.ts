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

  it('moving the camera is saved with the document but is no edit: no undo step, and undo leaves the camera alone', () => {
    vi.useFakeTimers();
    try {
      store.docId.set('doc-1');
      const { id } = store.addItem(part());
      const steps = () => (store.canUndo() ? 1 : 0);
      expect(steps()).toBe(1);
      store.undo(); // back to the empty document: now the only history is the camera
      store.redo();
      const view = { projection: 'persp' as const, position: [1, 2, 3] as Vec3, target: [0, 0, 0] as Vec3, zoom: 2, radius: 100 };
      store.setView(view);
      expect(store.doc().view).toEqual(view);
      store.updateItems('Move', new Map([[id, { position: [20, 0, 0] }]]));
      store.undo();
      expect(positions()).toEqual([[0, 0, 0]]);
      expect(store.doc().view).toEqual(view); // undoing a move did not put the camera back
      store.setView({ ...view, zoom: 3 });
      store.undo();
      expect(store.doc().items).toEqual([]); // the next undo step is the part that was added, not the camera
      expect(store.doc().view?.zoom).toBe(3);
    } finally {
      store.docId.set(null);
      vi.useRealTimers();
    }
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

  it('gives similar names one colour, but never copies black: a part like a black one gets a base colour', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const store = TestBed.inject(DocumentStore);
    store.addItem({ ...part(), name: 'BOLT_S1', color: 0 });
    const [bolt, again] = store.addParts([
      { path: 'x.stl', name: 'BOLT_S9', position: [20, 0, 0], rotation: [0, 0, 0, 1] },
      { path: 'y.stl', name: 'BOLT_S2', position: [40, 0, 0], rotation: [0, 0, 0, 1] },
    ]);
    expect(bolt.color).not.toBe(0);
    expect(again.color).toBe(bolt.color); // similar to the part just added
  });
});


describe('Groups', () => {
  let store: DocumentStore;
  let ids: string[];

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
    ids = [0, 20, 40, 60].map(x => store.addItem({ ...part([x, 0, 0]), name: `p${x}` }).id);
  });

  it('groups the selection in one undo step; selecting one member selects the group, Option-click only the part', () => {
    store.selectMany([ids[0], ids[2]]);
    expect(store.groupSelected()).toBe(true);
    expect(store.doc().groups?.length).toBe(1);
    expect(store.doc().items.slice(0, 2).map(i => i.id)).toEqual([ids[0], ids[2]]); // members are listed together, where the first was
    store.select(ids[2]);
    expect([...store.selectedIds()].sort()).toEqual([ids[0], ids[2]].sort());
    expect(store.selectedId()).toBe(ids[2]);
    store.selectPart(ids[2]);
    expect(store.selectedIds()).toEqual([ids[2]]);
    store.undo();
    expect(store.doc().groups?.length ?? 0).toBe(0);
    expect(store.doc().items.every(i => !i.groupId)).toBe(true);
  });

  it('the context menu of an unselected group member is for that part alone; with the group selected it is for the group', () => {
    store.selectMany([ids[0], ids[1]]);
    store.groupSelected();
    store.select(null);
    store.openContextMenu(0, 0, ids[1]);
    expect(store.contextMenu()?.ids).toEqual([ids[1]]);
    store.select(ids[1]);
    store.openContextMenu(0, 0, ids[1]);
    expect([...store.contextMenu()!.ids].sort()).toEqual([ids[0], ids[1]].sort());
  });

  it('needs two parts, ungroups, and dissolves a group that is left with one part', () => {
    store.select(ids[0]);
    expect(store.groupSelected()).toBe(false);
    store.selectMany([ids[0], ids[1], ids[2]]);
    store.groupSelected();
    store.remove(ids[0]);
    expect(store.doc().groups?.length).toBe(1); // two left: still a group
    store.remove(ids[1]);
    expect(store.doc().groups?.length).toBe(0); // one left: dissolved
    expect(store.doc().items.every(i => !i.groupId)).toBe(true);
    store.selectMany([ids[2], ids[3]]);
    store.groupSelected();
    expect(store.ungroupSelected()).toBe(true);
    expect(store.doc().groups?.length).toBe(0);
  });

  it('⌘-click with only some parts of a group selected adds or removes single parts of it', () => {
    store.selectMany([ids[0], ids[1], ids[2]]);
    store.groupSelected();
    store.selectPart(ids[0]);
    store.toggleSelect(ids[1]);
    expect([...store.selectedIds()].sort()).toEqual([ids[0], ids[1]].sort()); // not the whole group
    store.toggleSelect(ids[0]);
    expect(store.selectedIds()).toEqual([ids[1]]);
  });

  it('regrouping moves parts out of their old group, ⌘-click toggles a whole group, pasted parts are not grouped', () => {
    store.selectMany([ids[0], ids[1]]);
    store.groupSelected();
    store.toggleSelect(ids[2]);
    store.toggleSelect(ids[0]);
    expect(store.selectedIds()).toEqual([ids[2]]); // the whole group left the selection
    const [copy] = store.addParts([{ ...part(), groupId: store.doc().items[0].groupId }]);
    expect(copy.groupId).toBeNull();
  });
});

describe('Design and Render mode', () => {
  let store: DocumentStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
  });

  it('starts in Design, toggles, and remembers the mode per browser', () => {
    expect(store.appMode()).toBe('design');
    store.toggleAppMode();
    expect(store.appMode()).toBe('render');
    expect(localStorage.getItem('rasterfaster.appMode')).toBe('render');
    store.setAppMode('design');
    expect(store.appMode()).toBe('design');
  });

  it('shows the render colour only in Render mode, and only when the part has one', () => {
    const plain = store.addItem({ ...part(), color: 0x112233 });
    const own = store.addItem({ ...part(), color: 0x112233, render: { color: 0xabcdef } });
    expect([store.displayColor(plain), store.displayColor(own)]).toEqual([0x112233, 0x112233]);
    store.setAppMode('render');
    expect([store.displayColor(plain), store.displayColor(own)]).toEqual([0x112233, 0xabcdef]); // no render colour: the design colour
  });

  it('the render settings of a part go through undo and the clipboard', () => {
    const { id } = store.addItem(part());
    store.updateItems('Render finish', new Map([[id, { render: { finish: 'metal', color: 0x336699 } }]]));
    expect(store.doc().items[0].render).toEqual({ finish: 'metal', color: 0x336699 });
    store.undo();
    expect(store.doc().items[0].render).toBeUndefined();
    store.redo();
    store.select(id);
    store.copySelection();
    store.pasteClipboard();
    expect(store.doc().items[1].render).toEqual({ finish: 'metal', color: 0x336699 });
  });
});

describe('Paste', () => {
  it('pastes the copied parts exactly where the originals are, and selects the new ones', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    const store = TestBed.inject(DocumentStore);
    const a = store.addItem(part([40, 60, 6])), b = store.addItem(part([100, 60, 6]));
    store.selectedIds.set([a.id, b.id]);
    store.copySelection();
    expect(store.pasteClipboard()).toBe(2);
    const items = store.doc().items;
    expect(items.length).toBe(4);
    expect(items[2].position).toEqual([40, 60, 6]);
    expect(items[3].position).toEqual([100, 60, 6]);
    expect(store.selectedIds()).toEqual([items[2].id, items[3].id]); // the copies are selected, ready to move
  });
});

describe('Colours by mode', () => {
  let store: DocumentStore;
  let a: string, b: string;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
    a = store.addItem({ ...part(), color: 0x111111 }).id;
    b = store.addItem({ ...part([20, 0, 0]), color: 0x222222 }).id;
  });

  const item = (id: string) => store.doc().items.find(i => i.id === id)!;

  it('colours the design colour in Design mode and the render colour in Render mode', () => {
    store.setColor([a], 0xaa0000);
    expect([item(a).color, item(a).render]).toEqual([0xaa0000, undefined]);
    store.setAppMode('render');
    store.setColor([a, b], 0x00aa00);
    expect([item(a).color, item(a).render?.color, item(b).color, item(b).render?.color]).toEqual([0xaa0000, 0x00aa00, 0x222222, 0x00aa00]); // the design colours are untouched
    expect(store.displayColor(item(a))).toBe(0x00aa00);
    store.setAppMode('design');
    expect(store.displayColor(item(a))).toBe(0xaa0000);
  });

  it('resets a render colour, copies the design colour, and drops the empty render field', () => {
    store.setAppMode('render');
    store.setColor([a], 0x00aa00);
    store.resetRenderColor([a]);
    expect(item(a).render).toBeNull(); // nothing of Render mode is left on the part
    store.copyDesignToRender([b]);
    expect(item(b).render?.color).toBe(0x222222);
    store.setItemRender([b], { finish: 'metal' });
    store.resetRenderColor([b]);
    expect(item(b).render).toEqual({ color: null, finish: 'metal' }); // the finish stays
  });
});

describe('Finishes and hiding in Render mode', () => {
  let store: DocumentStore;
  let a: string, b: string;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
    a = store.addItem(part()).id;
    b = store.addItem(part([20, 0, 0])).id;
  });

  const item = (id: string) => store.doc().items.find(i => i.id === id)!;

  it('sets a finish, and satin takes it away again', () => {
    store.setFinish([a], 'mirror');
    expect(item(a).render).toEqual({ finish: 'mirror' });
    store.setFinish([a], 'satin');
    expect(item(a).render).toBeNull();
  });

  it('hides parts in Render mode only, and Select all leaves them out there', () => {
    store.setHiddenInRender([a], true);
    expect(store.isHiddenNow(item(a))).toBe(false); // Design mode: still there
    store.selectAll();
    expect(store.selectedIds().length).toBe(2);
    store.setAppMode('render');
    expect(store.isHiddenNow(item(a))).toBe(true);
    expect(store.isHiddenNow(item(b))).toBe(false);
    store.selectAll();
    expect(store.selectedIds()).toEqual([b]);
    store.setHiddenInRender([a], false);
    expect(item(a).render).toBeNull();
  });
});

describe('Saved views', () => {
  let store: DocumentStore;
  const camera = (x: number) => ({ projection: 'ortho' as const, position: [x, 0, 0] as Vec3, target: [0, 0, 0] as Vec3, zoom: 1, radius: 100, mode: 'solid' });

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
  });

  it('saves, numbers, renames, updates, recalls and deletes views, each one undo step', () => {
    expect(store.saveCurrentView()).toBeNull(); // no 3D view to take it from
    let x = 1;
    store.captureView = () => camera(x);
    const recalled: string[] = [];
    store.recallView = view => recalled.push(view.name);
    const first = store.saveCurrentView()!;
    x = 2;
    const second = store.saveCurrentView('Front')!;
    expect(first.name).toBe('View 1');
    expect(store.doc().views?.map(v => v.name)).toEqual(['View 1', 'Front']);
    store.renameSavedView(first.id, 'Top');
    x = 3;
    store.updateSavedView(second.id);
    expect(store.doc().views?.[1].position).toEqual([3, 0, 0]);
    store.goToSavedView(1);
    store.goToSavedView(second.id);
    store.updateSavedViewNumber(2);
    expect(store.doc().views?.[1].position).toEqual([3, 0, 0]);
    store.goToSavedView(9); // there is no ninth
    expect(recalled).toEqual(['Top', 'Front']);
    expect(store.lastViewId()).toBe(second.id); // the view the camera came from, for the panel's "changed" mark
    store.removeSavedView(first.id);
    expect(store.doc().views?.length).toBe(1);
    store.undo();
    expect(store.doc().views?.length).toBe(2);
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


describe('Find in browser (the request for the file list)', () => {
  let store: DocumentStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    store = TestBed.inject(DocumentStore);
  });

  it('asks for the file of each part once, in document order, and every request counts', () => {
    const a = store.addItem({ ...part(), path: 'Folder/a.stl' });
    const b = store.addItem({ ...part(), path: 'Other/b.stl' });
    const again = store.addItem({ ...part(), path: 'Folder/a.stl' });  // the same file twice
    expect(store.browserRequest()).toBeNull();
    store.findInBrowser([again.id, b.id]);
    expect(store.browserRequest()).toEqual({ paths: ['Other/b.stl', 'Folder/a.stl'], seq: 1, ids: [b.id, again.id] });
    store.findInBrowser([a.id, again.id]);
    expect(store.browserRequest()).toEqual({ paths: ['Folder/a.stl'], seq: 2, ids: [a.id, again.id] });         // asking again for the same file is a new request
    store.findInBrowser([]);
    expect(store.browserRequest()?.seq).toBe(2);                                         // nothing to find: no request
  });

  it('selectMany keeps the last id as the shown one and can add to the selection', () => {
    const [x, y, z] = [store.addItem(part()), store.addItem(part()), store.addItem(part())];
    store.select(x.id);
    store.selectMany([y.id, z.id]);
    expect(store.selectedIds()).toEqual([y.id, z.id]);
    expect(store.selectedId()).toBe(z.id);
    store.selectMany([x.id, y.id], true);
    expect(store.selectedIds()).toEqual([z.id, x.id, y.id]);                              // added ones last, no duplicates
  });

  it('relink points parts at another file: the chosen ones, or all that share the file; the name follows only when it was the file name; one undo step', () => {
    const one = store.addItem({ ...part(), path: 'old/Atlas.stl', name: 'Atlas' });
    const two = store.addItem({ ...part(), path: 'old/Atlas.stl', name: 'My own name' });
    const other = store.addItem({ ...part(), path: 'x/other.stl', name: 'other' });
    expect(store.relink([one.id], 'new/Atlas_001.stl')).toBe(1);
    expect(store.doc().items.map(i => [i.path, i.name])).toEqual([['new/Atlas_001.stl', 'Atlas_001'], ['old/Atlas.stl', 'My own name'], ['x/other.stl', 'other']]);
    expect(store.relink([two.id], 'new/Atlas_001.stl', true)).toBe(1);                      // all that share the old file (the first one moved already)
    expect(store.doc().items[1]).toMatchObject({ path: 'new/Atlas_001.stl', name: 'My own name' });
    expect(store.relink([one.id, two.id], 'new/Atlas_001.stl')).toBe(0);                    // nothing to change: no undo step
    store.undo();
    expect(store.doc().items[1].path).toBe('old/Atlas.stl');
    expect(store.doc().items[2].id).toBe(other.id);
  });
});
