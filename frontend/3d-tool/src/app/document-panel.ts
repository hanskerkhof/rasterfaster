import { Component, inject, output, signal } from '@angular/core';
import { BomDialog } from './bom-dialog';
import { DocItem, DocumentStore, clampToWorkArea, snapStepMm } from './document.store';

@Component({
  selector: 'app-document-panel',
  imports: [BomDialog],
  template: `
    <div class="picker">
      <select aria-label="Open document" (change)="open($any($event.target).value)">
        @for (d of store.documents(); track d.id) {
          <option [value]="d.id" [selected]="d.id === store.docId()">{{ d.name }} ({{ d.itemCount }})</option>
        }
      </select>
      <button type="button" title="New document" (click)="create()">New</button>
      <button type="button" title="Delete this document" [disabled]="!store.docId()" (click)="deleteDocument()">🗑</button>
    </div>
    <div class="head">
      <input class="docname" type="text" [value]="store.doc().name" aria-label="Document name" (change)="store.rename($any($event.target).value)" />
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
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Parts exactly as assembled, centred on the plate" (click)="export3mf('assembly')">Assembly</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Every part flat on the plate in its library orientation, ready to print" (click)="export3mf('print')">Print plate</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="3MF with the document's own coordinates (Z up), for opening in Fusion 360" (click)="export3mf('fusion')">Fusion</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="glTF for Blender (File > Import > glTF 2.0): coloured parts as placed, plus a camera that flies the camera path" (click)="exportBlender()">Blender</button>
      <button type="button" [disabled]="!store.doc().items.length || exporting()" title="Top / front / right drawing with 20 mm grid and legend" (click)="exportSvg()">SVG</button>
    </div>
    @if (exportError()) { <div class="export-error">{{ exportError() }}</div> }
    <div class="list">
      @for (item of store.doc().items; track item.id) {
        <div class="item" [class.sel]="isSelected(item.id)" (click)="onItemClick($event, item.id)" (dblclick)="centerItem.emit(item.id)" (contextmenu)="onItemContextMenu($event, item.id)" [class.muted]="item.muted" title="Double-click: centre the view · right-click: menu">
          <span class="dot" [style.background]="hex(item)"></span>
          <span class="label" [title]="item.path">{{ item.name }}</span>
          @if (item.centered) { <span class="badge" title="Kept centered on the grid">⌖</span> }
          @if (item.noExport) { <span class="badge" title="Do not export: left out of the 3MF and SVG, listed in its own BOM section">⊘</span> }
          <button type="button" class="x" title="Remove from document" (click)="remove($event, item)">✕</button>
        </div>
      } @empty {
        <div class="empty">Empty. Select an .stl in the list and press “Add to document” (or double-click it).</div>
      }
    </div>
    @if (store.selectedIds().length > 1) {
      <div class="multi">{{ store.selectedIds().length }} selected · drag, arrows and rotate keys move/turn them together · ⌘-click to add or remove</div>
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
    <div class="hint">Drag: move on grid ({{ step.x }}×{{ step.y }} mm) · Shift+drag: height (steps follow the Grid mode: right-click the view cube) · Alt: 1 mm · Arrows nudge X/Y · Shift+↑↓ or PgUp/PgDn: Z · Shift+←→: turn about Z · X / Y / Z keys: rotate about that axis (Shift = reverse), by the Step in the rotate panel · ⌘C / ⌘X / ⌘V: copy, cut, paste at the view centre · V: dim / show the selection · ⌘-click: centre the view there · Work area 100 × 100 cells (±1000 mm)</div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; padding: 8px; max-height: 100%; box-sizing: border-box; font-size: 12px; color: #dde1e8;
            background: rgba(35,38,45,.9); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; }
    .docname { width: 100%; box-sizing: border-box; font-weight: 600; background: transparent; color: inherit; border: 1px solid transparent; border-radius: 4px; padding: 3px 4px; font: inherit; }
    .docname:hover, .docname:focus { border-color: rgba(255,255,255,.25); background: #1b1d22; outline: none; }
    .toolbar { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .picker { display: flex; gap: 4px; }
    .picker select { flex: 1; min-width: 0; padding: 3px 4px; background: #1b1d22; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; }
    .export { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .export span { flex: 1 0 100%; opacity: .8; white-space: nowrap; }
    .export-error { color: #ff8a8a; font-size: 11px; }
    .status { margin-left: auto; opacity: .6; font-size: 11px; }
    .status.error { color: #ff8a8a; opacity: 1; }
    button { padding: 3px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    button:disabled { opacity: .35; cursor: default; }
    .list { overflow: auto; min-height: 40px; max-height: 220px; border: 1px solid rgba(255,255,255,.1); border-radius: 4px; }
    .item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; cursor: default; user-select: none; }
    .item:hover { background: rgba(255,255,255,.07); }
    .item.muted .label { opacity: .45; font-style: italic; }
    .item.sel { background: #d9822b; color: #fff; }
    .badge { opacity: .7; font-size: 11px; }
    .dot { flex: none; width: 10px; height: 10px; border-radius: 2px; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { padding: 0 5px; background: transparent; border: 0; opacity: .6; }
    .empty { padding: 8px; opacity: .6; font-style: italic; }
    .multi { padding: 4px 6px; border-radius: 4px; background: rgba(217,130,43,.18); color: #f0b070; font-size: 11px; line-height: 1.35; }
    .pos { display: flex; gap: 4px; }
    .pos label { flex: 1; display: flex; flex-direction: column; gap: 2px; font-weight: 700; }
    .pos input { width: 100%; box-sizing: border-box; padding: 3px 4px; background: #1b1d22; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; font-weight: 400; }
    .hint { opacity: .55; font-size: 11px; line-height: 1.35; }
  `,
})
export class DocumentPanel {
  protected readonly store = inject(DocumentStore);
  /** Double-click on a list item: the viewer should centre on it. */
  readonly centerItem = output<string>();
  protected readonly bomOpen = signal(false);
  protected readonly exporting = signal(false);
  protected readonly exportError = signal('');
  protected readonly axes = ['x', 'y', 'z'] as const;
  protected readonly step = snapStepMm;

  protected export3mf(layout: 'assembly' | 'print' | 'fusion') {
    return this.download(`export.3mf?layout=${layout}`, `${layout}.3mf`);
  }

  protected exportBlender() {
    return this.download('export.glb', 'blender.glb');
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

  protected isSelected(id: string) {
    return this.store.selectedIds().includes(id);
  }

  /** ⌘/Ctrl-click adds or removes the item from the selection; a plain click selects only it. */
  protected onItemClick(event: MouseEvent, id: string) {
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
