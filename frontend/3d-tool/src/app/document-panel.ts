import { LibraryService } from './library.service';
import { cubeKeepOut } from './view-cube';
import { ReleaseFocus } from './release-focus';
import { Component, DestroyRef, ElementRef, HostListener, afterNextRender, computed, effect, inject, input, output, signal } from '@angular/core';
import { BomDialog } from './bom-dialog';
import { VersionsDialog } from './versions-dialog';
import { rangeEndingAt } from './tree-selection';
import { DocItem, DocumentStore, clampToWorkArea, snapStepMm } from './document.store';

/** `snapRight`: the panel sits against the right edge of the view and stays there when the view gets wider or narrower (e.g. the file panel is collapsed). */
interface PanelGeometry { left: number; top: number; width: number; height: number; snapRight?: boolean }
const geometryStorageKey = 'rasterfaster.docPanelGeometry';
const snapDistance = 24; // px from the right edge of the view at which the panel snaps to it
const sideGap = 12;

/** Magnets for a moved panel: it snaps to the right edge of the view, and it never covers the view cube (it is put just below it instead). */
function snapPanel(g: PanelGeometry, parentWidth: number, parentHeight: number): PanelGeometry {
  let { left, top, width, height } = g;
  const snapRight = parentWidth - (left + width) < snapDistance;
  if (snapRight) left = parentWidth - width - sideGap;
  if (left + width > parentWidth - cubeKeepOut.width && top < cubeKeepOut.bottom) {
    top = cubeKeepOut.bottom;
    height = Math.min(height, Math.max(240, parentHeight - top));
  }
  return { left: Math.max(0, left), top: Math.max(0, Math.min(top, parentHeight - height)), width, height, snapRight };
}

const collapsedStorageKey = 'rasterfaster.docPanelCollapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(collapsedStorageKey) === 'true'; } catch { return false; }
}

function readGeometry(): PanelGeometry | null {
  try {
    const g = JSON.parse(localStorage.getItem(geometryStorageKey) ?? 'null');
    return g && [g.left, g.top, g.width, g.height].every(Number.isFinite) ? g : null;
  } catch { return null; }
}

