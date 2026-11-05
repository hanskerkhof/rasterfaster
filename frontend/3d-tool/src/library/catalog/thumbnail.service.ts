import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { firstValueFrom } from 'rxjs';
import { RF_LIBRARY_CONFIG } from '../core/library.config';
import { LibraryService } from '../core/library.service';
import { buildSilhouetteGeometry, creaseDegrees, drawingFlatDegrees } from '../preview/silhouette';
import { buildViewSvg } from '../preview/svg-view';
import { CatalogEntry } from './catalog.logic';
import { isLarge, isTooLarge, meshVolume, themeSvg, thumbnailDirection, thumbnailScale, thumbnailVersion } from './thumbnail.logic';

export interface DrawnInfo {
  /** The file's `modified` the drawing was made from (a changed file needs a new one). */
  modified: number;
  dims: number[] | null;
  volume: number | null;
}

const aspect = 4 / 3;

/**
 * Draws the thumbnails of the catalog: for the cards in view, one part at a time, in the browser (the hidden-lines view of the app, as an SVG),
 * and keeps them in the API's cache (`PUT /api/catalog/thumb`) so the next visit needs no drawing. The cards in view change as the list is
 * scrolled; the queue is the newest list, so what was scrolled past is not drawn. Parts over `maxAutoDrawBytes` wait for `drawNow`.
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailService {
  private readonly http = inject(HttpClient);
  private readonly lib = inject(LibraryService);
  private readonly api = inject(RF_LIBRARY_CONFIG).apiBase;

  /** The drawings that exist, by library path. */
  readonly drawn = signal<ReadonlyMap<string, DrawnInfo>>(new Map());
  /** Parts whose drawing failed (an unreadable file): not tried again until the catalog is opened again. */
  readonly failed = signal<ReadonlySet<string>>(new Set());
  /** What the big drawings of the detail page measured (a part opened before its thumbnail was drawn has no size yet). */
  readonly measured = signal<ReadonlyMap<string, { dims: number[]; volume: number }>>(new Map());
  /** How many cards in view are still waiting for their drawing. */
  readonly waiting = signal(0);

  private wanted: CatalogEntry[] = [];
  private readonly forced = new Set<string>();
  private running = false;
  private renderer: THREE.WebGLRenderer | null = null;

  /** The drawings the API already has (the catalog says so per entry), and a fresh start for the failures. */
  seed(entries: readonly CatalogEntry[]) {
    const map = new Map<string, DrawnInfo>();
    for (const entry of entries) if (entry.drawn && entry.thumbVersion === thumbnailVersion) map.set(entry.path, { modified: entry.modified, dims: entry.dims ?? null, volume: entry.volume ?? null });
    this.drawn.set(map);
    this.failed.set(new Set());
    this.forced.clear();
  }

  isDrawn(entry: CatalogEntry): boolean {
    return this.drawn().get(entry.path)?.modified === entry.modified;
  }

  /** What the card needs to show for this part. */
  state(entry: CatalogEntry): 'drawn' | 'toolarge' | 'large' | 'failed' | 'pending' {
    if (this.isDrawn(entry)) return 'drawn';
    if (isTooLarge(entry.size)) return 'toolarge';
    if (this.failed().has(entry.path)) return 'failed';
    if (isLarge(entry.size) && !this.forced.has(entry.path)) return 'large';
    return 'pending';
  }

  url(entry: CatalogEntry): string {
    return `${this.api}/catalog/thumb?path=${encodeURIComponent(entry.path)}&v=${entry.modified}-${thumbnailVersion}`;
  }

  /** The cards in view, in the order to draw them. */
  want(entries: readonly CatalogEntry[]) {
    this.wanted = [...entries];
    this.waiting.set(this.wanted.filter(entry => this.state(entry) === 'pending').length);
    void this.pump();
  }

  /** "Draw anyway" on a large part: next in the queue. */
  drawNow(entry: CatalogEntry) {
    if (isTooLarge(entry.size)) return;
    this.forced.add(entry.path);
    this.wanted = [entry, ...this.wanted.filter(e => e.path !== entry.path)];
    this.failed.update(set => { const next = new Set(set); next.delete(entry.path); return next; });
    void this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let entry = this.next(); entry; entry = this.next()) {
        await this.draw(entry);
        this.waiting.set(this.wanted.filter(e => this.state(e) === 'pending').length);
        await new Promise(resolve => setTimeout(resolve, 0)); // let the page breathe between two drawings
      }
    } finally {
      this.running = false;
    }
  }

  private next(): CatalogEntry | undefined {
    return this.wanted.find(entry => this.state(entry) === 'pending');
  }

  private async draw(entry: CatalogEntry) {
    try {
      const { svg, dims, volume } = await this.build(entry, 200);
      await firstValueFrom(this.http.put(`${this.api}/catalog/thumb`, { modified: entry.modified, version: thumbnailVersion, svg, dims, volume }, { params: { path: entry.path } }));
      this.drawn.update(map => new Map(map).set(entry.path, { modified: entry.modified, dims, volume }));
    } catch {
      this.failed.update(set => new Set(set).add(entry.path));
    }
  }

  /** A big drawing of one part for the detail page (`width` CSS pixels wide): not kept in the cache. Draws now, between the thumbnails; null when it fails. */
  async drawLarge(entry: CatalogEntry, width = 560): Promise<string | null> {
    if (isTooLarge(entry.size)) return null;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 50)); // the renderer is used by one drawing at a time
    this.running = true;
    try {
      const { svg, dims, volume } = await this.build(entry, width);
      this.measured.update(map => new Map(map).set(entry.path, { dims, volume }));
      return svg;
    } catch {
      return null;
    } finally {
      this.running = false;
      void this.pump();
    }
  }

  /** Reads the STL, draws it (hidden lines removed, isometric) as an SVG of `width` CSS pixels, and measures it. */
  private async build(entry: CatalogEntry, width: number): Promise<{ svg: string; dims: number[]; volume: number }> {
    let geometry: THREE.BufferGeometry | null = null, edges: THREE.BufferGeometry | null = null, silhouette: THREE.BufferGeometry | null = null;
    try {
      geometry = new STLLoader().parse(await firstValueFrom(this.lib.loadStl(entry.path)));
      const volume = meshVolume((geometry.getAttribute('position') as THREE.BufferAttribute).array);
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      geometry.translate(...geometry.boundingBox!.getCenter(new THREE.Vector3()).negate().toArray());
      geometry.computeBoundingSphere();
      edges = new THREE.EdgesGeometry(geometry, creaseDegrees);
      silhouette = buildSilhouetteGeometry(geometry, creaseDegrees, drawingFlatDegrees);
      const radius = Math.max(geometry.boundingSphere!.radius, 1e-3), distance = radius * 4;
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, distance - radius * 1.5, distance + radius * 1.5);
      camera.up.set(0, 0, 1);
      camera.position.set(...new THREE.Vector3(...thumbnailDirection).normalize().multiplyScalar(distance).toArray());
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      // fit the frame to the box of the part as the camera sees it (not to its bounding sphere: a flat plate would swim in empty space)
      const box = geometry.boundingBox!;
      let reachX = 1e-3, reachY = 1e-3;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const seen = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        reachX = Math.max(reachX, Math.abs(seen.x)); reachY = Math.max(reachY, Math.abs(seen.y));
      }
      const half = Math.max(reachY, reachX / aspect) * 1.04;
      camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
      camera.updateProjectionMatrix();

      this.renderer ??= new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false });
      const svg = themeSvg(buildViewSvg(this.renderer, camera, aspect, [{ geometry, position: new THREE.Vector3(), edges, silhouette }], { resolution: width * thumbnailScale, title: '' }));
      return { svg, dims: size.toArray().map(n => Math.round(n * 100) / 100), volume: Math.round(volume * 10) / 10 };
    } finally {
      geometry?.dispose(); edges?.dispose(); silhouette?.dispose();
    }
  }
}
