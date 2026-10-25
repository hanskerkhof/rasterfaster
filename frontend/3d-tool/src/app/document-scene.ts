import * as THREE from 'three';
import { DocItem, DocumentStore, PartStats, Quat, Vec3, cellCenteredPosition, clampToWorkArea, snapStepMm, workArea } from './document.store';
import { ViewMode, buildParts, clearParts } from './model-render';
import { ZGridMode, nearestZLevel, nextZLevel } from './z-levels';

const selectedColor = 0xf0a040;
const handleColor = 0xffe066;
const handleHoverColor = 0x55e68a;
const handleRadiusPx = 7;
/** The 8 anchor points on the footprint (fraction across the bounding box in X and Y): 4 corners and 4 side middles. */
const snapAnchors: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];
/** A single pointer move never shifts parts further than this; anything bigger is a glitch, not a drag. */
const maxDragDeltaMm = 2000;

/** A geometry rotated for one orientation and moved so its bounding-box minimum sits at the local origin. */
interface OrientedEntry {
  geometry: THREE.BufferGeometry;
  size: THREE.Vector3;
  edges?: THREE.EdgesGeometry;
}

interface ItemRuntime {
  group: THREE.Group;
  entryKey: string;
  selected: boolean;
  muted: boolean;
  mode: ViewMode;
  color: number;
}

interface DragState {
  /** The item under the pointer; the rest of the selection follows it by the same offset. */
  id: string;
  /** Start positions of everything being dragged. */
  starts: Map<string, Vec3>;
  /** Pointer went down on an item that was already part of a multi-selection (a plain click then narrows it). */
  wasInGroup: boolean;
  vertical: boolean;
  plane: THREE.Plane;
  /** Pointer hit minus item position at grab time, so the item doesn't jump to the cursor. */
  grabOffset: THREE.Vector3;
  moved: boolean;
}

export interface DocumentSceneContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** Element whose keydown events (bubbled from the canvas and the panels inside it) drive the shortcuts. */
  host: HTMLElement;
  store: DocumentStore;
  background: THREE.Color;
  loadGeometry: (path: string) => Promise<THREE.BufferGeometry>;
  /** Degrees per keyboard rotation press (the rotate panel's step). */
  rotationStep: () => number;
  /** Current height grid mode (fine / baseplate / coarse). */
  zGridMode: () => ZGridMode;
  /** Called after the visible items or their positions changed. */
  changed: () => void;
}

/** Bounding-box size and enclosed volume (signed tetrahedra against the origin; STLs are closed meshes). */
function measure(geometry: THREE.BufferGeometry): PartStats {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const position = geometry.getAttribute('position');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let volume = 0;
  const triangles = position.count / 3;
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    volume += a.dot(b.cross(c)) / 6;
  }
  return { size: [size.x, size.y, size.z], volumeCm3: Math.abs(volume) / 1000, triangles };
}

const snap = (value: number, step: number) => Math.round(value / step) * step;
const quatKey = (q: Quat) => q.map(n => n.toFixed(4)).join(',');

/**
 * Renders the document's items and lets the user pick, drag and nudge them on the snap grid.
 * Item pointer handling must be attached before OrbitControls so a drag on an object doesn't orbit the view.
 */
export class DocumentScene {
  readonly group = new THREE.Group();
  private active = false;
  private mode: ViewMode = 'solid';
  private readonly runtimes = new Map<string, ItemRuntime>();
  private readonly baseGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly baseLoading = new Map<string, Promise<THREE.BufferGeometry>>();
  private readonly oriented = new Map<string, OrientedEntry>();
  private readonly preparing = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly selectionBoxes = new THREE.Group();
  private readonly snapHandles = new THREE.Group();
  private hoveredHandle: THREE.Mesh | null = null;
  private drag: DragState | null = null;
  private emptyDown: { x: number; y: number } | null = null;
  private readonly listeners: [EventTarget, string, EventListener][] = [];

