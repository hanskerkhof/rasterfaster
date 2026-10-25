import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ClipboardContent, copyItems, pasteItems } from './clipboard';
import { DocumentApi, DocumentSummary } from './document.api';

/** Grid the document snaps to, in mm. */
/** X/Y snap steps in mm. Height (Z) follows the grid mode, see z-levels.ts. */
export const snapStepMm = { x: 20, y: 20 } as const;

export type Vec3 = [number, number, number];

/**
 * Safety limits for the document: parts can't leave this box (mm). 100 × 100 cells of the 20 mm grid, centred on the origin,
 * which keeps a runaway drag from flinging a part (and the grid) off to infinity.
 */
export const workArea = { min: [-1000, -1000, -200] as Vec3, max: [1000, 1000, 1000] as Vec3 };

/** Clamps a bounding-box min corner so the whole box (of `size`) stays inside the work area. */
/** Moves a bounding-box min corner so the footprint centre sits in the middle of the grid cell that holds it (z untouched). */
export function cellCenteredPosition(position: Vec3, size: Vec3): Vec3 {
  const cell = (centre: number, step: number) => Math.floor(centre / step) * step + step / 2;
  const round = (v: number) => Math.round(v * 1000) / 1000; // STL sizes carry float32 noise
  return [
    round(cell(position[0] + size[0] / 2, snapStepMm.x) - size[0] / 2),
    round(cell(position[1] + size[1] / 2, snapStepMm.y) - size[1] / 2),
    position[2],
  ];
}

export function clampToWorkArea(position: Vec3, size: Vec3 = [0, 0, 0]): Vec3 {
  return position.map((v, i) => {
    const high = Math.max(workArea.min[i], workArea.max[i] - size[i]);
    return Math.min(Math.max(v, workArea.min[i]), high);
  }) as Vec3;
}
export type Quat = [number, number, number, number];

export interface DocItem {
  id: string;
  /** Library path of the .stl, relative to the RASTERFASTER root. */
  path: string;
  name: string;
  color: number;
  /** World position of the bounding-box minimum corner *after* rotation (mm). */
  position: Vec3;
  rotation: Quat;
  /** Dimmed to a ghost and ignored by clicks (e.g. a cover while working on what's inside). */
  muted?: boolean;
  /** Keeps the footprint centre on the middle of a grid cell when the item is dragged, nudged or rotated. */
  centered?: boolean;
}

/** Measured from a part's STL as stored in the library (unrotated). */
export interface PartStats {
  size: Vec3;
  /** Solid volume in cm³. */
  volumeCm3: number;
  triangles: number;
}

export interface RfDocument {
  name: string;
  items: DocItem[];
}

const legacyStorageKey = 'rasterfaster.document'; // pre-API documents lived in the browser; migrated once on startup
const currentIdStorageKey = 'rasterfaster.documentId';
const clipboardStorageKey = 'rasterfaster.clipboard';
const itemColors = [0x6fa8dc, 0x93c47d, 0xf6b26b, 0xc27ba0, 0x8e7cc3, 0xe06666, 0x76a5af, 0xffd966];
const maxHistory = 200;
/** A gesture open this long never got its end (lost pointer, tab switch): treat it as finished. */
const gestureStaleMs = 30_000;
const saveDelayMs = 400;

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

/** Largest coordinate (mm) accepted from a stored document; further out is corrupt data, not a placement. */
const maxCoordinateMm = 20000;

/** Replaces non-finite or absurd positions/rotations (from an earlier drag glitch) with safe values. Returns whether anything changed. */
function sanitize(doc: RfDocument): boolean {
  let changed = false;
  for (const item of doc.items) {
    const safe = item.position.map(v => (Number.isFinite(v) && Math.abs(v) <= maxCoordinateMm ? v : 0)) as Vec3; // corrupt values restart at 0
    const clamped = clampToWorkArea(safe);
    if (clamped.some((v, i) => v !== item.position[i])) changed = true;
    item.position = clamped;
    if (!item.rotation.every(Number.isFinite)) { item.rotation = [0, 0, 0, 1]; changed = true; }
  }
  return changed;
}

function readClipboard(): ClipboardContent | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(clipboardStorageKey) ?? 'null');
    if (parsed && Array.isArray(parsed.items) && parsed.items.length && Array.isArray(parsed.origin)) return parsed;
  } catch { /* storage unavailable or corrupt */ }
  return null;
}

function emptyDocument(): RfDocument {
  return { name: 'Untitled', items: [] };
}

/**
 * The document being assembled: items, selection, undo/redo and persistence through the API.
 * `patch` changes the document without a history entry (use during drags); `commit` closes an edit and schedules a save.
 */
