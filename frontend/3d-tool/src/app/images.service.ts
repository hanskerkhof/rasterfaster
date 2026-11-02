import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { DocumentStore } from './document.store';
import { RenderService } from './render.service';

/** One picture or video of a document's gallery. */
export interface ImageNote {
  id: string;
  name: string;
  kind: 'hd' | 'quick' | 'turntable' | 'file';
  /** A picture (png) or a turntable video (mp4). */
  media?: 'png' | 'mp4';
  created: number;
  width: number;
  height: number;
  samples: number;
  elapsed: number;
  /** The document version it was made from, and whether the working copy was ahead of it. */
  version: number;
  edited: boolean;
  thumb: boolean;
  bytes: number;
  /** What the picture was rendered with (depth of field, lamp, ambient light, colours …). */
  settings?: RenderSettingsNote;
}

export interface RenderSettingsNote {
  depthOfField?: boolean;
  dofStrength?: number;
  focus?: string | null;
  focusId?: string | null;
  /** The camera and light of the render (the address parameters), to render the picture again at another size. */
  view?: string | null;
  light?: string | null;
  /** A turntable video: how it moves, how long and at what frame rate. */
  turntable?: { motion: 'orbit' | 'spin'; seconds: number; fps: number };
  /** The view of the 3D view the picture was made from, as the Views panel would save it. */
  savedView?: Record<string, unknown> | null;
  crop?: boolean;
  /** The shape of the picture and whether its background is transparent. */
  aspect?: string;
  transparent?: boolean;
  ambient?: number;
  lamp?: number;
  beam?: number;
  reflections?: number;
  background?: number | null;
  ground?: number | null;
  projection?: 'persp' | 'ortho' | null;
}

const thumbWidth = 320;

/** The gallery of the open document: finished full-size renders arrive by themselves, quick renders are kept on request. */
@Injectable({ providedIn: 'root' })
export class ImagesService {
  private readonly store = inject(DocumentStore);
  private readonly render = inject(RenderService);
  readonly images = signal<ImageNote[]>([]);
  readonly error = signal('');
  private loadedFor = '';
  private thumbQueue: string[] = [];
  private thumbBusy = false;

  constructor() {
    // The panel shows the library of the open document: load it when the panel opens or another document is opened.
    effect(() => {
      const id = this.store.docId();
      const open = this.store.imagesOpen();
      if (open && id) untracked(() => void this.load());
      if (!id) this.images.set([]);
    });
    // A full-size render of this document is ready: it is in the library now.
    effect(() => {
      const state = this.render.state();
      if (state?.state === 'done' && state.imageId && state.documentId === untracked(() => this.store.docId())) untracked(() => void this.load());
    });
  }

  private base() {
    const id = this.store.docId();
    return id ? `/api/documents/${id}/images` : null;
  }

