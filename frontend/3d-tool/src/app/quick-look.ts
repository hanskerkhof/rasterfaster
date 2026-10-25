import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, output, signal, viewChild } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Subscription } from 'rxjs';
import { LibraryService } from './library.service';
import { buildParts, clearParts, previewStyle } from './model-render';

/** Floating Finder-style preview of one library STL: isometric, hidden lines removed. Orbit by dragging. */
@Component({
  selector: 'app-quick-look',
  template: `
    <div class="card" [style.left.px]="left()" role="dialog" aria-label="Quick look" (mousedown)="$event.preventDefault(); interacted.emit()">
      <header>
        <span class="title" [title]="path()">{{ name() }}</span>
        <span class="info">{{ info() }}</span>
        <button type="button" aria-label="Close preview" (click)="closed.emit()">✕</button>
      </header>
      <div #host class="host"></div>
      @if (state()) { <div class="state">{{ state() }}</div> }
      <footer [class.added]="added()">{{ added() ? '✓ Added to document' : 'Space or Esc to close · ↑ ↓ browse · ⌘↓ add to document · drag to orbit' }}</footer>
    </div>
  `,
  styles: `
    .card { position: fixed; top: 84px; z-index: 20; width: min(560px, calc(100vw - 460px)); min-width: 320px; height: 440px; display: flex; flex-direction: column;
            background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; box-shadow: 0 14px 44px rgba(0,0,0,.55); overflow: hidden; font-size: 12px; }
    header { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #000; }
    .title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .info { opacity: .55; white-space: nowrap; font-variant-numeric: tabular-nums; }
    button { background: transparent; border: 0; color: inherit; opacity: .6; cursor: pointer; font: inherit; }
    button:hover { opacity: 1; }
    .host { position: relative; flex: 1; min-height: 0; background: #1b1d22; }
    .state { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: .6; font-style: italic; }
    footer { padding: 5px 10px; opacity: .45; font-size: 11px; border-top: 1px solid #000; }
    footer.added { opacity: 1; color: #7fd18b; font-weight: 600; }
  `,
})
export class QuickLook implements OnDestroy {
  private readonly library = inject(LibraryService);
  readonly path = input.required<string>();
  /** Viewport x of the card's left edge (just right of the list). */
  readonly left = input(392);
  /** Briefly true after ⌘↓ added the previewed file to the document. */
  readonly added = input(false);
  readonly closed = output<void>();
  /** Mouse went down inside the card (e.g. to orbit): the list should take keyboard focus back so shortcuts keep working. */
  readonly interacted = output<void>();

  protected readonly state = signal('Loading…');
  protected readonly info = signal('');
  protected readonly name = signal('');
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly ready = signal(false);
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
  private controls!: OrbitControls;
  private readonly model = new THREE.Group();
  private geometry: THREE.BufferGeometry | null = null;
  private edges: THREE.EdgesGeometry | null = null;
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
  }

  private init() {
    const el = this.host().nativeElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1b1d22);
    this.scene.add(this.model);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.resize()));
    this.ro.observe(el);
    this.resize();
    const loop = () => { this.frame = requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
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
    const geometry = new THREE.BufferGeometry().copy(new STLLoader().parse(buffer));
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.edges = null;
    const size = box.getSize(new THREE.Vector3());
    this.radius = geometry.boundingSphere!.radius;
    this.info.set(`${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`);
    this.model.add(...buildParts(geometry, 'hidden-removed', {
      ...previewStyle, background: this.scene.background as THREE.Color, radius: this.radius,
      edges: () => (this.edges ??= new THREE.EdgesGeometry(geometry, 25)),
    }));
    // Isometric, like the main view; the user's orbit is reset per file so every preview starts comparable.
    this.camera.zoom = 1;
    this.camera.position.set(1, -1, 0.8).normalize().multiplyScalar(this.radius * 4);
    this.controls.target.set(0, 0, 0);
    this.resize();
    this.state.set('');
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
    this.loadSub?.unsubscribe();
    this.ro?.disconnect();
    clearParts(this.model);
    this.geometry?.dispose();
    this.edges?.dispose();
    // dispose() frees GPU resources but not the WebGL context itself. Browsers allow ~16 live contexts and then drop the oldest
    // one, which would be the main 3D view (it turned white after many previews), so give the context back explicitly.
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
  }
}
