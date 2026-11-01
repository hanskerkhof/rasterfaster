import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DocItem, DocumentStore, PartStats, Quat, Vec3, cellCenteredPosition, clampToWorkArea, snapStepMm, workArea } from './document.store';
import { ViewMode, buildParts, clearParts } from './model-render';
import { ViewPart, buildWireGeometry } from './svg-view';
import { buildSilhouetteGeometry, creaseDegrees, silhouetteEdges } from './silhouette';
import { ZGridMode, nearestZLevel, nextZLevel } from './z-levels';

const selectedColor = 0xf0a040;
/** The rings of the rotate tool: dimmed at rest, the same colour brighter under the pointer. */
const ringColors = { X: { dim: 0x9a4b4b, bright: 0xff5c5c }, Y: { dim: 0x4a8a5a, bright: 0x5cff84 }, Z: { dim: 0x4b5f9e, bright: 0x6c8cff } };
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
  silhouette?: THREE.BufferGeometry;
  wire?: THREE.BufferGeometry;
}

interface ItemRuntime {
  group: THREE.Group;
  entryKey: string;
  selected: boolean;
  muted: boolean;
  mode: ViewMode;
  color: number;
  silhouette: boolean;
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
  /** The camera in use right now (a getter: it changes with the camera mode). */
  readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Element whose keydown events (bubbled from the canvas and the panels inside it) drive the shortcuts. */
  host: HTMLElement;
  store: DocumentStore;
  background: THREE.Color;
  loadGeometry: (path: string) => Promise<THREE.BufferGeometry>;
  /** Degrees per keyboard rotation press (the rotate panel's step). */
  rotationStep: () => number;
  /** Switches the orbit controls off while a handle of the rotate tool is dragged. */
  setOrbitEnabled?: (enabled: boolean) => void;
  /** X/Y of the point the view is centred on (where pasted parts land). */
  viewCenter: () => { x: number; y: number };
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

type ScreenRect = { left: number; right: number; top: number; bottom: number };

/** Liang-Barsky: does the segment (x0,y0)-(x1,y1) cross or lie inside the rectangle? */
export function segmentTouchesRect(x0: number, y0: number, x1: number, y1: number, r: ScreenRect) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - r.left], [dx, r.right - x0], [-dy, y0 - r.top], [dy, r.bottom - y0]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/** A triangle (vertex indices into the screen coordinates) touches the rectangle when an edge does, or the rectangle lies inside it. */
export function triangleTouchesRect(s: Float32Array, a: number, b: number, c: number, r: ScreenRect) {
  const ax = s[a * 2], ay = s[a * 2 + 1], bx = s[b * 2], by = s[b * 2 + 1], cx = s[c * 2], cy = s[c * 2 + 1];
  if (segmentTouchesRect(ax, ay, bx, by, r) || segmentTouchesRect(bx, by, cx, cy, r) || segmentTouchesRect(cx, cy, ax, ay, r)) return true;
  const px = r.left, py = r.top; // all edges miss: the rectangle is either outside or entirely inside the triangle (test one corner)
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy), d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Binary STL of the geometries, each placed with its matrix. */
function writeStl(parts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]): ArrayBuffer | null {
  const count = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  const triangles = parts.reduce((n, part) => n + count(part.geometry), 0);
  if (!triangles) return null;
  const buffer = new ArrayBuffer(84 + 50 * triangles);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  let offset = 84;
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n = new THREE.Vector3(), e = new THREE.Vector3();
  for (const { geometry, matrix } of parts) {
    const position = geometry.getAttribute('position'), index = geometry.index;
    for (let t = 0; t < count(geometry); t++) {
      for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k).applyMatrix4(matrix);
      n.subVectors(p[1], p[0]).cross(e.subVectors(p[2], p[0])).normalize();
      for (const v of [n, ...p]) { view.setFloat32(offset, v.x, true); view.setFloat32(offset + 4, v.y, true); view.setFloat32(offset + 8, v.z, true); offset += 12; }
      offset += 2; // attribute byte count
    }
  }
  return buffer;
}

