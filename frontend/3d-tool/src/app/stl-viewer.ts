import { Component, ElementRef, OnDestroy, effect, inject, input, signal, untracked, viewChild, afterNextRender } from '@angular/core';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { firstValueFrom } from 'rxjs';
import { DocumentScene } from './document-scene';
import { DocumentStore, workArea } from './document.store';
import { LibraryService } from './library.service';
import { ViewMode, buildParts, clearParts, previewStyle } from './model-render';
import { setSilhouetteEdges, silhouetteEdges } from './silhouette';
import { ViewCube } from './view-cube';
import { ZGridMode, defaultZGridMode, nextZLevel, zGridModes } from './z-levels';

const gridCellMm = 20; // RASTERFASTER base grid pitch
const gridColor = 0x4a4e58; // dark gray, visible on the #1b1d22 background
const grid3dStorageKey = 'rasterfaster.grid3d';
const pivotStorageKey = 'rasterfaster.pivotOnSelection';
const zGridModeStorageKey = 'rasterfaster.zGridMode';
const cameraModeStorageKey = 'rasterfaster.cameraMode';
const perspectiveFovDegrees = 35;
/** Home / fit leaves this much room around what it frames (1 = touching the edge of the view). */
const fitMargin = 1.35;

/** Fusion-style camera choice. Ortho faces = perspective, but orthographic while looking straight at a face of the cube. */
export type CameraMode = 'orthographic' | 'perspective' | 'perspective-ortho-faces';
const cameraModes: { id: CameraMode; title: string; detail: string }[] = [
  { id: 'orthographic', title: 'Orthographic', detail: 'parallel lines, no foreshortening (default)' },
  { id: 'perspective', title: 'Perspective', detail: 'things further away look smaller' },
  { id: 'perspective-ortho-faces', title: 'Perspective with ortho faces', detail: 'orthographic when looking straight at a face' },
];

function readCameraMode(): CameraMode {
  try {
    const stored = localStorage.getItem(cameraModeStorageKey);
    if (cameraModes.some(m => m.id === stored)) return stored as CameraMode;
  } catch { /* storage unavailable */ }
  return 'orthographic';
}

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