@Component({
  selector: 'app-document-panel',
  imports: [BomDialog, VersionsDialog, ReleaseFocus],
  host: {
    '[class.sized]': 'geom() !== null',
    '[class.collapsed]': 'collapsed()',
    '[style.left.px]': 'geom()?.left',
    '[style.top.px]': 'geom()?.top',
    '[style.width.px]': 'geom()?.width',
    '[style.height.px]': 'collapsed() ? null : geom()?.height',
    '[style.right]': "geom() ? 'auto' : null",
    '[style.max-height]': "geom() ? 'none' : null",
  },
  template: `
    <div class="header">
  <div class="grip" title="Drag to move the panel · double-click to put it back" (pointerdown)="startDrag($event, 'move')" (dblclick)="resetGeometry()"></div>
  <button type="button" class="fold" [attr.aria-expanded]="!collapsed()" [title]="collapsed() ? 'Expand the panel' : 'Collapse the panel'" (click)="toggleCollapsed()">
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          @if (collapsed()) { <path d="M2.5 4.5 6 8l3.5-3.5"/> } @else { <path d="M2.5 7.5 6 4l3.5 3.5"/> }
        </svg>
      </button>
    </div>

    @if (collapsed()) {
      <div class="mini" (dblclick)="toggleCollapsed()" title="Double-click to expand">{{ store.doc().name }} <small>{{ store.doc().items.length }} parts</small>@if (warnings(); as w) { <span class="mini-warn" [title]="w.tip">⚠ {{ w.ids.length }}</span> }</div>
    }

    <div class="edge w" (pointerdown)="startDrag($event, 'w')"></div>
    <div class="edge e" (pointerdown)="startDrag($event, 'e')"></div>
    <div class="edge s" (pointerdown)="startDrag($event, 's')"></div>
    <div class="edge sw" (pointerdown)="startDrag($event, 'sw')"></div>
    <div class="edge se" (pointerdown)="startDrag($event, 'se')"></div>
    <div class="picker">
      <select releaseFocus aria-label="Open document" (change)="open($any($event.target).value)">
        @for (d of store.documents(); track d.id) {
          <option [value]="d.id" [selected]="d.id === store.docId()">{{ d.name }} ({{ d.itemCount }})</option>
        }
      </select>
      <button type="button" title="New document" (click)="create()">New</button>
      <button type="button" title="Delete this document" [disabled]="!store.docId()" (click)="deleteDocument()">🗑</button>
    </div>
    <div class="head">
      <input #nameInput class="docname" type="text" maxlength="120" [value]="store.doc().name" aria-label="Document name" title="Click to rename · Enter saves · Esc cancels" [disabled]="store.viewing() !== null"
             (focus)="nameInput.select()" (keydown.enter)="nameInput.blur()" (keydown.escape)="cancelRename(nameInput)" (blur)="commitRename(nameInput)" />
      <button type="button" class="ver" title="Rename this document" aria-label="Rename document" [disabled]="!store.docId() || store.viewing() !== null" (click)="nameInput.focus()">✎</button>
      <button type="button" class="ver" [title]="versionTitle()" (click)="versionsOpen.set(true)">{{ versionLabel() }}</button>
    </div>
    <div class="toolbar">
      <button type="button" [disabled]="!store.canUndo()" title="Undo (⌘Z)" (click)="store.undo()">↶</button>
      <button type="button" [disabled]="!store.canRedo()" title="Redo (⇧⌘Z)" (click)="store.redo()">↷</button>
      <button type="button" [disabled]="!store.selectedIds().length" title="Duplicate (⌘D)" (click)="store.duplicateSelected()">Duplicate</button>
      <button type="button" [disabled]="!store.selectedIds().length" title="Delete" (click)="store.removeSelected()">Delete</button>
      <button type="button" [disabled]="!store.doc().items.length" title="Bill of materials" (click)="bomOpen.set(true)">BOM</button>
      <span class="status" [class.error]="store.saveState() === 'error'" [title]="statusTitle()">{{ statusLabel() }}</span>
    </div>
    <div class="export">
      <span>Export</span>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Parts exactly as assembled, centred on the plate" (click)="export3mf()">Assembly</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Blender file (.blend): Black PLA parts as placed, studio lighting, and a camera where the 3D view is now" (click)="exportBlender()">Blender</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Top / front / right drawing with 20 mm grid and legend" (click)="exportSvg()">SVG</button>
    </div>
    <div class="export">
      <span>Document file</span>
      <button type="button" [disabled]="!store.docId() || exporting()" title="Save this document, with all its versions, as a file you can keep (⤓)" (click)="exportDocumentFile()">Save file</button>
      <button type="button" title="Restore a document from a saved file (with its versions)" (click)="fileInput.click()">Open file…</button>
      <input #fileInput type="file" accept=".json,application/json" hidden (change)="importFile($any($event.target))" />
      <button type="button" title="Make a new document from a 3MF (ours or a Bambu Studio project); the parts are linked to the STL files in the library" (click)="threeMfInput.click()">Import 3MF…</button>
      <input #threeMfInput type="file" accept=".3mf" hidden (change)="import3mf($any($event.target))" />
      @if (warnings(); as w) {
        <button type="button" class="warn-sum" [title]="w.tip" (click)="selectWarnings()">⚠ {{ w.ids.length }}</button>
      }
    </div>
    @if (pendingImport(); as pending) {
      <div class="import-ask" role="alert">
        A document “{{ pending.existing.name }}” with this id already exists.
        <div class="buttons">
          <button type="button" (click)="finishImport('replace')">Replace it</button>
          <button type="button" (click)="finishImport('copy')">Import as a copy</button>
          <button type="button" (click)="pendingImport.set(null)">Cancel</button>
        </div>
      </div>
    }
    @if (importReport(); as report) {
      <div class="import-ask report" role="status">
        <div class="buttons"><button type="button" (click)="importReport.set(null)">OK</button> <span>{{ report.summary }}</span></div>
        @if (report.problems.length) {
          <div class="problems">
            @for (line of report.problems; track $index) { <div>⚠ {{ line }}</div> }
          </div>
        }
      </div>
    }
    @if (exportError()) { <div class="export-error">{{ exportError() }}</div> }
    <div class="list" tabindex="0" (mousedown)="lastListPointer = performance.now()"> <!-- focusable, so the stage shortcuts (V, arrows...) reach the scene from here: its keydown listener is on an ancestor -->
      @for (item of store.doc().items; track item.id) {
        <div class="item" [attr.data-id]="item.id" [class.sel]="isSelected(item.id)" (click)="onItemClick($event, item.id)" (dblclick)="centerItem.emit(item.id)" (contextmenu)="onItemContextMenu($event, item.id)" [class.muted]="item.muted" title="Double-click: centre the view · right-click: menu · ⌘-click: add or remove · ⇧-click: a range">
          <span class="dot" [style.background]="hex(item)"></span>
          <span class="label" [title]="item.path">{{ item.name }}</span>
          @if (store.missingPaths().has(item.path)) { <span class="badge warn" [title]="missingTip(item.path)">⚠</span> }
          @if (store.missingPaths().has(item.path) || item.path.startsWith('embedded:')) { <button type="button" class="relink" title="Relink: pick another library file for this part" (click)="relink($event, item.id)">⇄</button> }
          @if (item.path.startsWith('embedded:')) { <span class="badge warn" title="This geometry comes from an imported 3MF: there is no file for it in the library. Right-click ▸ Export STL (original) saves it as an STL.">⚠</span> }
          @if (item.centered) { <span class="badge" title="Kept centered on the grid">⌖</span> }
          @if (item.noExport) { <span class="badge" title="Do not export: left out of the 3MF and SVG, listed in its own BOM section">⊘</span> }
          <button type="button" class="x" title="Remove from document" (click)="remove($event, item)">✕</button>
        </div>
      } @empty {
        <div class="empty">Empty. Select an .stl in the list and press “Add to document” (or double-click it).</div>
      }
    </div>
    @if (store.selectedIds().length > 1) {
      <div class="multi">{{ store.selectedIds().length }} selected · drag, arrows and rotate keys move/turn them together · ⌘-click to add or remove · ⇧-click for a range</div>
    }
    @if (store.selected(); as item) {
      <div class="pos">
        @for (axis of axes; track axis; let i = $index) {
          <label>{{ axis.toUpperCase() }}
            <input type="number" [step]="axis === 'z' ? 2 : step[axis]" [value]="item.position[i]" (change)="setPosition(item, i, $any($event.target).value)" />
          </label>
        }
      </div>
    }
    @if (bomOpen()) { <app-bom-dialog (close)="bomOpen.set(false)" /> }
    @if (versionsOpen()) { <app-versions-dialog (close)="versionsOpen.set(false)" /> }
    <details class="keys"><summary>Keys and mouse</summary>
        <div class="hint">Drag: move on grid ({{ step.x }}×{{ step.y }} mm) · Shift+drag on a part: height (steps follow the Grid mode: right-click the view cube) · Alt: 1 mm · Shift+drag on empty space: select by rectangle (⌘ adds) · Arrows nudge X/Y · Shift+↑↓ or PgUp/PgDn: Z · Shift+←→: turn about Z · X / Y / Z keys: rotate about that axis (Shift = reverse), by the Step in the rotate panel · ⌘C / ⌘X / ⌘V: copy, cut, paste at the view centre · V: dim / show the selection · M: move a corner onto another part · ⌘-click: centre the view there · Work area 100 × 100 cells (±1000 mm)</div>
    </details>

  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; min-height: 0; padding: 0 8px 8px; max-height: 100%; box-sizing: border-box; font-size: 12px; color: #dde1e8;
            background: rgba(35,38,45,.9); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; }
    .head { display: flex; gap: 6px; align-items: center; }
    .ver { flex: none; padding: 2px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 10px; font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .ver:hover { background: #2f6fed; color: #fff; }
    .docname { flex: 1; min-width: 0; width: 100%; box-sizing: border-box; font-weight: 600; background: transparent; color: inherit; border: 1px solid transparent; border-radius: 4px; padding: 3px 4px; font: inherit; }
    .docname:hover, .docname:focus { border-color: rgba(255,255,255,.25); background: #1b1d22; outline: none; }
    .toolbar { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .picker { display: flex; gap: 4px; }
    .picker select { flex: 1; min-width: 0; padding: 3px 4px; background: #1b1d22; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; }
    .export { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .export span { flex: 1 0 100%; opacity: .8; white-space: nowrap; }
    .export-error { color: #ff8a8a; font-size: 11px; }
    .import-ask { padding: 6px 8px; background: #3a3320; border: 1px solid #6b5a20; border-radius: 6px; font-size: 11px; }
    .import-ask.report { flex: none; } .import-ask .buttons { align-items: center; }
    .problems { max-height: 160px; overflow-y: auto; margin-top: 6px; padding-top: 4px; border-top: 1px solid #6b5a20; word-break: break-word; }
    .problems div + div { margin-top: 3px; }
    .import-ask .buttons { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .status { margin-left: auto; opacity: .6; font-size: 11px; }
    .status.error { color: #ff8a8a; opacity: 1; }
    button { padding: 3px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    button:disabled { opacity: .35; cursor: default; }
    .list { flex: 0 1 auto; overflow: auto; min-height: 110px; max-height: 60vh; border: 1px solid rgba(255,255,255,.1); border-radius: 4px; outline: none; }
    .item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; cursor: default; user-select: none; }
    .item:hover { background: rgba(255,255,255,.07); }
    .item.muted .label { opacity: .45; font-style: italic; }
    .item.sel { background: #d9822b; color: #fff; }
    .warn-sum { margin-left: auto; padding: 2px 8px; background: #3a3320; color: #f0b232; border: 1px solid #6b5a20; border-radius: 4px; font: inherit; cursor: pointer; }
    .warn-sum:hover { background: #4a4126; }
    .badge { opacity: .7; font-size: 11px; }
    .badge.warn { opacity: 1; color: #f0b232; }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 2px; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { padding: 0 5px; background: transparent; border: 0; opacity: .6; }
    .empty { padding: 8px; opacity: .6; font-style: italic; }
    .multi { padding: 4px 6px; border-radius: 4px; background: rgba(217,130,43,.18); color: #f0b070; font-size: 11px; line-height: 1.35; }
    .pos { display: flex; gap: 4px; }
    .pos label { flex: 1; display: flex; flex-direction: column; gap: 2px; font-weight: 700; }
    .pos input { width: 100%; box-sizing: border-box; padding: 3px 4px; background: #1b1d22; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; font-weight: 400; }
    .relink { flex: none; padding: 0 5px; background: transparent; color: inherit; border: 1px solid rgba(255,255,255,.25); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; }
    .relink:hover { background: #2f6fed; color: #fff; }
    .header { flex: none; display: flex; align-items: stretch; height: 24px; margin: 0 -8px; padding: 0 4px 0 8px; }
    .fold { flex: none; width: 26px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; color: inherit; border: 0; border-radius: 4px; opacity: .55; cursor: pointer; }
    .fold:hover { opacity: 1; }
    .mini { display: flex; align-items: baseline; gap: 6px; padding: 0 4px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .mini small { font-weight: 400; opacity: .6; } .mini-warn { color: #f0b232; margin-left: auto; }
    :host(.collapsed) > *:not(.header):not(.mini):not(.edge) { display: none; }
    :host(.collapsed) .edge.s, :host(.collapsed) .edge.sw, :host(.collapsed) .edge.se { display: none; }
    :host(.collapsed) { padding-bottom: 8px; }
    .grip { flex: 1; position: relative; cursor: grab; touch-action: none; }
    .grip::after { content: ''; position: absolute; top: 10px; left: calc(50% - 16px); width: 32px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.25); }
    .grip:hover::after { background: rgba(255,255,255,.5); }
    .edge { position: absolute; touch-action: none; z-index: 1; }
    .edge.w { left: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .edge.e { right: -3px; top: 24px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .edge.s { left: 12px; right: 12px; bottom: -3px; height: 7px; cursor: ns-resize; }
    .edge.sw { left: -3px; bottom: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
    .edge.se { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .edge.se::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 11px; height: 11px; opacity: .55; /* the resize corner, drawn like the browser's own */
      background: linear-gradient(135deg, transparent 0 45%, currentColor 45% 53%, transparent 53% 72%, currentColor 72% 80%, transparent 80%); }
    .edge.se:hover::after { opacity: 1; }
    :host(.sized) .list { flex: 1 1 0; min-height: 60px; max-height: none; }
    .hint { opacity: .55; font-size: 11px; line-height: 1.35; }
    .keys { flex: none; } .keys summary { cursor: pointer; opacity: .6; font-size: 11px; user-select: none; } .keys summary:hover { opacity: 1; } .keys[open] .hint { margin-top: 4px; }
  `,
})
export class DocumentPanel {
  protected readonly store = inject(DocumentStore);
  private readonly lib = inject(LibraryService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Where the user put the panel and how big they made it (relative to the view); null = the default place and size. Remembered. */
  protected readonly geom = signal<PanelGeometry | null>(readGeometry());
  /** When the pointer last went down in the parts list (a selection right after it is not scrolled to). */
  protected lastListPointer = -Infinity;
  protected readonly performance = performance;

  constructor() {
    afterNextRender(() => {
      this.clampToParent();
      const parent = this.element.nativeElement.parentElement; // the view the panel floats in
      if (!parent) return;
      const observer = new ResizeObserver(() => this.clampToParent()); // the view itself changes size without the window doing so (the file panel collapses / opens)
      observer.observe(parent);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
    // A part was selected (in the 3D view, or by a command): its row scrolls into view in the list (centred in the list, smoothly).
    effect(() => {
      const ids = this.store.selectedIds();
      const last = ids[ids.length - 1];
      if (!last) return;
      if (performance.now() - this.lastListPointer < 400) return; // the selection came from a click in this list: the row is under the pointer already, do not move it
      setTimeout(() => this.element.nativeElement.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(last)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    });
  }

  @HostListener('window:resize')
  protected clampToParent() {
    const g = this.geom(), parent = this.element.nativeElement.offsetParent as HTMLElement | null;
    if (!g || !parent) return;
    const width = Math.min(g.width, parent.clientWidth), height = Math.min(g.height, parent.clientHeight);
    const next = snapPanel({ width, height, left: g.snapRight ? parent.clientWidth - width - sideGap : Math.max(0, Math.min(g.left, parent.clientWidth - width)), top: Math.max(0, Math.min(g.top, parent.clientHeight - height)) }, parent.clientWidth, parent.clientHeight);
    if (next.left !== g.left || next.top !== g.top || next.width !== g.width || next.height !== g.height) this.geom.set(next);
  }

  /** Parts that have a warning in the list (their file is missing, or they use the geometry of an imported 3MF); null when there are none. */
  protected readonly warnings = computed(() => {
    const missing = this.store.missingPaths();
    const items = this.store.doc().items;
    const lost = items.filter(i => missing.has(i.path)), embedded = items.filter(i => i.path.startsWith('embedded:'));
    const ids = [...lost, ...embedded].map(i => i.id);
    if (!ids.length) return null;
    const what = [lost.length ? `${lost.length} with a file that is not in the library` : '', embedded.length ? `${embedded.length} with geometry from an imported 3MF (no library file)` : ''].filter(Boolean).join(', ');
    return { ids, tip: `${ids.length} part${ids.length === 1 ? ' has' : 's have'} a warning: ${what}. Click to select them.` };
  });

  protected selectWarnings() {
    const ids = this.warnings()?.ids;
    if (ids) this.store.selectMany(ids);
  }

  protected readonly collapsed = signal(readCollapsed());

  protected toggleCollapsed() {
    this.collapsed.update(v => !v);
    try { localStorage.setItem(collapsedStorageKey, String(this.collapsed())); } catch { /* storage unavailable */ }
  }

  protected relink(event: Event, id: string) {
    event.stopPropagation();
    this.store.relinkRequest.set([id]);
  }

  protected resetGeometry() {
    this.geom.set(null);
    try { localStorage.removeItem(geometryStorageKey); } catch { /* storage unavailable */ }
  }

  /** Moves (the grip) or resizes (an edge or corner) the panel with the pointer; the result is remembered. */
  protected startDrag(event: PointerEvent, mode: 'move' | 'w' | 'e' | 's' | 'sw' | 'se') {
    if (event.button !== 0) return;
    event.preventDefault();
    const host = this.element.nativeElement, parent = host.offsetParent as HTMLElement | null;
    if (!parent) return;
    const box = host.getBoundingClientRect(), area = parent.getBoundingClientRect();
    const start: PanelGeometry = { left: box.left - area.left, top: box.top - area.top, width: box.width, height: box.height };
    this.geom.set(start);
    const minWidth = 200, minHeight = 240;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY;
      let { left, top, width, height } = start;
      if (mode === 'move') {
        left = Math.max(0, Math.min(start.left + dx, parent.clientWidth - width));
        top = Math.max(0, Math.min(start.top + dy, parent.clientHeight - height));
      } else {
        if (mode.includes('w')) { width = Math.max(minWidth, Math.min(start.width - dx, start.left + start.width)); left = start.left + start.width - width; }
        if (mode.includes('e')) {
          const reach = start.top < cubeKeepOut.bottom ? parent.clientWidth - cubeKeepOut.width : parent.clientWidth; // above the cube's bottom the panel may not grow under it
          width = Math.max(minWidth, Math.min(start.width + dx, reach - start.left));
        }
        if (mode.includes('s')) height = Math.max(minHeight, Math.min(start.height + dy, parent.clientHeight - start.top));
      }
      this.geom.set({ left, top, width, height });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const g = this.geom();
      if (mode === 'move' && g) this.geom.set(snapPanel(g, parent.clientWidth, parent.clientHeight)); // the magnets act on release, not while dragging
      else if (g) this.geom.set({ ...g, snapRight: parent.clientWidth - (g.left + g.width) < snapDistance }); // a resize keeps its place; it stays against the right edge when it was there
      try { localStorage.setItem(geometryStorageKey, JSON.stringify(this.geom())); } catch { /* storage unavailable */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Double-click on a list item: the viewer should centre on it. */
  readonly centerItem = output<string>();
  /** The 3D view's camera (see StlViewer.viewParam): the Blender export puts its camera there. */
  readonly viewProvider = input<() => string | null>(() => null);
  protected readonly bomOpen = signal(false);
  protected readonly versionsOpen = signal(false);

  /** "v3" (latest saved version), with a dot while the working copy has changes since it; "v–" before the first version. */
  protected versionLabel() {
    const shown = this.store.viewing() ?? this.store.version();
    return `${shown ? 'v' + shown : 'no version'}${this.store.viewing() === null && this.store.changedSinceVersion() ? ' •' : ''}`;
  }

  protected versionTitle() {
    if (this.store.viewing() !== null) return `Viewing v${this.store.viewing()} (read-only). Click for the versions.`;
    const base = this.store.version() ? `Latest saved version: v${this.store.version()}` : 'No version saved yet';
    return `${base}${this.store.changedSinceVersion() ? ' · changes since (⌘S saves a new version)' : ''}. Click for all versions.`;
  }
  protected readonly exporting = signal(false);
  protected readonly exportError = signal('');
  protected readonly axes = ['x', 'y', 'z'] as const;
  protected readonly step = snapStepMm;

  protected export3mf() {
    return this.download('export.3mf', 'assembly.3mf');
  }

  protected exportBlender() {
    const view = this.viewProvider()();
    return this.download(view ? `export.blend?view=${encodeURIComponent(view)}` : 'export.blend', 'scene.blend');
  }

  protected exportDocumentFile() {
    return this.download('export.rasterfaster', 'document.rasterfaster.json');
  }

  /** The file the user picked is waiting for their choice because a document with that id exists. */
  protected readonly pendingImport = signal<{ text: string; existing: { id: string; name: string } } | null>(null);

  protected async importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!file) return;
    this.exportError.set('');
    try {
      const text = await file.text();
      const { conflictWith } = await this.store.importDocumentFile(text);
      if (conflictWith) this.pendingImport.set({ text, existing: conflictWith });
    } catch (error) {
      this.exportError.set(`Import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** How the last imported 3MF was linked to the library; the unclear parts are listed. */
  protected readonly importReport = signal<{ summary: string; problems: string[] } | null>(null);

  protected async import3mf(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.exportError.set('');
    this.importReport.set(null);
    try {
      const report = await this.store.import3mf(await file.arrayBuffer(), file.name.replace(/\.3mf$/i, ''));
      const total = report.filter(l => l.matchedBy !== 'skipped').reduce((n, l) => n + l.count, 0);
      const linked = report.filter(l => ['path', 'name', 'name-shape', 'name-ambiguous', 'shape'].includes(l.matchedBy)).reduce((n, l) => n + l.count, 0);
      const embedded = report.filter(l => l.matchedBy === 'embedded').reduce((n, l) => n + l.count, 0);
      const problems = report.flatMap(l =>
        l.matchedBy === 'name-ambiguous' ? [`${l.name}: the same file is in several folders; took ${l.path}`]
        : l.matchedBy === 'skipped' ? [`${l.name}: ${l.note}`] : []);
      this.importReport.set({
        summary: `Imported ${total} parts: ${linked} linked to a library file` + (embedded ? `, ${embedded} use the 3MF's own geometry (not in the library; right-click ▸ Export STL saves one)` : '') + '.',
        problems,
      });
    } catch (error) {
      this.exportError.set(`Import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Saves the typed name (trimmed); an empty name puts the old one back. */
  protected commitRename(input: HTMLInputElement) {
    const name = input.value.trim();
    if (!name) input.value = this.store.doc().name;
    else if (name !== this.store.doc().name) this.store.rename(name);
  }

  protected cancelRename(input: HTMLInputElement) {
    input.value = this.store.doc().name;
    input.blur();
  }

  protected async finishImport(choice: 'replace' | 'copy') {
    const pending = this.pendingImport();
    this.pendingImport.set(null);
    if (!pending) return;
    try {
      await this.store.importDocumentFile(pending.text, choice);
    } catch (error) {
      this.exportError.set(`Import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  protected exportSvg() {
    return this.download('export.svg', 'drawing.svg');
  }

  /** Saves pending edits, asks the API for the file and hands it to the browser as a download. */
  private async download(endpoint: string, fallbackName: string) {
    const id = this.store.docId();
    if (!id) return;
    this.exporting.set(true);
    this.exportError.set('');
    try {
      await this.store.flush();
      const response = await fetch(`/api/documents/${id}/${endpoint}`);
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? `HTTP ${response.status}`);
      const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? `${id}-${fallbackName}`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      this.exportError.set(`Export failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.exporting.set(false);
    }
  }

  protected statusLabel() {
    return { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved…', error: 'Not saved' }[this.store.saveState()];
  }

  protected statusTitle() {
    return this.store.saveState() === 'error' ? 'Saving to the API failed; the next edit retries.' : 'Documents are saved as JSON files in the documents folder of the repo';
  }

  protected open(id: string) {
    void this.store.open(id);
  }

  protected create() {
    const name = prompt('Name of the new document', 'Untitled');
    if (name?.trim()) void this.store.create(name.trim());
  }

  protected deleteDocument() {
    if (confirm(`Delete document “${this.store.doc().name}” permanently?`)) void this.store.deleteCurrent();
  }

  protected hex(item: DocItem) {
    return '#' + item.color.toString(16).padStart(6, '0');
  }

  protected onItemContextMenu(event: MouseEvent, id: string) {
    event.preventDefault();
    this.store.openContextMenu(event.clientX, event.clientY, id);
  }

  /** The tooltip of the warning sign: the file the part uses is not in the library; in the Trash (and where), or just gone. */
  protected missingTip(path: string) {
    const item = this.lib.trashedFrom(path);
    return item
      ? `The file is in the Trash${item.kind === 'directory' ? ` (in the folder “${item.name}”)` : ''}: open the Trash and Put Back, and this part works again. ${path}`
      : `The file is not in the library (moved or deleted outside the app?): ${path}`;
  }

  protected isSelected(id: string) {
    return this.store.selectedIds().includes(id);
  }

  /** Where a Shift-click starts: the item that was last clicked without Shift (or the one shown in the position fields). */
  private anchorId: string | null = null;

  /**
   * Like the file list (and the Finder): a plain click selects only the item, ⌘/Ctrl-click adds or removes it, Shift-click selects the range
   * from the anchor to the clicked item (⌘⇧ adds the range to what is selected). Shift-click does not move the anchor.
   */
  protected onItemClick(event: MouseEvent, id: string) {
    if (event.shiftKey) {
      const ids = this.store.doc().items.map(item => item.id);
      this.store.selectMany(rangeEndingAt(ids, this.anchorId ?? this.store.selectedId(), id), event.metaKey || event.ctrlKey);
      return;
    }
    this.anchorId = id;
    if (event.metaKey || event.ctrlKey) this.store.toggleSelect(id);
    else this.store.select(id);
  }

  protected remove(event: Event, item: DocItem) {
    event.stopPropagation();
    this.store.remove(item.id);
  }

  /** Typed values are taken exactly (no snapping), so fits that need off-grid offsets stay possible. */
  protected setPosition(item: DocItem, axis: number, raw: string) {
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return;
    const position: [number, number, number] = [...item.position];
    position[axis] = value;
    this.store.updateItems('Set position', new Map([[item.id, { position: clampToWorkArea(position) }]])); // typed values stay inside the work area too
  }
}
