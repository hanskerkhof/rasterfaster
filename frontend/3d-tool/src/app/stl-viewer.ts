import { Component, ElementRef, OnDestroy, effect, inject, input, signal, untracked, viewChild, afterNextRender } from '@angular/core';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { firstValueFrom } from 'rxjs';
import { DocumentScene } from './document-scene';
import { DocumentStore, workArea } from './document.store';
import { LibraryService } from './library.service';
import { ViewMode, buildParts, clearParts, previewStyle } from './model-render';
import { ViewCube } from './view-cube';
import { ZGridMode, defaultZGridMode, nextZLevel, zGridModes } from './z-levels';

const gridCellMm = 20; // RASTERFASTER base grid pitch
const gridColor = 0x4a4e58; // dark gray, visible on the #1b1d22 background
const grid3dStorageKey = 'rasterfaster.grid3d';
const pivotStorageKey = 'rasterfaster.pivotOnSelection';
const zGridModeStorageKey = 'rasterfaster.zGridMode';

function foldDegrees(d: number) {
  const folded = ((d % 360) + 540) % 360 - 180; // -180..180
  return folded === -180 ? 180 : folded;
}

export type { ViewMode } from './model-render';

function readZGridMode(): ZGridMode {
  try {
    const stored = localStorage.getItem(zGridModeStorageKey);
    if (zGridModes.some(m => m.id === stored)) return stored as ZGridMode;
  } catch { /* storage unavailable */ }
  return defaultZGridMode;
}

function readPivotOnSelection() {
  try { return localStorage.getItem(pivotStorageKey) !== 'false'; } catch { return true; } // default on
}

function readGrid3d() {
  try { return localStorage.getItem(grid3dStorageKey) === 'true'; } catch { return false; }
}

