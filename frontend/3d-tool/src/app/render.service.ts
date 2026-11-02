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
const aspectStorageKey = 'rasterfaster.renderAspect';
const turntableStorageKey = 'rasterfaster.renderTurntable';

/** The turntable video: how long (seconds, at 30 frames per second), how good (samples per frame: each frame is cheaper than a still) and how it moves. */
export const turntableLengths = [3, 5, 10, 30];
export const turntableQualities = [
  { samples: 12, label: 'Draft · 960 px, 12 samples', draft: true }, // small and quick: a few minutes, to see the motion; the other two use the size menu's width
  { samples: 48, label: 'Standard · 48 samples', draft: false },
  { samples: 96, label: 'Fine · 96 samples', draft: false },
];
export const turntableMotions: { id: 'orbit' | 'spin'; label: string; title: string }[] = [
  { id: 'orbit', label: 'Camera circles', title: 'The camera goes once around the scene at its height; the light stays where it is' },
  { id: 'spin', label: 'Objects turn', title: 'The parts turn once in front of the camera, which stays where it is; the light stays too, like a photo turntable' },
];
export type TurnDirection = 'ccw' | 'cw';
export const turnDirections: { id: TurnDirection; label: string; title: string }[] = [
  { id: 'ccw', label: 'CCW', title: 'Counter-clockwise, seen from above (Camera circles: the camera goes that way round; Objects turn: the scene appears to go that way)' },
  { id: 'cw', label: 'CW', title: 'Clockwise, seen from above' },
];
interface TurntableChoice { seconds: number; samples: number; motion: 'orbit' | 'spin'; direction: TurnDirection }

function readTurntable(): TurntableChoice {
  const fallback: TurntableChoice = { seconds: 5, samples: 48, motion: 'orbit', direction: 'ccw' };
  try {
    const stored = JSON.parse(localStorage.getItem(turntableStorageKey) ?? 'null') ?? {};
    // each setting on its own: one that is no longer on offer (the Draft replaced a quality) must not make the others forgotten
    return {
      seconds: turntableLengths.includes(stored.seconds) ? stored.seconds : fallback.seconds,
      samples: turntableQualities.some(q => q.samples === stored.samples) ? stored.samples : fallback.samples,
      motion: stored.motion === 'orbit' || stored.motion === 'spin' ? stored.motion : fallback.motion,
      direction: stored.direction === 'cw' ? 'cw' : 'ccw',
    };
  } catch { return fallback; }
}
const boxStorageKey = 'rasterfaster.renderBox';
/** The focus of the depth of field on the middle of all the objects, instead of a part. */
export const focusCentre = '_centre';
const frameStorageKey = 'rasterfaster.renderFrame';
const transparentStorageKey = 'rasterfaster.renderTransparent';

/** The shapes of a picture: the width comes from the size menu, the height follows the shape. */
export type Aspect = '16:9' | '1:1' | '4:5' | '9:16';
export const aspects: { id: Aspect; label: string }[] = [{ id: '16:9', label: '16:9 wide' }, { id: '1:1', label: '1:1 square' }, { id: '4:5', label: '4:5 portrait' }, { id: '9:16', label: '9:16 tall' }];

/** "16:9" as a number (width over height). */
export function aspectRatio(aspect: string | null | undefined): number {
  const [w, h] = (aspect ?? '16:9').split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}
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

/** The names of the render menus, also used to describe a picture of the gallery. */
export const ambientNames = ['None', 'Soft glow', 'Overcast', 'Softbox', 'Daylight', 'Bright studio'];
export const beamNames = ['Spot', 'Direct', 'Soft', 'Diffuse', 'Flood'];
export const strengthNames = ['Subtle', 'Soft', 'Medium', 'Strong', 'Extreme'];
/** What metal, mirror and glass reflect (the dark studio is what renders always had). */
/** The styles of a picture (FX): the ids the API takes and the names the toolbar shows. */
export const fxIds = ['none', 'cartoon', 'outline', 'sketch', 'clay', 'blueprint', 'isometric', 'xray', 'lowpoly', 'wireframe', 'thermal', 'cutaway', 'clayrough', 'clayroughcolour'];
export const fxNames = ['None', 'Cartoon', 'Outline', 'Sketch', 'Clay', 'Blueprint', 'Isometric', 'X-ray', 'Low poly', 'Wireframe', 'Thermal', 'Cut-away', 'Clay rough', 'Clay rough colour'];
export const reflectionNames = ['Studio dark', 'Softbox', 'Daylight', 'Neutral grey', 'None'];

