import { Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { closeOnEscape } from './escape-close';
import { DocumentStore } from './document.store';
import { ImageNote, ImagesService } from './images.service';
import { RenderService, ambientNames, aspectRatio, reflectionNames, fxIds, fxNames, beamNames, hdWidths, strengthNames } from './render.service';
import { ReleaseFocus } from './release-focus';

const storageKey = 'rasterfaster.imagesPanel';

interface Geometry { left: number; top: number; width?: number; height?: number }

const minWidth = 220, minHeight = 150;
const defaultWidth = 280; // as in the styles

function read(): { geom: Geometry | null; collapsed: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const geom = stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)
      ? { left: stored.left, top: stored.top, ...(Number.isFinite(stored.width) && Number.isFinite(stored.height) ? { width: stored.width, height: stored.height } : {}) } : null;
    return { geom, collapsed: stored?.collapsed === true };
  } catch { return { geom: null, collapsed: false }; }
}

/**
 * The gallery of the document in a floating panel: finished full-size renders arrive here by themselves, quick renders are kept from the
 * render dialog. Every picture carries the document version it was made from, so the ones of old versions are easy to clear in one go.
 * Drag the title bar to move it, ▾ folds it, I (or ✕) closes and opens it.
 */
@Component({
  selector: 'app-images-panel',
  imports: [ReleaseFocus],
  host: {
    '(dragover)': 'onDragOver($event)', '(dragleave)': 'dropping.set(false)', '(drop)': 'onDrop($event)', '[class.dropping]': 'dropping()',
    '[style.left]': 'leftCss()', '[style.top]': 'topCss()', '[style.width.px]': 'geom()?.width', '[style.height.px]': 'collapsed() ? null : geom()?.height',
    '[class.placed]': 'geom() !== null', '[class.sized]': 'geom()?.height !== undefined', '[class.collapsed]': 'collapsed()', '[style.max-height]': "geom()?.height !== undefined ? 'none' : null",
  },
  template: `
    @if (!collapsed()) {
      <div class="edge w" (pointerdown)="startDrag($event, 'w')"></div>
      <div class="edge e" (pointerdown)="startDrag($event, 'e')"></div>
      <div class="edge s" (pointerdown)="startDrag($event, 's')"></div>
      <div class="edge sw" (pointerdown)="startDrag($event, 'sw')"></div>
      <div class="edge se" (pointerdown)="startDrag($event, 'se')"></div>
    }
    <div class="head" (pointerdown)="startDrag($event, 'move')" (dblclick)="resetGeometry()" title="Drag to move the panel · double-click to put it back">
      <button type="button" class="fold" releaseFocus [attr.aria-expanded]="!collapsed()" [title]="collapsed() ? 'Expand the gallery' : 'Collapse the gallery'" (pointerdown)="$event.stopPropagation()" (click)="toggle()">{{ collapsed() ? '▸' : '▾' }}</button>
      <span class="title">Gallery</span>
      @if (service.images().length) { <span class="count">{{ service.images().length }}</span> }
      <button type="button" class="add" releaseFocus title="Put a PNG picture or an MP4 video of your own in the gallery (or drop files on the panel)" (pointerdown)="$event.stopPropagation()" (click)="fileInput.click()">Add file…</button>
      <input #fileInput type="file" hidden multiple accept="image/png,video/mp4,.png,.mp4" (change)="addFiles($any($event.target).files); $any($event.target).value = ''" />
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
          <div class="card" (click)="show(note)" (contextmenu)="openMenu($event, note)" [title]="note.name + ' · ' + note.width + ' × ' + note.height + ' px · click to view large · right-click: menu'">
            <div class="thumb">
              @if (note.thumb) { <img [src]="service.thumbSrc(note)" [alt]="note.name" loading="lazy" /> } @else { <span class="spinner"></span> }
              <span class="kind">{{ badge(note) }}</span>
            </div>
            <div class="caption"><span class="name">{{ note.name }}</span><span class="ver" [class.current]="note.version === store.version()" [title]="'Made from version ' + note.version + (note.edited ? ' (with changes after it)' : '')">{{ versionLabel(note) }}</span></div>
          </div>
        } @empty { <div class="empty">Nothing here yet. Full-size renders and turntable videos are kept here by themselves; in the Render dialog, <b>Save quick render to gallery</b> keeps a quick render; <b>Add file…</b> (or drop files on the panel) puts a PNG or MP4 of your own here.</div> }
      </div>
      <details class="keys"><summary>Keys and mouse</summary>
        <div class="hint">Full-size renders arrive here by themselves when they are done · Render dialog ▸ <b>Save quick render to gallery</b> keeps a quick render · right-click a picture for a menu (view, download, rename, render HD again, delete) · click a picture: view it large, Go to view brings the camera, display, light and ground it was made from back (to carry on working), Save as view puts that view in the Views panel, download, rename (double-click the name) or delete it (a second click confirms) · Esc closes the large view · ← and → (or the arrows on the picture) go through the pictures · every picture carries the document version it was made from: <b>v13</b>, <b>v13*</b> when the working copy was ahead of it · green: the current version · Clean up: delete the pictures of older versions, or the quick renders, in one go (a second click confirms) · I: show or hide this panel · drag the title bar: move it, drag an edge or corner: resize it, double-click the title bar: put it back · ▾: fold it · the pictures live next to the document and go with it when it is deleted</div>
      </details>
    }
    @if (menu(); as m) {
      <div class="backdrop menu-backdrop" (mousedown)="closeMenu()" (contextmenu)="$event.preventDefault(); closeMenu()"></div>
      <div class="menu" role="menu" [style.left.px]="m.x" [style.top.px]="m.y">
        <div class="mtitle">{{ m.note.name }} <span>{{ versionLabel(m.note) }}</span></div>
        <button type="button" role="menuitem" (click)="menuView(m.note)"><span class="icon">⤢</span>View large</button>
        <a role="menuitem" class="item" [href]="service.downloadSrc(m.note)" download (click)="closeMenu()"><span class="icon">⤓</span>Download PNG</a>
        <button type="button" role="menuitem" (click)="menuRename(m.note)"><span class="icon">✎</span>Rename…</button>
        @if (m.note.settings?.savedView) {
          <button type="button" role="menuitem" (click)="menuGoToView(m.note)"><span class="icon">◎</span>Go to its view</button>
          <button type="button" role="menuitem" (click)="menuSaveAsView(m.note)"><span class="icon">+</span>Save its view in the Views panel</button>
        }
        @if (m.note.settings?.view && m.note.media !== 'mp4') {
          <div class="msep"></div>
          <div class="mhead" [title]="render.queueFull() ? 'The render queue is full' : 'Render this picture again at full size, with the same camera, light and settings (it joins the queue when a render is running)'">Render HD again{{ render.queueFull() ? ' (queue full)' : (render.running() ? ' (joins the queue)' : '') }}</div>
          @for (size of hdSizes; track size.width) { <button type="button" role="menuitem" class="size" [disabled]="render.queueFull()" (click)="menuRenderHd(m.note, size.width)">{{ size.label }}</button> }
        }
        <div class="msep"></div>
        <button type="button" role="menuitem" class="danger" [class.sure]="menuConfirm()" (click)="menuDelete(m.note)"><span class="icon">✕</span>{{ menuConfirm() ? 'Really delete?' : 'Delete' }}</button>
      </div>
    }
    @if (viewing(); as note) {
      <div class="backdrop" (click)="hdOpen() ? hdOpen.set(false) : viewing.set(null)"></div>
      <section class="viewer" role="dialog" aria-label="Image">
        <header>
          @if (renaming()) {
            <input #nameInput class="rename" [value]="note.name" maxlength="120" (keydown)="onNameKey($event, nameInput)" (blur)="commitName(note, nameInput.value)" />
          } @else { <b class="vname" title="Double-click to rename" (dblclick)="startRename()">{{ note.name }}</b> }
          <span class="meta">@if (service.images().length > 1) { <b class="pos">{{ position(note) }} / {{ service.images().length }}</b> · }{{ note.width }} × {{ note.height }} px · {{ note.samples }} samples · {{ minutes(note.elapsed) }} · {{ versionLabel(note) }}{{ note.edited && note.version ? ' (edited)' : '' }} · {{ megabytes(note.bytes) }}</span>
          @if (note.settings?.savedView) {
            <button type="button" title="Go back to the view this picture was made from (camera, display, light, ground) and close this window: to carry on working on it" (click)="goToView(note)">Go to view</button>
            <button type="button" title="Save that view in the Views panel" (click)="saveAsView(note)">Save as view</button>
          }
          @if (note.settings?.view && note.media !== 'mp4') {
            <span class="hdmenu">
              <button type="button" [disabled]="render.queueFull()" [title]="render.queueFull() ? 'The render queue is full' : 'Render this picture again at full size, with the same camera, light and settings'" (click)="hdOpen.set(!hdOpen())">Render HD ▾</button>
              @if (hdOpen()) {
                <div class="hdlist" role="menu">
                  @for (size of hdSizes; track size.width) { <button type="button" role="menuitem" (click)="renderHd(note, size.width)">{{ size.label }}</button> }
                  <small>same camera, light and settings, {{ render.hdSamples() }} samples (the quality of the Render dialog); the document as it is now</small>
                </div>
              }
            </span>
          }
          <a class="button" [href]="service.downloadSrc(note)" [download]="''" title="Save the picture as a PNG file">Download</a>
          <button type="button" [class.sure]="confirmDelete()" (click)="remove(note)" title="Delete this picture">{{ confirmDelete() ? 'Really delete?' : 'Delete' }}</button>
          <button type="button" class="x" title="Close (Esc)" (click)="viewing.set(null)">✕</button>
        </header>
        <div class="settings" aria-label="Render settings">
          @for (line of settingLines(note); track line.label) {
            <span class="chip" [title]="line.label"><i>{{ line.label }}</i>@if (line.swatch) { <b class="swatch" [style.background]="line.swatch"></b> }{{ line.value }}</span>
          } @empty { <span class="muted">No render settings were kept with this picture.</span> }
        </div>
        <div class="stage">
          @if (service.images().length > 1) {
            <button type="button" class="nav prev" title="Previous picture (←)" aria-label="Previous picture" (click)="step(-1)">‹</button>
            <button type="button" class="nav next" title="Next picture (→)" aria-label="Next picture" (click)="step(1)">›</button>
          }
          @if (note.media === 'mp4') { <video [src]="service.src(note)" controls autoplay loop muted playsinline></video> }
          @else { <img [src]="service.src(note)" [alt]="note.name" /> }
        </div>
      </section>
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 40; }
    .viewer { position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(1200px, 94vw); max-height: 92vh; display: flex; flex-direction: column; gap: 8px; padding: 12px;
              background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 13px; }
    .viewer header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .vname { font-size: 14px; cursor: text; } .meta { flex: 1; min-width: 0; color: #8a93a2; }
    .menu-backdrop { z-index: 44; background: transparent; }
    .menu { position: fixed; z-index: 45; min-width: 230px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; display: flex; flex-direction: column; }
    .menu button, .menu .item { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; text-align: left; padding: 5px 8px; background: transparent; border: 0; border-radius: 4px; color: inherit; font: inherit; text-decoration: none; cursor: pointer; }
    .menu button:hover:not(:disabled), .menu .item:hover { background: #2f6fed; color: #fff; } .menu button:disabled { opacity: .45; cursor: default; }
    .menu .icon { width: 14px; text-align: center; opacity: .8; } .menu .size { padding-left: 30px; }
    .mtitle { padding: 3px 8px 5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; } .mtitle span { font-weight: 400; color: #8a93a2; margin-left: 6px; }
    .mhead { padding: 3px 8px; color: #8a93a2; font-size: 11px; } .msep { height: 1px; margin: 4px 2px; background: rgba(255,255,255,.12); }
    .menu .danger.sure { background: #a33a3a; color: #fff; }
    .hdmenu { position: relative; } .hdlist { position: absolute; right: 0; top: calc(100% + 4px); z-index: 2; display: flex; flex-direction: column; gap: 2px; min-width: 210px; padding: 4px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
    .hdlist button { text-align: left; background: transparent; border: 0; padding: 4px 8px; } .hdlist button:hover { background: #2f6fed; } .hdlist small { padding: 2px 8px 4px; color: #8a93a2; font-size: 11px; }
    .settings { display: flex; flex-wrap: wrap; gap: 4px 6px; } .muted { color: #8a93a2; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px; background: #2e323c; font-size: 12px; } .chip i { font-style: normal; color: #8a93a2; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid rgba(255,255,255,.35); display: inline-block; }
    .stage { position: relative; display: flex; justify-content: center; }
    .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 36px; height: 56px; padding: 0; font-size: 30px; line-height: 1; background: rgba(0,0,0,.45); border: 0; border-radius: 6px; opacity: .55; }
    .nav:hover { opacity: 1; background: rgba(47,111,237,.85); } .nav.prev { left: 6px; } .nav.next { right: 6px; } .pos { color: #dde1e8; }
    .viewer video { max-width: 100%; max-height: calc(92vh - 130px); align-self: center; background: #16181d; border-radius: 4px; }
    .viewer img { max-width: 100%; max-height: calc(92vh - 130px); object-fit: contain; align-self: center; background: #16181d; border-radius: 4px; }
    .viewer .rename { font: inherit; font-size: 14px; color: inherit; background: #1b1d23; border: 1px solid #2f6fed; border-radius: 3px; padding: 1px 4px; outline: none; min-width: 200px; }
    .button { padding: 2px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; text-decoration: none; } .button:hover { background: #2f6fed; color: #fff; }
    .viewer button.sure { background: #a33a3a; color: #fff; }
    :host { position: absolute; left: 12px; bottom: 36px; z-index: 5; width: 280px; max-height: 60%; display: flex; flex-direction: column; box-sizing: border-box; font-size: 12px; color: #dde1e8;
            background: rgba(35,38,45,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; }
    :host(.placed) { bottom: auto; }
    :host(.sized) .grid { flex: 1 1 0; min-height: 0; }
    .edge { position: absolute; z-index: 1; touch-action: none; }
    .edge.w { left: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; } .edge.e { right: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .edge.s { left: 12px; right: 12px; bottom: -3px; height: 7px; cursor: ns-resize; }
    .edge.sw { left: -3px; bottom: -3px; width: 14px; height: 14px; cursor: nesw-resize; } .edge.se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .edge.se::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 11px; height: 11px; opacity: .55;
      background: linear-gradient(135deg, transparent 0 45%, currentColor 45% 53%, transparent 53% 72%, currentColor 72% 80%, transparent 80%); } .edge.se:hover::after { opacity: 1; }
    .head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: grab; user-select: none; touch-action: none; } .head:active { cursor: grabbing; }
    :host(.dropping) { outline: 2px dashed #2f6fed; outline-offset: -3px; background: rgba(47,111,237,.18); }
    .add { margin-left: auto; font-size: 11px; padding: 1px 8px; } .add + input + .close { margin-left: 0; }
    .title { font-weight: 600; } .count { color: #8a93a2; font-size: 11px; } .close { margin-left: 0; }
    button { background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; padding: 2px 8px; cursor: pointer; } button:hover { background: #2f6fed; color: #fff; }
    .fold { padding: 0 4px; background: transparent; border: 0; } .fold:hover { background: transparent; color: #fff; }
    .x { padding: 0 5px; background: transparent; border: 0; opacity: .7; } .x:hover { opacity: 1; background: transparent; color: #fff; }
    .error { margin: 0 6px 6px; padding: 4px 6px; background: #3a2323; border: 1px solid #7a3030; border-radius: 4px; }
    .clean { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 6px 6px; } .clean .label { color: #8a93a2; } .muted { color: #8a93a2; }
    .clean button { padding: 1px 6px; font-size: 11px; } .clean button.sure { background: #a33a3a; color: #fff; }
    .grid { overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; padding: 0 6px 6px; }
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
  protected readonly geom = signal<Geometry | null>(this.initial.geom);
  protected readonly collapsed = signal(this.initial.collapsed);
  protected readonly confirming = signal<'older' | 'quick' | null>(null);
  /** The picture shown large. */
  protected readonly viewing = signal<ImageNote | null>(null);
  protected readonly olderCount = computed(() => this.service.images().filter(n => n.version < this.store.version()).length);
  protected readonly quickCount = computed(() => this.service.images().filter(n => n.kind === 'quick').length);

  constructor() {
    effect(() => this.remember(this.geom(), this.collapsed()));
    closeOnEscape(() => this.closeMenu(), () => this.menu() !== null);
    closeOnEscape(() => this.viewing.set(null), () => this.viewing() !== null && !this.renaming());
    // ← and → go through the pictures while one is shown (before the 3D view's arrow keys, which would move parts)
    const arrows = (event: KeyboardEvent) => {
      if (!this.viewing() || this.renaming() || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.step(event.key === 'ArrowRight' ? 1 : -1);
    };
    document.addEventListener('keydown', arrows, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', arrows, true));
  }

  private remember(geom: Geometry | null, collapsed: boolean) {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...geom, collapsed })); } catch { /* storage unavailable */ }
  }

  protected readonly render = inject(RenderService);
  protected readonly hdSizes = hdWidths;
  protected readonly hdOpen = signal(false);
  protected readonly renaming = signal(false);
  /** The right-click menu of a picture (where it opened, and for which picture). */
  protected readonly menu = signal<{ x: number; y: number; note: ImageNote } | null>(null);
  protected readonly menuConfirm = signal(false);

  protected openMenu(event: MouseEvent, note: ImageNote) {
    event.preventDefault();
    event.stopPropagation();
    this.menuConfirm.set(false);
    this.menu.set({ x: event.clientX, y: event.clientY, note });
    requestAnimationFrame(() => this.fitMenu()); // once it is drawn its real size is known: it is moved so that all of it is in the window
  }

  /** Moves the open menu up and to the left as far as it needs so that none of it is off the window (it scrolls when it is taller than the window). */
  private fitMenu() {
    const open = this.menu();
    const element = this.element.nativeElement.querySelector<HTMLElement>('.menu');
    if (!open || !element) return;
    const box = element.getBoundingClientRect();
    const x = Math.max(8, Math.min(open.x, innerWidth - box.width - 8));
    const y = Math.max(8, Math.min(open.y, innerHeight - box.height - 8));
    if (x !== open.x || y !== open.y) this.menu.set({ ...open, x, y });
  }
  protected goToView(note: ImageNote) {
    const view = note.settings?.savedView;
    if (!view) return;
    this.viewing.set(null);
    this.store.goToView(view as never);
  }
  protected saveAsView(note: ImageNote) {
    const view = note.settings?.savedView;
    if (!view) return;
    const saved = this.store.addSavedView(view as never, note.name === this.store.doc().name ? `Picture of ${new Date(note.created * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : note.name);
    this.store.announce(`Saved as the view "${saved.name}" in the Views panel`, 3500);
  }
  protected menuGoToView(note: ImageNote) { this.closeMenu(); this.goToView(note); }
  protected menuSaveAsView(note: ImageNote) { this.closeMenu(); this.saveAsView(note); }
  protected closeMenu() { this.menu.set(null); this.menuConfirm.set(false); }
  protected menuView(note: ImageNote) { this.closeMenu(); this.show(note); }
  protected menuRename(note: ImageNote) { this.closeMenu(); this.show(note); this.startRename(); }
  protected async menuRenderHd(note: ImageNote, width: number) {
    this.closeMenu();
    const documentId = this.store.docId();
    if (documentId && note.settings) await this.render.startFromNote(documentId, note.settings as Record<string, unknown>, width);
  }
  protected async menuDelete(note: ImageNote) {
    if (!this.menuConfirm()) { this.menuConfirm.set(true); return; }
    this.closeMenu();
    await this.service.remove(note);
  }

  /** Starts a full-size render with the settings of this picture; the viewer closes and the progress shows at the bottom as for any HD render. */
  protected async renderHd(note: ImageNote, width: number) {
    this.hdOpen.set(false);
    const documentId = this.store.docId();
    if (!documentId || !note.settings) return;
    this.viewing.set(null);
    await this.render.startFromNote(documentId, note.settings as Record<string, unknown>, width);
  }
  protected readonly confirmDelete = signal(false);
  protected readonly dropping = signal(false);

  protected async addFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) await this.service.addFile(file);
  }
  protected onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dropping.set(true);
  }
  protected onDrop(event: DragEvent) {
    event.preventDefault();
    this.dropping.set(false);
    void this.addFiles(event.dataTransfer?.files ?? null);
  }

  protected toggle() { this.collapsed.update(v => !v); }
  /** v13, v13* when the working copy was ahead of it, and a dash when no version had been saved yet. */
  protected versionLabel(note: ImageNote) { return note.version ? `v${note.version}${note.edited ? '*' : ''}` : 'no version'; }
  /** The render settings of a picture, in words: one chip per setting. */
  protected settingLines(note: ImageNote): { label: string; value: string; swatch?: string }[] {
    const s = note.settings;
    if (!s || !Object.keys(s).length) return [];
    const lines: { label: string; value: string; swatch?: string }[] = [];
    const hex = (colour: number) => '#' + colour.toString(16).padStart(6, '0');
    if (s.projection) lines.push({ label: 'Camera', value: s.projection === 'ortho' ? 'Orthographic' : 'Perspective' });
    if (s.depthOfField !== undefined) lines.push({ label: 'Depth of field', value: s.depthOfField && s.projection === 'ortho' ? 'off (an orthographic view has none)' : s.depthOfField ? `${strengthNames[(s.dofStrength ?? 3) - 1] ?? ''}${s.focus ? ' · focus: ' + s.focus : ' · nearest part'}` : 'off' });
    if (s.ambient !== undefined) lines.push({ label: 'Ambient', value: ambientNames[s.ambient] ?? String(s.ambient) });
    if (s.fx && s.fx !== 'none') lines.push({ label: 'Style', value: (fxNames[fxIds.indexOf(s.fx)] ?? s.fx) + (s.fx === 'cutaway' && s.cut ? ` (${s.cut.split(':')[0].toUpperCase()} ${s.cut.split(':')[1]}%)` : '') });
    if (s.reflections) lines.push({ label: 'Reflects', value: reflectionNames[s.reflections] ?? String(s.reflections) });
    if (s.beam !== undefined) lines.push({ label: 'Lamp type', value: beamNames[s.beam] ?? String(s.beam) });
    if (s.lamp !== undefined) { const share = 2 ** ((s.lamp - 40) / 10) * 100; lines.push({ label: 'Lamp', value: `${share >= 100 ? Math.round(share) : Math.round(share * 10) / 10} %` }); }
    if (s.transparent) lines.push({ label: 'Background', value: 'transparent (the ground shows its shadows only)' });
    else if (s.background !== undefined) lines.push(s.background === null ? { label: 'Background', value: 'studio' } : { label: 'Background', value: hex(s.background), swatch: hex(s.background) });
    if (s.ground !== undefined && !s.transparent) lines.push(s.ground === null ? { label: 'Ground', value: 'studio' } : { label: 'Ground', value: hex(s.ground), swatch: hex(s.ground) });
    if (s.aspect && s.aspect !== '16:9') lines.push({ label: 'Shape', value: s.aspect });
    if (s.turntable) lines.push({ label: 'Turntable', value: `${s.turntable.motion === 'spin' ? 'objects turn' : 'camera circles'} · ${s.turntable.direction === 'cw' ? 'CW' : 'CCW'} · ${s.turntable.seconds} s · ${s.turntable.fps} fps` });
    if (s.crop !== undefined && !s.turntable) lines.push({ label: 'Crop', value: s.crop ? 'on' : 'off' });
    return lines;
  }
  /** The tag on a thumbnail: the resolution's name (HD, QHD, 4K UHD …, found by the height, which a cropped picture keeps), or Quick. */
  protected badge(note: ImageNote) {
    if (note.media === 'mp4') return 'Video';
    if (note.kind === 'file') return 'File';
    if (note.kind !== 'hd') return 'Quick';
    const ratio = aspectRatio(note.settings?.aspect);
    const size = hdWidths.find(w => Math.round(w.width / ratio) === note.height);
    const name = size?.label.split(' · ')[1];
    return name === 'Full HD' ? 'HD' : name ?? 'HD';
  }

  protected position(note: ImageNote) { return this.service.images().findIndex(n => n.id === note.id) + 1; }

  /** The next (1) or previous (-1) picture of the library, going round; the list is newest first. */
  protected step(delta: number) {
    const list = this.service.images(), current = this.viewing();
    if (list.length < 2 || !current) return;
    const at = list.findIndex(n => n.id === current.id);
    this.hdOpen.set(false); this.confirmDelete.set(false);
    this.viewing.set(list[(at + delta + list.length) % list.length]);
  }

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
  protected show(note: ImageNote) { this.hdOpen.set(false); this.viewing.set(note); }

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

  /** Where the panel is, as the 3D view allows: when the view gets narrower (the file panel opens) the panel keeps inside it, and goes back when the view is wide again. */
  protected readonly leftCss = computed(() => (this.geom() ? `min(${this.geom()!.left}px, calc(100% - ${this.geom()!.width ?? defaultWidth}px))` : null));
  protected readonly topCss = computed(() => (this.geom() ? `min(${this.geom()!.top}px, calc(100% - 40px))` : null));

  protected resetGeometry() {
    this.geom.set(null);
  }

  /** Moves (the title bar) or resizes (an edge or corner) the panel with the pointer; the result is remembered. It stays inside the 3D view. */
  protected startDrag(event: PointerEvent, mode: 'move' | 'w' | 'e' | 's' | 'sw' | 'se') {
    if (event.button !== 0) return;
    event.preventDefault();
    const host = this.element.nativeElement, parent = host.offsetParent as HTMLElement | null;
    if (!parent) return;
    const box = host.getBoundingClientRect(), area = parent.getBoundingClientRect();
    const start = { left: box.left - area.left, top: box.top - area.top, width: box.width, height: box.height };
    if (mode !== 'move') this.geom.set(start); // from now on the panel has a size of its own
    else this.geom.update(g => g ?? { left: start.left, top: start.top });
    const move = (e: PointerEvent) => {
      const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY;
      let { left, top, width, height } = start;
      if (mode === 'move') {
        left = Math.max(0, Math.min(start.left + dx, parent.clientWidth - width));
        top = Math.max(0, Math.min(start.top + dy, Math.max(0, parent.clientHeight - 28)));
        this.geom.update(g => ({ ...g, left, top }));
        return;
      }
      if (mode.includes('w')) { width = Math.max(minWidth, Math.min(start.width - dx, start.left + start.width)); left = start.left + start.width - width; }
      if (mode.includes('e')) width = Math.max(minWidth, Math.min(start.width + dx, parent.clientWidth - start.left));
      if (mode.includes('s')) height = Math.max(minHeight, Math.min(start.height + dy, parent.clientHeight - start.top));
      this.geom.set({ left, top, width, height });
    };
    const end = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }
}
