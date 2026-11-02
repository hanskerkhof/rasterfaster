import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { RenderService, hdWidths } from './render.service';
import { DocumentStore } from './document.store';
import { ColorPalette } from './color-palette';

/**
 * A Cycles render of the scene (what the Blender file would render), made by the API through Blender in the background. Either a quick one
 * (800 px, a few seconds, shown here at once) or a finished full-size render (1920 px, 96 samples, about two minutes) that was made in the
 * background and is shown when its notice is clicked. "Render HD" starts a full-size one in the background and closes this dialog.
 */
@Component({
  selector: 'app-render-dialog',
  imports: [ColorPalette],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Render">
      <header>
        <h2>Render <small>{{ detail() }}</small></h2>
        <label class="check" title="Crop: the picture is only as wide as the objects (the height stays: 450 px for the quick render, 1080 px for HD), so a tall stack gives a narrow picture and a row of parts a wide one">
          <input type="checkbox" [checked]="render.crop()" (change)="toggleCrop($any($event.target).checked)" /> Crop
        </label>
        <label class="check" title="Blurs what is in front of and behind the part nearest to the camera, like a real lens (needs the perspective camera: an orthographic view has no depth of field)">
          <input type="checkbox" [checked]="render.depthOfField()" (change)="toggleDepthOfField($any($event.target).checked)" /> Depth of field
        </label>
        @if (render.depthOfField() && orthographic()) { <span class="dofnote" title="An orthographic view has no depth of field: switch the 3D view to the perspective camera">⚠ needs a perspective view</span> }
          <select class="focus" [disabled]="!render.depthOfField()" [value]="focusValue()" title="The part that is sharp. Automatic: the part nearest to the camera that is in the picture." (change)="chooseFocus($any($event.target).value)">
            <option value="" [selected]="!focusValue()">Focus: nearest in the picture</option>
            @for (part of parts(); track part.id) { <option [value]="part.id" [selected]="part.id === focusValue()">Focus: {{ part.label }}</option> }
          </select>
          <button type="button" [disabled]="!render.depthOfField() || !selected()" [title]="selected() ? 'Focus on the part that is selected in the document' : 'Select a part in the document before you open the Render dialog: it is then focused on that part with one click'" (click)="chooseFocus(selected()!)">Selected</button>
          <select class="focus strength" [disabled]="!render.depthOfField()" [value]="render.dofStrength()" title="How blurred what is far from the focus is. Medium: unsharp but still recognizable." (change)="chooseStrength(+$any($event.target).value)">
            @for (level of strengths; track level.value) { <option [value]="level.value" [selected]="level.value === render.dofStrength()">Blur: {{ level.label }}</option> }
          </select>
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      <div class="lighting" aria-label="Lighting">
        <span class="bar-title">Lighting</span>
        <select class="focus strength" [value]="render.ambient()" title="Ambient light: a big soft light above the scene that lightens the shadows." (change)="chooseAmbient(+$any($event.target).value)">
          @for (level of ambients; track level.value) { <option [value]="level.value" [selected]="level.value === render.ambient()">Ambient: {{ level.label }}</option> }
        </select>
        <select class="focus strength" [value]="render.beam()" title="The type of the lamp: from a spotlight (razor-sharp shadows) to a flood (very soft shadows)" (change)="chooseBeam(+$any($event.target).value)">
          @for (type of beams; track type.value) { <option [value]="type.value" [selected]="type.value === render.beam()">Lamp: {{ type.label }}</option> }
        </select>
        <label class="lamp" title="The strength of the lamp pointed at the parts: left is darker, right is brighter. Two thirds of the way is the normal strength (double-click to go back to it).">Lamp
          <input type="range" min="0" max="60" step="1" [value]="render.lamp()" (input)="render.setLamp(+$any($event.target).value)" (change)="lampChanged()" (dblclick)="resetLamp()" />
          <output class="lamp-value">{{ lampText() }}</output>
        </label>
        @for (target of colourTargets; track target.key) {
          <span class="colour">
            <button type="button" class="swatch-button" [title]="target.title" (click)="colourOpen.set(colourOpen() === target.key ? null : target.key)">
              <i class="chip" [style.background]="hex(colourOf(target.key))"></i>{{ target.label }}
            </button>
            @if (colourOpen() === target.key) {
              <div class="colour-backdrop" (click)="colourOpen.set(null)"></div>
              <div class="flyout" role="menu" [attr.aria-label]="target.label + ' colour'">
                <app-color-palette [isOn]="isColour(target.key)" (picked)="chooseColour(target.key, $event)" />
                <button type="button" class="studio" (click)="chooseColour(target.key, null)">Studio default</button>
              </div>
            }
          </span>
        }
      </div>
      <div class="actions">
        @if (url()) {
          <button type="button" [disabled]="busy()" title="800 px, 24 samples: a few seconds" (click)="quick(true)">
            @if (busy()) { <span class="spinner small"></span> } @else if (quickReady()) { <svg class="tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="The quick render is ready"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg> }Quick render
          </button>
        }
        @if (url()) {
          <select class="focus size" [disabled]="render.running()" [value]="render.hdWidth()" title="The size of the full-size render: larger pictures take much longer" (change)="render.setHdWidth(+$any($event.target).value)">
            @for (size of hdSizes; track size.width) { <option [value]="size.width" [selected]="size.width === render.hdWidth()">{{ size.label }}</option> }
          </select>
          <button type="button" [disabled]="render.running()" [title]="render.running() ? 'A render is running already' : render.hdWidth() + ' px, 96 samples: in the background, about two minutes at 1920 px and longer for larger pictures (you get a message when it is ready)'" (click)="startFullSize()">
            @if (render.running()) { <span class="spinner small"></span> }Render HD
          </button>
        }
        @if (picture()) {
          <a class="button download" [href]="picture()" [download]="fileName()" [title]="url() ? 'Save the quick render (800 px) as a PNG file' : 'Save the full-size render as a PNG file'">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>
            {{ url() ? 'Download quick render PNG' : 'Download HD render PNG' }}
          </a>
        }
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <div class="frame">
        @if (picture()) { <img [src]="picture()" alt="Render of the document" [class.dim]="busy()" /> } @else { <div class="placeholder"></div> }
        @if (busy()) { <div class="over"><span class="spinner big"></span><span>{{ busyText() }}</span></div> }
      </div>
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 10; }
    .dialog { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(960px, 94vw); max-height: 92vh; overflow: auto;
              padding: 14px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; padding-right: 34px; }
    .actions { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; } .actions .download { margin-left: auto; } /* room for the close button, which stays in the corner */
    h2 { margin: 0 auto 0 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    .lighting { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; } .bar-title { font-weight: 600; opacity: .7; }
    .lamp-value { min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
    .colour { position: relative; display: inline-block; }
    .swatch-button .chip { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(255,255,255,.35); }
    .colour-backdrop { position: fixed; inset: 0; z-index: 12; background: transparent; }
    .flyout { position: absolute; z-index: 13; top: calc(100% + 4px); left: 0; padding: 8px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .flyout .studio { display: block; margin-top: 8px; width: 100%; justify-content: center; }
    .lamp { display: inline-flex; align-items: center; gap: 6px; } .lamp input { width: 130px; margin: 0; accent-color: #2f6fed; }
    .focus.strength { max-width: 150px; } .focus.size { max-width: 200px; }
    .focus:disabled { opacity: .45; cursor: default; }
    .focus { max-width: 230px; padding: 3px 6px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; }
    .check { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; cursor: pointer; user-select: none; } .check input { margin: 0; }
    .dofnote { font-size: 12px; color: #f0b429; white-space: nowrap; }
    button, .button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; text-decoration: none; }
    button:hover:not(:disabled), .button:hover { background: #2f6fed; color: #fff; } button:disabled { opacity: .5; cursor: default; } .x { position: absolute; top: 10px; right: 10px; padding: 2px 8px; background: transparent; border: 0; }
    img { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; }
    .frame { position: relative; } .placeholder { width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: #0b0c0f; border: 1px dashed rgba(255,255,255,.12); box-sizing: border-box; } img.dim { filter: brightness(.45) blur(1px); transition: filter .2s; }
    .over { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #fff; text-shadow: 0 1px 4px #000; }
    .spinner.big { width: 44px; height: 44px; border-width: 4px; }
    .busy { display: flex; align-items: center; gap: 10px; padding: 24px 4px; opacity: .85; }
    .tick { color: #5bd68a; flex: none; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.25); border-top-color: #2f6fed; border-radius: 50%; animation: spin .8s linear infinite; } .spinner.small { width: 11px; height: 11px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { margin: 0 0 10px; padding: 6px 8px; background: #3a2323; border: 1px solid #7a3030; border-radius: 6px; }
  `,
})
export class RenderDialog implements OnInit, OnDestroy {
  protected readonly render = inject(RenderService);
  /** The API address of the quick picture (`…/render.png?…`), with the camera and the light of the 3D view; empty when a finished render is shown. */
  readonly url = input('');
  /** The quick render's view is orthographic (the URL carries `view=…;ortho`): no depth of field then. */
  protected readonly orthographic = computed(() => /view=[^&]*%3Bortho/.test(this.url()));
  /** A finished full-size render to show. */
  readonly jobId = input('');
  readonly name = input('document');
  readonly close = output<void>();
  protected readonly picture = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly detail = signal('');
  protected readonly busyText = signal('Rendering a preview with Blender (800 px, a few seconds)…');
  protected readonly store = inject(DocumentStore);
  /** The parts of the document to choose the focus from (equal names are numbered). */
  protected parts() {
    const seen = new Map<string, number>();
    return this.store.doc().items.map(item => {
      const n = (seen.get(item.name) ?? 0) + 1;
      seen.set(item.name, n);
      return { id: item.id, label: n > 1 ? `${item.name} (${n})` : item.name };
    });
  }
  protected readonly strengths = [{ value: 1, label: 'Subtle' }, { value: 2, label: 'Soft' }, { value: 3, label: 'Medium' }, { value: 4, label: 'Strong' }, { value: 5, label: 'Extreme' }];
  protected readonly ambients = [{ value: 0, label: 'None' }, { value: 1, label: 'Soft glow' }, { value: 2, label: 'Overcast' }, { value: 3, label: 'Softbox' }, { value: 4, label: 'Daylight' }, { value: 5, label: 'Bright studio' }];
  /** The lamp as a share of its normal strength: every 10 steps of the slider double or halve it. */
  protected readonly beams = [{ value: 0, label: 'Spot' }, { value: 1, label: 'Direct' }, { value: 2, label: 'Soft' }, { value: 3, label: 'Diffuse' }, { value: 4, label: 'Flood' }];
  protected chooseBeam(type: number) {
    this.render.setBeam(type);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected readonly hdSizes = hdWidths;
  protected readonly colourTargets = [
    { key: 'background' as const, label: 'Background', title: 'The colour of the background behind the parts (the studio default is dark)' },
    { key: 'ground' as const, label: 'Ground', title: 'The colour of the round ground the parts stand on (the studio default is dark)' },
  ];
  protected readonly colourOpen = signal<'background' | 'ground' | null>(null);
  protected colourOf(key: 'background' | 'ground') {
    return key === 'background' ? this.render.background() : this.render.ground();
  }
  protected hex(colour: number | null) {
    return colour === null ? '#1b1d23' : '#' + colour.toString(16).padStart(6, '0'); // the studio's own colours are about this dark
  }
  protected isColour(key: 'background' | 'ground') {
    return (colour: number) => this.colourOf(key) === colour;
  }
  protected chooseColour(key: 'background' | 'ground', colour: number | null) {
    key === 'background' ? this.render.setBackground(colour) : this.render.setGround(colour);
    this.colourOpen.set(null);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected lampText() {
    const share = 2 ** ((this.render.lamp() - 40) / 10) * 100;
    return `${share >= 100 ? Math.round(share) : Math.round(share * 10) / 10} %`;
  }
  protected lampChanged() {
    if (this.url() && !this.busy()) void this.quick();
  }
  protected resetLamp() {
    this.render.setLamp(40);
    this.lampChanged();
  }
  protected chooseAmbient(level: number) {
    this.render.setAmbient(level);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected chooseStrength(level: number) {
    this.render.setDofStrength(level);
    if (this.url() && !this.busy()) void this.quick();
  }
  protected selected() { return this.store.selectedId(); }
  protected focusValue() { const id = this.render.focusId(); return id && this.store.doc().items.some(i => i.id === id) ? id : ''; }
  protected chooseFocus(id: string) {
    this.render.setFocus(id || null);
    if (this.url() && !this.busy()) void this.quick();
  }
  /** The quick render is on show (it turns the button's spinner into a tick). */
  protected readonly quickReady = signal(false);
  protected fileName = () => `${this.name().replace(/[^\w.-]+/g, '_')}-render-${this.url() ? 'quick' : 'hd'}.png`;

  constructor() {
    closeOnEscape(() => this.close.emit());
  }

  ngOnInit() {
    void (this.jobId() ? this.finished() : this.quick());
  }

  ngOnDestroy() {
    this.forget();
  }

  private forget() {
    if (this.picture()) URL.revokeObjectURL(this.picture());
  }

  private show(blob: Blob, detail: string) {
    this.forget();
    this.picture.set(URL.createObjectURL(blob));
    this.detail.set(detail);
  }

  /** The full-size render that was made in the background. */
  private async finished() {
    this.busyText.set('Loading the render…');
    this.busy.set(true);
    try {
      const id = this.jobId();
      const status = await (await fetch(`/api/render-jobs/${id}`, { cache: 'no-store' })).json();
      const response = await fetch(`/api/render-jobs/${id}/image.png`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      this.show(await response.blob(), `${status.width} px · ${status.samples} samples · ${Math.floor(status.elapsed / 60)}:${String(Math.round(status.elapsed % 60)).padStart(2, '0')}`);
      void this.render.collect(id); // looked at: the API can forget it (the picture stays here until the dialog closes)
    } catch (error) {
      this.error.set(`The render is not available any more: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async quick(force = false) {
    const quickUrl = new URL(this.url(), location.origin);
    this.render.dofParams(quickUrl);
    const key = quickUrl.href + '\n' + JSON.stringify(this.store.doc().items); // clean (nothing changed since the last picture) or dirty (render again)
    const last = this.render.lastQuick;
    if (!force && last?.key === key) {
      this.error.set('');
      this.show(last.blob, last.detail);
      this.quickReady.set(true);
      return;
    }
    this.quickReady.set(false);
    this.busyText.set('Rendering a preview with Blender (800 px, a few seconds)…');
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch(quickUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const blob = await response.blob();
      const detail = `800 px · 24 samples${this.render.crop() ? ' · cropped' : ''}${this.render.depthOfField() ? ' · depth of field' : ''}`;
      this.render.lastQuick = { key, blob, detail };
      this.show(blob, detail);
      this.quickReady.set(true);
    } catch (error) {
      this.error.set(`Render failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleCrop(on: boolean) {
    this.render.setCrop(on);
    if (this.url() && !this.busy()) void this.quick();
  }

  /** The checkbox: remembered, and the quick picture on show is made again with it. */
  protected toggleDepthOfField(on: boolean) {
    this.render.setDepthOfField(on);
    if (this.url() && !this.busy()) void this.quick();
  }

  protected async startFullSize() {
    await this.render.startFullSize(this.url());
    this.close.emit(); // it runs in the background now
  }
}