/** One full loop of the fly-around path. */
const flightLoopSeconds = 280;
const showPathStorageKey = 'rasterfaster.showCameraPath';
function readShowPath() {
  try { return localStorage.getItem(showPathStorageKey) === 'true'; } catch { return false; }
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
        <div class="submenu-host" (mouseenter)="cameraMenuOpen.set(true); gridModeOpen.set(false)" (mouseleave)="cameraMenuOpen.set(false)">
          <button type="button" role="menuitem" aria-haspopup="menu" [attr.aria-expanded]="cameraMenuOpen()" (click)="cameraMenuOpen.set(!cameraMenuOpen())">
            <span class="tick"></span>Camera<span class="hint">{{ currentCameraTitle() }} ◂</span>
          </button>
          @if (cameraMenuOpen()) {
            <div class="flyout" role="menu">
              @for (m of cameraModes; track m.id) {
                <button type="button" role="menuitemradio" [attr.aria-checked]="cameraMode() === m.id" (click)="setCameraMode(m.id)">
                  <span class="tick">{{ cameraMode() === m.id ? '✓' : '' }}</span>
                  <span class="two-line"><span>{{ m.title }}</span><small>{{ m.detail }}</small></span>
                </button>
              }
            </div>
          }
        </div>
        <div class="submenu-host" (mouseenter)="gridModeOpen.set(true); cameraMenuOpen.set(false)" (mouseleave)="gridModeOpen.set(false)">
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
        @if (documentMode()) {
          <button type="button" role="menuitem" (click)="toggleFlight(); cubeMenu.set(null)">
            <span class="tick">{{ flying() ? '✓' : '' }}</span>Fly-around<span class="hint">{{ flying() ? 'on' : 'off' }}</span>
          </button>
        }
        @if (documentMode()) {
          <button type="button" role="menuitem" (click)="toggleShowPath()">
            <span class="tick">{{ showPath() ? '✓' : '' }}</span>Show camera path<span class="hint">{{ showPath() ? 'on' : 'off' }}</span>
          </button>
        }
        <button type="button" role="menuitem" title="Draw the contour of curved walls (cylinders, cones) in the hidden-line views" (click)="toggleSilhouette()">
          <span class="tick">{{ silhouette() ? '✓' : '' }}</span>Silhouette edges<span class="hint">{{ silhouette() ? 'on' : 'off' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="togglePivotOnSelection()">
          <span class="tick">{{ pivotOnSelection() ? '✓' : '' }}</span>Rotate around selection<span class="hint">{{ pivotOnSelection() ? 'on' : 'off' }}</span>
        </button>
      </div>
    }
    @if (documentMode()) {
      <button class="home fly" type="button" [class.on]="flying()" [title]="flying() ? 'Stop the fly-around' : 'Fly-around: slowly circle the assembly'" aria-label="Fly-around" [attr.aria-pressed]="flying()" (click)="toggleFlight()">
        @if (flying()) {
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        } @else {
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
        }
      </button>
    }
    @if (documentMode() && flying()) {
      <button class="home fly zoom-reset" type="button" title="Reset the zoom of the fly-around" aria-label="Reset fly-around zoom" (click)="resetFlightZoom()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M8.5 11h5"/></svg>
      </button>
    }
    <button class="home" type="button" title="Home: isometric view, fit to the model" aria-label="Home view" (click)="goHome()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10"/></svg>
    </button>`,
  styles: `
    :host, .host { display: block; width: 100%; height: 100%; } .host { position: relative; overflow: hidden; }
    :host { position: relative; }
    /* Fusion-style: a small house icon in the top-left corner of the view cube's area (the cube is 150 px wide, 12 px from the edges) */
    .home { position: absolute; top: 12px; right: 144px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; padding: 0;
            background: transparent; color: #d5d9e2; border: 1px solid transparent; border-radius: 6px; cursor: pointer; opacity: .8; }
    .home.fly { right: 110px; } .home.fly.zoom-reset { right: 76px; } .home.fly.on { background: #2f6fed; color: #fff; opacity: 1; }
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
  private readonly orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(perspectiveFovDegrees, 1, 1, 100000);
  /** The camera in use; everything (controls, picking, the view cube, pan and zoom) goes through it. */
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = this.orthoCamera;
  private projection: 'ortho' | 'persp' = 'ortho';
  protected readonly cameraMode = signal<CameraMode>(readCameraMode());
  protected readonly cameraModes = cameraModes;
  protected readonly cameraMenuOpen = signal(false);
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
  protected readonly silhouette = silhouetteEdges;
  protected readonly cubeMenu = signal<{ x: number; y: number } | null>(null);
  /** Height grid: fine (2 mm), baseplate (2 mm then 4 mm) or coarse (4 mm). Chosen in the view cube menu's "Grid mode" fly-out. */
  protected readonly zGridMode = signal(readZGridMode());
  protected readonly zGridModes = zGridModes;
  protected readonly gridModeOpen = signal(false);
  /** Rotating the view (drag, or dragging the view cube) pivots around the selected parts instead of the current view centre. */
  protected readonly pivotOnSelection = signal(readPivotOnSelection());
  private pivotGoal: THREE.Vector3 | null = null;
  /** Fly-around: the camera slowly circles the assembly on a wandering path (azimuth sweep, rising and falling elevation, breathing zoom, drifting centre). */
  protected readonly flying = signal(false);
  protected readonly showPath = signal(readShowPath());
  private pathLine: THREE.Line | null = null;
  /** Zoom the user added on top of the flight's own zoom (wheel / pinch keep working while flying); the reset button sets it back to 1. */
  private userZoom = 1;
  private flightZoomSet = 0;
  private cameraBody: THREE.LineSegments | null = null;
  private flightTime = 0;
  private flightLast = 0;
  private flightAzimuth0 = 0;
  private readonly stopFlight = () => this.flying.set(false);
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
    this.orthoCamera.up.set(0, 0, 1);
    this.perspectiveCamera.up.set(0, 0, 1);
    // Created first so its pointerdown handler can swallow clicks that land on the cube.
    this.viewCube = new ViewCube(this.renderer.domElement, d => this.snapTo(d), (dx, dy) => this.orbitBy(dx, dy), (clientX, clientY) => {
      const host = this.host().nativeElement.getBoundingClientRect();
      const menuWidth = 300; // keep the menu inside the view when the cube is at the right edge
      this.cubeMenu.set({ x: Math.min(clientX - host.left, host.width - menuWidth), y: clientY - host.top });
    }, () => this.startPivot());
    // Also before OrbitControls: a drag that starts on a document object must move it, not orbit.
    const viewer = this; // the scene reads the *current* camera (it changes with the camera mode)
    this.documentScene = new DocumentScene({
      scene: this.scene, get camera() { return viewer.camera; }, canvas: this.renderer.domElement, host: (el.closest('.stage') as HTMLElement | null) ?? el, store: this.store,
      background: this.scene.background as THREE.Color,
      loadGeometry: path => this.loadGeometry(path),
      zGridMode: () => this.zGridMode(),
      viewCenter: () => ({ x: this.controls.target.x, y: this.controls.target.y }),
      rotationStep: () => this.rotationStep(),
      changed: () => this.onDocumentChanged(),
    });
    // ⌘-click centres the view on the clicked point. Registered before OrbitControls so it can swallow the click.
    this.renderer.domElement.addEventListener('pointerdown', this.onCentreClick);
    this.renderer.domElement.addEventListener('pointerdown', this.stopFlight); // grabbing the view takes over from the fly-around
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.applyCameraMode(); // start in the saved mode (controls exist now)
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
      this.stepFlight();
      this.updatePathLine();
      this.updateAutoProjection();
      this.documentScene.tick();
      this.controls.update();
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.viewCube.render(this.renderer, this.camera, this.controls.target);
    };
    loop();
  }

  /**
   * The camera of this view for the Blender export: `dx,dy,dz;tx,ty,tz;height;projection[;fov]` (viewing direction from the centre to the camera,
   * view centre in mm, visible height at the centre in mm, `persp` or `ortho`). Null outside the document view.
   */
  readonly viewParam = (): string | null => {
    if (!this.documentMode()) return null;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const target = this.controls.target;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // A zoomed-in perspective view has a narrower field of view than the camera's own: send the effective one so the picture looks the same.
    const fov = this.camera instanceof THREE.PerspectiveCamera ? `;${round((2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / this.camera.zoom)) * (180 / Math.PI))}` : '';
    return `${[direction.x, direction.y, direction.z].map(round)};${[target.x, target.y, target.z].map(round)};${round(this.viewHeight())};${this.projection}${fov}`;
  };

  protected toggleFlight() {
    if (this.flying()) { this.flying.set(false); return; }
    if (!this.documentMode() || !this.documentScene.bounds()) return;
    this.snapAnimation = null; this.panAnimation = null; this.pivotGoal = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.flightAzimuth0 = Math.atan2(offset.y, offset.x);
    this.flightTime = 0;
    this.userZoom = 1;
    this.flightZoomSet = this.camera.zoom;
    this.flightLast = performance.now();
    this.flying.set(true);
  }

  /** The fly-around path: where the camera wants to be `t` seconds into the flight (viewing direction, view centre, zoom relative to the fit). */
  private flightPose(t: number, azimuth0: number, bounds: THREE.Box3) {
    const size = bounds.getSize(new THREE.Vector3());
    // Every frequency is a whole multiple of w (one loop = flightLoopSeconds), so the path closes perfectly: 4 turns, then it repeats.
    const w = (2 * Math.PI) / flightLoopSeconds;
    const azimuth = azimuth0 + t * 4 * w; // one turn per 70 s
    const elevation = THREE.MathUtils.degToRad(38 + 26 * Math.sin(t * 6 * w + 0.8) + 8 * Math.sin(t * 14 * w));
    const direction = new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation));
    const centre = bounds.getCenter(new THREE.Vector3()).add(new THREE.Vector3(
      size.x * 0.16 * Math.sin(t * 8 * w), size.y * 0.16 * Math.cos(t * 5 * w), size.z * 0.2 * Math.sin(t * 10 * w)));
    return { direction, centre, zoomFactor: 1 + 0.45 * (0.5 + 0.5 * Math.sin(t * 9 * w - 1)) };
  }

  protected resetFlightZoom() {
    this.userZoom = 1;
  }

  protected toggleShowPath() {
    const on = !this.showPath();
    this.showPath.set(on);
    try { localStorage.setItem(showPathStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.cubeMenu.set(null);
  }

  /** Draws the camera path as a line (the orbit's shape, not the camera's real distance): the whole closed loop (280 s) starting from the current moment while flying, otherwise a preview from the current view direction. */
  private updatePathLine() {
    const bounds = this.documentMode() ? this.documentScene.bounds() : null;
    if (!this.showPath() || !bounds) {
      if (this.pathLine) { this.scene.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine = null; }
      if (this.cameraBody) { this.scene.remove(this.cameraBody); this.cameraBody.geometry.dispose(); this.cameraBody = null; }
      return;
    }
    this.radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 60);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const azimuth0 = this.flying() ? this.flightAzimuth0 : Math.atan2(offset.y, offset.x);
    const from = this.flying() ? this.flightTime : 0;
    const distance = this.radius * 1.25; // drawn as an orbit around the assembly (the real camera sits much further out, which would be off screen)
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= flightLoopSeconds * 2; i++) { // every 0.5 s; the last point equals the first, so the line is closed
      const pose = this.flightPose(from + i * 0.5, azimuth0, bounds);
      points.push(pose.centre.addScaledVector(pose.direction, distance));
    }
    if (!this.pathLine) {
      this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 }));
      this.pathLine.renderOrder = 10;
      this.pathLine.frustumCulled = false;
      this.scene.add(this.pathLine);
    }
    this.pathLine.geometry.setFromPoints(points);
    this.updateCameraBody(this.flightPose(from, azimuth0, bounds), distance);
  }

  /** A Blender-style camera outline (pyramid, frame and "up" triangle) at the current point of the path, looking at the view centre. */
  private updateCameraBody(pose: { direction: THREE.Vector3; centre: THREE.Vector3 }, distance: number) {
    if (!this.cameraBody) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(22 * 3), 3));
      this.cameraBody = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false }));
      this.cameraBody.renderOrder = 11;
      this.cameraBody.frustumCulled = false;
      this.scene.add(this.cameraBody);
    }
    const apex = pose.centre.clone().addScaledVector(pose.direction, distance);
    const forward = pose.direction.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const el = this.host().nativeElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const depth = this.radius * 0.16, hh = depth * 0.45, hw = hh * aspect;
    const corner = (sx: number, sy: number) => apex.clone().addScaledVector(forward, depth).addScaledVector(right, sx * hw).addScaledVector(up, sy * hh);
    const bl = corner(-1, -1), br = corner(1, -1), tr = corner(1, 1), tl = corner(-1, 1);
    const peak = apex.clone().addScaledVector(forward, depth).addScaledVector(up, hh * 1.6);
    const v = [apex, bl, apex, br, apex, tr, apex, tl, bl, br, br, tr, tr, tl, tl, bl, tl, peak, peak, tr];
    const attr = this.cameraBody.geometry.getAttribute('position') as THREE.BufferAttribute;
    v.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
    this.cameraBody.geometry.setDrawRange(0, v.length);
  }

  /**
   * One frame of the fly-around. The wanted view is a sum of slow sines with unrelated periods, so the path keeps changing and
   * covers the assembly from the sides, the top and a low angle; the real camera eases towards it (which also blends in and out smoothly).
   * The zoom is relative to the fit for the current direction, so the whole assembly stays in view.
   */
  private stepFlight() {
    if (!this.flying()) return;
    const bounds = this.documentScene.bounds();
    if (!this.documentMode() || !bounds) { this.flying.set(false); return; }
    const now = performance.now();
    const dt = Math.min((now - this.flightLast) / 1000, 0.1);
    this.flightLast = now;
    this.flightTime += dt;
    const t = this.flightTime;
    const size = bounds.getSize(new THREE.Vector3());
    this.radius = Math.max(size.length() / 2, 60);

    const { direction, centre, zoomFactor } = this.flightPose(t, this.flightAzimuth0, bounds);
    const zoom = this.fitZoom(size, direction) * zoomFactor;

    const k = 1 - Math.exp(-dt * 1.5);
    const current = this.camera.position.clone().sub(this.controls.target);
    const heading = current.lengthSq() > 1e-6 ? current.normalize() : direction.clone();
    heading.lerp(direction, k).normalize();
    this.controls.target.lerp(centre, k);
    if (this.flightZoomSet > 0 && Math.abs(this.camera.zoom / this.flightZoomSet - 1) > 1e-6) this.userZoom *= this.camera.zoom / this.flightZoomSet; // changed by the wheel
    this.camera.zoom += (zoom * this.userZoom - this.camera.zoom) * k;
    this.flightZoomSet = this.camera.zoom;
    this.camera.position.copy(this.controls.target).addScaledVector(heading, this.fitDistance());
    this.camera.updateProjectionMatrix();
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

  /** Adds several library STLs next to each other as one undo step. */
  addObjects(paths: string[]) {
    return this.documentScene.addObjects(paths);
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
      const zoom = this.fitZoom(size, direction);
      this.controls.target.copy(size).multiplyScalar(0.5);
      this.camera.position.copy(this.controls.target).add(direction.multiplyScalar(this.fitDistance()));
      this.camera.zoom = zoom;
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
    const size = bounds.getSize(new THREE.Vector3());
    this.radius = Math.max(size.length() / 2, 60);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const direction = offset.lengthSq() > 1e-6 ? offset.normalize() : this.homeDirection.clone(); // no view yet: start isometric
    const zoom = this.fitZoom(size, direction);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(this.fitDistance()));
    this.camera.zoom = zoom;
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
    const worldPerPixel = this.viewHeight() / canvas.clientHeight;
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
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
      this.camera.near = Math.max(1, this.radius * 0.05);
      this.camera.far = Math.max(10000, this.radius * 200);
    } else {
      Object.assign(this.camera, { left: -s * aspect, right: s * aspect, top: s, bottom: -s });
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * The zoom at which a box (`size` mm across, centred on the view centre) fills the view along `direction` with `fitMargin` to spare.
   * It uses the box's real extent as seen from that direction (not its bounding sphere) and the window's aspect ratio.
   */
  private fitZoom(size: THREE.Vector3, direction: THREE.Vector3) {
    const forward = direction.clone().negate(); // from the camera towards the centre
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 0, 1));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // looking straight down or up
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    let halfWidth = 0, halfHeight = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const corner = new THREE.Vector3((sx * size.x) / 2, (sy * size.y) / 2, (sz * size.z) / 2);
      halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
    }
    const el = this.host().nativeElement;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const needed = Math.max(halfHeight, halfWidth / aspect, 1) * fitMargin;
    return Math.min(Math.max((this.radius * 1.3) / needed, 0.05), 60); // the frustum at zoom 1 is radius * 1.3 high
  }

  /** Height of the world that is visible at the view centre, in mm (the same measure for both cameras). */
  private viewHeight() {
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const distance = this.camera.position.distanceTo(this.controls.target);
      return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.camera.zoom;
    }
    return (this.camera.top - this.camera.bottom) / this.camera.zoom;
  }

  /** How far the camera sits from the view centre so that the model fills the view the same way in both projections. */
  private fitDistance() {
    return this.projection === 'persp'
      ? (this.radius * 1.3) / Math.tan(THREE.MathUtils.degToRad(perspectiveFovDegrees / 2))
      : this.radius * 4;
  }

  /**
   * Switches between the orthographic and the perspective camera. The apparent size at the view centre and the viewing direction
   * stay the same, so the model does not jump when the projection changes.
   */
  private setProjection(kind: 'ortho' | 'persp') {
    if (kind === this.projection) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const direction = offset.lengthSq() > 1e-6 ? offset.clone().normalize() : this.homeDirection.clone();
    const halfHeight = this.viewHeight() / 2;
    const next = kind === 'persp' ? this.perspectiveCamera : this.orthoCamera;
    next.up.copy(this.camera.up);
    if (kind === 'persp') {
      next.zoom = 1;
      next.position.copy(target).add(direction.multiplyScalar(halfHeight / Math.tan(THREE.MathUtils.degToRad(perspectiveFovDegrees / 2))));
    } else {
      next.zoom = (this.radius * 1.3) / halfHeight; // visible half height = frustum half height / zoom
      next.position.copy(target).add(direction.multiplyScalar(Math.max(offset.length(), 1)));
    }
    this.camera = next;
    this.projection = kind;
    this.controls.object = next;
    next.lookAt(target);
    next.updateMatrixWorld();
    this.resize();
  }

  /** Applies the chosen camera mode (explicit projection, or the automatic one for "perspective with ortho faces"). */
  private applyCameraMode() {
    const mode = this.cameraMode();
    if (mode === 'orthographic') this.setProjection('ortho');
    else if (mode === 'perspective') this.setProjection('persp');
    else this.updateAutoProjection();
  }

  /** "Perspective with ortho faces": orthographic while the view looks straight along an axis (a cube face), perspective otherwise. */
  private updateAutoProjection() {
    if (this.cameraMode() !== 'perspective-ortho-faces') return;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const alongAxis = Math.max(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)) > 0.99995;
    this.setProjection(alongAxis ? 'ortho' : 'persp');
  }

  protected setCameraMode(mode: CameraMode) {
    this.cameraMode.set(mode);
    try { localStorage.setItem(cameraModeStorageKey, mode); } catch { /* storage unavailable */ }
    this.applyCameraMode();
    this.cameraMenuOpen.set(false);
    this.cubeMenu.set(null);
  }

  protected currentCameraTitle() {
    return cameraModes.find(m => m.id === this.cameraMode())?.title ?? '';
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
      : this.homeDirection.clone().multiplyScalar(this.fitDistance());
    if (isNewModel && this.hasView) offset.setLength(this.fitDistance());
    this.hasView = true;
    if (isNewModel) this.camera.zoom = this.fitZoom(size, offset.clone().normalize());
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

  protected toggleSilhouette() {
    setSilhouetteEdges(!silhouetteEdges());
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
    this.renderer?.domElement.removeEventListener('pointerdown', this.stopFlight);
    this.renderer?.domElement.removeEventListener('wheel', this.onWheel);
    this.ro?.disconnect();
    this.clearModel();
    this.documentScene?.dispose();
    this.viewCube?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}