  constructor(private readonly ctx: DocumentSceneContext) {
    this.group.visible = false;
    this.selectionBoxes.visible = false;
    ctx.scene.add(this.group, this.selectionBoxes, this.snapHandles);
    this.on(ctx.canvas, 'pointerdown', e => this.onPointerDown(e as PointerEvent));
    this.on(ctx.canvas, 'pointermove', e => this.onPointerMove(e as PointerEvent));
    this.on(ctx.canvas, 'pointerup', e => this.onPointerUp(e as PointerEvent));
    ctx.store.sizeOf = item => this.sizeOfItem(item);
    this.on(ctx.canvas, 'contextmenu', e => this.onContextMenu(e as MouseEvent));
    this.on(ctx.host, 'keydown', e => this.onKey(e as KeyboardEvent));
    // Esc leaves a pick mode wherever the keyboard focus is (after choosing the menu item it is on the page body, not on the stage).
    this.on(document, 'keydown', e => {
      if ((e as KeyboardEvent).key !== 'Escape' || !this.picking()) return;
      ctx.store.cancelPicks();
      e.preventDefault();
    });
  }

  private on(target: EventTarget, type: string, fn: EventListener) {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }

  setActive(active: boolean) {
    this.active = active;
    this.group.visible = active;
    this.selectionBoxes.visible = active;
    this.snapHandles.visible = active;
    if (!active) { this.drag = null; this.ctx.store.cancelPicks(); }
  }

  /** Redraws whatever differs between the store and the scene. Call from a reactive effect. */
  reconcile(mode: ViewMode) {
    this.mode = mode;
    const { store } = this.ctx;
    const items = store.doc().items;
    const selectedIds = new Set(store.selectedIds());
    const ids = new Set(items.map(i => i.id));
    for (const [id, runtime] of this.runtimes) {
      if (ids.has(id)) continue;
      clearParts(runtime.group);
      this.group.remove(runtime.group);
      this.runtimes.delete(id);
    }
    for (const item of items) this.syncItem(item, selectedIds.has(item.id));
    this.updateSelectionBox();
    this.updateSnapHandles();
    this.ctx.changed();
  }

  private syncItem(item: DocItem, selected: boolean) {
    const key = `${item.path}|${quatKey(item.rotation)}`;
    const entry = this.oriented.get(key);
    if (!entry) { void this.prepare(item, key); return; }
    let runtime = this.runtimes.get(item.id);
    if (!runtime) {
      runtime = { group: new THREE.Group(), entryKey: '', selected: false, muted: false, mode: this.mode, color: 0 };
      runtime.group.userData['itemId'] = item.id;
      this.group.add(runtime.group);
      this.runtimes.set(item.id, runtime);
    }
    const muted = !!item.muted;
    if (runtime.entryKey !== key || runtime.selected !== selected || runtime.muted !== muted || runtime.mode !== this.mode || runtime.color !== item.color) {
      clearParts(runtime.group);
      const base = new THREE.Color(selected ? selectedColor : item.color);
      const style = {
        background: this.ctx.background, solid: base.getHex(), line: base.getHex(), wire: base.getHex(),
        dashed: base.clone().multiplyScalar(0.45).getHex(), radius: entry.size.length() / 2,
        edges: () => (entry.edges ??= new THREE.EdgesGeometry(entry.geometry, 25)),
        ghost: muted,
      };
      for (const part of buildParts(entry.geometry, this.mode, style)) {
        part.userData['itemId'] = item.id;
        runtime.group.add(part);
      }
      Object.assign(runtime, { entryKey: key, selected, muted, mode: this.mode, color: item.color });
    }
    runtime.group.position.set(...item.position);
  }

  private async prepare(item: DocItem, key: string) {
    if (this.preparing.has(key)) return;
    this.preparing.add(key);
    try {
      const base = await this.loadBase(item.path);
      this.oriented.set(key, this.orient(base, item.rotation));
      this.reconcile(this.mode);
    } catch (err) {
      console.warn(`Could not load ${item.path}`, err);
    } finally {
      this.preparing.delete(key);
    }
  }

  private loadBase(path: string) {
    const known = this.baseLoading.get(path);
    if (known) return known;
    const loading = this.ctx.loadGeometry(path).then(g => {
      this.baseGeometries.set(path, g);
      this.ctx.store.setPartStats(path, measure(g));
      return g;
    });
    loading.catch(() => this.baseLoading.delete(path));
    this.baseLoading.set(path, loading);
    return loading;
  }

  private orient(base: THREE.BufferGeometry, rotation: Quat): OrientedEntry {
    const geometry = base.clone();
    geometry.applyQuaternion(new THREE.Quaternion(...rotation));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    geometry.translate(-box.min.x, -box.min.y, -box.min.z);
    return { geometry, size: box.getSize(new THREE.Vector3()) };
  }

