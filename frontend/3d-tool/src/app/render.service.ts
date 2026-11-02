import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DocumentStore } from './document.store';

const depthOfFieldStorageKey = 'rasterfaster.renderDepthOfField';
const cropStorageKey = 'rasterfaster.renderCrop';
const dofStrengthStorageKey = 'rasterfaster.renderDofStrength';
const ambientStorageKey = 'rasterfaster.renderAmbient';
const lampStorageKey = 'rasterfaster.renderLamp';
const beamStorageKey = 'rasterfaster.renderBeam';
const backgroundStorageKey = 'rasterfaster.renderBackground';
const groundStorageKey = 'rasterfaster.renderGround';

function readColour(key: string): number | null {
  try {
    const stored = localStorage.getItem(key);
    const value = stored === null || stored === '' ? NaN : Number(stored);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  } catch { /* storage unavailable */ }
  return null;
}
const hdWidthStorageKey = 'rasterfaster.renderHdWidth';
const hdSamplesStorageKey = 'rasterfaster.renderHdSamples';

/** The quality of a full-size render: the samples Cycles takes per pixel (more is cleaner, mirrors and glass especially, and slower). */
export const hdQualities = [{ samples: 96, label: 'Standard · 96 samples' }, { samples: 256, label: 'Fine · 256 samples' }, { samples: 512, label: 'Best · 512 samples' }];

function readHdSamples(): number {
  try {
    const stored = Number(localStorage.getItem(hdSamplesStorageKey));
    if (hdQualities.some(q => q.samples === stored)) return stored;
  } catch { /* storage unavailable */ }
  return 96;
}
/** The widths the full-size render can be made at (16:9): the first is the default. */
export const hdWidths = [{ width: 1920, label: '1920 × 1080 · Full HD' }, { width: 2560, label: '2560 × 1440 · QHD' }, { width: 3200, label: '3200 × 1800 · QHD+' }, { width: 3840, label: '3840 × 2160 · 4K UHD' }, { width: 5120, label: '5120 × 2880 · 5K' }, { width: 7680, label: '7680 × 4320 · 8K UHD' }];

/** The common name of a render width: "Full HD", "4K UHD" … (empty for a width without one). */
export function sizeName(width: number): string {
  return hdWidths.find(w => w.width === width)?.label.split(' · ')[1] ?? '';
}

function readHdWidth(): number {
  try {
    const stored = Number(localStorage.getItem(hdWidthStorageKey));
    if (hdWidths.some(w => w.width === stored)) return stored;
  } catch { /* storage unavailable */ }
  return 1920;
}

function readLamp(): number {
  try {
    const stored = Number(localStorage.getItem(lampStorageKey));
    if (Number.isInteger(stored) && stored >= 0 && stored <= 60 && localStorage.getItem(lampStorageKey) !== null) return stored;
  } catch { /* storage unavailable */ }
  return 40;
}

function readAmbient(): number {
  try {
    const stored = Number(localStorage.getItem(ambientStorageKey));
    if (Number.isInteger(stored) && stored >= 0 && stored <= 5) return stored;
  } catch { /* storage unavailable */ }
  return 0;
}

function readCrop(): boolean {
  try { return localStorage.getItem(cropStorageKey) === 'true'; } catch { return false; }
}
const focusStoragePrefix = 'rasterfaster.renderFocus.';

function readDofStrength(): number {
  try {
    const stored = Number(localStorage.getItem(dofStrengthStorageKey));
    if (Number.isInteger(stored) && stored >= 1 && stored <= 5) return stored;
  } catch { /* storage unavailable */ }
  return 3;
}

function readFocus(docId: string): string | null {
  try { return localStorage.getItem(focusStoragePrefix + docId); } catch { return null; }
}

function readDepthOfField(): boolean {
  try { return localStorage.getItem(depthOfFieldStorageKey) === 'true'; } catch { return false; }
}

const stepLabels: Record<string, string> = { prepare: 'Preparing the scene', load: 'Loading the scene', render: 'Rendering', finish: 'Denoising and saving' };

/** One step of a render in the progress bar: how long it takes (or is expected to) and how much of it is done (0 to 1). */
export interface RenderStep { name: string; label: string; duration: number; fill: number; started: boolean; done: boolean }

/** The names of the render menus, also used to describe a picture of the image library. */
export const ambientNames = ['None', 'Soft glow', 'Overcast', 'Softbox', 'Daylight', 'Bright studio'];
export const beamNames = ['Spot', 'Direct', 'Soft', 'Diffuse', 'Flood'];
export const strengthNames = ['Subtle', 'Soft', 'Medium', 'Strong', 'Extreme'];

