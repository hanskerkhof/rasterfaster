import { Component, ElementRef, OnDestroy, computed, untracked, afterNextRender, effect, inject, input, output, signal, viewChild } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Subscription } from 'rxjs';
import { LibraryService } from './library.service';
import { ViewMode, buildParts, clearParts, previewStyle } from './model-render';
import { buildSilhouetteGeometry, creaseDegrees, silhouetteEdges } from './silhouette';

const modeStorageKey = 'rasterfaster.quickLookMode';
const sizeStorageKey = 'rasterfaster.quickLookSize';

const margin = 12; // free space kept between the card and the window edges
const minCardWidth = 320;
const minCardHeight = 260;

function readSize(): { w: number; h: number } | null {
  try {
    const stored = JSON.parse(localStorage.getItem(sizeStorageKey) ?? 'null');
    if (stored && Number.isFinite(stored.w) && Number.isFinite(stored.h)) return { w: Math.max(320, stored.w), h: Math.max(260, stored.h) };
  } catch { /* storage unavailable or damaged */ }
  return null;
}
const quickModes: { id: ViewMode; label: string; title: string }[] = [
  { id: 'solid', label: 'Solid', title: 'Solid' },
  { id: 'wireframe', label: 'Wireframe', title: 'Wireframe' },
  { id: 'hidden-removed', label: 'Hidden removed', title: 'Hidden lines removed' },
  { id: 'hidden-shown', label: 'Hidden dashed', title: 'Hidden lines dashed' },
];

function readMode(): ViewMode {
  try {
    const stored = localStorage.getItem(modeStorageKey) as ViewMode | null;
    if (stored && quickModes.some(m => m.id === stored)) return stored;
  } catch { /* storage unavailable */ }
  return 'hidden-removed';
}

/** Floating Finder-style preview of one library STL: isometric, with a view-mode switch (default hidden lines removed). Orbit by dragging; drag the bottom-right corner to resize. */
@Component({
  selector: 'app-quick-look',
  template: `
    <div #card class="card" [style.left.px]="leftPx()" [style.top.px]="top" [style.width.px]="size()?.w" [style.height.px]="size()?.h"
         [style.max-width.px]="availWidth()" [style.max-height.px]="availHeight()" [style.min-width.px]="minWidth()" [style.min-height.px]="minHeight()" role="dialog" aria-label="Quick look" (mousedown)="onMouseDown($event)">
      <header>
        <span class="title" [title]="path()">{{ name() }}</span>
        <span class="info">{{ info() }}</span>
        <button type="button" aria-label="Close preview" (click)="closed.emit()">✕</button>
      </header>
      <div class="modes" role="group" aria-label="View mode">
        @for (m of quickModes; track m.id) {
          <button type="button" [class.on]="mode() === m.id" [title]="m.title" (click)="setMode(m.id)">{{ m.label }}</button>
        }
      </div>
      <div #host class="host"></div>
      @if (state()) { <div class="state">{{ state() }}</div> }
      <footer>Space or Esc to close · ↑ ↓ browse · ⌘↓ add to document (closes this) · drag to orbit · drag the corner to resize</footer>
    </div>
  `,
  styles: `
    .card { box-sizing: border-box; position: fixed; z-index: 20; width: min(560px, calc(100vw - 460px)); height: 440px; resize: both; display: flex; flex-direction: column;
            background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; box-shadow: 0 14px 44px rgba(0,0,0,.55); overflow: hidden; font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #000; }
    .title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info { opacity: .55; white-space: nowrap; font-variant-numeric: tabular-nums; }
    button { background: transparent; border: 0; color: inherit; opacity: .6; cursor: pointer; font: inherit; }
    button:hover { opacity: 1; }
    .modes { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #000; }
    .modes button { padding: 3px 9px; background: #31353f; opacity: 1; border: 1px solid #000; border-radius: 4px; font-size: 11px; }
    .modes button.on { background: #2f6fed; color: #fff; }
    .modes button:hover:not(.on) { background: #3b404c; }
    .host { position: relative; flex: 1; min-height: 0; background: #1b1d22; }
    .state { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: .6; font-style: italic; }
    footer { padding: 5px 10px; opacity: .45; font-size: 11px; border-top: 1px solid #000; }
  `,
})
export class QuickLook implements OnDestroy {
  private readonly library = inject(LibraryService);
  readonly path = input.required<string>();
  /** Viewport x of the card's left edge (just right of the list). */
  readonly left = input(392);
  readonly closed = output<void>();
  /** Mouse went down inside the card (e.g. to orbit): the list should take keyboard focus back so shortcuts keep working. */
  readonly interacted = output<void>();

