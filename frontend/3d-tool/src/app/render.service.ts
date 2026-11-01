import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DocumentStore } from './document.store';

const depthOfFieldStorageKey = 'rasterfaster.renderDepthOfField';
const cropStorageKey = 'rasterfaster.renderCrop';
const dofStrengthStorageKey = 'rasterfaster.renderDofStrength';
const ambientStorageKey = 'rasterfaster.renderAmbient';

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

export interface RenderState {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  width: number;
  samples: number;
  elapsed: number;
  error: string;
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
  /** The percentage of the running render, for the tooltip of the button. */
  readonly percent = computed(() => Math.round((this.state()?.progress ?? 0) * 100));
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
      if (own) { this.depthOfField.set(own.depthOfField); this.focusId.set(own.focusId ?? null); if (own.dofStrength) this.dofStrength.set(own.dofStrength); this.crop.set(!!own.crop); this.ambient.set(own.ambient ?? 0); }
      else this.focusId.set(id ? readFocus(id) : null);
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
    const before = this.state();
    this.track(message as RenderState);
    const next = message.state && message.state !== ('idle' as string) ? (message as RenderState) : null;
    this.state.set(next && next.state !== 'cancelled' ? next : null);
    if (next?.state === 'done' && (before?.id !== next.id || before.state !== 'done')) this.toast.set(next);
    else if (next?.state === 'error') this.toast.set(next);
    else if (!next || next.state === 'cancelled' || next.state === 'running') {
      const shown = this.toast();
      if (shown && 'id' in shown && shown.id !== next?.id) this.toast.set(null);
      if (!next || next.state === 'cancelled') this.toast.set(null);
    }
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

  private saveSettings() {
    this.store.setRenderSettings({ depthOfField: this.depthOfField(), dofStrength: this.dofStrength(), crop: this.crop(), ambient: this.ambient(), ...(this.focusId() ? { focusId: this.focusId() } : {}) });
  }

  /** The address parameters for the focus: `dof` and, with a part chosen that is still in the document, `focus`. */
  dofParams(url: URL) {
    url.searchParams.set('crop', String(this.crop()));
    url.searchParams.set('ambient', String(this.ambient()));
    url.searchParams.set('dof', String(this.depthOfField()));
    url.searchParams.set('strength', String(this.dofStrength()));
    const focus = this.focusId();
    if (focus && this.store.doc().items.some(i => i.id === focus)) url.searchParams.set('focus', focus);
  }

  /** F12 / the Render button: asks for the render dialog (ignored while a full-size render runs, like the button). */
  requestOpen() {
    if (!this.running() && !this.dialog()) this.openRequests.update(n => n + 1);
  }

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
      url.searchParams.set('width', '1920');
      url.searchParams.set('samples', '96');
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const started = await response.json();
      this.track(started);
      this.state.set(started); // the WebSocket keeps it up to date from here
      this.store.announce('Full-size render started in the background: you get a message when it is ready', 6000);
      void this.poll(); // and the polling does when there is no WebSocket
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