@Injectable({ providedIn: 'root' })
export class DocumentStore {
  private readonly api = inject(DocumentApi);

  readonly doc = signal<RfDocument>(emptyDocument());
  readonly docId = signal<string | null>(null);
  readonly documents = signal<DocumentSummary[]>([]);
  readonly saveState = signal<SaveState>('saved');
  /** Per library path, filled in as the scene loads each STL. Not part of the saved document. */
  readonly partStats = signal<Record<string, PartStats>>({});
  /** Selected item ids in selection order (⌘-click adds/removes). */
  readonly selectedIds = signal<readonly string[]>([]);
  /** The most recently selected item. */
  readonly selectedId = computed(() => this.selectedIds().at(-1) ?? null);
  readonly selectedItems = computed(() => {
    const ids = new Set(this.selectedIds());
    return this.doc().items.filter(i => ids.has(i.id));
  });
  /** The selected item when exactly one is selected (what the X/Y/Z fields edit). */
  readonly selected = computed(() => (this.selectedItems().length === 1 ? this.selectedItems()[0] : null));
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  private past: string[] = [];
  private future: string[] = [];
  private committed = JSON.stringify(this.doc());
  private gestureLabel: string | null = null;
  private gestureStartedAt = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving = false;
  private dirty = false;

  constructor() {
    // Flush a pending save when the tab closes; keepalive lets the request outlive the page.
    addEventListener('pagehide', () => {
      const id = this.docId();
      if (!id || !this.dirty) return;
      const { name, items } = this.doc();
      fetch(`/api/documents/${id}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, items }) });
    });
  }

  /** Loads the last opened document (or the newest, or a fresh one) and migrates a pre-API browser document once. */
  async init() {
    const legacy = this.takeLegacyDocument(); // synchronously first, so two overlapping page loads can't both import it
    try {
      let list = await firstValueFrom(this.api.list());
      if (legacy) {
        const created = await firstValueFrom(this.api.create({ name: legacy.name === 'Untitled' ? 'Imported' : legacy.name, items: legacy.items }));
        list = await firstValueFrom(this.api.list());
        this.writeCurrentId(created.id);
      }
      const wanted = this.readCurrentId();
      const id = list.find(d => d.id === wanted)?.id ?? list[0]?.id;
      this.documents.set(list);
      if (id) await this.open(id);
      else await this.create('Untitled');
    } catch {
      this.saveState.set('error');
    }
  }

  private takeLegacyDocument(): RfDocument | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(legacyStorageKey) ?? 'null');
      localStorage.removeItem(legacyStorageKey);
      return parsed && Array.isArray(parsed.items) && parsed.items.length ? parsed : null;
    } catch { return null; }
  }

  private readCurrentId() {
    try { return localStorage.getItem(currentIdStorageKey); } catch { return null; }
  }

  private writeCurrentId(id: string | null) {
    try { id ? localStorage.setItem(currentIdStorageKey, id) : localStorage.removeItem(currentIdStorageKey); } catch { /* storage unavailable */ }
  }

  async refreshList() {
    this.documents.set(await firstValueFrom(this.api.list()));
  }

  /** Opens a stored document, saving the one being left first. */
  async open(id: string) {
    await this.flush();
    const stored = await firstValueFrom(this.api.get(id));
    this.resetTo(stored.id, { name: stored.name, items: stored.items });
  }

  async create(name = 'Untitled') {
    await this.flush();
    const created = await firstValueFrom(this.api.create({ name, items: [] }));
    this.resetTo(created.id, { name: created.name, items: created.items });
    await this.refreshList();
  }

  async deleteCurrent() {
    const id = this.docId();
    if (!id) return;
    clearTimeout(this.saveTimer);
    this.dirty = false;
    await firstValueFrom(this.api.delete(id));
    await this.refreshList();
    const next = this.documents()[0]?.id;
    if (next) await this.open(next);
    else await this.create('Untitled');
  }

  private resetTo(id: string, doc: RfDocument) {
    const repaired = sanitize(doc);
    clearTimeout(this.saveTimer);
    this.dirty = false;
    this.docId.set(id);
    this.writeCurrentId(id);
    this.doc.set(doc);
    this.selectedIds.set([]);
    this.past = [];
    this.future = [];
    this.committed = JSON.stringify(doc);
    this.updateFlags();
    this.saveState.set('saved');
    if (repaired) this.scheduleSave(); // write the repaired document back
  }

  /** Debounced autosave. Saves are serialised so a slow PUT can't overwrite a newer one. */
  private scheduleSave() {
    this.dirty = true;
    this.saveState.set('unsaved');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), saveDelayMs);
  }

  /** Saves now if there are unsaved changes. */
  async flush() {
    clearTimeout(this.saveTimer);
    if (this.saving || !this.dirty) return;
    const id = this.docId();
    if (!id) return;
    this.saving = true;
    this.dirty = false;
    this.saveState.set('saving');
    try {
      const doc = this.doc();
      await firstValueFrom(this.api.update(id, doc));
      this.documents.update(list => list.map(d => (d.id === id ? { ...d, name: doc.name, itemCount: doc.items.length, modified: Date.now() / 1000 } : d)));
      if (!this.dirty) this.saveState.set('saved');
    } catch {
      this.dirty = true;
      this.saveState.set('error');
    } finally {
      this.saving = false;
    }
    if (this.dirty && this.saveState() !== 'error') await this.flush(); // edits arrived while saving
  }

  setPartStats(path: string, stats: PartStats) {
    this.partStats.update(all => ({ ...all, [path]: stats }));
  }

  nextColor() {
    return itemColors[this.doc().items.length % itemColors.length];
  }

  /**
   * THE choke point: every change to the document goes through here (the undo history and autosave hang off it, so no action can
   * forget them). `change` returns the new document; when nothing actually changed there is no undo entry and no save. Inside a
   * gesture (a drag) the change is applied live but the undo entry is written once, when the gesture ends.
   * `label` names the step (handy when debugging history). Returns whether anything changed.
   */
  mutate(label: string, change: (doc: RfDocument) => RfDocument): boolean {
    if (this.gestureLabel && Date.now() - this.gestureStartedAt > gestureStaleMs) this.endGesture(); // a drag that never got its end
    const current = this.doc();
    const next = change(current);
    if (next === current || JSON.stringify(next) === JSON.stringify(current)) return false;
    this.doc.set(next);
    if (!this.gestureLabel) this.commit();
    return true;
  }

  /** Changes properties of several items in one step. */
  updateItems(label: string, changes: Map<string, Partial<Pick<DocItem, 'position' | 'rotation' | 'muted' | 'centered'>>>): boolean {
    if (!changes.size) return false;
    return this.mutate(label, d => ({ ...d, items: d.items.map(i => (changes.has(i.id) ? { ...i, ...changes.get(i.id) } : i)) }));
  }

  /**
   * A gesture groups many live changes (every pointer move of a drag) into ONE undo step: changes show immediately, the step is
   * written by endGesture(), and abortGesture() puts the document back as it was when the gesture began.
   */
  beginGesture(label: string) {
    if (this.gestureLabel) this.endGesture();
    this.gestureLabel = label;
    this.gestureStartedAt = Date.now();
  }

  endGesture() {
    if (!this.gestureLabel) return;
    this.gestureLabel = null;
    this.commit();
  }

  abortGesture() {
    if (!this.gestureLabel) return;
    this.gestureLabel = null;
    this.doc.set(JSON.parse(this.committed)); // back to the last undo step; nothing to save
    const present = new Set(this.doc().items.map(i => i.id));
    this.selectedIds.update(ids => ids.filter(id => present.has(id)));
  }

  get gestureOpen() {
    return this.gestureLabel !== null;
  }

  addItem(item: Omit<DocItem, 'id'>) {
    const created: DocItem = { ...item, id: crypto.randomUUID() };
    this.mutate('Add part', d => ({ ...d, items: [...d.items, created] }));
    this.selectedIds.set([created.id]);
    return created;
  }

  remove(id: string) {
    this.mutate('Remove part', d => ({ ...d, items: d.items.filter(i => i.id !== id) }));
    this.selectedIds.update(ids => ids.filter(selected => selected !== id));
  }

  rename(name: string) {
    this.mutate('Rename document', d => ({ ...d, name }));
  }

  clear() {
    this.mutate('Clear document', d => ({ ...d, items: [] }));
    this.selectedIds.set([]);
  }

  select(id: string | null) {
    this.selectedIds.set(id ? [id] : []);
  }

  /** ⌘-click: add the item to the selection, or take it out when it is already selected. */
  toggleSelect(id: string) {
    this.selectedIds.update(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]));
  }

  /** Selects everything that reacts to clicks (muted items stay out of it). */
  selectAll() {
    this.selectedIds.set(this.doc().items.filter(i => !i.muted).map(i => i.id));
  }

  /** Dims or restores items (one undo step). */
  setMuted(ids: readonly string[], muted: boolean) {
    this.updateItems(muted ? 'Dim parts' : 'Show parts', new Map(ids.map(id => [id, { muted }])));
  }

  /** Bounding-box size of an item as drawn (after rotation); set by the 3D scene, null while its geometry is loading. */
  sizeOf: ((item: DocItem) => Vec3 | null) | null = null;

  /**
   * "Center on grid" for items: on = move each footprint centre to the middle of the nearest grid cell (z unchanged) and keep it
   * there while the item is dragged, nudged or rotated; off = just stop doing that. One undo step.
   */
  setCentered(ids: readonly string[], flag: boolean) {
    const wanted = new Set(ids);
    const changes = new Map<string, Partial<Pick<DocItem, 'position' | 'centered'>>>();
    for (const item of this.doc().items) {
      if (!wanted.has(item.id)) continue;
      const change: Partial<Pick<DocItem, 'position' | 'centered'>> = { centered: flag };
      const size = flag ? this.sizeOf?.(item) : null;
      if (size) change.position = clampToWorkArea(cellCenteredPosition(item.position, size), size);
      changes.set(item.id, change);
    }
    this.updateItems(flag ? 'Center on grid' : 'Stop centering', changes);
  }

  /**
   * Moves the items vertically so the lowest point of the selection is at `height` (0 = ground, 6 = top of the baseplate). A position is
   * the bounding-box corner with the lowest z, so for one item that is simply z = height; several items keep their relative heights.
   */
  moveToHeight(ids: readonly string[], height: number) {
    const wanted = new Set(ids);
    const picked = this.doc().items.filter(i => wanted.has(i.id));
    if (!picked.length) return;
    const delta = height - Math.min(...picked.map(i => i.position[2]));
    if (delta === 0) return;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    this.updateItems('Move to height', new Map(picked.map(i => [i.id, { position: [i.position[0], i.position[1], round(i.position[2] + delta)] as Vec3 }])));
  }

  /**
   * Copied parts. Kept in local storage too, so the clipboard survives a reload and works across browser tabs and documents.
   * It holds the parts' content (file, rotation, color, flags) and their offsets, never ids or absolute positions.
   */
  readonly clipboard = signal<ClipboardContent | null>(readClipboard());

  /** Where the view is looking (X/Y in mm); set by the 3D scene. Pasted parts land here. */
  viewCenter: (() => { x: number; y: number }) | null = null;

  copySelection(): boolean {
    const content = copyItems(this.selectedItems());
    if (!content) return false;
    this.clipboard.set(content);
    try { localStorage.setItem(clipboardStorageKey, JSON.stringify(content)); } catch { /* storage unavailable */ }
    return true;
  }

  /** Copy, then remove the selection: one undo step. */
  cutSelection() {
    if (this.copySelection()) this.removeSelected();
  }

  /** Pastes the clipboard at the view centre as ONE undo step and selects the new parts. Returns how many were pasted. */
  pasteClipboard(): number {
    const clip = this.clipboard();
    if (!clip) return 0;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const created = pasteItems(clip, this.viewCenter?.() ?? null, snapStepMm, (position, item) => {
      const size = this.sizeOf?.({ path: item.path, rotation: item.rotation } as DocItem) ?? undefined; // unknown until its geometry has loaded
      const placed = item.centered && size ? cellCenteredPosition(position, size) : (position.map(round) as Vec3);
      return clampToWorkArea(placed, size);
    });
    return this.addItems(created);
  }

  /** Adds several items in one step (one undo entry) and selects them. */
  addItems(items: Omit<DocItem, 'id'>[]): number {
    if (!items.length) return 0;
    const created = items.map<DocItem>(item => ({ ...item, id: crypto.randomUUID() }));
    this.mutate('Add parts', d => ({ ...d, items: [...d.items, ...created] }));
    this.selectedIds.set(created.map(c => c.id));
    return created.length;
  }

  /** "Snap to grid…" is waiting for the user to click a corner/side handle on these items. */
  readonly snapPick = signal<string[] | null>(null);

  beginSnapPick(ids: readonly string[]) {
    this.snapPick.set(ids.length ? [...ids] : null);
  }

  /**
   * "Move to…" in two clicks: first a corner of the selection's box (`source`), then a corner of another item, which the selection
   * snaps onto. `source` is null while waiting for the first click.
   */
  readonly movePick = signal<{ ids: string[]; source: Vec3 | null } | null>(null);

  beginMovePick(ids: readonly string[]) {
    this.movePick.set(ids.length ? { ids: [...ids], source: null } : null);
  }

  setMoveSource(point: Vec3) {
    const pick = this.movePick();
    if (pick) this.movePick.set({ ...pick, source: point });
  }

  /** Leaves whichever pick mode is active (Esc, Cancel button, or a click on nothing). */
  cancelPicks() {
    this.snapPick.set(null);
    this.movePick.set(null);
  }

  /** Moves the picked items by (target - source), so the chosen corner lands exactly on the other item's corner. */
  applyMoveTo(target: Vec3) {
    const pick = this.movePick();
    this.movePick.set(null);
    if (!pick?.source) return;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const delta = target.map((t, i) => t - pick.source![i]);
    const ids = new Set(pick.ids);
    const changes = new Map<string, Partial<Pick<DocItem, 'position' | 'centered'>>>();
    for (const item of this.doc().items) {
      if (!ids.has(item.id)) continue;
      const size = this.sizeOf?.(item) ?? undefined;
      const moved = item.position.map((v, i) => round(v + delta[i])) as Vec3;
      changes.set(item.id, { position: clampToWorkArea(moved, size), ...(item.centered ? { centered: false } : {}) });
    }
    this.updateItems('Move to', changes);
  }

  /**
   * One-time snap: the chosen point of each picked item's footprint (fx, fy in 0..1 across its bounding box: 0,0 = lowest X/Y corner,
   * 0.5,0 = middle of the low-Y side, ...) moves to the nearest grid intersection. Z is unchanged. An item that is set to stay
   * centered gives that up, since the two contradict each other.
   */
  applySnap(fx: number, fy: number) {
    const ids = new Set(this.snapPick() ?? []);
    this.snapPick.set(null);
    const changes = new Map<string, Partial<Pick<DocItem, 'position' | 'centered'>>>();
    for (const item of this.doc().items) {
      const size = ids.has(item.id) ? this.sizeOf?.(item) : null;
      if (!size) continue;
      const point = [item.position[0] + size[0] * fx, item.position[1] + size[1] * fy];
      const dx = Math.round(point[0] / snapStepMm.x) * snapStepMm.x - point[0];
      const dy = Math.round(point[1] / snapStepMm.y) * snapStepMm.y - point[1];
      const round = (v: number) => Math.round(v * 1000) / 1000;
      const position = clampToWorkArea([round(item.position[0] + dx), round(item.position[1] + dy), item.position[2]], size);
      changes.set(item.id, { position, ...(item.centered ? { centered: false } : {}) });
    }
    this.updateItems('Snap to grid', changes);
  }

  /** Right-click menu for objects: where to show it and which items it acts on. */
  readonly contextMenu = signal<{ x: number; y: number; ids: string[] } | null>(null);

  /** Opens the object menu; a right-click inside the selection acts on all of it, otherwise on that item alone. */
  openContextMenu(x: number, y: number, id: string) {
    if (!this.selectedIds().includes(id)) this.select(id);
    this.contextMenu.set({ x, y, ids: [...this.selectedIds()] });
  }

  removeSelected() {
    const ids = new Set(this.selectedIds());
    if (!ids.size) return;
    this.mutate('Delete parts', d => ({ ...d, items: d.items.filter(i => !ids.has(i.id)) }));
    this.selectedIds.set([]);
  }

  /** Copies every selected item one grid cell over and selects the copies. */
  duplicateSelected() {
    const copies = this.selectedItems().map<DocItem>(source => ({
      ...source, id: crypto.randomUUID(), position: [source.position[0] + snapStepMm.x, source.position[1] + snapStepMm.y, source.position[2]], rotation: [...source.rotation],
    }));
    if (!copies.length) return;
    this.mutate('Duplicate parts', d => ({ ...d, items: [...d.items, ...copies] }));
    this.selectedIds.set(copies.map(c => c.id));
  }

  /** Writes the undo step for what changed since the last one (no-op when nothing changed). Only mutate() and endGesture() call this. */
  private commit() {
    const now = JSON.stringify(this.doc());
    if (now === this.committed) return;
    this.past.push(this.committed);
    if (this.past.length > maxHistory) this.past.shift();
    this.future = [];
    this.committed = now;
    this.updateFlags();
    this.scheduleSave();
  }

  undo() {
    const previous = this.past.pop();
    if (previous === undefined) return;
    this.future.push(this.committed);
    this.restore(previous);
  }

  redo() {
    const next = this.future.pop();
    if (next === undefined) return;
    this.past.push(this.committed);
    this.restore(next);
  }

  private restore(json: string) {
    this.committed = json;
    this.doc.set(JSON.parse(json));
    const present = new Set(this.doc().items.map(i => i.id));
    this.selectedIds.update(ids => ids.filter(id => present.has(id)));
    this.updateFlags();
    this.scheduleSave();
  }

  private updateFlags() {
    this.canUndo.set(this.past.length > 0);
    this.canRedo.set(this.future.length > 0);
  }
}