  /** The window size: the card never grows beyond it, whatever size was remembered. */
  private readonly viewport = signal({ w: innerWidth, h: innerHeight });
  private readonly onWindowResize = () => this.viewport.set({ w: innerWidth, h: innerHeight });
  protected readonly top = 84;
  protected readonly leftPx = computed(() => Math.max(margin, Math.min(this.left(), this.viewport().w - margin - minCardWidth)));
  protected readonly availWidth = computed(() => Math.max(0, this.viewport().w - this.leftPx() - margin));
  protected readonly availHeight = computed(() => Math.max(0, this.viewport().h - this.top - margin));
  protected readonly minWidth = computed(() => Math.min(minCardWidth, this.availWidth()));
  protected readonly minHeight = computed(() => Math.min(minCardHeight, this.availHeight()));
  protected readonly quickModes = quickModes;
  /** The size the user dragged the card to, remembered across previews and reloads (null: the default size). */
  protected readonly size = signal(readSize());
  protected readonly mode = signal<ViewMode>(readMode());
  protected readonly state = signal('Loading…');
  protected readonly info = signal('');
  protected readonly name = signal('');
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly card = viewChild.required<ElementRef<HTMLDivElement>>('card');
  private resizing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly stopResizing = () => { this.resizing = false; };
  private readonly ready = signal(false);
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private controls!: OrbitControls;
  private readonly model = new THREE.Group();
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  private geometry: THREE.BufferGeometry | null = null;
  private edges: THREE.EdgesGeometry | null = null;
  private silhouette: THREE.BufferGeometry | null = null;
  private radius = 1;
  private frame = 0;
  private ro?: ResizeObserver;
  private loadSub?: Subscription;

  constructor() {
    afterNextRender(() => { this.init(); this.ready.set(true); });
    effect(() => {
      const path = this.path();
      if (this.ready()) this.load(path);
    });
    effect(() => {
      silhouetteEdges(); // the setting in the view cube menu changed: redraw the loaded file
      if (this.ready()) untracked(() => this.rebuild());
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
    // The solid view needs light (without it the model is black): soft ambient plus a key light that follows the camera, so the faces
    // you look at are always lit whichever way you orbit.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    this.scene.add(this.keyLight);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => { this.resize(); this.rememberSize(); }));
    this.ro.observe(el);
    addEventListener('mouseup', this.stopResizing);
    addEventListener('resize', this.onWindowResize);
    this.resize();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.keyLight.position.copy(this.camera.position).add(new THREE.Vector3(0.4, -0.3, 0.6).multiplyScalar(this.radius)); // up and to the side of the viewer
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private resize() {
    const el = this.host().nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h, s = this.radius * 1.25;
    Object.assign(this.camera, { left: -s * aspect, right: s * aspect, top: s, bottom: -s });
    this.camera.updateProjectionMatrix();
  }

  private load(path: string) {
    this.name.set(path.split('/').pop()!.replace(/\.stl$/i, ''));
    this.state.set('Loading…');
    this.loadSub?.unsubscribe(); // arrowing quickly: drop the download of the file we left
    this.loadSub = this.library.loadStl(path).subscribe({
      next: buffer => this.show(buffer),
      error: () => this.state.set('Could not load this file'),
    });
  }

  private show(buffer: ArrayBuffer) {
    clearParts(this.model);
    this.geometry?.dispose();
    this.edges?.dispose();
    this.silhouette?.dispose();
    const geometry = new THREE.BufferGeometry().copy(new STLLoader().parse(buffer));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.edges = null;
    this.silhouette = null;
    const size = box.getSize(new THREE.Vector3());
    this.radius = geometry.boundingSphere!.radius;
    this.info.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`);
    this.rebuild();
    // Isometric, like the main view; the user's orbit is reset per file so every preview starts comparable.
    this.camera.zoom = 1;
    this.camera.position.set(1, -1, 0.8).normalize().multiplyScalar(this.radius * 4);
    this.controls.target.set(0, 0, 0);
    this.resize();
    this.state.set('');
  }

  protected onMouseDown(event: MouseEvent) {
    const card = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (event.clientX > card.right - 20 && event.clientY > card.bottom - 20) { this.resizing = true; return; } // the resize corner: let the browser resize
    event.preventDefault(); // keep keyboard focus on the list so its shortcuts keep working
    this.interacted.emit();
  }

  /** While the user drags the corner, remembers the card's size (when the drag has settled). */
  private rememberSize() {
    if (!this.resizing) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const card = this.card().nativeElement;
      const size = { w: Math.round(card.offsetWidth), h: Math.round(card.offsetHeight) };
      try { localStorage.setItem(sizeStorageKey, JSON.stringify(size)); } catch { /* storage unavailable */ }
    }, 250);
  }

  protected setMode(mode: ViewMode) {
    this.mode.set(mode);
    try { localStorage.setItem(modeStorageKey, mode); } catch { /* storage unavailable */ }
    this.rebuild();
  }

  /** (Re)creates the meshes of the loaded file in the chosen view mode; the camera stays where the user put it. */
  private rebuild() {
    const geometry = this.geometry;
    if (!geometry) return;
    clearParts(this.model);
    this.model.add(...buildParts(geometry, this.mode(), {
      ...previewStyle, background: this.scene.background as THREE.Color, radius: this.radius,
      edges: () => (this.edges ??= new THREE.EdgesGeometry(geometry, creaseDegrees)),
      silhouette: () => (this.silhouette ??= buildSilhouetteGeometry(geometry)),
    }));
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.saveTimer);
    removeEventListener('mouseup', this.stopResizing);
    removeEventListener('resize', this.onWindowResize);
    this.loadSub?.unsubscribe();
    this.ro?.disconnect();
    clearParts(this.model);
    this.geometry?.dispose();
    this.edges?.dispose();
    this.silhouette?.dispose();
    // dispose() frees GPU resources but not the WebGL context itself. Browsers allow ~16 live contexts and then drop the oldest
    // one, which would be the main 3D view (it turned white after many previews), so give the context back explicitly.
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
  }
}
