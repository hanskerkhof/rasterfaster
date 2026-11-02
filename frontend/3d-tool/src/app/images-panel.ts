import { Component, ElementRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { DocumentStore } from './document.store';
import { ImageNote, ImagesService } from './images.service';
import { ReleaseFocus } from './release-focus';

const storageKey = 'rasterfaster.imagesPanel';

interface Spot { left: number; top: number }

function read(): { spot: Spot | null; collapsed: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const spot = stored && Number.isFinite(stored.left) && Number.isFinite(stored.top) ? { left: stored.left, top: stored.top } : null;
    return { spot, collapsed: stored?.collapsed === true };
  } catch { return { spot: null, collapsed: false }; }
}

/**
 * The image library of the document in a floating panel: finished full-size renders arrive here by themselves, quick renders are kept from the
 * render dialog. Every picture carries the document version it was made from, so the ones of old versions are easy to clear in one go.
 * Drag the title bar to move it, ▾ folds it, I (or ✕) closes and opens it.
 */
@Component({
  selector: 'app-images-panel',
  imports: [ReleaseFocus],
  host: { '[style.left.px]': 'spot()?.left', '[style.top.px]': 'spot()?.top', '[class.placed]': 'spot() !== null', '[class.collapsed]': 'collapsed()' },
  template: `
    <div class="head" (pointerdown)="startDrag($event)" title="Drag to move the panel">
      <button type="button" class="fold" releaseFocus [attr.aria-expanded]="!collapsed()" [title]="collapsed() ? 'Expand the images' : 'Collapse the images'" (pointerdown)="$event.stopPropagation()" (click)="toggle()">{{ collapsed() ? '▸' : '▾' }}</button>
      <span class="title">Images</span>
      @if (service.images().length) { <span class="count">{{ service.images().length }}</span> }
      <button type="button" class="x close" releaseFocus title="Close the panel (I)" (pointerdown)="$event.stopPropagation()" (click)="store.toggleImages()">✕</button>
    </div>
    @if (!collapsed()) {
      @if (service.error()) { <div class="error">{{ service.error() }}</div> }
      @if (service.images().length) {
        <div class="clean">
          <span class="label">Clean up</span>
          @if (olderCount() > 0) { <button type="button" [class.sure]="confirming() === 'older'" (click)="clean('older')" [title]="'Delete the pictures made from versions older than v' + store.version()">{{ confirming() === 'older' ? 'Really delete ' + olderCount() + '?' : 'Older than v' + store.version() + ' (' + olderCount() + ')' }}</button> }
          @if (quickCount() > 0) { <button type="button" [class.sure]="confirming() === 'quick'" (click)="clean('quick')" title="Delete the quick renders you kept">{{ confirming() === 'quick' ? 'Really delete ' + quickCount() + '?' : 'Quick renders (' + quickCount() + ')' }}</button> }
          @if (olderCount() === 0 && quickCount() === 0) { <span class="muted">nothing to clear</span> }
        </div>
      }
      <div class="grid">
        @for (note of service.images(); track note.id) {
          <div class="card" (click)="show(note)" [title]="note.name + ' · ' + note.width + ' × ' + note.height + ' px · click to view large'">
            <div class="thumb">
              @if (note.thumb) { <img [src]="service.thumbSrc(note)" [alt]="note.name" loading="lazy" /> } @else { <span class="spinner"></span> }
              <span class="kind">{{ note.kind === 'hd' ? 'HD' : 'Quick' }}</span>
            </div>
            <div class="caption"><span class="name">{{ note.name }}</span><span class="ver" [class.current]="note.version === store.version()" [title]="'Made from version ' + note.version + (note.edited ? ' (with changes after it)' : '')">{{ versionLabel(note) }}</span></div>
          </div>
        } @empty { <div class="empty">No pictures yet. Full-size renders are kept here by themselves; in the Render dialog, <b>Save to library</b> keeps a quick render.</div> }
      </div>
      <details class="keys"><summary>Keys and mouse</summary>
        <div class="hint">Full-size renders arrive here by themselves when they are done · Render dialog ▸ <b>Save to library</b> keeps a quick render · click a picture: view it large, download, rename (double-click the name) or delete it (a second click confirms) · Esc closes the large view · every picture carries the document version it was made from: <b>v13</b>, <b>v13*</b> when the working copy was ahead of it · green: the current version · Clean up: delete the pictures of older versions, or the quick renders, in one go (a second click confirms) · I: show or hide this panel · drag the title bar: move it · ▾: fold it · the pictures live next to the document and go with it when it is deleted</div>
      </details>
    }
    @if (viewing(); as note) {
      <div class="backdrop" (click)="viewing.set(null)"></div>
      <section class="viewer" role="dialog" aria-label="Image">
        <header>
          @if (renaming()) {
            <input #nameInput class="rename" [value]="note.name" maxlength="120" (keydown)="onNameKey($event, nameInput)" (blur)="commitName(note, nameInput.value)" />
          } @else { <b class="vname" title="Double-click to rename" (dblclick)="startRename()">{{ note.name }}</b> }
          <span class="meta">{{ note.width }} × {{ note.height }} px · {{ note.samples }} samples · {{ minutes(note.elapsed) }} · {{ versionLabel(note) }}{{ note.edited && note.version ? ' (edited)' : '' }} · {{ megabytes(note.bytes) }}</span>
          <a class="button" [href]="service.downloadSrc(note)" [download]="''" title="Save the picture as a PNG file">Download</a>
          <button type="button" [class.sure]="confirmDelete()" (click)="remove(note)" title="Delete this picture">{{ confirmDelete() ? 'Really delete?' : 'Delete' }}</button>
          <button type="button" class="x" title="Close (Esc)" (click)="viewing.set(null)">✕</button>
        </header>
        <img [src]="service.src(note)" [alt]="note.name" />
      </section>
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 40; }
    .viewer { position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(1200px, 94vw); max-height: 92vh; display: flex; flex-direction: column; gap: 8px; padding: 12px;
              background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 13px; }
    .viewer header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .vname { font-size: 14px; cursor: text; } .meta { flex: 1; min-width: 0; color: #8a93a2; }
    .viewer img { max-width: 100%; max-height: calc(92vh - 90px); object-fit: contain; align-self: center; background: #16181d; border-radius: 4px; }
    .viewer .rename { font: inherit; font-size: 14px; color: inherit; background: #1b1d23; border: 1px solid #2f6fed; border-radius: 3px; padding: 1px 4px; outline: none; min-width: 200px; }
    .button { padding: 2px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; text-decoration: none; } .button:hover { background: #2f6fed; color: #fff; }
    .viewer button.sure { background: #a33a3a; color: #fff; }
    :host { position: absolute; left: 12px; bottom: 36px; z-index: 5; width: 280px; max-height: 60%; display: flex; flex-direction: column; box-sizing: border-box; font-size: 12px; color: #dde1e8;
            background: rgba(35,38,45,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; }
    :host(.placed) { bottom: auto; }
    .head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: grab; user-select: none; touch-action: none; } .head:active { cursor: grabbing; }
    .title { font-weight: 600; } .count { color: #8a93a2; font-size: 11px; } .close { margin-left: auto; }
    button { background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; padding: 2px 8px; cursor: pointer; } button:hover { background: #2f6fed; color: #fff; }
    .fold { padding: 0 4px; background: transparent; border: 0; } .fold:hover { background: transparent; color: #fff; }
    .x { padding: 0 5px; background: transparent; border: 0; opacity: .7; } .x:hover { opacity: 1; background: transparent; color: #fff; }
    .error { margin: 0 6px 6px; padding: 4px 6px; background: #3a2323; border: 1px solid #7a3030; border-radius: 4px; }
    .clean { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 6px 6px; } .clean .label { color: #8a93a2; } .muted { color: #8a93a2; }
    .clean button { padding: 1px 6px; font-size: 11px; } .clean button.sure { background: #a33a3a; color: #fff; }
    .grid { overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 6px 6px; }
    .card { cursor: pointer; border-radius: 4px; background: rgba(255,255,255,.04); overflow: hidden; } .card:hover { background: rgba(255,255,255,.1); }
    .thumb { position: relative; aspect-ratio: 16 / 9; background: #16181d; display: flex; align-items: center; justify-content: center; }
    .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .kind { position: absolute; left: 3px; top: 3px; padding: 0 4px; font-size: 10px; border-radius: 3px; background: rgba(0,0,0,.6); }
    .caption { display: flex; align-items: center; gap: 4px; padding: 3px 5px; } .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ver { flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px; background: #3b404c; color: #b9c0cc; } .ver.current { background: #1f6b4a; color: #fff; }
    .keys { flex: none; padding: 0 6px 6px; } .keys summary { cursor: pointer; opacity: .6; font-size: 11px; user-select: none; } .keys summary:hover { opacity: 1; } .keys[open] .hint { margin-top: 4px; }
    .keys .hint { font-size: 11px; line-height: 1.45; opacity: .75; overflow-y: auto; max-height: 160px; }
    .empty { grid-column: 1 / -1; padding: 4px 2px; color: #8a93a2; }
    .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.25); border-top-color: #2f6fed; border-radius: 50%; animation: spin .8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class ImagesPanel {
  protected readonly store = inject(DocumentStore);
  protected readonly service = inject(ImagesService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly initial = read();
  protected readonly spot = signal<Spot | null>(this.initial.spot);
  protected readonly collapsed = signal(this.initial.collapsed);
  protected readonly confirming = signal<'older' | 'quick' | null>(null);
  /** The picture shown large. */
  protected readonly viewing = signal<ImageNote | null>(null);
  protected readonly olderCount = computed(() => this.service.images().filter(n => n.version < this.store.version()).length);
  protected readonly quickCount = computed(() => this.service.images().filter(n => n.kind === 'quick').length);

  constructor() {
    effect(() => this.remember(this.spot(), this.collapsed()));
    closeOnEscape(() => this.viewing.set(null), () => this.viewing() !== null && !this.renaming());
  }

  private remember(spot: Spot | null, collapsed: boolean) {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...spot, collapsed })); } catch { /* storage unavailable */ }
  }

  protected readonly renaming = signal(false);
  protected readonly confirmDelete = signal(false);

  protected toggle() { this.collapsed.update(v => !v); }
  /** v13, v13* when the working copy was ahead of it, and a dash when no version had been saved yet. */
  protected versionLabel(note: ImageNote) { return note.version ? `v${note.version}${note.edited ? '*' : ''}` : 'no version'; }
  protected minutes(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`; }
  protected megabytes(bytes: number) { return `${(bytes / 1e6).toFixed(1)} MB`; }

  protected startRename() {
    this.renaming.set(true);
    setTimeout(() => { const input = this.element.nativeElement.querySelector<HTMLInputElement>('input.rename'); input?.focus(); input?.select(); });
  }
  protected onNameKey(event: KeyboardEvent, input: HTMLInputElement) {
    event.stopPropagation();
    if (event.key === 'Enter') input.blur();
    else if (event.key === 'Escape') { input.value = this.viewing()?.name ?? ''; input.blur(); }
  }
  protected async commitName(note: ImageNote, name: string) {
    if (!this.renaming()) return;
    this.renaming.set(false);
    await this.service.rename(note, name);
    const updated = this.service.images().find(n => n.id === note.id);
    if (updated) this.viewing.set(updated);
  }
  protected async remove(note: ImageNote) {
    if (!this.confirmDelete()) { this.confirmDelete.set(true); setTimeout(() => this.confirmDelete.set(false), 4000); return; }
    this.confirmDelete.set(false);
    this.viewing.set(null);
    await this.service.remove(note);
  }
  protected show(note: ImageNote) { this.viewing.set(note); }

  /** Two clicks: the first asks, the second deletes. */
  protected async clean(what: 'older' | 'quick') {
    if (this.confirming() !== what) { this.confirming.set(what); setTimeout(() => this.confirming.update(c => (c === what ? null : c)), 4000); return; }
    this.confirming.set(null);
    await this.service.removeMatching(what === 'older' ? { beforeVersion: this.store.version() } : { kind: 'quick' });
  }

  @HostListener('document:pointerdown', ['$event'])
  protected away(event: PointerEvent) {
    if (this.confirming() && !(event.target as HTMLElement | null)?.closest('.clean')) this.confirming.set(null);
  }

  /** Dragging the title bar moves the panel; it stays inside the 3D view. */
  protected startDrag(event: PointerEvent) {
    if (event.button !== 0) return;
    const host = this.element.nativeElement;
    const parent = host.offsetParent as HTMLElement | null;
    if (!parent) return;
    const box = host.getBoundingClientRect(), area = parent.getBoundingClientRect();
    const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top;
    const move = (e: PointerEvent) => {
      const left = Math.min(Math.max(0, e.clientX - area.left - offsetX), Math.max(0, parent.clientWidth - box.width));
      const top = Math.min(Math.max(0, e.clientY - area.top - offsetY), Math.max(0, parent.clientHeight - 28));
      this.spot.set({ left, top });
    };
    const end = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
    event.preventDefault();
  }
}
