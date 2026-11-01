import { Component, OnDestroy, OnInit, inject, input, output, signal } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { RenderService } from './render.service';
import { DocumentStore } from './document.store';

/**
 * A Cycles render of the scene (what the Blender file would render), made by the API through Blender in the background. Either a quick one
 * (800 px, a few seconds, shown here at once) or a finished full-size render (1920 px, 96 samples, about two minutes) that was made in the
 * background and is shown when its notice is clicked. "Render HD" starts a full-size one in the background and closes this dialog.
 */
@Component({
  selector: 'app-render-dialog',
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Render">
      <header>
        <h2>Render <small>{{ detail() }}</small></h2>
        <label class="check" title="Blurs what is in front of and behind the part nearest to the camera, like a real lens (needs the perspective camera: an orthographic view has no depth of field)">
          <input type="checkbox" [checked]="render.depthOfField()" (change)="toggleDepthOfField($any($event.target).checked)" /> Depth of field
        </label>
        @if (render.depthOfField()) {
          <select class="focus" [value]="focusValue()" title="The part that is sharp. Automatic: the part nearest to the camera that is in the picture." (change)="chooseFocus($any($event.target).value)">
            <option value="" [selected]="!focusValue()">Focus: nearest in the picture</option>
            @for (part of parts(); track part.id) { <option [value]="part.id" [selected]="part.id === focusValue()">Focus: {{ part.label }}</option> }
          </select>
          <button type="button" [disabled]="!selected()" title="Focus on the part that is selected in the document" (click)="chooseFocus(selected()!)">Selected</button>
          <select class="focus strength" [value]="render.dofStrength()" title="How blurred what is far from the focus is. Medium: unsharp but still recognizable." (change)="chooseStrength(+$any($event.target).value)">
            @for (level of strengths; track level.value) { <option [value]="level.value" [selected]="level.value === render.dofStrength()">Blur: {{ level.label }}</option> }
          </select>
        }
        @if (picture()) { <a class="button" [href]="picture()" [download]="fileName()">Download PNG</a> }
        @if (url()) { <button type="button" [disabled]="busy()" title="800 px, 24 samples: a few seconds" (click)="quick()">Quick render</button> }
        @if (url()) {
          <button type="button" [disabled]="render.running()" [title]="render.running() ? 'A render is running already' : '1920 px, 96 samples: about two minutes, in the background (you get a message when it is ready)'" (click)="startFullSize()">
            @if (render.running()) { <span class="spinner small"></span> }Render HD
          </button>
        }
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      @if (busy()) { <div class="busy"><span class="spinner"></span>{{ busyText() }}</div> }
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (picture()) { <img [src]="picture()" alt="Render of the document" /> }
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 10; }
    .dialog { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(960px, 94vw); max-height: 92vh; overflow: auto;
              padding: 14px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
    h2 { margin: 0 auto 0 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    .focus.strength { max-width: 130px; }
    .focus { max-width: 230px; padding: 3px 6px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; }
    .check { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; cursor: pointer; user-select: none; } .check input { margin: 0; }
    button, .button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; text-decoration: none; }
    button:hover:not(:disabled), .button:hover { background: #2f6fed; color: #fff; } button:disabled { opacity: .5; cursor: default; } .x { padding: 2px 8px; background: transparent; border: 0; }
    img { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; }
    .busy { display: flex; align-items: center; gap: 10px; padding: 24px 4px; opacity: .85; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.25); border-top-color: #2f6fed; border-radius: 50%; animation: spin .8s linear infinite; } .spinner.small { width: 11px; height: 11px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { margin: 0 0 10px; padding: 6px 8px; background: #3a2323; border: 1px solid #7a3030; border-radius: 6px; }
  `,
})
export class RenderDialog implements OnInit, OnDestroy {
  protected readonly render = inject(RenderService);
  /** The API address of the quick picture (`…/render.png?…`), with the camera and the light of the 3D view; empty when a finished render is shown. */
  readonly url = input('');
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
  protected fileName = () => `${this.name().replace(/[^\w.-]+/g, '_')}-render.png`;

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

  protected async quick() {
    this.busyText.set('Rendering a preview with Blender (800 px, a few seconds)…');
    this.busy.set(true);
    this.error.set('');
    try {
      const quickUrl = new URL(this.url(), location.origin);
      this.render.dofParams(quickUrl);
      const response = await fetch(quickUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      this.show(await response.blob(), `800 px · 24 samples${this.render.depthOfField() ? ' · depth of field' : ''}`);
    } catch (error) {
      this.error.set(`Render failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy.set(false);
    }
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