  async load() {
    const base = this.base();
    if (!base) return;
    const mine = base;
    try {
      const response = await fetch(base, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json() as ImageNote[];
      if (mine !== this.base()) return; // another document was opened meanwhile
      this.images.set(list);
      this.error.set('');
      this.loadedFor = mine;
      this.thumbQueue = list.filter(note => !note.thumb).map(note => note.id);
      void this.makeThumbs();
    } catch (error) {
      this.error.set(`The images could not be loaded: ${error instanceof Error ? error.message : error}`);
    }
  }

  src(note: ImageNote) {
    return `${this.base()}/${note.id}.${note.media === 'mp4' ? 'mp4' : 'png'}`;
  }
  downloadSrc(note: ImageNote) {
    return `${this.src(note)}?download=true`;
  }
  thumbSrc(note: ImageNote) {
    return `${this.base()}/${note.id}/thumb.jpg`;
  }

  /** Keeps a quick render (the picture the render dialog shows). */
  async saveQuick(blob: Blob, name: string, samples: number, settings = '') {
    const base = this.base();
    if (!base) return null;
    try {
      const response = await fetch(`${base}?kind=quick&samples=${samples}&name=${encodeURIComponent(name)}${settings ? `&settings=${encodeURIComponent(settings)}` : ''}`, { method: 'POST', body: blob });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const note = await response.json() as ImageNote;
      this.images.update(list => [note, ...list]);
      void this.thumbFromBlob(note.id, blob);
      this.store.announce(`Saved to the gallery (v${note.version}${note.edited ? ', edited' : ''})`, 4000);
      return note;
    } catch (error) {
      this.error.set(`Saving failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /** Puts a PNG picture or an MP4 video of your own in the gallery (it gets the document's current version). Returns whether it went in. */
  async addFile(file: File, extra: { kind?: 'file' | 'quick'; settings?: string } = {}) {
    const base = this.base();
    if (!base) return false;
    const isVideo = /\.mp4$/i.test(file.name) || file.type === 'video/mp4';
    if (!isVideo && !/\.png$/i.test(file.name) && file.type !== 'image/png') {
      this.error.set(`"${file.name}" is not a PNG picture or an MP4 video`);
      return false;
    }
    try {
      let size = '';
      if (isVideo) { // the API does not read videos: the browser tells how big it is
        const { width, height } = await this.videoSize(file);
        size = `&width=${width}&height=${height}`;
      }
      const name = file.name.replace(/\.(png|mp4)$/i, '');
      const response = await fetch(`${base}?kind=${extra.kind ?? 'file'}&samples=0&name=${encodeURIComponent(name)}${size}${extra.settings ? `&settings=${encodeURIComponent(extra.settings)}` : ''}`, { method: 'POST', body: file });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const note = await response.json() as ImageNote;
      this.images.update(list => [note, ...list]);
      if (extra.kind === 'quick') this.store.announce('Saved to the gallery', 3000);
      this.error.set('');
      this.thumbQueue.push(note.id);
      void this.makeThumbs();
      return true;
    } catch (error) {
      this.error.set(`Adding "${file.name}" failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  private videoSize(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);
      video.preload = 'metadata';
      video.onloadedmetadata = () => { URL.revokeObjectURL(url); video.videoWidth ? resolve({ width: video.videoWidth, height: video.videoHeight }) : reject(new Error('the browser cannot read this video')); };
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the browser cannot read this video')); };
      video.src = url;
    });
  }

  async rename(note: ImageNote, name: string) {
    const clean = name.trim();
    if (!clean || clean === note.name) return;
    const response = await fetch(`${this.base()}/${note.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: clean }) });
    if (response.ok) this.replace(await response.json());
  }

  async remove(note: ImageNote) {
    const response = await fetch(`${this.base()}/${note.id}`, { method: 'DELETE' });
    if (response.ok) this.images.update(list => list.filter(n => n.id !== note.id));
  }

  /** Batch delete: pictures of versions older than `beforeVersion` and / or of one kind. Returns how many went. */
  async removeMatching(filter: { beforeVersion?: number; kind?: 'hd' | 'quick' }) {
    const params = new URLSearchParams();
    if (filter.beforeVersion !== undefined) params.set('beforeVersion', String(filter.beforeVersion));
    if (filter.kind) params.set('kind', filter.kind);
    const response = await fetch(`${this.base()}?${params}`, { method: 'DELETE' });
    if (!response.ok) return 0;
    const { deleted } = await response.json() as { deleted: number };
    await this.load();
    return deleted;
  }

  private replace(note: ImageNote) {
    this.images.update(list => list.map(n => (n.id === note.id ? note : n)));
  }

  /** The small pictures of the gallery are made here, in the browser (the API has no way to shrink a PNG): one at a time, the first time they are needed. */
  private async makeThumbs() {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    try {
      while (this.thumbQueue.length) {
        const id = this.thumbQueue.shift()!;
        const base = this.base();
        if (!base || base !== this.loadedFor) break;
        try {
          const note = this.images().find(n => n.id === id);
          if (note?.media === 'mp4') await this.thumbFromVideo(id, `${base}/${id}.mp4`);
          else {
            const response = await fetch(`${base}/${id}.png`);
            if (response.ok) await this.thumbFromBlob(id, await response.blob());
          }
        } catch { /* the picture stays without a thumbnail; it is tried again next time */ }
      }
    } finally {
      this.thumbBusy = false;
    }
  }

  /** The small picture of a video: one of its first frames. */
  private async thumbFromVideo(id: string, src: string) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = src;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => { video.currentTime = Math.min(0.1, (video.duration || 1) / 2); };
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('video'));
        setTimeout(() => reject(new Error('timeout')), 15000);
      });
      const frame = await createImageBitmap(video);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, thumbWidth / frame.width);
      canvas.width = Math.max(1, Math.round(frame.width * scale));
      canvas.height = Math.max(1, Math.round(frame.height * scale));
      canvas.getContext('2d')?.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      const thumb = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      const base = this.base();
      if (!thumb || !base) return;
      const response = await fetch(`${base}/${id}/thumb.jpg`, { method: 'PUT', body: thumb });
      if (response.ok) this.images.update(list => list.map(n => (n.id === id ? { ...n, thumb: true } : n)));
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  private async thumbFromBlob(id: string, blob: Blob) {
    const base = this.base();
    if (!base) return;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, thumbWidth / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#16181d'; // a transparent picture gets the studio's dark background
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumb = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!thumb) return;
    const response = await fetch(`${base}/${id}/thumb.jpg`, { method: 'PUT', body: thumb });
    if (response.ok) this.images.update(list => list.map(n => (n.id === id ? { ...n, thumb: true } : n)));
  }
}