/** A letter in the given colour with a dark outline, for the labels of the tools (a sprite texture). */
function letterTexture(letter: string, color: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c2d = canvas.getContext('2d');
  if (c2d) {
    c2d.font = 'bold 44px system-ui, sans-serif';
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.lineJoin = 'round';
    c2d.lineWidth = 7;
    c2d.strokeStyle = 'rgba(15, 17, 22, 0.95)';
    c2d.strokeText(letter, 32, 34);
    c2d.fillStyle = '#' + color.toString(16).padStart(6, '0');
    c2d.fillText(letter, 32, 34);
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * How far a part is turned about each world axis from the way its STL file is saved, in degrees. The turns are applied about the world axes
 * one after the other (X, then Y, then Z), which is Euler order ZYX.
 */
export function axisAngles(rotation: Quat): { x: number; y: number; z: number } {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...rotation), 'ZYX');
  const deg = (v: number) => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10 || 0;
  return { x: deg(e.x), y: deg(e.y), z: deg(e.z) };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const snap = (value: number, step: number) => Math.round(Math.round(value / step) * step * 1000) / 1000; // (rounded: 0.1 steps must not leave 10.100000000000001)
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
  /** Keys of parts whose file could not be loaded (missing in the library): not retried on every redraw, but they count as settled for the fit-to-view. */
  private readonly failed = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly selectionBoxes = new THREE.Group();
  private readonly snapHandles = new THREE.Group();
  private hoveredHandle: THREE.Mesh | null = null;
  private drag: DragState | null = null;
  private emptyDown: { x: number; y: number } | null = null;
  /** Shift-drag on empty space: the dashed selection rectangle (client coordinates) and its overlay element. */
  private marquee: { x0: number; y0: number; x1: number; y1: number; box: HTMLDivElement } | null = null;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  /** The rotate tool (key R): rings about X, Y and Z at the centre of the selection, like Fusion's Move/Copy rotate handles. */
  private readonly rotatePivot = new THREE.Object3D();
  private readonly rotateTool: TransformControls;
  private rotateToolOn = false;
  /** The move tool (key M): arrows along X, Y and Z at the lower left corner of the selection (the corner of its box with the lowest X, Y and Z). */
  private readonly movePivot = new THREE.Object3D();
  private readonly moveTool: TransformControls;
  private moveToolOn = false;
  private moveToolFor = '';
  /** Option is held (read in the capture phase, so it is up to date when the move tool reports a drag). */
  private altHeld = false;
  private readonly trackAlt = (e: Event) => { this.altHeld = (e as KeyboardEvent | PointerEvent).altKey; };
  /** The tool put the corner handles of "Move to…" up (so it can take them down again). */
  private movePickOwned = false;
  private moveSnapshot: Map<string, { position: Vec3 }> | null = null;
  private moveStart: { items: DocItem[]; min: THREE.Vector3 } | null = null;
  private readonly moveLabels = new Map<string, { sprite: THREE.Sprite; dim: THREE.CanvasTexture; bright: THREE.CanvasTexture }>();
  /** The pivot point the selection turns about: a dot in the middle of the selection's box, the same size on screen at any zoom. */
  private readonly pivotMarker = new THREE.Group();
  private pivotFlash?: ReturnType<typeof setTimeout>;
  private pivotFlashing = false;
  /** The selection the tool was opened for: choosing other parts (or none) closes it, so it only shows after R. */
  private rotateToolFor = '';
  /** Where every part was when the tool was opened: Esc puts them back (the rotate session is undone). */
  private rotateSnapshot: Map<string, { position: Vec3; rotation: Quat }> | null = null;
  /** The letters on the rings: dim at rest, bright while their ring (or the letter itself) is under the pointer. */
  private readonly ringLabels = new Map<string, { sprite: THREE.Sprite; dim: THREE.CanvasTexture; bright: THREE.CanvasTexture }>();
  /** The selection as it was when a ring was grabbed, and the centre it turns about and its lowest point. */
  private rotateStart: { items: DocItem[]; pivot: THREE.Vector3; low: number } | null = null;

  constructor(private readonly ctx: DocumentSceneContext) {
    this.group.visible = false;
    this.selectionBoxes.visible = false;
    ctx.scene.add(this.group, this.selectionBoxes, this.snapHandles);
    this.rotateTool = new TransformControls(ctx.camera, ctx.canvas);
    this.rotateTool.setMode('rotate');
    this.rotateTool.setSpace('world');
    this.rotateTool.setSize(1.1);
    this.rotateTool.setColors(ringColors.X.dim, ringColors.Y.dim, ringColors.Z.dim, 0xffffff);
    this.rotateTool.addEventListener('axis-changed', event => { // the ring under the pointer lights up in its own colour
      const axis = (event as unknown as { value: string | null }).value as 'X' | 'Y' | 'Z' | null;
      this.rotateTool.setColors(ringColors.X.dim, ringColors.Y.dim, ringColors.Z.dim, axis && axis in ringColors ? ringColors[axis].bright : 0xffffff);
      for (const [letter, label] of this.ringLabels) { label.sprite.material.map = axis === letter ? label.bright : label.dim; label.sprite.material.needsUpdate = true; } // and so does its letter
    });
    this.addRingLabels();
    const helper = this.rotateTool.getHelper();
    helper.visible = false;
    ctx.scene.add(this.rotatePivot, helper);
    this.buildPivotMarker();
    this.rotateTool.addEventListener('dragging-changed', event => this.onRotateDragging(!!(event as unknown as { value: boolean }).value));
    this.rotateTool.addEventListener('objectChange', () => this.onRotateChange());
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'keyup']) window.addEventListener(type, this.trackAlt, true);
    this.moveTool = new TransformControls(ctx.camera, ctx.canvas);
    this.moveTool.setMode('translate');
    this.moveTool.setSpace('world');
    this.moveTool.setSize(1);
    this.moveTool.showXY = this.moveTool.showYZ = this.moveTool.showXZ = false; // the arrows only (this also hides the free-move dot in the middle)
    this.moveTool.setColors(ringColors.X.dim, ringColors.Y.dim, ringColors.Z.dim, 0xffffff);
    this.moveTool.addEventListener('axis-changed', event => {
      const axis = (event as unknown as { value: string | null }).value as 'X' | 'Y' | 'Z' | null;
      this.moveTool.setColors(ringColors.X.dim, ringColors.Y.dim, ringColors.Z.dim, axis && axis in ringColors ? ringColors[axis].bright : 0xffffff);
      for (const [letter, label] of this.moveLabels) { label.sprite.material.map = axis === letter ? label.bright : label.dim; label.sprite.material.needsUpdate = true; }
    });
    this.addMoveLabels();
    const moveHelper = this.moveTool.getHelper();
    moveHelper.visible = false;
    ctx.scene.add(this.movePivot, moveHelper);
    this.moveTool.addEventListener('dragging-changed', event => this.onMoveDragging(!!(event as unknown as { value: boolean }).value));
    this.moveTool.addEventListener('objectChange', () => this.onMoveChange());
    this.on(ctx.canvas, 'pointerdown', e => this.onPointerDown(e as PointerEvent));
    this.on(ctx.canvas, 'pointermove', e => this.onPointerMove(e as PointerEvent));
    this.on(ctx.canvas, 'pointerup', e => this.onPointerUp(e as PointerEvent));
    ctx.store.sizeOf = item => this.sizeOfItem(item);
    ctx.store.zMode = () => ctx.zGridMode();
    ctx.store.viewCenter = ctx.viewCenter;
    ctx.store.stlOf = (ids, placed) => (placed ? this.stlOf(ids) : this.ownStlOf(ids));
    this.on(ctx.canvas, 'contextmenu', e => this.onContextMenu(e as MouseEvent));
    this.on(ctx.host, 'keydown', e => this.onKey(e as KeyboardEvent));
    // Esc leaves a pick mode wherever the keyboard focus is (after choosing the menu item it is on the page body, not on the stage),
    // and puts a part being dragged back where it was.
    this.on(document, 'keydown', e => {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      if (this.marquee) { this.endMarquee(); e.preventDefault(); return; }
      if (this.drag) { this.cancelDrag(); e.preventDefault(); return; }
      if (this.moveToolOn && !(e as KeyboardEvent).defaultPrevented && this.escapeMoveTool()) { e.preventDefault(); return; }
      if (!this.picking()) return;
      ctx.store.cancelPicks();
      e.preventDefault();
    });
    // A drag that never gets its pointerup must not leave the history gesture open or the drag state stuck:
    // the browser cancelling the pointer aborts it; losing focus or switching tabs keeps what was done so far and ends it.
    this.on(ctx.canvas, 'pointercancel', () => { this.endMarquee(); this.cancelDrag(); });
    this.on(window, 'blur', () => this.finishDrag());
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.finishDrag(); });
  }

  private startMarquee(e: PointerEvent) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:20;pointer-events:none;border:1.5px dashed #fff;background:rgba(47,111,237,.14);display:none';
    document.body.appendChild(box);
    this.marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, box };
    this.ctx.canvas.setPointerCapture(e.pointerId);
  }

  private updateMarquee(e: PointerEvent) {
    const m = this.marquee!;
    m.x1 = e.clientX; m.y1 = e.clientY;
    const small = Math.hypot(m.x1 - m.x0, m.y1 - m.y0) < 4; // a click, not a rectangle yet
    Object.assign(m.box.style, { display: small ? 'none' : 'block', left: `${Math.min(m.x0, m.x1)}px`, top: `${Math.min(m.y0, m.y1)}px`,
                                 width: `${Math.abs(m.x1 - m.x0)}px`, height: `${Math.abs(m.y1 - m.y0)}px` });
  }

  private endMarquee() {
    this.marquee?.box.remove();
    this.marquee = null;
  }

  /** Release: select the parts inside or touched by the rectangle (⌘ held: add to the selection); a plain Shift-click clears the selection. */
  private finishMarquee(e: PointerEvent) {
    const m = this.marquee!;
    this.updateMarquee(e);
    const rect = { left: Math.min(m.x0, m.x1), right: Math.max(m.x0, m.x1), top: Math.min(m.y0, m.y1), bottom: Math.max(m.y0, m.y1) };
    this.endMarquee();
    this.ctx.canvas.releasePointerCapture(e.pointerId);
    if (rect.right - rect.left < 4 && rect.bottom - rect.top < 4) { if (!e.metaKey) this.ctx.store.select(null); return; }
    const ids = this.itemsInRect(rect);
    if (e.metaKey) this.ctx.store.selectMany(ids, true);
    else this.ctx.store.selectMany(ids);
  }

  /** Ids of the visible, clickable parts with any triangle inside or crossing the screen rectangle (client coordinates). */
  private itemsInRect(rect: { left: number; right: number; top: number; bottom: number }): string[] {
    const bounds = this.ctx.canvas.getBoundingClientRect();
    const r = { left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
    const camera = this.ctx.camera;
    camera.updateMatrixWorld();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const full = new THREE.Matrix4();
    const v = new THREE.Vector4();
    const hit = new Set<string>();
    for (const object of this.pickableMeshes()) {
      const id = object.userData['itemId'] as string;
      if (hit.has(id)) continue;
      const mesh = object as THREE.Mesh;
      const position = mesh.geometry.getAttribute('position');
      if (!position) continue;
      object.updateWorldMatrix(true, false);
      full.multiplyMatrices(viewProjection, object.matrixWorld);
      const count = position.count;
      const screen = new Float32Array(count * 2);
      const usable = new Uint8Array(count); // 0: behind the camera
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        v.set(position.getX(i), position.getY(i), position.getZ(i), 1).applyMatrix4(full);
        if (v.w <= 1e-6) continue;
        const x = (v.x / v.w * 0.5 + 0.5) * bounds.width, y = (1 - (v.y / v.w * 0.5 + 0.5)) * bounds.height;
        screen[i * 2] = x; screen[i * 2 + 1] = y; usable[i] = 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (maxX < r.left || minX > r.right || maxY < r.top || minY > r.bottom) continue; // the part's outline does not reach the rectangle
      const index = mesh.geometry.index;
      const triangles = (index ? index.count : count) / 3;
      for (let t = 0; t < triangles; t++) {
        const a = index ? index.getX(t * 3) : t * 3, b = index ? index.getX(t * 3 + 1) : t * 3 + 1, c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (usable[a] && usable[b] && usable[c] && triangleTouchesRect(screen, a, b, c, r)) { hit.add(id); break; }
      }
    }
    return this.ctx.store.doc().items.filter(i => hit.has(i.id)).map(i => i.id);
  }

  /** One binary STL (mm, document axes) with the given parts exactly as placed: rotation and position applied. */
  private stlOf(ids: readonly string[]): ArrayBuffer | null {
    const wanted = new Set(ids);
    const parts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    this.group.traverse(o => {
      if (!(o as THREE.Mesh).isMesh || !wanted.has(o.userData['itemId'])) return;
      o.updateWorldMatrix(true, false);
      parts.push({ geometry: (o as THREE.Mesh).geometry, matrix: o.matrixWorld });
    });
    return writeStl(parts);
  }

  /** The geometry of one part as its STL has it (not rotated, not moved); the first of the given parts that has loaded. */
  private ownStlOf(ids: readonly string[]): ArrayBuffer | null {
    const item = this.ctx.store.doc().items.find(i => ids.includes(i.id) && this.baseGeometries.has(i.path));
    return item ? writeStl([{ geometry: this.baseGeometries.get(item.path)!, matrix: new THREE.Matrix4() }]) : null;
  }

  /** Aborts the drag in progress: the parts go back to where they were and no undo step is written. */
  private cancelDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.ctx.store.abortGesture();
  }

  /** Ends the drag in progress as if the mouse button had been released here (one undo step for what was moved). */
  private finishDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.ctx.store.endGesture();
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
    if (!active) { this.finishDrag(); this.ctx.store.cancelPicks(); }
    this.updateRotateTool();
    this.updateMoveTool();
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
    this.updateRotateTool();
    this.updateMoveTool();
    this.ctx.changed();
  }

  private syncItem(item: DocItem, selected: boolean) {
    const key = `${item.path}|${quatKey(item.rotation)}`;
    const entry = this.oriented.get(key);
    if (!entry) { if (!this.failed.has(key)) void this.prepare(item, key); return; }
    let runtime = this.runtimes.get(item.id);
    if (!runtime) {
      runtime = { group: new THREE.Group(), entryKey: '', selected: false, muted: false, mode: this.mode, color: 0, silhouette: false };
      runtime.group.userData['itemId'] = item.id;
      this.group.add(runtime.group);
      this.runtimes.set(item.id, runtime);
    }
    const muted = !!item.muted;
    if (runtime.entryKey !== key || runtime.selected !== selected || runtime.muted !== muted || runtime.mode !== this.mode || runtime.color !== item.color || runtime.silhouette !== silhouetteEdges()) {
      clearParts(runtime.group);
      const base = new THREE.Color(selected ? selectedColor : item.color);
      const style = {
        background: this.ctx.background, solid: base.getHex(), line: base.getHex(), wire: base.getHex(),
        dashed: base.clone().multiplyScalar(0.45).getHex(), radius: entry.size.length() / 2,
        edges: () => (entry.edges ??= new THREE.EdgesGeometry(entry.geometry, creaseDegrees)),
        silhouette: () => (entry.silhouette ??= buildSilhouetteGeometry(entry.geometry)),
        ghost: muted,
      };
      for (const part of buildParts(entry.geometry, this.mode, style)) {
        part.userData['itemId'] = item.id;
        runtime.group.add(part);
      }
      Object.assign(runtime, { entryKey: key, selected, muted, mode: this.mode, color: item.color, silhouette: silhouetteEdges() });
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
      this.failed.add(key);
      this.ctx.changed(); // the others may all be loaded already: the view can be fitted to them now
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

    const originIds = new Set(store.originPick() ?? []);
    if (originIds.size) { // "Set origin": the 8 corners and the middle of the box of every picked part
      for (const item of store.doc().items) {
        const size = originIds.has(item.id) ? this.sizeOfItem(item) : null;
        if (!size) continue;
        const centre: Vec3 = [item.position[0] + size[0] / 2, item.position[1] + size[1] / 2, item.position[2] + size[2] / 2];
        for (const point of [...corners(item.position, size), centre]) addHandle(point, { kind: 'origin', point });
      }
      return;
    }

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
    const camera = this.ctx.camera;
    const height = this.ctx.canvas.clientHeight;
    for (const handle of this.snapHandles.children) {
      const mmPerPixel = camera instanceof THREE.PerspectiveCamera
        ? (camera.position.distanceTo(handle.position) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / camera.zoom / height // grows with distance
        : (camera.top - camera.bottom) / camera.zoom / height;
      handle.scale.setScalar(mmPerPixel * handleRadiusPx);
    }
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
    return !!(this.ctx.store.snapPick() || this.ctx.store.movePick() || this.ctx.store.originPick());
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

  /** Hides the selection outlines and the pick handles (for a picture of the model); returns the function that shows them again. */
  hideHelpers(): () => void {
    const was = [this.selectionBoxes.visible, this.snapHandles.visible];
    this.selectionBoxes.visible = false;
    this.snapHandles.visible = false;
    return () => { [this.selectionBoxes.visible, this.snapHandles.visible] = was; };
  }

  /** What a hidden-lines drawing of the document needs from each visible part (dimmed parts are left out, as they are in the 3D view). */
  viewParts(withWire = false): ViewPart[] {
    const parts: ViewPart[] = [];
    for (const item of this.ctx.store.doc().items) {
      const entry = this.entryFor(item);
      if (!entry || item.muted) continue;
      if (withWire) { // the wireframe drawing needs every triangle edge, not the feature edges
        parts.push({ geometry: entry.geometry, position: new THREE.Vector3(...item.position), edges: (entry.wire ??= buildWireGeometry(entry.geometry)), wire: entry.wire });
        continue;
      }
      entry.edges ??= new THREE.EdgesGeometry(entry.geometry, creaseDegrees);
      if (silhouetteEdges()) entry.silhouette ??= buildSilhouetteGeometry(entry.geometry);
      parts.push({ geometry: entry.geometry, position: new THREE.Vector3(...item.position), edges: entry.edges, silhouette: silhouetteEdges() ? entry.silhouette : undefined });
    }
    return parts;
  }

  /** Bounding box of these items (after rotation), or null when none of their geometry has loaded. */
  boundsOf(ids: readonly string[]): THREE.Box3 | null {
    const wanted = new Set(ids);
    const boxes = this.ctx.store.doc().items
      .filter(item => wanted.has(item.id))
      .map(item => { const entry = this.entryFor(item); return entry ? new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(entry.size)) : null; })
      .filter((box): box is THREE.Box3 => box !== null);
    return boxes.length ? boxes.reduce((all, box) => all.union(box)) : null;
  }

  /** Bounding box of the selected items (after rotation), or null while none is selected or none of their geometry has loaded. */
  selectionBounds(): THREE.Box3 | null {
    const boxes = this.ctx.store.selectedItems()
      .map(item => { const entry = this.entryFor(item); return entry ? new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(entry.size)) : null; })
      .filter((box): box is THREE.Box3 => box !== null);
    return boxes.length ? boxes.reduce((all, box) => all.union(box)) : null;
  }

  /** Number of items that are settled: their geometry is loaded, or it could not be (to know when a fit-to-view is meaningful). */
  readyCount() {
    return this.ctx.store.doc().items.filter(i => this.entryFor(i) || this.failed.has(`${i.path}|${quatKey(i.rotation)}`)).length;
  }

  /** Tries the parts that failed to load again (their files may be back, e.g. after Put Back from the Trash). */
  retryFailed() {
    if (!this.failed.size) return;
    this.failed.clear();
    this.reconcile(this.mode);
  }

  /**
   * Throws away every loaded geometry and reads the STL files again (they may have been overwritten on disk). The parts on screen stay
   * until their new geometry has arrived, so nothing flickers.
   */
  reloadGeometries() {
    for (const entry of this.oriented.values()) { entry.geometry.dispose(); entry.edges?.dispose(); entry.silhouette?.dispose(); }
    for (const geometry of this.baseGeometries.values()) geometry.dispose();
    this.oriented.clear();
    this.baseGeometries.clear();
    this.baseLoading.clear();
    this.failed.clear();
    for (const runtime of this.runtimes.values()) runtime.entryKey = ''; // rebuilt from the new geometry
    this.reconcile(this.mode);
  }

  /** Loads the file and drops it into the first free spot along +X at ground level. */
  addObject(path: string) {
    return this.addObjects([path]);
  }

  /** Loads the files and puts them where their STLs say (see below), as one undo step. */
  async addObjects(paths: string[]) {
    const { store } = this.ctx;
    const taken = store.doc().items
      .map(item => { const entry = this.entryFor(item); return entry && new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(entry.size)); })
      .filter((b): b is THREE.Box3 => !!b);
    const created: Omit<DocItem, 'id' | 'color'>[] = [];
    // An STL keeps the place it was exported from (Fusion does too), so a set of parts saved together lands as it was assembled. When that
    // place lies outside the work area the whole set moves by one common offset (the relative positions stay), so it just fits. A part goes to
    // the first free spot along +X instead when another copy of the same file already sits exactly there.
    const bases = await Promise.all(paths.map(path => this.loadBase(path)));
    const spots = bases.map(base => {
      base.computeBoundingBox();
      const box = base.boundingBox!;
      return { min: box.min.clone(), size: this.orient(base, [0, 0, 0, 1]).size };
    });
    const whole = new THREE.Box3();
    for (const spot of spots) whole.union(new THREE.Box3(spot.min, spot.min.clone().add(spot.size)));
    const wholeMin = whole.min.toArray() as Vec3;
    const shift = clampToWorkArea(wholeMin, whole.getSize(new THREE.Vector3()).toArray() as Vec3).map((v, i) => v - wholeMin[i]);
    const exact = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 0.001);
    for (const [index, path] of paths.entries()) {
      const size = spots[index].size;
      const saved = spots[index].min.toArray().map((v, i) => Math.round((v + shift[i]) * 1000) / 1000) as Vec3;
      const duplicate = [...store.doc().items, ...created].some(i => i.path === path && exact(i.position, saved));
      if (!duplicate) {
        created.push({ path, name: path.split('/').pop()!.replace(/\.stl$/i, ''), position: saved, rotation: [0, 0, 0, 1] });
        continue;
      }
      let x = 0;
      for (let attempt = 0; attempt < 200; attempt++) {
        const candidate = new THREE.Box3(new THREE.Vector3(x + 0.01, 0.01, 0.01), new THREE.Vector3(x + size.x - 0.01, size.y - 0.01, size.z - 0.01));
        const blocker = taken.find(b => b.intersectsBox(candidate));
        if (!blocker) break;
        x = Math.max(x + snapStepMm.x, Math.ceil(blocker.max.x / snapStepMm.x) * snapStepMm.x);
      }
      taken.push(new THREE.Box3(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, 0, 0).add(size))); // the next file of this batch goes after it
      created.push({ path, name: path.split('/').pop()!.replace(/\.stl$/i, ''), position: [x, 0, 0], rotation: [0, 0, 0, 1] });
    }
    store.addParts(created);
    // The keyboard goes from the file list to the canvas (its container is the focusable element; the stage host is not), so the new parts can be moved at once.
    (document.activeElement as HTMLElement | null)?.blur();
    this.ctx.canvas.parentElement?.focus({ preventScroll: true });
  }

  /**
   * Rotates the selection around a world axis through the middle of its box (the pivot point, drawn while it turns), as one rigid body.
   * The lowest point of the selection stays where it was and the group goes back to the grid as a whole.
   */
  rotateSelected(axis: 'x' | 'y' | 'z', degrees: number) {
    const { store } = this.ctx;
    const items = store.selectedItems().filter(item => this.baseGeometries.has(item.path) && this.entryFor(item));
    if (!items.length) return;
    const worldAxis = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const step = new THREE.Quaternion().setFromAxisAngle(worldAxis, THREE.MathUtils.degToRad(degrees));

    const boxes = items.map(item => new THREE.Box3(new THREE.Vector3(...item.position), new THREE.Vector3(...item.position).add(this.entryFor(item)!.size)));
    const groupBox = boxes.reduce((all, box) => all.union(box), new THREE.Box3());
    const pivot = this.pivotOf(items, groupBox);

    this.rotateGroup(items, step, pivot, groupBox.min.z);
    this.flashPivot(pivot);
  }

  /**
   * Puts the selected parts back to the rotation of their STL file about one axis (the turns about the other axes stay). Each part turns about
   * the middle of its own box, so it stays where it is.
   */
  resetRotation(axis: 'x' | 'y' | 'z' | 'all') {
    const items = this.ctx.store.selectedItems().filter(item => this.baseGeometries.has(item.path) && this.entryFor(item));
    const changes = new Map<string, Partial<{ position: Vec3; rotation: Quat }>>();
    for (const item of items) {
      const old = new THREE.Quaternion(...item.rotation);
      const euler = new THREE.Euler().setFromQuaternion(old, 'ZYX');
      if (axis === 'all') euler.set(0, 0, 0, 'ZYX'); else euler[axis] = 0;
      const next = new THREE.Quaternion().setFromEuler(euler);
      const step = next.clone().multiply(old.clone().invert()); // the turn that takes the part from where it is to where it should be
      const base = this.baseGeometries.get(item.path)!;
      const size = this.entryFor(item)!.size;
      const centre = item.origin ? this.originWorld(item, base) : new THREE.Vector3(...item.position).addScaledVector(size, 0.5);
      const origin = new THREE.Vector3(...item.position).sub(this.rotatedMin(base, old));
      const position = origin.sub(centre).applyQuaternion(step).add(centre).add(this.rotatedMin(base, next));
      const clean = (v: number) => Math.abs(v) < 1e-6 ? 0 : Math.round(v * 1e6) / 1e6;
      const rotation: Quat = [clean(next.x), clean(next.y), clean(next.z), clean(next.w)];
      const key = `${item.path}|${quatKey(rotation)}`;
      if (!this.oriented.has(key)) this.oriented.set(key, this.orient(base, rotation));
      changes.set(item.id, { rotation, position: clampToWorkArea([round3(position.x), round3(position.y), round3(position.z)], this.oriented.get(key)!.size.toArray() as Vec3) });
    }
    if (changes.size) this.ctx.store.updateItems('Reset rotation', changes);
  }

  /**
   * Where the part's lowest corner is when its origin point sits at the world's 0, 0, 0 (the position the Move panel's ↺ goes to). A part saved
   * far from the origin in its STL file (Fusion exports keep their place) cannot get there inside the work area: it goes as near as it can,
   * and that spot counts as 0.
   */
  private zeroPosition(item: DocItem): Vec3 | null {
    const base = this.baseGeometries.get(item.path), size = this.sizeOfItem(item);
    if (!base || !size) return null;
    const q = new THREE.Quaternion(...item.rotation);
    const zero = this.rotatedMin(base, q);
    if (item.origin) zero.sub(new THREE.Vector3(...item.origin).applyQuaternion(q));
    return clampToWorkArea([zero.x, zero.y, zero.z], size);
  }

  /** The Move panel's numbers: how far the part is from its zero position (see zeroPosition). */
  originOffset(item: DocItem): Vec3 | null {
    const zero = this.zeroPosition(item);
    return zero ? [round3(item.position[0] - zero[0]), round3(item.position[1] - zero[1]), round3(item.position[2] - zero[2])] : null;
  }

  /** Where the part's origin point (the one the user set, or the STL's own 0, 0, 0) is in the world. */
  private originWorld(item: DocItem, base = this.baseGeometries.get(item.path)!): THREE.Vector3 {
    const q = new THREE.Quaternion(...item.rotation);
    const stlOrigin = new THREE.Vector3(...item.position).sub(this.rotatedMin(base, q)); // where the STL's own 0, 0, 0 lies
    return item.origin ? stlOrigin.add(new THREE.Vector3(...item.origin).applyQuaternion(q)) : stlOrigin;
  }

  /** What a selection turns about: the origin point of the part chosen last when it has one of its own, else the middle of the selection's box. */
  private pivotOf(items: DocItem[], box: THREE.Box3): THREE.Vector3 {
    const last = items.at(-1);
    return last?.origin && this.baseGeometries.has(last.path) ? this.originWorld(last) : box.getCenter(new THREE.Vector3());
  }

  /** The "Set origin" buttons: handles appear on the corners and the middle of the selected parts; the one clicked becomes their origin. */
  beginSetOrigin() {
    const ids = this.ctx.store.selectedItems().filter(item => this.entryFor(item)).map(item => item.id);
    if (ids.length) this.ctx.store.beginOriginPick(ids);
  }

  /** The clicked point (world) becomes the origin of every picked part: stored in the part's own STL coordinates, so it turns and moves with it. */
  private setOriginAt(point: Vec3) {
    const { store } = this.ctx;
    const ids = new Set(store.originPick() ?? []);
    store.originPick.set(null);
    const changes = new Map<string, Partial<{ origin: Vec3 | null }>>();
    for (const item of store.doc().items) {
      if (!ids.has(item.id) || !this.baseGeometries.has(item.path)) continue;
      const q = new THREE.Quaternion(...item.rotation);
      const stlOrigin = new THREE.Vector3(...item.position).sub(this.rotatedMin(this.baseGeometries.get(item.path)!, q));
      const local = new THREE.Vector3(...point).sub(stlOrigin).applyQuaternion(q.clone().invert());
      changes.set(item.id, { origin: [round3(local.x), round3(local.y), round3(local.z)] });
    }
    if (changes.size) store.updateItems('Set origin', changes);
  }

  /** Back to the STL's own origin for the selected parts. */
  clearOrigin() {
    const { store } = this.ctx;
    store.originPick.set(null);
    const changes = new Map<string, Partial<{ origin: Vec3 | null }>>();
    for (const item of store.selectedItems()) if (item.origin) changes.set(item.id, { origin: null });
    if (changes.size) store.updateItems('Use STL origin', changes);
  }

  /** The − / + buttons of the Move panel: the selection moves `mm` along one axis, as one undo step, kept inside the work area. */
  moveSelected(axis: 'x' | 'y' | 'z', mm: number) {
    const items = this.ctx.store.selectedItems().filter(item => this.entryFor(item));
    if (!items.length) return;
    const i = { x: 0, y: 1, z: 2 }[axis];
    const delta: Vec3 = [0, 0, 0];
    delta[i] = mm;
    const d = this.clampDelta(delta, items.map(item => ({ position: item.position, size: this.sizeOfItem(item) ?? [0, 0, 0] as Vec3 })));
    if (d[i] === 0) return;
    const changes = new Map<string, Partial<{ position: Vec3 }>>();
    for (const item of items) changes.set(item.id, { position: [round3(item.position[0] + d[0]), round3(item.position[1] + d[1]), round3(item.position[2] + d[2])] });
    this.ctx.store.updateItems('Move', changes);
  }

  /** The ↺ button of the Move panel: the selected parts go back to where their STL files put them along one axis. */
  resetOffset(axis: 'x' | 'y' | 'z' | 'all') {
    const only = axis === 'all' ? -1 : { x: 0, y: 1, z: 2 }[axis];
    const changes = new Map<string, Partial<{ position: Vec3 }>>();
    for (const item of this.ctx.store.selectedItems()) {
      const zero = this.zeroPosition(item);
      if (!zero) continue;
      const position: Vec3 = [...item.position];
      for (const k of [0, 1, 2]) if (only < 0 || k === only) position[k] = round3(zero[k]);
      if (position.some((v, k) => v !== item.position[k])) changes.set(item.id, { position });
    }
    if (changes.size) this.ctx.store.updateItems('Reset position', changes);
  }

  /** An X, Y and Z at the rings. Each label is a child of its ring, so it follows the scale that keeps the gizmo the same size on screen. */
  private addRingLabels() {
    const gizmo = (this.rotateTool as unknown as { _gizmo?: { gizmo?: { rotate?: THREE.Object3D }; picker?: { rotate?: THREE.Object3D } } })._gizmo;
    const rings = gizmo?.gizmo?.rotate, pickers = gizmo?.picker?.rotate;
    if (!rings || !pickers) return;
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const ring = rings.children.find(c => c.name === axis && (c as THREE.Mesh).geometry instanceof THREE.TorusGeometry) as THREE.Mesh | undefined;
      const g = ring?.geometry as THREE.TorusGeometry | undefined;
      if (!ring || !g) continue;
      // A point of the ring at 45° (the rings are thin tori already lying in their plane; some are half circles): the label sits there.
      const { arc, tubularSegments } = g.parameters;
      const at = g.getAttribute('position');
      const index = Math.round(tubularSegments * (Math.PI / 4) / arc);
      if (index > tubularSegments) continue;
      const letter = (color: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const c2d = canvas.getContext('2d');
        if (c2d) {
          c2d.font = 'bold 44px system-ui, sans-serif';
          c2d.textAlign = 'center';
          c2d.textBaseline = 'middle';
          c2d.lineJoin = 'round';
          c2d.lineWidth = 7; // a dark outline keeps the letter readable over parts of any colour
          c2d.strokeStyle = 'rgba(15, 17, 22, 0.95)';
          c2d.strokeText(axis, 32, 34);
          c2d.fillStyle = '#' + color.toString(16).padStart(6, '0');
          c2d.fillText(axis, 32, 34);
        }
        return new THREE.CanvasTexture(canvas);
      };
      const dim = letter(ringColors[axis].dim), bright = letter(ringColors[axis].bright);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dim, depthTest: false, transparent: true }));
      this.ringLabels.set(axis, { sprite, dim, bright });
      sprite.position.set(at.getX(index), at.getY(index), at.getZ(index));
      sprite.scale.setScalar(0.26);
      sprite.renderOrder = Infinity; // like the rings themselves: drawn over everything, the letters over the rings
      ring.add(sprite);
      // A letter can be grabbed like its ring: an invisible ball in the picker group (what the tool tests the pointer against) follows it.
      const grab = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
      grab.name = axis;
      pickers.add(grab);
      const spot = new THREE.Vector3();
      sprite.onBeforeRender = () => { sprite.getWorldPosition(spot); grab.position.copy(pickers.worldToLocal(spot)); };
    }
  }

  private buildPivotMarker() {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x8c919c, depthTest: false, transparent: true }));
    const edge = new THREE.Mesh(new THREE.SphereGeometry(1.45, 16, 12), new THREE.MeshBasicMaterial({ color: 0x15181f, depthTest: false, transparent: true, side: THREE.BackSide }));
    edge.renderOrder = 1e9; // the dark rim first, the grey dot over it
    dot.renderOrder = Infinity;
    this.pivotMarker.add(edge, dot);
    this.pivotMarker.visible = false;
    dot.onBeforeRender = () => { // 5 px, whatever the zoom or the camera
      const camera = this.ctx.camera, height = this.ctx.canvas.clientHeight || 1;
      const worldPerPixel = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
        ? 2 * camera.position.distanceTo(this.rotatePivot.position) * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2) / height
        : ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom) / camera.zoom / height;
      this.pivotMarker.scale.setScalar(5 * worldPerPixel);
      this.pivotMarker.updateMatrixWorld(true);
    };
    this.rotatePivot.add(this.pivotMarker);
  }

  /** Shows the pivot point for a moment while a button or key turns the selection (the rotate tool shows it for as long as it is open). */
  private flashPivot(at: THREE.Vector3) {
    if (this.rotateStart) return;
    this.rotatePivot.position.copy(at);
    this.pivotMarker.visible = true;
    this.pivotFlashing = true;
    clearTimeout(this.pivotFlash);
    this.pivotFlash = setTimeout(() => { this.pivotFlashing = false; this.updateRotateTool(); }, 1200);
  }

  /**
   * Esc in the rotate tool: closes it and undoes every rotation made since it was opened (also one that is being dragged), putting the parts
   * back where they were. Returns false when the tool is not open, so Esc can do its usual job.
   */
  private cancelRotateTool(): boolean {
    if (!this.rotateToolOn) return false;
    const { store } = this.ctx;
    if (this.rotateStart) { this.rotateStart = null; store.abortGesture(); }
    const back = this.rotateSnapshot;
    const changes = new Map<string, Partial<{ position: Vec3; rotation: Quat }>>();
    for (const item of store.doc().items) {
      const before = back?.get(item.id);
      if (before && (before.position.some((v, i) => v !== item.position[i]) || before.rotation.some((v, i) => v !== item.rotation[i]))) changes.set(item.id, { position: before.position, rotation: before.rotation });
    }
    if (changes.size) store.updateItems('Cancel rotation', changes);
    this.rotateToolOn = false;
    this.rotateSnapshot = null;
    this.updateRotateTool();
    store.announce(changes.size ? 'Rotation cancelled' : 'Rotate tool off');
    return true;
  }

  // --- the move tool (M) -------------------------------------------------------------------------------------------------------------

  /** An X, Y and Z at the arrow tips (children of the arrows: they keep the gizmo's scale), grabbable like the arrows. */
  private addMoveLabels() {
    const gizmo = (this.moveTool as unknown as { _gizmo?: { gizmo?: { translate?: THREE.Object3D }; picker?: { translate?: THREE.Object3D } } })._gizmo;
    const arrows = gizmo?.gizmo?.translate, pickers = gizmo?.picker?.translate;
    if (!arrows || !pickers) return;
    const tips = { X: 0, Y: 1, Z: 2 };
    for (const axis of ['X', 'Y', 'Z'] as const) {
      // The arrows' offsets are baked into their geometry: the + arrow is the one whose geometry lies on the positive side of its axis.
      const arrow = arrows.children.find(c => {
        const g = (c as THREE.Mesh).geometry;
        if (c.name !== axis || !(g instanceof THREE.CylinderGeometry)) return false;
        g.computeBoundingBox();
        return g.boundingBox!.max.getComponent(tips[axis]) > 0.3;
      }) as THREE.Mesh | undefined;
      if (!arrow) continue;
      const tip = arrow.geometry.boundingBox!.max.getComponent(tips[axis]);
      const dim = letterTexture(axis, ringColors[axis].dim), bright = letterTexture(axis, ringColors[axis].bright);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dim, depthTest: false, transparent: true }));
      this.moveLabels.set(axis, { sprite, dim, bright });
      sprite.position.setComponent(tips[axis], tip + 0.12); // just beyond the tip, along the axis
      sprite.scale.setScalar(0.2);
      sprite.renderOrder = Infinity;
      arrow.add(sprite);
      const grab = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
      grab.name = axis;
      pickers.add(grab);
      const spot = new THREE.Vector3();
      sprite.onBeforeRender = () => { sprite.getWorldPosition(spot); grab.position.copy(pickers.worldToLocal(spot)); };
    }
  }

  /** M: shows or hides the move tool (arrows at the lower left corner of the selection). */
  toggleMoveTool() {
    if (!this.moveToolOn) this.closeRotateTool();
    this.moveToolOn = !this.moveToolOn;
    this.moveToolFor = this.ctx.store.selectedIds().join(',');
    this.moveSnapshot = this.moveToolOn ? new Map(this.ctx.store.doc().items.map(i => [i.id, { position: [...i.position] as Vec3 }])) : null;
    this.updateMoveTool();
    const { store } = this.ctx;
    store.announce(!this.moveToolOn ? 'Move tool off' : store.selectedIds().length ? 'Move tool: drag an arrow, or click a corner and then a corner of another part (M to close)' : 'Move tool: select one or more parts, then drag an arrow (M to close)');
  }

  private closeRotateTool() {
    if (!this.rotateToolOn) return;
    this.rotateToolOn = false;
    this.rotateSnapshot = null;
    this.updateRotateTool();
  }

  private closeMoveTool() {
    if (!this.moveToolOn) return;
    this.moveToolOn = false;
    this.moveSnapshot = null;
    this.updateMoveTool();
  }

  /** Puts the arrows at the lower left corner of the selection (not while one is being dragged), or hides them when there is nothing to move. */
  private updateMoveTool() {
    const chosen = this.ctx.store.selectedIds().join(',');
    if (this.moveToolOn && !this.moveStart && chosen !== this.moveToolFor) {
      if (this.moveToolFor === '' && chosen !== '') { // opened with nothing selected: the first choice gets the arrows
        this.moveToolFor = chosen;
        this.ctx.store.announce('Move tool: drag an arrow, or click a corner and then a corner of another part (M to close)');
      } else { this.moveToolOn = false; this.moveSnapshot = null; }
    }
    const items = this.ctx.store.selectedItems().filter(item => this.entryFor(item));
    const show = this.active && this.moveToolOn && items.length > 0;
    this.moveTool.getHelper().visible = show;
    this.moveTool.enabled = show;
    if (!show) {
      if (this.moveTool.object) this.moveTool.detach();
      if (this.movePickOwned) { this.movePickOwned = false; this.ctx.store.cancelPicks(); }
      return;
    }
    if (this.moveStart) return;
    const { store } = this.ctx;
    if (!store.movePick() && !store.snapPick()) { // "Move to…" belongs to this tool: the corners of the selection to start from
      store.beginMovePick(items.map(item => item.id));
      this.movePickOwned = true;
    }
    const box = this.selectionBounds();
    if (!box) return;
    this.movePivot.position.copy(box.min);
    if (this.moveTool.object !== this.movePivot) this.moveTool.attach(this.movePivot);
  }

  private onMoveDragging(dragging: boolean) {
    this.ctx.setOrbitEnabled?.(!dragging);
    const { store } = this.ctx;
    if (dragging) {
      const items = store.selectedItems().filter(item => this.entryFor(item));
      const box = this.selectionBounds();
      if (!items.length || !box) return;
      this.moveStart = { items: items.map(item => ({ ...item, position: [...item.position] as Vec3 })), min: box.min.clone() };
      store.beginGesture('Move');
    } else if (this.moveStart) {
      this.moveStart = null;
      store.endGesture();
      this.updateMoveTool();
    }
  }

  /** An arrow was dragged: the selection follows along that axis only, with its lowest corner on the grid (X and Y 20 mm, Z the height levels). */
  private onMoveChange() {
    const start = this.moveStart;
    const axis = this.moveTool.axis;
    if (!start || (axis !== 'X' && axis !== 'Y' && axis !== 'Z')) return;
    const i = { X: 0, Y: 1, Z: 2 }[axis];
    const raw = start.min.getComponent(i) + (this.movePivot.position.getComponent(i) - start.min.getComponent(i));
    const fine = this.altHeld; // Option: the fine step (1 mm or 0.1 mm, as chosen with the step button) instead of the grid
    const target = fine ? snap(raw, this.ctx.store.fineStepMm()) : i === 2 ? nearestZLevel(raw, this.ctx.zGridMode()) : snap(raw, i === 0 ? snapStepMm.x : snapStepMm.y);
    const delta: Vec3 = [0, 0, 0];
    delta[i] = target - start.min.getComponent(i);
    const clamped = this.clampDelta(delta, start.items.map(item => ({ position: item.position, size: this.sizeOfItem(item) ?? [0, 0, 0] as Vec3 })));
    const changes = new Map<string, Partial<{ position: Vec3 }>>();
    for (const item of start.items) changes.set(item.id, { position: [round3(item.position[0] + clamped[0]), round3(item.position[1] + clamped[1]), round3(item.position[2] + clamped[2])] });
    this.ctx.store.updateItems('Move', changes);
  }

  /** The Cancel button of the pick banners: the same as Esc (in the move tool it steps back, then closes the tool and puts the parts back). */
  cancelPicks() {
    if (!this.escapeMoveTool()) this.ctx.store.cancelPicks();
  }

  /** Esc in the move tool: first back from a chosen corner to choosing one, then it closes the tool and puts the parts back. */
  private escapeMoveTool(): boolean {
    if (!this.moveToolOn) return false;
    const pick = this.ctx.store.movePick();
    if (pick?.source) { this.ctx.store.beginMovePick(pick.ids); return true; }
    return this.cancelMoveTool();
  }

  /** Enter in the move or rotate tool: the changes stay (one undo step each, as made), the tool closes. */
  private confirmTools() {
    const what = this.moveToolOn && this.rotateToolOn ? 'Move and rotate' : this.moveToolOn ? 'Move' : 'Rotate';
    this.closeMoveTool();
    this.closeRotateTool();
    this.ctx.store.announce(`${what} confirmed`);
  }

  /** Esc in the move tool: closes it and puts every part back where it was when the tool was opened. False when the tool is not open. */
  private cancelMoveTool(): boolean {
    if (!this.moveToolOn) return false;
    const { store } = this.ctx;
    if (this.moveStart) { this.moveStart = null; store.abortGesture(); }
    const back = this.moveSnapshot;
    const changes = new Map<string, Partial<{ position: Vec3 }>>();
    for (const item of store.doc().items) {
      const before = back?.get(item.id);
      if (before && before.position.some((v, k) => v !== item.position[k])) changes.set(item.id, { position: before.position });
    }
    if (changes.size) store.updateItems('Cancel move', changes);
    this.moveToolOn = false;
    this.moveSnapshot = null;
    this.updateMoveTool();
    store.announce(changes.size ? 'Move cancelled' : 'Move tool off');
    return true;
  }

  /** True while the pointer is on a ring or arrow of the rotate / move tool (a press then belongs to the tool, not to the view). */
  gizmoGrabbed(): boolean {
    return (this.rotateToolOn && !!this.rotateTool.axis) || (this.moveToolOn && !!this.moveTool.axis);
  }

  /** Opens the rotate tool if it is closed (the − / + buttons of the rotate panel do this, so the rings show where the part turns). */
  showRotateTool() {
    if (!this.rotateToolOn) this.toggleRotateTool();
  }

  /** R: shows or hides the rotate tool (rings about X, Y and Z at the centre of the selection). */
  toggleRotateTool() {
    if (!this.rotateToolOn) this.closeMoveTool();
    this.rotateToolOn = !this.rotateToolOn;
    this.rotateToolFor = this.ctx.store.selectedIds().join(',');
    this.rotateSnapshot = this.rotateToolOn ? new Map(this.ctx.store.doc().items.map(i => [i.id, { position: [...i.position] as Vec3, rotation: [...i.rotation] as Quat }])) : null;
    this.updateRotateTool();
    const { store } = this.ctx;
    store.announce(!this.rotateToolOn ? 'Rotate tool off' : store.selectedIds().length ? 'Rotate tool: drag a ring (R to close)' : 'Rotate tool: select one or more parts, then drag a ring (R to close)');
  }

  /** Puts the rings at the centre of the selection (not while one is being dragged), or hides them when there is nothing to turn. */
  private updateRotateTool() {
    const helper = this.rotateTool.getHelper();
    const chosen = this.ctx.store.selectedIds().join(',');
    if (this.rotateToolOn && !this.rotateStart && chosen !== this.rotateToolFor) {
      if (this.rotateToolFor === '' && chosen !== '') { // opened with nothing selected: the first choice gets the rings
        this.rotateToolFor = chosen;
        this.ctx.store.announce('Rotate tool: drag a ring (R to close)');
      } else { this.rotateToolOn = false; this.rotateSnapshot = null; }
    }
    const items = this.ctx.store.selectedItems().filter(item => this.entryFor(item));
    const show = this.active && this.rotateToolOn && items.length > 0;
    helper.visible = show;
    this.rotateTool.enabled = show;
    this.pivotMarker.visible = show || this.pivotFlashing;
    if (!show) { if (this.rotateTool.object) this.rotateTool.detach(); return; }
    if (this.rotateStart) return;
    const box = this.selectionBounds();
    if (!box) return;
    this.rotatePivot.position.copy(this.pivotOf(items, box));
    this.rotatePivot.quaternion.identity();
    this.rotateTool.setRotationSnap(THREE.MathUtils.degToRad(this.ctx.rotationStep()));
    if (this.rotateTool.object !== this.rotatePivot) this.rotateTool.attach(this.rotatePivot);
  }

  private onRotateDragging(dragging: boolean) {
    this.ctx.setOrbitEnabled?.(!dragging);
    const { store } = this.ctx;
    if (dragging) {
      const items = store.selectedItems().filter(item => this.entryFor(item) && this.baseGeometries.has(item.path));
      const box = this.selectionBounds();
      if (!items.length || !box) return;
      this.rotateStart = { items: items.map(item => ({ ...item, position: [...item.position] as Vec3, rotation: [...item.rotation] as Quat })), pivot: this.pivotOf(items, box), low: box.min.z };
      store.beginGesture('Rotate');
    } else if (this.rotateStart) {
      this.rotateStart = null;
      store.endGesture();
      this.updateRotateTool();
    }
  }

  /** A ring turned: the parts are put where turning the selection as it was at the start by this angle leaves them (live, one undo step at the end). */
  private onRotateChange() {
    const start = this.rotateStart;
    if (!start) return;
    this.rotateGroup(start.items, this.rotatePivot.quaternion.clone(), start.pivot, start.low);
  }

  /**
   * Turns several items as one rigid body: every point of every part is rotated about the pivot, so the parts keep their places relative to each
   * other (a part's own box centre is not its mesh's centre, so turning each box about the pivot would pull them apart). The group as a whole
   * goes back to the grid and keeps its lowest point.
   */
  private rotateGroup(items: DocItem[], step: THREE.Quaternion, pivot: THREE.Vector3, oldLow: number) {
    const turned = items.map(item => {
      const base = this.baseGeometries.get(item.path)!;
      const old = new THREE.Quaternion(...item.rotation);
      const next = step.clone().multiply(old).normalize();
      const nextRotation: Quat = [next.x, next.y, next.z, next.w];
      const key = `${item.path}|${quatKey(nextRotation)}`;
      const entry = this.oriented.get(key) ?? this.orient(base, nextRotation);
      this.oriented.set(key, entry);
      const origin = new THREE.Vector3(...item.position).sub(this.rotatedMin(base, old)); // where the mesh's own origin sits in the world
      const newOrigin = origin.sub(pivot).applyQuaternion(step).add(pivot);
      const position = newOrigin.add(this.rotatedMin(base, next));
      return { item, rotation: nextRotation, size: entry.size, position };
    });
    const low = new THREE.Vector3(Math.min(...turned.map(t => t.position.x)), Math.min(...turned.map(t => t.position.y)), Math.min(...turned.map(t => t.position.z)));
    const shift = new THREE.Vector3(snap(low.x, snapStepMm.x) - low.x, snap(low.y, snapStepMm.y) - low.y, oldLow - low.z);
    const delta = this.clampDelta(shift.toArray() as Vec3, turned.map(t => ({ position: t.position.toArray() as Vec3, size: t.size.toArray() as Vec3 })));
    const round3 = (v: number) => Math.round(v * 1000) / 1000;
    const changes = new Map<string, Partial<{ position: Vec3; rotation: Quat }>>();
    for (const t of turned) changes.set(t.item.id, { rotation: t.rotation, position: [round3(t.position.x + delta[0]), round3(t.position.y + delta[1]), round3(t.position.z + delta[2])] });
    this.ctx.store.updateItems('Rotate', changes);
  }

  /** The lowest corner of the mesh's box once it is turned by `rotation` (the mesh itself is stored around its own origin). */
  private rotatedMin(base: THREE.BufferGeometry, rotation: THREE.Quaternion): THREE.Vector3 {
    const geometry = base.clone().applyQuaternion(rotation);
    geometry.computeBoundingBox();
    const min = geometry.boundingBox!.min.clone();
    geometry.dispose();
    return min;
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
    e.preventDefault();
    if (!id) this.ctx.store.openCanvasMenu(e.clientX, e.clientY);
    else this.ctx.store.openContextMenu(e.clientX, e.clientY, id);
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.active || e.button !== 0) return;
    this.moveTool.camera = this.ctx.camera;
    this.rotateTool.camera = this.ctx.camera;
    this.rotateTool.setRotationSnap(THREE.MathUtils.degToRad(this.ctx.rotationStep())); // the Step may have changed since the tool was shown
    if (this.rotateToolOn && this.rotateTool.axis) return; // a ring of the rotate tool was grabbed: it handles the drag
    if (this.moveToolOn && this.moveTool.axis) return; // an arrow of the move tool
    if (this.picking()) { // "Snap to grid…" / "Move to…": the next click chooses a handle
      const handle = this.pickHandle(e);
      if (handle) {
        e.stopImmediatePropagation();
        const { store } = this.ctx;
        const data = handle.userData;
        if (data['kind'] === 'snap') { const [fx, fy] = data['anchor'] as [number, number]; store.applySnap(fx, fy); }
        else if (data['kind'] === 'origin') this.setOriginAt(data['point'] as Vec3);
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
    if (!hit && e.shiftKey && e.button === 0) { // Shift-drag on empty space: a dashed rectangle selects the parts it holds or touches
      e.stopImmediatePropagation();
      this.startMarquee(e);
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
    this.ctx.store.beginGesture('Move'); // every pointer move of the drag changes the document live; the undo step is written once, at the end
    this.ctx.canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent) {
    this.rotateTool.camera = this.ctx.camera;
    this.moveTool.camera = this.ctx.camera;
    if (this.active && this.picking()) this.hoverHandle(this.pickHandle(e));
    if (this.marquee) { this.updateMarquee(e); return; }
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
    const fine = e.altKey; // hold Alt for fine steps (1 mm or 0.1 mm, the toolbar's step mode)
    const fineStep = this.ctx.store.fineStepMm();
    const step = (axis: 'x' | 'y') => (fine ? fineStep : snapStepMm[axis]);
    // Snap the grabbed item, then move everything by the same delta so the group keeps its shape.
    const grabbed = this.ctx.store.doc().items.find(i => i.id === drag.id);
    const grabbedSize = grabbed && this.sizeOfItem(grabbed);
    const rawX = point.x - drag.grabOffset.x, rawY = point.y - drag.grabOffset.y;
    let delta: Vec3;
    // Height snaps to the z levels of the current grid mode; Alt gives 1 mm steps.
    if (drag.vertical && !fine && grabbed?.centered && grabbedSize) { // a centered part moves by its centre: the centre hops from level to level
      delta = [0, 0, nearestZLevel(point.z - drag.grabOffset.z + grabbedSize[2] / 2, this.ctx.zGridMode()) - grabbedSize[2] / 2 - start[2]];
    } else if (drag.vertical) delta = [0, 0, (fine ? snap(point.z - drag.grabOffset.z, fineStep) : nearestZLevel(point.z - drag.grabOffset.z, this.ctx.zGridMode())) - start[2]];
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
    this.ctx.store.updateItems('Move', changes); // inside the drag's gesture: live, one undo step at the end
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.active) return;
    if (this.marquee) { this.finishMarquee(e); return; }
    if (this.drag) {
      this.ctx.store.endGesture(); // writes the single undo step (nothing when the part never moved)
      if (!this.drag.moved && this.drag.wasInGroup) this.ctx.store.select(this.drag.id); // plain click inside a multi-selection narrows it, like Finder
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
    const fine = e.altKey; // ⌥: fine steps (1 mm or 0.1 mm, the toolbar's step mode)
    const fineStep = store.fineStepMm();
    const move = (dx: number, dy: number, dz: number) => {
      const items = store.selectedItems();
      if (!items.length) return false;
      const [cx, cy, cz] = this.clampDelta([dx, dy, dz], this.placed(items));
      const horizontal = cx !== 0 || cy !== 0;
      store.updateItems('Nudge', new Map(items.map(i => [i.id, { position: this.keepCentered(i, [round3(i.position[0] + cx), round3(i.position[1] + cy), round3(i.position[2] + cz)], horizontal) }])));
      return true;
    };
    const stepX = fine ? fineStep : snapStepMm.x, stepY = fine ? fineStep : snapStepMm.y;
    // One step up/down the z levels, decided by the lowest selected item (the base); the rest of the selection keeps its offsets.
    const moveZ = (direction: 1 | -1) => {
      const selected = store.selectedItems();
      // when every selected part is centered the levels are those of the parts' centres: the lowest centre steps to the next level
      const sizes = selected.map(i => this.sizeOfItem(i));
      const byCentre = !fine && selected.length > 0 && selected.every((i, k) => i.centered && sizes[k]);
      const lowest = byCentre ? Math.min(...selected.map((i, k) => i.position[2] + sizes[k]![2] / 2)) : Math.min(...selected.map(i => i.position[2]));
      if (!Number.isFinite(lowest)) return false;
      return move(0, 0, fine ? direction * fineStep : nextZLevel(lowest, direction, this.ctx.zGridMode()) - lowest);
    };
    let handled = true;
    if (command && e.key.toLowerCase() === 'z') (e.shiftKey ? store.redo() : store.undo());
    else if (command && e.key.toLowerCase() === 'c') store.copySelection();
    else if (command && e.key.toLowerCase() === 'x') store.cutSelection();
    else if (command && e.key.toLowerCase() === 'v') store.pasteClipboard();
    else if (command && e.key.toLowerCase() === 'a') store.selectAll();
    else if (e.key === 'ArrowLeft') (e.shiftKey ? this.rotateSelected('z', this.ctx.rotationStep()) : move(-stepX, 0, 0)); // Shift+←/→: turn about Z
    else if (e.key === 'ArrowRight') (e.shiftKey ? this.rotateSelected('z', -this.ctx.rotationStep()) : move(stepX, 0, 0));
    else if (!command && !e.altKey && e.key.toLowerCase() === 'v') { // V: dim / show the selection (the same as the menu's Dim)
      const selected = store.selectedItems();
      if (selected.length) store.setMuted(selected.map(i => i.id), !selected.every(i => i.muted));
    }
    else if (!command && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm' && !e.repeat) this.toggleMoveTool(); // M: the move tool
    else if (!command && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'm') { // Shift+M: Move to… (the same as the menu item; needs another part to move onto)
      const selected = store.selectedItems();
      if (selected.length && store.doc().items.length > selected.length) store.beginMovePick(selected.map(i => i.id));
    }
    else if (!command && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r' && !e.repeat) this.toggleRotateTool(); // R: the rotate tool
    else if (!command && !e.altKey && ['x', 'y', 'z'].includes(e.key.toLowerCase())) this.rotateSelected(e.key.toLowerCase() as 'x' | 'y' | 'z', e.shiftKey ? -this.ctx.rotationStep() : this.ctx.rotationStep());
    else if (e.key === 'ArrowUp') (e.shiftKey ? moveZ(1) : move(0, stepY, 0)); // Shift = height, like Shift+drag
    else if (e.key === 'ArrowDown') (e.shiftKey ? moveZ(-1) : move(0, -stepY, 0));
    else if (e.key === 'PageUp' || e.key === ']') moveZ(1);
    else if (e.key === 'PageDown' || e.key === '[') moveZ(-1);
    else if (e.key === 'Delete' || e.key === 'Backspace') store.removeSelected();
    else if (e.key === 'Enter' && !command && !e.altKey && !e.shiftKey && !this.drag && (this.moveToolOn || this.rotateToolOn)) this.confirmTools(); // Enter: keep what was done and leave the tool
    else if (e.key === 'Escape') { if (!this.drag && !this.escapeMoveTool() && !this.cancelRotateTool()) store.select(null); } // while dragging, Esc only cancels the drag
    else handled = false;
    if (handled) e.preventDefault();
  }

  dispose() {
    this.endMarquee();
    this.finishDrag();
    this.ctx.store.sizeOf = null;
    this.ctx.store.zMode = null;
    this.ctx.store.viewCenter = null;
    this.ctx.store.stlOf = null;
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    for (const runtime of this.runtimes.values()) clearParts(runtime.group);
    for (const entry of this.oriented.values()) { entry.geometry.dispose(); entry.edges?.dispose(); entry.silhouette?.dispose(); }
    for (const geometry of this.baseGeometries.values()) geometry.dispose();
    this.clearSelectionBoxes();
    this.snapHandles.clear();
    this.rotateTool.dispose();
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'keyup']) window.removeEventListener(type, this.trackAlt, true);
    this.moveTool.dispose();
    this.ctx.scene.remove(this.movePivot, this.moveTool.getHelper());
    this.ctx.scene.remove(this.rotatePivot, this.rotateTool.getHelper());
  }
}