@Component({
  selector: 'app-stl-viewer',
  template: `
    <div #host class="host" tabindex="0"></div>
    <div class="rotate" aria-label="Rotate object">
      <div class="title">{{ documentMode() ? 'Rotate selected' : 'Rotate object' }}</div>
      @for (axis of axes; track axis) {
        <div class="axis">
          <span [class]="'name ' + axis">{{ axis.toUpperCase() }}<small>{{ rotated()[axis] ? ' ' + (rotated()[axis] > 0 ? '+' : '') + rotated()[axis] + '°' : '' }}</small></span>
          <button type="button" [title]="'Rotate −' + rotationStep() + '° around ' + axis.toUpperCase()" [disabled]="documentMode() && !store.selectedId()" [class.active]="rotated()[axis] < 0" (click)="rotateObject(axis, -rotationStep())">−</button>
          <button type="button" [title]="'Rotate +' + rotationStep() + '° around ' + axis.toUpperCase()" [disabled]="documentMode() && !store.selectedId()" [class.active]="rotated()[axis] > 0" (click)="rotateObject(axis, rotationStep())">+</button>
        </div>
      }
      <div class="axis">
        <span class="name">Step</span>
        <select [value]="rotationStep()" (change)="rotationStep.set(+$any($event.target).value)">
          @for (s of rotationSteps; track s) { <option [value]="s" [selected]="s === rotationStep()">{{ s }}°</option> }
        </select>
      </div>
      @if (!documentMode()) { <button type="button" class="reset" (click)="resetObjectRotation()">Reset</button> }
    </div>
    @if (cubeMenu(); as menu) {
      <div class="menu-backdrop" (mousedown)="cubeMenu.set(null)" (contextmenu)="$event.preventDefault(); cubeMenu.set(null)"></div>
      <div class="cube-menu" role="menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
        <button type="button" role="menuitem" (click)="toggleGrid3d()">
          <span class="tick">{{ grid3d() ? '✓' : '' }}</span>3D grid<span class="hint">{{ grid3d() ? 'on' : 'off' }}</span>
        </button>
        <div class="submenu-host" (mouseenter)="gridModeOpen.set(true)" (mouseleave)="gridModeOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="gridModeOpen()" (click)="gridModeOpen.set(!gridModeOpen())">
            <span class="tick"></span>Grid mode<span class="hint">{{ currentGridModeTitle() }} ◂</span>
          </button>
          @if (gridModeOpen()) {
            <div class="flyout" role="menu">
              @for (m of zGridModes; track m.id) {
                <button type="button" role="menuitemradio" [attr.aria-checked]="zGridMode() === m.id" (click)="setZGridMode(m.id)">
                  <span class="tick">{{ zGridMode() === m.id ? '✓' : '' }}</span>
                  <span class="two-line"><span>{{ m.title }}</span><small>{{ m.detail }}</small></span>
                </button>
              }
            </div>
          }
        </div>
        <button type="button" role="menuitem" (click)="togglePivotOnSelection()">
          <span class="tick">{{ pivotOnSelection() ? '✓' : '' }}</span>Rotate around selection<span class="hint">{{ pivotOnSelection() ? 'on' : 'off' }}</span>
        </button>
      </div>
    }
    <button class="home" type="button" title="Home: isometric view, fit to the model" aria-label="Home view" (click)="goHome()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10"/></svg>
    </button>`,
  styles: `
    :host, .host { display: block; width: 100%; height: 100%; } .host { position: relative; overflow: hidden; }
    :host { position: relative; }
    /* Fusion-style: a small house icon in the top-left corner of the view cube's area (the cube is 150 px wide, 12 px from the edges) */
    .home { position: absolute; top: 12px; right: 132px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; padding: 0;
            background: transparent; color: #d5d9e2; border: 1px solid transparent; border-radius: 6px; cursor: pointer; opacity: .8; }
    .home:hover { background: #2f6fed; color: #fff; opacity: 1; }
    .rotate { position: absolute; top: 12px; left: 12px; width: 124px; padding: 8px; display: flex; flex-direction: column; gap: 6px;
              background: rgba(35,38,45,.85); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; font-size: 12px; color: #dde1e8; }
    .title { font-weight: 600; opacity: .8; }
    .axis { display: flex; align-items: center; gap: 4px; }
    .name { flex: 1; font-weight: 700; } .name.x { color: #c9605e; } .name.y { color: #6fb56f; } .name.z { color: #7b7fd6; }
    .rotate button, .rotate select { padding: 3px 9px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; }
    .rotate button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    .rotate button:disabled { opacity: .35; cursor: default; }
    .host:focus { outline: none; }
    .menu-backdrop { position: absolute; inset: 0; z-index: 8; }
    .cube-menu { position: absolute; z-index: 9; min-width: 220px; padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18);
                 border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; }
    .cube-menu button { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; text-align: left; cursor: pointer; font: inherit; }
    .cube-menu button:hover { background: #2f6fed; color: #fff; }
    .submenu-host { position: relative; }
    .flyout { position: absolute; right: calc(100% - 2px); top: -4px; min-width: 250px; padding: 4px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18);
              border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .two-line { display: flex; flex-direction: column; gap: 1px; }
    .two-line small { opacity: .55; font-size: 11px; }
    .cube-menu .tick { width: 1em; text-align: center; }
    .cube-menu .hint { margin-left: auto; opacity: .55; font-size: 11px; }
    .rotate button.active { background: #d9822b; color: #fff; }
    small { font-weight: 400; opacity: .85; color: #dde1e8; }
    .reset { width: 100%; }`,
})
export class StlViewer implements OnDestroy {
  readonly data = input<ArrayBuffer | null>(null);
  readonly mode = input<ViewMode>('solid');
  /** false: preview one STL; true: show and edit the document's items. */
  readonly documentMode = input(false);
  protected readonly store = inject(DocumentStore);
  private readonly library = inject(LibraryService);
  readonly info = signal('');
  protected readonly axes = ['x', 'y', 'z'] as const;

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private controls!: OrbitControls;
  private model = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private edges: THREE.EdgesGeometry | null = null;
  private frame = 0;
  private ro?: ResizeObserver;
  private radius = 1;
  private ready = signal(false);
  private hasView = false;
  private baseGeometry: THREE.BufferGeometry | null = null;
  private readonly objectRotation = new THREE.Quaternion();
  private grid: THREE.LineSegments | null = null;
  protected readonly rotationStep = signal(45);
  /** Net degrees applied per world axis (button presses summed, folded into -180..180) so the panel can show what was rotated. */
  protected readonly rotated = signal({ x: 0, y: 0, z: 0 });
  protected readonly rotationSteps = [90, 45, 15, 5, 1];
  private viewCube!: ViewCube;
  private documentScene!: DocumentScene;
  private needsDocumentFit = true;
  private gridKey = '';
  /** Full 3D lattice (X, Y and the z levels) instead of only the ground grid; toggled from the view cube's right-click menu. */
  protected readonly grid3d = signal(readGrid3d());
  protected readonly cubeMenu = signal<{ x: number; y: number } | null>(null);
  /** Height grid: fine (2 mm), baseplate (2 mm then 4 mm) or coarse (4 mm). Chosen in the view cube menu's "Grid mode" fly-out. */
  protected readonly zGridMode = signal(readZGridMode());
  protected readonly zGridModes = zGridModes;
  protected readonly gridModeOpen = signal(false);
  /** Rotating the view (drag, or dragging the view cube) pivots around the selected parts instead of the current view centre. */
  protected readonly pivotOnSelection = signal(readPivotOnSelection());
  private pivotGoal: THREE.Vector3 | null = null;
  private lastGrid: { min: THREE.Vector3; max: THREE.Vector3; zTop: number } | null = null;
  private panAnimation: { offset: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; start: number } | null = null;
  private readonly pickRaycaster = new THREE.Raycaster();
  private lastItemCount = 0;
  private snapAnimation: { from: THREE.Vector3; rotation: THREE.Quaternion; start: number; distance: number } | null = null;
  private readonly homeDirection = new THREE.Vector3(1, -1, 0.8).normalize();

