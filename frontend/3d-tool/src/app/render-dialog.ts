import { Component, OnDestroy, OnInit, inject, input, output, signal } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { RenderService } from './render.service';

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
    header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    h2 { margin: 0 auto 0 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
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
      const response = await fetch(this.url(), { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      this.show(await response.blob(), '800 px · 24 samples');
    } catch (error) {
      this.error.set(`Render failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async startFullSize() {
    await this.render.startFullSize(this.url());
    this.close.emit(); // it runs in the background now
  }
}