export interface RenderState {
  id: string;
  name: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  width: number;
  samples: number;
  elapsed: number;
  /** Width and height of the finished picture. */
  size?: [number, number] | null;
  /** The steps of the render (seconds since it began; `start` is null before a step has begun, `end` while it runs). */
  phases?: { name: string; start: number | null; end: number | null; estimate: number }[];
  phase?: string | null;
  error: string;
  /** The document it was made from, the version of that document, and the picture's id in the document's image library once it is done. */
  documentId?: string;
  version?: number;
  imageId?: string | null;
  /** How many renders wait behind the running one, this one's place in the queue (0: not waiting), and how many renders the queue takes. */
  waiting?: number;
  position?: number;
  queueMax?: number;
}

/**
 * The full-size render: it runs in the background on the API (Blender), one at a time, and this page hears about it over the WebSocket
 * (`/api/ws`): progress while it runs, and "ready" when it is done, also when the page was closed meanwhile (the API says it on connecting).
 */
@Injectable({ providedIn: 'root' })
export class RenderService {
  /** The render the API told us about last: running, or done and not yet looked at. Null when there is none. */
  readonly state = signal<RenderState | null>(null);
  readonly running = computed(() => this.state()?.state === 'running');
  /** Renders waiting behind the running one, and how many the queue takes (running one included); the API says both with every message. */
  readonly waiting = signal(0);
  private readonly queueMax = signal(10);
  /** No room for another render in the queue. */
  readonly queueFull = computed(() => (this.running() ? 1 : 0) + this.waiting() >= this.queueMax());
  /**
   * The steps of the render for the progress bar. A step that is over has the time it took, the one running is estimated from the
   * samples done (or from the last render), the ones to come from the last render too.
   */
  readonly steps = computed<RenderStep[]>(() => {
    const r = this.state();
    if (!r?.phases) return [];
    const elapsed = r.state === 'running' ? this.elapsed() : r.elapsed;
    return r.phases.map(p => {
      const label = stepLabels[p.name] ?? p.name;
      if (p.start !== null && p.end !== null) return { name: p.name, label, duration: Math.max(p.end - p.start, 0.1), fill: 1, started: true, done: true };
      if (p.start === null) return { name: p.name, label, duration: Math.max(p.estimate, 0.1), fill: 0, started: false, done: false };
      const inStep = Math.max(elapsed - p.start, 0);
      const duration = Math.max(p.name === 'render' && r.progress > 0.03 ? inStep / r.progress : Math.max(p.estimate, inStep + 1), inStep, 0.1);
      return { name: p.name, label, duration, fill: p.name === 'render' ? r.progress : Math.min(inStep / duration, 0.97), started: true, done: false };
    });
  });
  /** The step that is running, for the toast. */
  readonly currentStep = computed(() => this.steps().find(s => s.started && !s.done) ?? null);
  /** The percentage of the whole render, all steps together. */
  readonly percent = computed(() => {
    const steps = this.steps();
    if (!steps.length) return Math.round((this.state()?.progress ?? 0) * 100);
    const total = steps.reduce((sum, s) => sum + s.duration, 0);
    return Math.round((steps.reduce((sum, s) => sum + s.duration * s.fill, 0) / Math.max(total, 1e-6)) * 100);
  });
  /** The clock of the progress toast: the time now, ticking every second while a render runs. */
  private readonly now = signal(Date.now());
  /** When the running render started (this page's clock), and the progress reports so far: the estimate comes from how fast they came in. */
  private startedAt = 0;
  private reports: { at: number; progress: number }[] = [];
  private ticker?: ReturnType<typeof setInterval>;
  /** Seconds the running render has taken. */
  readonly elapsed = computed(() => (this.running() ? Math.max(0, (this.now() - this.startedAt) / 1000) : 0));
  /**
   * Seconds still to go, or null until two reports have come in (Blender reports in a few big steps, so the first one says nothing about the speed):
   * the speed between the first and the latest report, applied to what is left, minus the time since the latest report.
   */
  readonly eta = computed(() => {
    const steps = this.steps();
    if (this.running() && steps.length) return Math.max(0, steps.reduce((sum, s) => sum + s.duration * (1 - s.fill), 0));
    const now = this.now();
    const first = this.reports[0], last = this.reports.at(-1);
    if (!this.running() || !first || !last || last.progress <= first.progress) return null;
    const perUnit = (last.at - first.at) / (last.progress - first.progress);
    return Math.max(0, (perUnit * (1 - last.progress) - (now - last.at)) / 1000);
  });
  /** The message that asks to be clicked: a render that is ready (or that failed). */
  readonly toast = signal<RenderState | { error: string } | null>(null);
  /** F12 was pressed: the document panel (which knows the camera and the light of the view) opens the render dialog. Counts up. */
  readonly openRequests = signal(0);
  /** The render dialog: the quick render's address, or a finished full-size render to show. */
  readonly dialog = signal<{ url: string; jobId: string } | null>(null);
  private readonly store = inject(DocumentStore);
  /** The Depth of field checkbox of the Render dialog: remembered in local storage and, per document, in the document file. */
  readonly depthOfField = signal(readDepthOfField());
  /** The part the depth of field is focused on (an item id of the open document), or null for the part nearest to the camera in the picture. */
  readonly focusId = signal<string | null>(null);
  /** The strength of the depth of field, 1 (subtle) to 5 (extreme). */
  readonly dofStrength = signal(readDofStrength());
  /** The ambient light preset, 0 (none) to 5. */
  readonly ambient = signal(readAmbient());
  /** The lamp slider, 0 to 60; 40 is the normal strength (two thirds of the way). */
  readonly lamp = signal(readLamp());
  /** The colour of the background and of the ground disc in the render; null is the studio's own. */
  /** The lamp type: 0 spot, 1 direct, 2 soft, 3 diffuse, 4 flood. */
  readonly beam = signal((() => { try { const v = Number(localStorage.getItem(beamStorageKey)); return Number.isInteger(v) && v >= 0 && v <= 4 && localStorage.getItem(beamStorageKey) !== null ? v : 1; } catch { return 1; } })());
  readonly background = signal<number | null>(readColour(backgroundStorageKey));
  readonly ground = signal<number | null>(readColour(groundStorageKey));
  /** The width of the full-size render (its height follows at 16:9). */
  readonly hdWidth = signal(readHdWidth());
  readonly hdSamples = signal(readHdSamples());
  /** The Crop checkbox: the picture is as wide as the parts. */
  readonly crop = signal(readCrop());
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private wait = 3000;

  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => { // a document that says what it wants wins over what this browser remembers
      const own = this.store.doc().render;
      const id = this.store.docId();
      if (own) { this.depthOfField.set(own.depthOfField); this.focusId.set(own.focusId ?? null); if (own.dofStrength) this.dofStrength.set(own.dofStrength); this.crop.set(!!own.crop); this.ambient.set(own.ambient ?? 0); this.lamp.set(own.lamp ?? 40); this.beam.set(own.beam ?? 1); this.background.set(own.background ?? null); this.ground.set(own.ground ?? null); }
      else { this.focusId.set(id ? readFocus(id) : null); this.lamp.set(40); this.beam.set(1); this.background.set(null); this.ground.set(null); } // a document without render settings starts with the normal lamp (100%)
    });
    this.connect();
    void this.poll(); // the WebSocket may be unavailable (a proxy that does not pass it on): the same messages can be asked for
  }

  /**
   * Asks the API for the newest render once, and again every 2 seconds while one runs and the WebSocket is not open: the page then still
   * learns that it is ready. With the WebSocket open this stays quiet (it only checks once every 30 seconds).
   */
  private async poll() {
    clearTimeout(this.pollTimer);
    try {
      this.receive(JSON.stringify({ type: 'render', ...(await (await fetch('/api/render-jobs/latest', { cache: 'no-store' })).json()) }));
    } catch { /* the API is not there */ }
    const live = this.socket?.readyState === WebSocket.OPEN;
    this.pollTimer = setTimeout(() => void this.poll(), this.running() && !live ? 2000 : 30000);
  }

  private connect() {
    if (typeof WebSocket === 'undefined') return;
    try {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws`);
      this.socket = socket;
      socket.onmessage = event => { this.wait = 3000; this.receive(event.data); };
      socket.onclose = () => { // the API restarted, the connection dropped, or nothing passes WebSockets on: try again, less and less often
        this.reconnect = setTimeout(() => this.connect(), this.wait);
        this.wait = Math.min(this.wait * 2, 60000);
      };
      socket.onerror = () => socket.close();
    } catch {
      this.reconnect = setTimeout(() => this.connect(), 5000);
    }
  }

  private receive(data: unknown) {
    let message: Partial<RenderState> & { type?: string };
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.type !== 'render') return;
    if (typeof message.waiting === 'number') this.waiting.set(message.waiting);
    if (typeof message.queueMax === 'number') this.queueMax.set(message.queueMax);
    if (message.state === 'queued') return; // a render joined the queue: only the count changes
    if (message.state === 'cancelled' && this.running() && message.id !== this.state()?.id) return; // a waiting render was cancelled: the running one goes on
    if (message.state === ('idle' as string)) this.waiting.set(0);
    const before = this.state();
    this.track(message as RenderState);
    const next = message.state && message.state !== ('idle' as string) ? (message as RenderState) : null;
    this.state.set(next && next.state !== 'cancelled' ? next : null);
    if (next?.state === 'done' && (before?.id !== next.id || before.state !== 'done')) this.toast.set(next);
    else if (next?.state === 'error') this.toast.set(next);
    else if (!next || next.state === 'cancelled') this.toast.set(null); // a finished picture's message stays while the next render runs
  }

  /** Keeps the clock and the progress reports of the running render (a render that was running before this page opened counts from what the API says). */
  private track(message: Partial<RenderState>) {
    if (message.state !== 'running') {
      this.reports = [];
      if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
      return;
    }
    const now = Date.now();
    if (this.state()?.id !== message.id || !this.ticker) {
      this.startedAt = now - (message.elapsed ?? 0) * 1000;
      this.reports = [];
      this.now.set(now);
      this.ticker ??= setInterval(() => this.now.set(Date.now()), 1000);
    }
    const progress = message.progress ?? 0;
    if (progress > 0 && progress !== this.reports.at(-1)?.progress) this.reports.push({ at: now, progress });
  }

  setDepthOfField(on: boolean) {
    this.depthOfField.set(on);
    try { localStorage.setItem(depthOfFieldStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  /** The part to focus on (null: the part nearest to the camera in the picture): remembered per document, here and in the document file. */
  setFocus(id: string | null) {
    this.focusId.set(id);
    const doc = this.store.docId();
    if (doc) { try { id ? localStorage.setItem(focusStoragePrefix + doc, id) : localStorage.removeItem(focusStoragePrefix + doc); } catch { /* storage unavailable */ } }
    this.saveSettings();
  }

  setCrop(on: boolean) {
    this.crop.set(on);
    try { localStorage.setItem(cropStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  setDofStrength(level: number) {
    this.dofStrength.set(level);
    try { localStorage.setItem(dofStrengthStorageKey, String(level)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  setAmbient(level: number) {
    this.ambient.set(level);
    try { localStorage.setItem(ambientStorageKey, String(level)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  /** For the toasts: " (4K UHD)" after a width, or nothing. */
  sizeSuffix(width: number): string {
    const name = sizeName(width);
    return name ? ` (${name})` : '';
  }

  setHdSamples(samples: number) {
    this.hdSamples.set(samples);
    try { localStorage.setItem(hdSamplesStorageKey, String(samples)); } catch { /* storage unavailable */ }
  }

  setHdWidth(width: number) {
    this.hdWidth.set(width);
    try { localStorage.setItem(hdWidthStorageKey, String(width)); } catch { /* storage unavailable */ }
  }

  setBeam(type: number) {
    this.beam.set(type);
    try { localStorage.setItem(beamStorageKey, String(type)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  setBackground(colour: number | null) {
    this.background.set(colour);
    try { colour === null ? localStorage.removeItem(backgroundStorageKey) : localStorage.setItem(backgroundStorageKey, String(colour)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  setGround(colour: number | null) {
    this.ground.set(colour);
    try { colour === null ? localStorage.removeItem(groundStorageKey) : localStorage.setItem(groundStorageKey, String(colour)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  setLamp(value: number) {
    this.lamp.set(value);
    try { localStorage.setItem(lampStorageKey, String(value)); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  private saveSettings() {
    this.store.setRenderSettings({ depthOfField: this.depthOfField(), dofStrength: this.dofStrength(), crop: this.crop(), ambient: this.ambient(), lamp: this.lamp(), beam: this.beam(), background: this.background(), ground: this.ground(), ...(this.focusId() ? { focusId: this.focusId() } : {}) });
  }

  /** The address parameters for the focus: `dof` and, with a part chosen that is still in the document, `focus`. */
  dofParams(url: URL) {
    url.searchParams.set('crop', String(this.crop()));
    url.searchParams.set('ambient', String(this.ambient()));
    url.searchParams.set('lamp', String(this.lamp()));
    url.searchParams.set('beam', String(this.beam()));
    if (this.background() !== null) url.searchParams.set('bg', String(this.background()));
    if (this.ground() !== null) url.searchParams.set('floor', String(this.ground()));
    url.searchParams.set('dof', String(this.depthOfField()));
    url.searchParams.set('strength', String(this.dofStrength()));
    const focus = this.focusId();
    if (focus && this.store.doc().items.some(i => i.id === focus)) url.searchParams.set('focus', focus);
  }

  /** F12 / the Render button: asks for the render dialog. */
  requestOpen() {
    if (!this.dialog()) this.openRequests.update(n => n + 1);
  }

  /** The last quick picture with what it was made from: while that is unchanged (view, light, parts, render settings) the dialog shows it again instead of rendering. */
  lastQuick: { key: string; blob: Blob; detail: string; settings: string } | null = null;

  /** The Render button: a quick picture (shown at once by the dialog). */
  openQuick(url: string) {
    this.dialog.set({ url, jobId: '' });
  }

  /** The full-size render starts in the background; the quick render's address carries the camera and the light of the 3D view. */
  async startFullSize(quickUrl: string) {
    this.toast.set(null);
    try {
      const url = new URL(quickUrl.replace('/render.png', '/render-jobs'), location.origin);
      this.dofParams(url);
      url.searchParams.set('width', String(this.hdWidth()));
      url.searchParams.set('samples', String(this.hdSamples()));
      await this.launch(url);
    } catch (error) {
      this.toast.set({ error: `Render failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  /** Starts the job a render-jobs address describes and follows it. */
  private async launch(url: URL) {
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
    const started = await response.json() as RenderState;
    if (typeof started.waiting === 'number') this.waiting.set(started.waiting);
    if (typeof started.queueMax === 'number') this.queueMax.set(started.queueMax);
    if (started.state === 'queued') { // another render runs: this one waits its turn (the running one stays on show)
      this.store.announce(`Render queued: ${started.position === 1 ? 'next' : 'number ' + started.position} in line. It is saved to the image library when it is done`, 6000);
    } else {
      this.track(started);
      this.state.set(started); // the WebSocket keeps it up to date from here
      this.store.announce('Full-size render started in the background: you get a message when it is ready', 6000);
    }
    void this.poll(); // and the polling does when there is no WebSocket
  }

  /** Renders a picture of the image library again at full size, with the camera, light and settings it was made with (the document as it is now). */
  async startFromNote(documentId: string, settings: Record<string, unknown>, width: number) {
    this.toast.set(null);
    try {
      const url = new URL(`/api/documents/${documentId}/render-jobs`, location.origin);
      const put = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value)); };
      put('view', settings['view']); put('light', settings['light']);
      put('dof', settings['depthOfField']); put('strength', settings['dofStrength']); put('focus', settings['focusId']);
      put('crop', settings['crop']); put('ambient', settings['ambient']); put('lamp', settings['lamp']); put('beam', settings['beam']);
      put('bg', settings['background']); put('floor', settings['ground']);
      url.searchParams.set('width', String(width));
      url.searchParams.set('samples', String(this.hdSamples()));
      await this.launch(url);
    } catch (error) {
      this.toast.set({ error: `Render failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  /** The toast was clicked: the finished render opens in the dialog. */
  view() {
    const shown = this.toast();
    this.toast.set(null);
    if (shown && 'id' in shown && shown.state === 'done') this.dialog.set({ url: '', jobId: shown.id });
  }

  /** The picture has been looked at: the API can forget it. */
  async collect(jobId: string) {
    try { await fetch(`/api/render-jobs/${jobId}`, { method: 'DELETE' }); } catch { /* it is dropped with the next render */ }
  }

  /** "Cancel all": the running render stops and the queue is emptied. */
  async cancelAll() {
    this.track({ state: 'cancelled' });
    this.state.set(null);
    this.waiting.set(0);
    this.store.announce('All renders cancelled');
    try { await fetch('/api/render-jobs', { method: 'DELETE' }); } catch { /* they end on their own */ }
  }

  /** The Cancel button of the progress toast: Blender is stopped; the toast goes at once. */
  async cancel() {
    const running = this.state();
    if (running?.state !== 'running') return;
    this.track({ state: 'cancelled' });
    this.state.set(null);
    this.store.announce('Render cancelled');
    try { await fetch(`/api/render-jobs/${running.id}`, { method: 'DELETE' }); } catch { /* it ends on its own */ }
  }
}