  constructor() {
    afterNextRender(() => { this.init(); this.ready.set(true); });
    effect(() => {
      const d = this.data();
      // untracked: setModel/applyMode read the mode signal, which must not re-run (and reset) the camera
      if (this.ready() && d) untracked(() => this.setModel(d));
    });
    effect(() => {
      this.mode();
      if (this.ready()) this.applyMode();
    });
    effect(() => {
      const documentMode = this.documentMode();
      if (this.ready()) untracked(() => this.enterMode(documentMode));
    });
    effect(() => {
      this.grid3d();
      this.zGridMode(); // the 3D grid's levels follow the mode
      if (this.ready()) untracked(() => this.rebuildGrid());
    });
    // Another document was opened: fit the camera to it once its geometry has loaded.
    effect(() => { this.store.docId(); untracked(() => { this.needsDocumentFit = true; this.lastItemCount = 0; }); });
    // Tracks the store and the view mode (read inside reconcile) and redraws the document items.
    effect(() => {
      if (this.ready()) this.documentScene.reconcile(this.mode());
    });
  }

  private init() {
    const el = this.host().nativeElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b1d22);
    this.scene.add(this.model);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1, -2, 3);
    this.scene.add(dir);
    // STL / 3D-printing convention: Z is up. Classic isometric: look along (-1,-1,-1).
    this.camera.up.set(0, 0, 1);
    // Created first so its pointerdown handler can swallow clicks that land on the cube.
    this.viewCube = new ViewCube(this.renderer.domElement, d => this.snapTo(d), (dx, dy) => this.orbitBy(dx, dy), (clientX, clientY) => {
      const host = this.host().nativeElement.getBoundingClientRect();
      const menuWidth = 300; // keep the menu inside the view when the cube is at the right edge
      this.cubeMenu.set({ x: Math.min(clientX - host.left, host.width - menuWidth), y: clientY - host.top });
    }, () => this.startPivot());
    // Also before OrbitControls: a drag that starts on a document object must move it, not orbit.
    this.documentScene = new DocumentScene({
      scene: this.scene, camera: this.camera, canvas: this.renderer.domElement, host: (el.closest('.stage') as HTMLElement | null) ?? el, store: this.store,
      background: this.scene.background as THREE.Color,
      loadGeometry: path => this.loadGeometry(path),
      zGridMode: () => this.zGridMode(),
      viewCenter: () => ({ x: this.controls.target.x, y: this.controls.target.y }),
      rotationStep: () => this.rotationStep(),
      changed: () => this.onDocumentChanged(),
    });
    // ⌘-click centres the view on the clicked point. Registered before OrbitControls so it can swallow the click.
    this.renderer.domElement.addEventListener('pointerdown', this.onCentreClick);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Trackpad like Fusion 360: two-finger scroll pans, pinch zooms (towards the cursor). OrbitControls keeps rotate (drag).
    this.controls.enableZoom = false;
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.resize())); // rAF avoids the "ResizeObserver loop" warning
    this.ro.observe(el);
    this.resize();
    this.renderer.autoClear = false;
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.stepSnapAnimation();
      this.stepPanAnimation();
      this.stepPivot();
      this.documentScene.tick();
      this.controls.update();
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.viewCube.render(this.renderer, this.camera, this.controls.target);
    };
    loop();
  }

  /** Animate the camera to look at the model from `direction` (unit vector model -> camera). */
  private snapTo(direction: THREE.Vector3) {
    const dir = direction.clone();
    // Straight down/up the Z axis would make lookAt degenerate with Z-up; tilt a hair so +Y stays "up" on screen.
    if (Math.abs(dir.z) > 0.999) dir.y = -0.001 * Math.sign(dir.z);
    dir.normalize();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from = offset.clone().normalize();
    this.snapAnimation = { from, rotation: new THREE.Quaternion().setFromUnitVectors(from, dir), start: performance.now(), distance: offset.length() };
  }

  goHome() {
    if (this.documentMode()) this.fitDocument();
    this.snapTo(this.homeDirection);
  }

  private async loadGeometry(path: string) {
    const buffer = await firstValueFrom(this.library.loadStl(path));
    return new STLLoader().parse(buffer);
  }

  /** Adds a library STL to the document (see DocumentScene.addObject). */
  addObject(path: string) {
    return this.documentScene.addObject(path);
  }

  private enterMode(documentMode: boolean) {
    this.model.visible = !documentMode;
    this.documentScene.setActive(documentMode);
    this.gridKey = '';
    if (documentMode) {
      this.needsDocumentFit = true;
      this.onDocumentChanged();
    } else if (this.geometry) {
      const size = new THREE.Box3().setFromBufferAttribute(this.geometry.getAttribute('position') as THREE.BufferAttribute).getSize(new THREE.Vector3());
      this.buildGrid(new THREE.Vector3(0, 0, 0), size, size.z);
      // Back to the previewed model: re-centre on it, keeping the viewing direction.
      this.radius = this.geometry.boundingSphere?.radius ?? this.radius;
      const direction = this.camera.position.clone().sub(this.controls.target).normalize();
      this.controls.target.copy(size).multiplyScalar(0.5);
      this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(this.radius * 4));
      this.camera.zoom = 1;
      this.resize();
    }
  }

  /** Document grid follows the items; the camera fits once the first geometry has arrived. */
  private onDocumentChanged() {
    if (!this.documentMode() || !this.ready()) return;
    const bounds = this.documentScene.bounds();
    const count = this.store.doc().items.length;
    if (count > this.lastItemCount) this.needsDocumentFit = true; // a new object: make sure it is in view
    this.lastItemCount = count;
    this.info.set(count ? `${count} object${count === 1 ? '' : 's'}${bounds ? ` · ${(bounds.max.x - bounds.min.x).toFixed(0)} × ${(bounds.max.y - bounds.min.y).toFixed(0)} × ${(bounds.max.z - bounds.min.z).toFixed(0)} mm` : ''}` : 'Empty document');
    const key = bounds ? `${bounds.min.toArray()}|${bounds.max.toArray()}` : 'empty';
    if (key !== this.gridKey) {
      this.gridKey = key;
      const fallback = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12 * gridCellMm, 8 * gridCellMm, 0));
      const area = bounds ? bounds.clone().union(fallback) : fallback;
      this.buildGrid(area.min, area.max, bounds ? bounds.max.z : 0);
    }
    if (this.needsDocumentFit && this.documentScene.readyCount() === count && count > 0) {
      this.needsDocumentFit = false;
      this.fitDocument();
    }
  }

  /** Re-centres the camera on the document without changing the viewing direction. */
  private fitDocument() {
    const bounds = this.documentScene.bounds() ?? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12 * gridCellMm, 8 * gridCellMm, 40));
    const center = bounds.getCenter(new THREE.Vector3());
    this.radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 60);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const direction = offset.lengthSq() > 1e-6 ? offset.normalize() : this.homeDirection.clone(); // no view yet: start isometric
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(this.radius * 4));
    this.camera.zoom = 1;
    this.resize();
  }

  /**
   * Wheel events from a MacBook trackpad: two-finger scroll arrives as plain wheel events (pan), pinch as wheel with ctrlKey (zoom).
   * Alt/Option + wheel zooms too, for a mouse wheel.
   */
  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.snapAnimation = null;
    this.panAnimation = null;
    const lineHeight = e.deltaMode === 1 ? 16 : 1; // Firefox reports mouse wheels in lines
    const dx = e.deltaX * lineHeight, dy = e.deltaY * lineHeight;
    if (e.ctrlKey || e.altKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
    else this.panByPixels(dx, dy);
  };

  /**
   * Moves the view so the scene follows the fingers. With natural scrolling a swipe up gives dy > 0 and a swipe right gives dx < 0,
   * so the camera (and its target) move by right * dx - up * dy.
   */
  private panByPixels(dx: number, dy: number) {
    const canvas = this.renderer.domElement;
    const worldPerPixel = (this.camera.top - this.camera.bottom) / this.camera.zoom / canvas.clientHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const shift = right.multiplyScalar(dx * worldPerPixel).addScaledVector(up, -dy * worldPerPixel);
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.camera.updateMatrixWorld();
  }

  /** Zooms by `factor` keeping the point under the cursor fixed. */
  private zoomAt(clientX: number, clientY: number, factor: number) {
    this.camera.updateMatrixWorld(); // several wheel events can arrive between two renders
    const before = this.pointUnderCursor(clientX, clientY);
    this.camera.zoom = Math.min(Math.max(this.camera.zoom * factor, 0.05), 60);
    this.camera.updateProjectionMatrix();
    const shift = before.sub(this.pointUnderCursor(clientX, clientY));
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.camera.updateMatrixWorld();
  }

  /** World point under the cursor on the plane through the view centre, facing the camera. */
  private pointUnderCursor(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.pickRaycaster.setFromCamera(ndc, this.camera);
    const facing = this.camera.position.clone().sub(this.controls.target).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, this.controls.target);
    return this.pickRaycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.controls.target.clone();
  }

  /** ⌘-click: look at the clicked surface point (or, over empty space, the point on the plane through the current target). */
  private readonly onCentreClick = (e: PointerEvent) => {
    if (!e.metaKey) { // a plain left press that reached here starts a view rotation (nothing else claimed it)
      if (e.button === 0) this.startPivot();
      return;
    }
    if (e.button !== 0) return;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const inCube = e.clientX > rect.right - 150 - 12 && e.clientY < rect.top + 150 + 12; // ViewCube corner has its own clicks
    if (inCube) return;
    e.stopImmediatePropagation();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    this.pickRaycaster.setFromCamera(ndc, this.camera);
    const meshes: THREE.Object3D[] = this.model.visible ? [] : this.documentScene.pickableMeshes(); // muted parts don't catch clicks
    if (this.model.visible) this.model.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    const hit = this.pickRaycaster.intersectObjects(meshes, false)[0];
    let point: THREE.Vector3 | undefined = hit?.point;
    if (!point) {
      const facing = this.camera.position.clone().sub(this.controls.target).normalize();
      point = this.pickRaycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(facing, this.controls.target), new THREE.Vector3()) ?? undefined;
    }
    if (point) this.panTo(point);
  };

  /** A view rotation is starting: with a selection, make its centre the pivot (the view glides so it is centred). */
  private startPivot() {
    if (!this.pivotOnSelection() || !this.documentMode()) return;
    const centre = this.documentScene.selectionCenter();
    if (!centre) return;
    this.panAnimation = null;
    this.pivotGoal = centre;
  }

  /** Moves view centre and camera together towards the pivot, a bit each frame, without touching the camera's direction. */
  private stepPivot() {
    const goal = this.pivotGoal;
    if (!goal) return;
    const delta = goal.clone().sub(this.controls.target);
    if (delta.length() < 0.05) { this.camera.position.add(delta); this.controls.target.add(delta); this.pivotGoal = null; return; }
    delta.multiplyScalar(0.3);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
  }

  protected togglePivotOnSelection() {
    const on = !this.pivotOnSelection();
    this.pivotOnSelection.set(on);
    try { localStorage.setItem(pivotStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  /** Glide the view so `point` becomes the centre; direction and distance stay. */
  private panTo(point: THREE.Vector3) {
    this.snapAnimation = null;
    this.panAnimation = {
      offset: this.camera.position.clone().sub(this.controls.target),
      from: this.controls.target.clone(), to: point.clone(), start: performance.now(),
    };
  }

  /** Centres the view on a document item (double-click in the document list). */
  centerOnItem(id: string) {
    const center = this.documentScene.itemCenter(id);
    if (center) this.panTo(center);
  }

  private stepPanAnimation() {
    const a = this.panAnimation;
    if (!a) return;
    const t = Math.min((performance.now() - a.start) / 250, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    this.controls.target.lerpVectors(a.from, a.to, eased);
    this.camera.position.copy(this.controls.target).add(a.offset); // same direction and distance, new centre
    if (t >= 1) this.panAnimation = null;
  }

  private stepSnapAnimation() {
    const a = this.snapAnimation;
    if (!a) return;
    const t = Math.min((performance.now() - a.start) / 350, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const q = new THREE.Quaternion().slerp(a.rotation, eased);
    this.camera.position.copy(this.controls.target).add(a.from.clone().applyQuaternion(q).multiplyScalar(a.distance));
    if (t >= 1) this.snapAnimation = null;
  }

  /** Drag on the cube: azimuth around world Z, elevation clamped short of the poles. */
  private orbitBy(dx: number, dy: number) {
    this.snapAnimation = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const r = offset.length();
    const azimuth = Math.atan2(offset.y, offset.x) - dx * 0.01;
    const limit = Math.PI / 2 - 0.02;
    const elevation = Math.max(-limit, Math.min(limit, Math.asin(offset.z / r) + dy * 0.01));
    offset.set(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)).multiplyScalar(r);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  private resize() {
    const el = this.host().nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h, s = this.radius * 1.3;
    Object.assign(this.camera, { left: -s * aspect, right: s * aspect, top: s, bottom: -s });
    this.camera.updateProjectionMatrix();
  }

  private setModel(buf: ArrayBuffer) {
    this.baseGeometry?.dispose();
    this.baseGeometry = new STLLoader().parse(buf);
    this.objectRotation.identity();
    this.rotated.set({ x: 0, y: 0, z: 0 });
    this.rebuildGeometry(true);
  }

  /** Rotate the object (not the camera) around a world axis; it is re-seated on the ground afterwards. */
  rotateObject(axis: 'x' | 'y' | 'z', degrees: number) {
    if (this.documentMode()) { this.documentScene.rotateSelected(axis, degrees); return; }
    if (!this.baseGeometry) return;
    const worldAxis = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const step = new THREE.Quaternion().setFromAxisAngle(worldAxis, THREE.MathUtils.degToRad(degrees));
    this.objectRotation.premultiply(step).normalize();
    this.rotated.update(r => ({ ...r, [axis]: foldDegrees(r[axis] + degrees) }));
    this.rebuildGeometry(false);
  }

  resetObjectRotation() {
    if (this.documentMode() || !this.baseGeometry) return;
    this.objectRotation.identity();
    this.rotated.set({ x: 0, y: 0, z: 0 });
    this.rebuildGeometry(false);
  }

  /**
   * Applies the object rotation to the loaded STL and places its bounding-box min corner on the grid origin,
   * so the 20 mm grid lines line up with the model's cell edges.
   */
  private rebuildGeometry(isNewModel: boolean) {
    const g = this.baseGeometry!.clone();
    g.applyQuaternion(this.objectRotation);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    g.translate(-box.min.x, -box.min.y, -box.min.z);
    g.computeBoundingSphere();
    this.geometry?.dispose();
    this.edges?.dispose();
    this.geometry = g;
    this.edges = null;
    const size = box.getSize(new THREE.Vector3());
    this.info.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm · ${(g.attributes['position'].count / 3).toLocaleString()} triangles`);
    this.radius = g.boundingSphere!.radius;
    if (!this.documentMode()) this.buildGrid(new THREE.Vector3(0, 0, 0), size, size.z);

    // Keep the user's viewing direction; first model starts isometric. Rotating keeps the camera offset as is.
    const target = size.clone().multiplyScalar(0.5);
    const offset = this.hasView
      ? this.camera.position.clone().sub(this.controls.target)
      : this.homeDirection.clone().multiplyScalar(this.radius * 4);
    if (isNewModel && this.hasView) offset.setLength(this.radius * 4);
    this.hasView = true;
    if (isNewModel) this.camera.zoom = 1;
    this.camera.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.resize();
    this.applyMode();
  }

  /** Switches the 3D grid on or off (view cube menu) and remembers the choice. */
  protected currentGridModeTitle() {
    return zGridModes.find(m => m.id === this.zGridMode())?.title.split(':')[0] ?? '';
  }

  protected setZGridMode(mode: ZGridMode) {
    this.zGridMode.set(mode);
    try { localStorage.setItem(zGridModeStorageKey, mode); } catch { /* storage unavailable */ }
    this.gridModeOpen.set(false);
    this.cubeMenu.set(null);
  }

  protected toggleGrid3d() {
    const on = !this.grid3d();
    this.grid3d.set(on);
    try { localStorage.setItem(grid3dStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  private rebuildGrid() {
    if (this.lastGrid) this.buildGrid(this.lastGrid.min, this.lastGrid.max, this.lastGrid.zTop);
  }

  /**
   * Grid with 20 mm cells (the RASTERFASTER base grid) covering min..max plus a two-cell margin: the ground grid, or with the 3D grid
   * on a lattice that also has horizontal grids at every z level up to `zTop` and vertical lines through every node.
   */
  private buildGrid(min: THREE.Vector3, max: THREE.Vector3, zTop: number) {
    this.lastGrid = { min: min.clone(), max: max.clone(), zTop };
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const cell = gridCellMm;
    const margin = 2 * cell;
    // The grid is the work area: at most 100 x 100 cells, never beyond the limits parts are clamped to.
    const limit = workArea.max[0];
    const minX = Math.max(Math.floor(min.x / cell) * cell - margin, -limit), minY = Math.max(Math.floor(min.y / cell) * cell - margin, -limit);
    const maxX = Math.min(Math.ceil(max.x / cell) * cell + margin, limit), maxY = Math.min(Math.ceil(max.y / cell) * cell + margin, limit);
    const ground = -0.05; // a hair below the model's underside so the two never z-fight
    const levels = [ground];
    if (this.grid3d()) {
      const top = Math.min(Math.max(zTop + 12, 40), workArea.max[2]);
      const mode = this.zGridMode();
      for (let z = nextZLevel(0, 1, mode); levels.length < 400; z = nextZLevel(z, 1, mode)) { // z levels above the ground (0)
        levels.push(z);
        if (z >= top) break;
      }
    }
    const highest = levels[levels.length - 1];
    const points: number[] = [];
    for (const z of levels) {
      for (let x = minX; x <= maxX; x += cell) points.push(x, minY, z, x, maxY, z);
      for (let y = minY; y <= maxY; y += cell) points.push(minX, y, z, maxX, y, z);
    }
    if (levels.length > 1) {
      for (let x = minX; x <= maxX; x += cell) for (let y = minY; y <= maxY; y += cell) points.push(x, y, ground, x, y, highest);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.grid = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: gridColor, transparent: levels.length > 1, opacity: levels.length > 1 ? 0.7 : 1 }));
    this.scene.add(this.grid);
  }

  private clearModel() {
    clearParts(this.model);
    this.geometry?.dispose();
    this.edges?.dispose();
    this.baseGeometry?.dispose();
    if (this.grid) { this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
  }

  private applyMode() {
    if (!this.geometry) return;
    const geometry = this.geometry;
    clearParts(this.model);
    const parts = buildParts(geometry, this.mode(), {
      ...previewStyle, background: this.scene.background as THREE.Color, radius: this.radius,
      edges: () => (this.edges ??= new THREE.EdgesGeometry(geometry, 25)),
    });
    this.model.add(...parts);
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
    this.renderer?.domElement.removeEventListener('pointerdown', this.onCentreClick);
    this.renderer?.domElement.removeEventListener('wheel', this.onWheel);
    this.ro?.disconnect();
    this.clearModel();
    this.documentScene?.dispose();
    this.viewCube?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}