  private entryFor(item: DocItem) {
    return this.oriented.get(`${item.path}|${quatKey(item.rotation)}`);
  }

  /** One orange outline per selected item. */
  private updateSelectionBox() {
    this.clearSelectionBoxes();
    for (const item of this.ctx.store.selectedItems()) {
      const entry = this.entryFor(item);
      if (!entry) continue;
      const min = new THREE.Vector3(...item.position);
      const helper = new THREE.Box3Helper(new THREE.Box3(min, min.clone().add(entry.size)), selectedColor);
      helper.renderOrder = 5;
      (helper.material as THREE.Material).depthTest = false;
      this.selectionBoxes.add(helper);
    }
  }

  /**
   * Clickable handles for the pick modes. Snap to grid: corners and side middles of the picked items. Move to: step 1 the 8 corners of
   * the selection's box, step 2 the 8 corners of every other item (plus a green marker on the chosen source corner).
   */
  private updateSnapHandles() {
    for (const handle of this.snapHandles.children as THREE.Mesh[]) {
      handle.geometry.dispose();
      (handle.material as THREE.Material).dispose();
    }
    this.snapHandles.clear();
    this.hoveredHandle = null;
    const { store } = this.ctx;
    const addHandle = (position: Vec3, data: Record<string, unknown>, color = handleColor) => {
      const handle = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      handle.position.set(...position);
      handle.renderOrder = 10;
      Object.assign(handle.userData, data);
      this.snapHandles.add(handle);
    };
    const corners = (low: Vec3, size: Vec3): Vec3[] => {
      const points: Vec3[] = [];
      for (const fx of [0, 1]) for (const fy of [0, 1]) for (const fz of [0, 1]) points.push([low[0] + size[0] * fx, low[1] + size[1] * fy, low[2] + size[2] * fz]);
      return points;
    };

    const snapIds = new Set(store.snapPick() ?? []);
    if (snapIds.size) {
      for (const item of store.doc().items) {
        const size = snapIds.has(item.id) ? this.sizeOfItem(item) : null;
        if (!size) continue;
        for (const [fx, fy] of snapAnchors) addHandle([item.position[0] + size[0] * fx, item.position[1] + size[1] * fy, item.position[2]], { kind: 'snap', anchor: [fx, fy] });
      }
      return;
    }

    const move = store.movePick();
    if (!move) return;
    const items = store.doc().items.map(item => ({ item, size: this.sizeOfItem(item) })).filter((x): x is { item: DocItem; size: Vec3 } => !!x.size);
    if (!move.source) {
      const picked = items.filter(x => move.ids.includes(x.item.id));
      if (!picked.length) return;
      const box = picked.reduce((all, { item, size }) => all.union(new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(new THREE.Vector3(...size)))), new THREE.Box3());
      for (const point of corners(box.min.toArray() as Vec3, box.getSize(new THREE.Vector3()).toArray() as Vec3)) addHandle(point, { kind: 'move-source', point });
      return;
    }
    addHandle(move.source, { kind: 'marker' }, handleHoverColor);
    for (const { item, size } of items) {
      if (move.ids.includes(item.id)) continue;
      for (const point of corners(item.position, size)) addHandle(point, { kind: 'move-target', point });
    }
  }

  /** Called every frame: keeps the snap handles the same size on screen whatever the zoom. */
  tick() {
    if (!this.snapHandles.children.length) return;
    const camera = this.ctx.camera as THREE.OrthographicCamera;
    const mmPerPixel = (camera.top - camera.bottom) / camera.zoom / this.ctx.canvas.clientHeight;
    for (const handle of this.snapHandles.children) handle.scale.setScalar(mmPerPixel * handleRadiusPx);
  }

  private pickHandle(e: PointerEvent) {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    this.snapHandles.updateMatrixWorld(true);
    const clickable = this.snapHandles.children.filter(h => h.userData['kind'] !== 'marker'); // the source marker is only a reminder
    return (this.raycaster.intersectObjects(clickable, false)[0]?.object as THREE.Mesh | undefined) ?? null;
  }

  /** True while "Snap to grid…" or "Move to…" is waiting for clicks. */
  private picking() {
    return !!(this.ctx.store.snapPick() || this.ctx.store.movePick());
  }

  private hoverHandle(handle: THREE.Mesh | null) {
    if (handle === this.hoveredHandle) return;
    if (this.hoveredHandle) (this.hoveredHandle.material as THREE.MeshBasicMaterial).color.setHex(handleColor);
    this.hoveredHandle = handle;
    if (handle) (handle.material as THREE.MeshBasicMaterial).color.setHex(handleHoverColor);
    this.ctx.canvas.style.cursor = handle ? 'pointer' : this.picking() ? 'crosshair' : '';
  }

  private clearSelectionBoxes() {
    for (const helper of [...this.selectionBoxes.children] as THREE.Box3Helper[]) {
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    }
    this.selectionBoxes.clear();
  }

  /** Bounds of everything currently drawn, or null when empty. */
  bounds() {
    const box = new THREE.Box3();
    for (const item of this.ctx.store.doc().items) {
      const entry = this.entryFor(item);
      if (!entry) continue;
      const min = new THREE.Vector3(...item.position);
      box.union(new THREE.Box3(min, min.clone().add(entry.size)));
    }
    return box.isEmpty() ? null : box;
  }

  /** Centre of the box around all selected items, or null when nothing (loaded) is selected. */
  selectionCenter() {
    const box = new THREE.Box3();
    for (const item of this.ctx.store.selectedItems()) {
      const size = this.sizeOfItem(item);
      if (!size) continue;
      const low = new THREE.Vector3(...item.position);
      box.union(new THREE.Box3(low, low.clone().add(new THREE.Vector3(...size))));
    }
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  }

  /** Centre of an item's bounding box in world coordinates, or null while its geometry is still loading. */
  itemCenter(id: string) {
    const item = this.ctx.store.doc().items.find(i => i.id === id);
    const entry = item && this.entryFor(item);
    return item && entry ? new THREE.Vector3(...item.position).add(entry.size.clone().multiplyScalar(0.5)) : null;
  }

  /** Number of items whose geometry is loaded (to know when a fit-to-view is meaningful). */
  readyCount() {
    return this.ctx.store.doc().items.filter(i => this.entryFor(i)).length;
  }

  /** Loads the file and drops it into the first free spot along +X at ground level. */
  async addObject(path: string) {
    const { store } = this.ctx;
    const base = await this.loadBase(path);
    const size = this.orient(base, [0, 0, 0, 1]).size;
    const taken = store.doc().items
      .map(item => { const entry = this.entryFor(item); return entry && new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(entry.size)); })
      .filter((b): b is THREE.Box3 => !!b);
    let x = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      const candidate = new THREE.Box3(new THREE.Vector3(x + 0.01, 0.01, 0.01), new THREE.Vector3(x + size.x - 0.01, size.y - 0.01, size.z - 0.01));
      const blocker = taken.find(b => b.intersectsBox(candidate));
      if (!blocker) break;
      x = Math.max(x + snapStepMm.x, Math.ceil(blocker.max.x / snapStepMm.x) * snapStepMm.x);
    }
    const name = path.split('/').pop()!.replace(/\.stl$/i, '');
    store.addItem({ path, name, color: store.nextColor(), position: [x, 0, 0], rotation: [0, 0, 0, 1] });
  }

  /**
   * Rotates the selection around a world axis through its common centre, then re-snaps each item to the grid.
   * One item turns in place. The lowest point of the selection stays where it was.
   */
  rotateSelected(axis: 'x' | 'y' | 'z', degrees: number) {
    const { store } = this.ctx;
    const items = store.selectedItems().filter(item => this.baseGeometries.has(item.path) && this.entryFor(item));
    if (!items.length) return;
    const worldAxis = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const step = new THREE.Quaternion().setFromAxisAngle(worldAxis, THREE.MathUtils.degToRad(degrees));

    const boxes = items.map(item => new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(this.entryFor(item)!.size)));
    const groupBox = boxes.reduce((all, box) => all.union(box), new THREE.Box3());
    const pivot = groupBox.getCenter(new THREE.Vector3());

    const turned = items.map((item, index) => {
      const rotation = step.clone().multiply(new THREE.Quaternion(...item.rotation)).normalize();
      const next: Quat = [rotation.x, rotation.y, rotation.z, rotation.w];
      const key = `${item.path}|${quatKey(next)}`;
      const entry = this.oriented.get(key) ?? this.orient(this.baseGeometries.get(item.path)!, next);
      this.oriented.set(key, entry);
      const center = boxes[index].getCenter(new THREE.Vector3()).sub(pivot).applyQuaternion(step).add(pivot);
      return { item, next, size: entry.size, center };
    });
    const oldLow = groupBox.min.z;
    const newLow = Math.min(...turned.map(t => t.center.z - t.size.z / 2));
    const changes = new Map<string, Partial<{ position: Vec3; rotation: Quat }>>();
    for (const t of turned) {
      changes.set(t.item.id, {
        rotation: t.next,
        position: clampToWorkArea(
          t.item.centered
            ? cellCenteredPosition([t.center.x - t.size.x / 2, t.center.y - t.size.y / 2, t.center.z - t.size.z / 2 + (oldLow - newLow)], t.size.toArray() as Vec3)
            : [snap(t.center.x - t.size.x / 2, snapStepMm.x), snap(t.center.y - t.size.y / 2, snapStepMm.y), t.center.z - t.size.z / 2 + (oldLow - newLow)],
          t.size.toArray() as Vec3,
        ),
      });
    }
    store.patchMany(changes);
    store.commit();
  }

  /** Shortens a move so every item in `items` stays inside the work area (the group keeps its shape at the edge). */
  private clampDelta(delta: Vec3, items: { position: Vec3; size: Vec3 }[]): Vec3 {
    return delta.map((d, axis) => {
      let low = -Infinity, high = Infinity;
      for (const { position, size } of items) {
        low = Math.max(low, workArea.min[axis] - position[axis]);
        high = Math.min(high, workArea.max[axis] - size[axis] - position[axis]);
      }
      const round = (v: number) => Math.round(v * 100) / 100; // STL sizes carry float32 noise; don't let it knock parts off the grid
      return high < low ? 0 : round(Math.min(Math.max(d, round(low)), round(high)));
    }) as Vec3;
  }

  private sizeOfItem(item: DocItem): Vec3 | null {
    return (this.entryFor(item)?.size.toArray() as Vec3 | undefined) ?? null;
  }

  /** For items set to "keep centered on grid", puts the footprint centre back on a cell middle after a horizontal move. */
  private keepCentered(item: DocItem, position: Vec3, horizontal: boolean): Vec3 {
    const size = item.centered && horizontal ? this.sizeOfItem(item) : null;
    return size ? clampToWorkArea(cellCenteredPosition(position, size), size) : position;
  }

  private placed(items: DocItem[], positions?: Map<string, Vec3>) {
    return items.map(item => ({ position: positions?.get(item.id) ?? item.position, size: this.entryFor(item)?.size.toArray() as Vec3 ?? [0, 0, 0] as Vec3 }));
  }

  /** Meshes a click can hit: everything except muted items (or only the muted ones, for the right-click menu). */
  pickableMeshes(mutedOnly = false): THREE.Object3D[] {
    const muted = new Set(this.ctx.store.doc().items.filter(i => i.muted).map(i => i.id));
    const meshes: THREE.Object3D[] = [];
    this.group.traverse(o => { if ((o as THREE.Mesh).isMesh && muted.has(o.userData['itemId']) === mutedOnly) meshes.push(o); });
    return meshes;
  }

  private pickMuted(e: MouseEvent): string | null {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hit = this.raycaster.intersectObjects(this.pickableMeshes(true), false)[0];
    return hit ? (hit.object.userData['itemId'] as string) : null;
  }

  private pickItem(e: PointerEvent) {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hit = this.raycaster.intersectObjects(this.pickableMeshes(), false)[0];
    return hit ? { id: hit.object.userData['itemId'] as string, point: hit.point } : null;
  }

  /** Right-click on a part opens the object menu (muted parts can't be hit; use the list for those). */
  private onContextMenu(e: MouseEvent) {
    if (!this.active) return;
    // A solid part under the cursor wins; otherwise a dimmed one (so a ghost can always be brought back from the 3D view).
    const id = this.pickItem(e as PointerEvent)?.id ?? this.pickMuted(e);
    if (!id) return;
    e.preventDefault();
    this.ctx.store.openContextMenu(e.clientX, e.clientY, id);
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.active || e.button !== 0) return;
    if (this.picking()) { // "Snap to grid…" / "Move to…": the next click chooses a handle
      const handle = this.pickHandle(e);
      if (handle) {
        e.stopImmediatePropagation();
        const { store } = this.ctx;
        const data = handle.userData;
        if (data['kind'] === 'snap') { const [fx, fy] = data['anchor'] as [number, number]; store.applySnap(fx, fy); }
        else if (data['kind'] === 'move-source') store.setMoveSource(data['point'] as Vec3);
        else if (data['kind'] === 'move-target') store.applyMoveTo(data['point'] as Vec3);
        return;
      }
      this.ctx.store.cancelPicks(); // a click elsewhere cancels and then acts as usual
    }
    const hit = this.pickItem(e);
    if (e.metaKey) {
      // ⌘-click on a part adds/removes it from the selection; ⌘-click on empty space is left to the viewer (centre the view)
      if (!hit) return;
      e.stopImmediatePropagation();
      this.ctx.store.toggleSelect(hit.id);
      return;
    }
    if (!hit) { this.emptyDown = { x: e.clientX, y: e.clientY }; return; } // let OrbitControls orbit
    e.stopImmediatePropagation();
    const { store } = this.ctx;
    const wasInGroup = store.selectedIds().includes(hit.id) && store.selectedIds().length > 1;
    if (!wasInGroup) store.select(hit.id); // dragging a member of a multi-selection moves the whole selection
    const starts = new Map(store.selectedItems().map(i => [i.id, [...i.position] as Vec3]));
    const item = store.doc().items.find(i => i.id === hit.id)!;
    const vertical = e.shiftKey;
    const plane = new THREE.Plane();
    if (vertical) {
      const toCamera = this.ctx.camera.position.clone().setZ(0).normalize(); // plane faces the camera, stays upright
      plane.setFromNormalAndCoplanarPoint(toCamera, hit.point);
    } else {
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), hit.point);
    }
    this.drag = { id: hit.id, starts, wasInGroup, vertical, plane, grabOffset: hit.point.clone().sub(new THREE.Vector3(...item.position)), moved: false };
    this.ctx.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent) {
    if (this.active && this.picking()) this.hoverHandle(this.pickHandle(e));
    const drag = this.drag;
    if (!this.active || !drag) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    // A ray that skims the drag plane (camera nearly level with it) hits it absurdly far away: ignore those moves.
    if (Math.abs(this.raycaster.ray.direction.dot(drag.plane.normal)) < 0.08) return;
    const point = this.raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    const start = drag.starts.get(drag.id);
    if (!point || !start) return;
    const fine = e.altKey; // hold Alt for 1 mm steps
    const step = (axis: 'x' | 'y') => (fine ? 1 : snapStepMm[axis]);
    // Snap the grabbed item, then move everything by the same delta so the group keeps its shape.
    const grabbed = this.ctx.store.doc().items.find(i => i.id === drag.id);
    const grabbedSize = grabbed && this.sizeOfItem(grabbed);
    const rawX = point.x - drag.grabOffset.x, rawY = point.y - drag.grabOffset.y;
    let delta: Vec3;
    // Height snaps to the z levels of the current grid mode; Alt gives 1 mm steps.
    if (drag.vertical) delta = [0, 0, (fine ? snap(point.z - drag.grabOffset.z, 1) : nearestZLevel(point.z - drag.grabOffset.z, this.ctx.zGridMode())) - start[2]];
    else if (grabbed?.centered && grabbedSize) {
      const cell = cellCenteredPosition([rawX, rawY, start[2]], grabbedSize); // a centered item hops from cell middle to cell middle
      delta = [cell[0] - start[0], cell[1] - start[1], 0];
    } else delta = [snap(rawX, step('x')) - start[0], snap(rawY, step('y')) - start[1], 0];
    if (delta.some(v => !Number.isFinite(v) || Math.abs(v) > maxDragDeltaMm)) return;
    const dragged = this.ctx.store.doc().items.filter(i => drag.starts.has(i.id));
    const [dx, dy, dz] = this.clampDelta(delta, this.placed(dragged, drag.starts));
    const changes = new Map<string, Partial<{ position: Vec3 }>>();
    for (const item of dragged) {
      const from = drag.starts.get(item.id)!;
      changes.set(item.id, { position: this.keepCentered(item, [from[0] + dx, from[1] + dy, from[2] + dz], !drag.vertical) });
    }
    const current = grabbed?.position;
    const target = changes.get(drag.id)!.position!;
    if (current && current[0] === target[0] && current[1] === target[1] && current[2] === target[2]) return;
    drag.moved = true;
    this.ctx.store.patchMany(changes);
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.active) return;
    if (this.drag) {
      if (this.drag.moved) this.ctx.store.commit();
      else if (this.drag.wasInGroup) this.ctx.store.select(this.drag.id); // plain click inside a multi-selection narrows it, like Finder
      this.drag = null;
      this.ctx.canvas.releasePointerCapture(e.pointerId);
    } else if (this.emptyDown) {
      if (Math.hypot(e.clientX - this.emptyDown.x, e.clientY - this.emptyDown.y) < 4) this.ctx.store.select(null); // a click, not an orbit
    }
    this.emptyDown = null;
  }

  private onKey(e: KeyboardEvent) {
    if (!this.active || ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return; // typing / choosing, not editing the scene
    const { store } = this.ctx;
    const command = e.metaKey || e.ctrlKey;
    const fine = e.altKey;
    const move = (dx: number, dy: number, dz: number) => {
      const items = store.selectedItems();
      if (!items.length) return false;
      const [cx, cy, cz] = this.clampDelta([dx, dy, dz], this.placed(items));
      const horizontal = cx !== 0 || cy !== 0;
      store.patchMany(new Map(items.map(i => [i.id, { position: this.keepCentered(i, [i.position[0] + cx, i.position[1] + cy, i.position[2] + cz], horizontal) }])));
      store.commit();
      return true;
    };
    const stepX = fine ? 1 : snapStepMm.x, stepY = fine ? 1 : snapStepMm.y;
    // One step up/down the z levels, decided by the lowest selected item (the base); the rest of the selection keeps its offsets.
    const moveZ = (direction: 1 | -1) => {
      const lowest = Math.min(...store.selectedItems().map(i => i.position[2]));
      if (!Number.isFinite(lowest)) return false;
      return move(0, 0, fine ? direction : nextZLevel(lowest, direction, this.ctx.zGridMode()) - lowest);
    };
    let handled = true;
    if (command && e.key.toLowerCase() === 'z') (e.shiftKey ? store.redo() : store.undo());
    else if (command && e.key.toLowerCase() === 'd') store.duplicateSelected();
    else if (command && e.key.toLowerCase() === 'a') store.selectAll();
    else if (e.key === 'ArrowLeft') (e.shiftKey ? this.rotateSelected('z', this.ctx.rotationStep()) : move(-stepX, 0, 0)); // Shift+←/→: turn about Z
    else if (e.key === 'ArrowRight') (e.shiftKey ? this.rotateSelected('z', -this.ctx.rotationStep()) : move(stepX, 0, 0));
    else if (!command && !e.altKey && e.key.toLowerCase() === 'v') { // V: dim / show the selection (the same as the menu's Dim)
      const selected = store.selectedItems();
      if (selected.length) store.setMuted(selected.map(i => i.id), !selected.every(i => i.muted));
    }
    else if (!command && !e.altKey && ['x', 'y', 'z'].includes(e.key.toLowerCase())) this.rotateSelected(e.key.toLowerCase() as 'x' | 'y' | 'z', e.shiftKey ? -this.ctx.rotationStep() : this.ctx.rotationStep());
    else if (e.key === 'ArrowUp') (e.shiftKey ? moveZ(1) : move(0, stepY, 0)); // Shift = height, like Shift+drag
    else if (e.key === 'ArrowDown') (e.shiftKey ? moveZ(-1) : move(0, -stepY, 0));
    else if (e.key === 'PageUp' || e.key === ']') moveZ(1);
    else if (e.key === 'PageDown' || e.key === '[') moveZ(-1);
    else if (e.key === 'Delete' || e.key === 'Backspace') store.removeSelected();
    else if (e.key === 'Escape') store.select(null);
    else handled = false;
    if (handled) e.preventDefault();
  }

  dispose() {
    this.ctx.store.sizeOf = null;
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    for (const runtime of this.runtimes.values()) clearParts(runtime.group);
    for (const entry of this.oriented.values()) { entry.geometry.dispose(); entry.edges?.dispose(); }
    for (const geometry of this.baseGeometries.values()) geometry.dispose();
    this.clearSelectionBoxes();
    this.snapHandles.clear();
  }
}