/** A render that waits in the queue. */
export interface QueuedRender {
  id: string;
  name: string;
  kind: 'picture' | 'turntable';
  width: number;
  samples: number;
  frames: number;
  motion: 'orbit' | 'spin' | null;
  size: string;
}

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
  /** The document it was made from, the version of that document, and the picture's id in the document's gallery once it is done. */
  documentId?: string;
  version?: number;
  imageId?: string | null;
  /** How many renders wait behind the running one, this one's place in the queue (0: not waiting), and how many renders the queue takes. */
  /** A picture or a turntable video, the frames of the video, and how it moves (the camera circles, or the parts turn). */
  kind?: 'picture' | 'turntable';
  frames?: number;
  motion?: 'orbit' | 'spin' | null;
  /** The renders that wait, in order (the API says it with every message). */
  queue?: QueuedRender[];
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
  /** Who waits, in order. */
  readonly queue = signal<QueuedRender[]>([]);
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
  readonly turntable = signal<TurntableChoice>(readTurntable());
  /** The part a turntable with Camera circles goes round (an item id of the open document); null: the point the view looks at. */
  readonly trackId = signal<string | null>(null);
  /** The tracked part, when it is still in the document. */
  readonly tracked = computed(() => this.store.doc().items.find(i => i.id === this.trackId()) ?? null);

  /** What the camera goes round while it tracks a part: the middle of the view (looking at the part, like a drone) or the part itself. */
  readonly trackPivot = signal<'part' | 'all' | 'view'>('all');
  /** What Camera circles keeps looking at: the tracked part, the middle of all the objects, or nothing in particular (it keeps its angle). */
  readonly lookAt = signal<'part' | 'all' | 'view'>('view');
  /** What metal, mirror and glass reflect: 0 the dark studio, 1 softbox, 2 daylight, 3 neutral grey, 4 none (in the 3D view and in renders). */
  readonly reflections = signal(0);
  /** The style of the render (FX): see fxIds. */
  readonly fx = signal('none');

  /** The cut-away section: the axis, how far along the parts (percent) and which side is cut away (0 or 1), as "z:50:0". */
  readonly cut = signal('z:50:0');
  cutParts() { const [axis, position, flip] = this.cut().split(':'); return { axis, position: +position, flip: flip === '1' }; }
  setCut(change: Partial<{ axis: string; position: number; flip: boolean }>) {
    const now = { ...this.cutParts(), ...change };
    this.cut.set(`${now.axis}:${Math.min(Math.max(Math.round(now.position), 0), 100)}:${now.flip ? 1 : 0}`);
    this.saveSettings();
  }

  setFx(id: string) {
    this.fx.set(fxIds.includes(id) ? id : 'none');
    this.saveSettings();
  }

  setReflections(preset: number) {
    this.reflections.set(preset);
    this.saveSettings();
  }

  setLookAt(choice: 'part' | 'all' | 'view') {
    this.lookAt.set(choice);
    this.saveSettings();
  }

  setTrackPivot(pivot: 'part' | 'all' | 'view') {
    this.trackPivot.set(pivot);
    this.saveSettings();
  }

  setTrack(id: string | null) {
    this.trackId.set(id);
    if (id && this.lookAt() === 'view') this.lookAt.set('part'); // a part was chosen to be tracked: the camera looks at it
    if (!id) { // no part any more: what needed one goes back to something that does not
      if (this.lookAt() === 'part') this.lookAt.set('view');
      if (this.trackPivot() === 'part') this.trackPivot.set('all');
    }
    this.saveSettings();
  }

  setTurntable(change: Partial<TurntableChoice>) {
    this.turntable.update(t => ({ ...t, ...change }));
    try { localStorage.setItem(turntableStorageKey, JSON.stringify(this.turntable())); } catch { /* storage unavailable */ }
  }

  /** What a turntable video would be: its width (a draft is at most 960 px), frames per second, frames, and the samples. */
  turntableSpec() {
    const choice = this.turntable();
    const draft = turntableQualities.find(q => q.samples === choice.samples)?.draft ?? false;
    const fps = draft ? 24 : 30;
    return { width: Math.min(this.hdWidth(), draft ? 960 : 3840), fps, frames: choice.seconds * fps, samples: choice.samples, seconds: choice.seconds, motion: choice.motion, direction: choice.direction };
  }

  /** About how long the video takes (seconds), asked from the API (it knows what the last renders took); null while unknown. */
  readonly turntableEstimate = signal<number | null>(null);
  private estimateTimer?: ReturnType<typeof setTimeout>;

  refreshTurntableEstimate() {
    clearTimeout(this.estimateTimer);
    this.estimateTimer = setTimeout(async () => {
      const spec = this.turntableSpec();
      try {
        const response = await fetch(`/api/render-estimate?width=${spec.width}&samples=${spec.samples}&frames=${spec.frames}&aspect=${encodeURIComponent(this.aspect())}`, { cache: 'no-store' });
        this.turntableEstimate.set(response.ok ? (await response.json()).seconds : null);
      } catch { this.turntableEstimate.set(null); }
    }, 250);
  }

  /** The frame the running turntable is on (1 to its frames). */
  readonly frameNow = computed(() => {
    const s = this.state();
    return s?.kind === 'turntable' && s.frames ? Math.min(s.frames, Math.floor((this.percent() / 100) * s.frames) + 1) : 0;
  });
  /** The Crop checkbox: the picture is as wide as the parts. */
  readonly crop = signal(readCrop());
  readonly aspect = signal<Aspect>((() => { try { const v = localStorage.getItem(aspectStorageKey); return aspects.some(a => a.id === v) ? (v as Aspect) : '16:9'; } catch { return '16:9'; } })());
  readonly transparent = signal((() => { try { return localStorage.getItem(transparentStorageKey) === 'true'; } catch { return false; } })());
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private wait = 3000;

  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => { // a document that says what it wants wins over what this browser remembers
      const own = this.store.doc().render;
      const id = this.store.docId();
      if (own) { this.depthOfField.set(own.depthOfField); this.focusId.set(own.focusId ?? null); if (own.dofStrength) this.dofStrength.set(own.dofStrength); this.crop.set(!!own.crop); this.ambient.set(own.ambient ?? 0); this.lamp.set(own.lamp ?? 40); this.beam.set(own.beam ?? 1); this.background.set(own.background ?? null); this.ground.set(own.ground ?? null); this.aspect.set(own.aspect ?? '16:9'); this.transparent.set(!!own.transparent); this.trackId.set(own.trackId ?? null); this.trackPivot.set(own.trackPivot ?? 'all'); this.lookAt.set(own.lookAt ?? (own.trackId ? 'part' : 'view')); this.reflections.set(own.reflections ?? 0); this.fx.set(own.fx && fxIds.includes(own.fx) ? own.fx : 'none'); this.cut.set(own.cut && /^[xyz]:\d{1,3}:[01]$/.test(own.cut) ? own.cut : 'z:50:0'); }
      else { this.focusId.set(id ? readFocus(id) : null); this.lamp.set(40); this.beam.set(1); this.background.set(null); this.ground.set(null); this.aspect.set('16:9'); this.transparent.set(false); this.trackId.set(null); this.trackPivot.set('all'); this.lookAt.set('view'); this.reflections.set(0); this.fx.set('none'); this.cut.set('z:50:0'); } // a document without render settings starts with the normal lamp (100%)
    });
    this.store.onTrackChosen = id => { // the 3D view's pick of the part a turntable tracks is over
      if (id) { this.setTrack(id); this.store.announce(`The turntable tracks "${this.tracked()?.name ?? ''}"`, 4000); }
      if (this.store.trackPickFromDialog) { this.store.trackPickFromDialog = false; this.requestOpen(); } // the Render dialog comes back
    };
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
    if (Array.isArray(message.queue)) this.queue.set(message.queue);
    if (typeof message.queueMax === 'number') this.queueMax.set(message.queueMax);
    if (message.state === 'queued') return; // a render joined the queue: only the count changes
    if (message.state === 'cancelled' && this.running() && message.id !== this.state()?.id) return; // a waiting render was cancelled: the running one goes on
    if (message.state === ('idle' as string)) { this.waiting.set(0); this.queue.set([]); }
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

  setAspect(aspect: Aspect) {
    this.aspect.set(aspect);
    try { localStorage.setItem(aspectStorageKey, aspect); } catch { /* storage unavailable */ }
    this.saveSettings();
  }

  /** Whether the dashed frame (what the render contains) is drawn over the view in Render mode. */
  readonly showFrame = signal((() => { try { return localStorage.getItem(frameStorageKey) !== 'false'; } catch { return true; } })());

  setShowFrame(on: boolean) {
    this.showFrame.set(on);
    try { localStorage.setItem(frameStorageKey, String(on)); } catch { /* storage unavailable */ }
  }

  /** Whether the outline round all the objects is drawn in the view in Render mode. */
  readonly showBox = signal((() => { try { return localStorage.getItem(boxStorageKey) !== 'false'; } catch { return true; } })());

  setShowBox(on: boolean) {
    this.showBox.set(on);
    try { localStorage.setItem(boxStorageKey, String(on)); } catch { /* storage unavailable */ }
  }

  setTransparent(on: boolean) {
    this.transparent.set(on);
    try { localStorage.setItem(transparentStorageKey, String(on)); } catch { /* storage unavailable */ }
    this.saveSettings();
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
    this.store.setRenderSettings({ depthOfField: this.depthOfField(), dofStrength: this.dofStrength(), crop: this.crop(), ambient: this.ambient(), lamp: this.lamp(), beam: this.beam(), background: this.background(), ground: this.ground(), aspect: this.aspect(), transparent: this.transparent(), ...(this.trackId() ? { trackId: this.trackId() } : {}), trackPivot: this.trackPivot(), lookAt: this.lookAt(), reflections: this.reflections(), fx: this.fx(), cut: this.cut(), ...(this.focusId() ? { focusId: this.focusId() } : {}) });
  }

  /** The address parameters for the focus: `dof` and, with a part chosen that is still in the document, `focus`. */
  dofParams(url: URL) {
    url.searchParams.set('crop', String(this.crop()));
    url.searchParams.set('ambient', String(this.ambient()));
    url.searchParams.set('lamp', String(this.lamp()));
    url.searchParams.set('beam', String(this.beam()));
    url.searchParams.set('aspect', this.aspect());
    url.searchParams.set('reflections', String(this.reflections()));
    url.searchParams.set('fx', this.fx());
    url.searchParams.set('cut', this.cut());
    url.searchParams.set('transparent', String(this.transparent()));
    if (this.background() !== null) url.searchParams.set('bg', String(this.background()));
    if (this.ground() !== null) url.searchParams.set('floor', String(this.ground()));
    url.searchParams.set('dof', String(this.depthOfField()));
    url.searchParams.set('strength', String(this.dofStrength()));
    const focus = this.focusId();
    if (focus === focusCentre || (focus && this.store.doc().items.some(i => i.id === focus))) url.searchParams.set('focus', focus);
  }

  /** F12 / the Render button: asks for the render dialog. */
  requestOpen() {
    if (!this.dialog()) this.openRequests.update(n => n + 1);
  }

  /** The view the open Render dialog shows a picture of (what a saved view would hold). */
  quickView: Record<string, unknown> | null = null;

  /** The last quick picture with what it was made from: while that is unchanged (view, light, parts, render settings) the dialog shows it again instead of rendering. */
  lastQuick: { key: string; blob: Blob; detail: string; settings: string } | null = null;

  /** The Render button: a quick picture (shown at once by the dialog). */
  openQuick(url: string) {
    this.quickView = this.store.captureView?.() ?? null; // the camera, display, light and ground the picture is made from: kept with it, to come back to
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
      if (this.quickView) url.searchParams.set('savedView', JSON.stringify(this.quickView));
      await this.launch(url);
    } catch (error) {
      this.toast.set({ error: `Render failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  /** A turntable video of the quick picture's view: one turn in the chosen length at 30 frames per second, at most 4K wide. */
  async startTurntable(quickUrl: string) {
    this.toast.set(null);
    try {
      const url = new URL(quickUrl.replace('/render.png', '/render-jobs'), location.origin);
      this.dofParams(url);
      const spec = this.turntableSpec();
      url.searchParams.set('width', String(spec.width));
      url.searchParams.set('samples', String(spec.samples));
      url.searchParams.set('turntable', spec.motion);
      url.searchParams.set('direction', spec.direction);
      url.searchParams.set('seconds', String(spec.seconds));
      url.searchParams.set('fps', String(spec.fps));
      if (this.tracked()) url.searchParams.set('track', this.tracked()!.id); // the camera looks at it (both motions) ...
      url.searchParams.set('trackPivot', this.trackPivot()); // ... what it goes round (Camera circles only: with Objects turn the camera stays where the view is)
      url.searchParams.set('lookAt', this.lookAt());
      if (this.quickView) url.searchParams.set('savedView', JSON.stringify(this.quickView));
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
    if (Array.isArray(started.queue)) this.queue.set(started.queue);
    if (typeof started.queueMax === 'number') this.queueMax.set(started.queueMax);
    if (started.state === 'queued') { // another render runs: this one waits its turn (the running one stays on show)
      this.store.announce(`Render queued: ${started.position === 1 ? 'next' : 'number ' + started.position} in line. It is saved to the gallery when it is done`, 6000);
    } else {
      this.track(started);
      this.state.set(started); // the WebSocket keeps it up to date from here
      this.store.announce(started.kind === 'turntable' ? 'Turntable video started in the background: you get a message when it is ready' : 'Full-size render started in the background: you get a message when it is ready', 6000);
    }
    void this.poll(); // and the polling does when there is no WebSocket
  }

  /** Renders a picture of the gallery again at full size, with the camera, light and settings it was made with (the document as it is now). */
  async startFromNote(documentId: string, settings: Record<string, unknown>, width: number) {
    this.toast.set(null);
    try {
      const url = new URL(`/api/documents/${documentId}/render-jobs`, location.origin);
      const put = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value)); };
      put('view', settings['view']); put('light', settings['light']);
      put('dof', settings['depthOfField']); put('strength', settings['dofStrength']); put('focus', settings['focusId']);
      put('crop', settings['crop']); put('ambient', settings['ambient']); put('lamp', settings['lamp']); put('beam', settings['beam']);
      put('bg', settings['background']); put('floor', settings['ground']); put('aspect', settings['aspect']); put('transparent', settings['transparent']); put('reflections', settings['reflections']); put('fx', settings['fx']); put('cut', settings['cut']);
      if (settings['savedView']) url.searchParams.set('savedView', JSON.stringify(settings['savedView']));
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

  /** Takes one waiting render out of the queue. */
  async cancelWaiting(id: string) {
    this.queue.update(list => list.filter(q => q.id !== id));
    this.waiting.update(n => Math.max(0, n - 1));
    try { await fetch(`/api/render-jobs/${id}`, { method: 'DELETE' }); } catch { /* it is dropped with the queue */ }
  }

  /** "Cancel all": the running render stops and the queue is emptied. */
  async cancelAll() {
    this.track({ state: 'cancelled' });
    this.state.set(null);
    this.waiting.set(0);
    this.queue.set([]);
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
