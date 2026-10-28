import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DocumentStore, itemColors } from './document.store';
import { baseThicknessMm } from './z-levels';

/** Right-click menu for document objects. Shown at the pointer; acts on the items the store names. */
@Component({
  selector: 'app-object-menu',
  template: `
    @if (store.contextMenu(); as menu) {
      <div class="backdrop" (mousedown)="close()" (contextmenu)="$event.preventDefault(); close()"></div>
      <div #menuEl class="menu" role="menu" (mouseover)="onMenuOver($event)" [style.left.px]="left(menu.x)" [style.top.px]="top(menu.y)" [style.visibility]="size() ? 'visible' : 'hidden'">
        @if (!menu.ids.length) {
          <button type="button" role="menuitem" [disabled]="!store.clipboard()" (click)="paste()">
            <span class="icon">⎘</span>Paste<span class="hint">{{ store.clipboard() ? '⌘V' : 'nothing copied' }}</span>
          </button>
        } @else {
        <div class="title">{{ title() }}</div>
        <button type="button" role="menuitem" (click)="copy(false)">
          <span class="icon">⧉</span>Copy<span class="hint">⌘C</span>
        </button>
        <button type="button" role="menuitem" (click)="copy(true)">
          <span class="icon">✂</span>Cut<span class="hint">⌘X</span>
        </button>
        <button type="button" role="menuitem" [disabled]="!store.clipboard()" (click)="paste()">
          <span class="icon">⎘</span>Paste<span class="hint">{{ store.clipboard() ? store.clipboard()!.items.length + ' part' + (store.clipboard()!.items.length === 1 ? '' : 's') + ' · ⌘V' : 'nothing copied' }}</span>
        </button>
        <div class="sep"></div>
        <button type="button" role="menuitem" [disabled]="!canExport()" (click)="exportStl(true)">
          <span class="icon">⤓</span>Export STL (as placed)
          <span class="hint">{{ canExport() ? 'rotation and position applied' : 'no geometry (file missing)' }}</span>
        </button>
        <button type="button" role="menuitem" [disabled]="!canExport() || items().length !== 1" (click)="exportStl(false)">
          <span class="icon">⤓</span>Export STL (original)
          <span class="hint">{{ items().length === 1 ? 'own geometry, not rotated or moved' : 'select one part' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="relink()">
          <span class="icon">⇄</span>Relink file…
          <span class="hint">{{ missing() ? 'its file is not in the library: pick another' : 'use another library file' }}</span>
        </button>
        <button type="button" role="menuitem" class="sub" (mouseenter)="openColors($event)" (click)="openColors($event)">
          <span class="icon">◐</span>Color<span class="hint">▸</span>
        </button>
        <button type="button" role="menuitem" (click)="toggleMuted()">
          <span class="icon">◌</span>{{ allMuted() ? 'Show normally' : 'Dim (mute)' }}
          <span class="hint">{{ allMuted() ? '' : 'barely visible, ignores clicks' }}</span><span class="hint key">V</span>
        </button>
        <button type="button" role="menuitem" (click)="toggleCentered()">
          <span class="icon">{{ allCentered() ? '✓' : '⌖' }}</span>Center on grid
          <span class="hint">{{ allCentered() ? 'on: stays centered (X, Y, Z) while moving' : 'middle of the nearest 20 × 20 cell and Z level' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="snapToGrid()">
          <span class="icon">⊞</span>Snap to grid…
          <span class="hint">pick which corner or side</span>
        </button>
        <button type="button" role="menuitem" [disabled]="!hasOthers()" (click)="moveTo()">
          <span class="icon">⇥</span>Move to…
          <span class="hint">{{ hasOthers() ? 'a corner onto a corner of another part' : 'needs another part' }}</span><span class="hint key">M</span>
        </button>
        <button type="button" role="menuitem" [disabled]="lowestAt(0)" (click)="moveToHeight(0)">
          <span class="icon">⤓</span>Move to ground
          <span class="hint">{{ lowestAt(0) ? 'already on the ground' : 'lowest point to z = 0' }}</span>
        </button>
        <button type="button" role="menuitem" [disabled]="lowestAt(baseMm)" (click)="moveToHeight(baseMm)">
          <span class="icon">⇥</span>Move to base ({{ baseMm }} mm)
          <span class="hint">{{ lowestAt(baseMm) ? 'already on the base' : 'lowest point to z = ' + baseMm }}</span>
        </button>
        <div class="sep"></div>
        <button type="button" role="menuitem" (click)="toggleNoExport()">
          <span class="icon">{{ allNoExport() ? '✓' : '⊘' }}</span>Do not export
          <span class="hint">{{ allNoExport() ? 'on: not in 3MF / SVG, own BOM section' : 'mock part: leave out of the exports' }}</span>
        </button>
        <div class="sep"></div>
        <button type="button" role="menuitem" (click)="findInBrowser()">
          <span class="icon">⌕</span>Find in browser
          <span class="hint">show {{ items().length > 1 ? 'the files' : 'the file' }} in the file list</span>
        </button>
        <button type="button" role="menuitem" (click)="showInAssembly()">
          <span class="icon">⌖</span>Show in assembly
          <span class="hint">select and zoom to {{ items().length > 1 ? 'these parts' : 'this part' }}</span>
        </button>
        }
      </div>
      @if (colorsAt(); as at) {
        <div class="flyout" role="menu" aria-label="Color" [style.left.px]="at.x" [style.top.px]="at.y">
          @for (c of colors; track c) {
            <button type="button" class="swatch" role="menuitem" [class.on]="isColor(c)" [style.background]="hex(c)" [title]="hex(c)" (click)="setColor(c)"></button>
          }
        </div>
      }
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 30; }
    .menu { position: fixed; z-index: 31; max-height: calc(100vh - 16px); overflow-y: auto; width: max-content; min-width: 380px; max-width: calc(100vw - 16px); padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18);
            border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; }
    .title { padding: 4px 8px 6px; font-size: 11px; opacity: .55; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { white-space: nowrap; display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; text-align: left; cursor: pointer; font: inherit; }
    .sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.12); }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    button:disabled { opacity: .4; cursor: default; }
    .flyout { position: fixed; z-index: 32; display: grid; grid-template-columns: repeat(4, 28px); gap: 4px; padding: 6px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .swatch { width: 28px; height: 28px; padding: 0; border: 2px solid transparent; border-radius: 5px; }
    .swatch:hover:not(:disabled) { background-color: inherit; border-color: #fff; }
    .swatch.on { border-color: #fff; box-shadow: inset 0 0 0 2px #2b2f38; }
    .icon { width: 1em; text-align: center; }
    .hint { margin-left: auto; opacity: .5; font-size: 11px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; padding-left: 12px; }
    .hint + .hint { margin-left: 10px; min-width: 14px; text-align: right; opacity: .75; }
  `,
})
export class ObjectMenu {
  protected readonly store = inject(DocumentStore);

  private readonly items = computed(() => {
    const ids = new Set(this.store.contextMenu()?.ids ?? []);
    return this.store.doc().items.filter(i => ids.has(i.id));
  });
  protected readonly allMuted = computed(() => this.items().length > 0 && this.items().every(i => i.muted));
  /** Move to needs at least one part that is not part of the selection to snap onto. */
  protected readonly hasOthers = computed(() => this.store.doc().items.length > this.items().length);
  protected readonly baseMm = baseThicknessMm;
  protected readonly colors = itemColors;
  /** Where the colour flyout is shown (fixed, beside the Color row), or null while it is closed. */
  protected readonly colorsAt = signal<{ x: number; y: number } | null>(null);

  protected hex(c: number) {
    return '#' + c.toString(16).padStart(6, '0');
  }

  protected isColor(c: number) {
    return this.items().length > 0 && this.items().every(i => i.color === c);
  }

  /** Opens the flyout to the right of the row (to the left when there is no room); it is 4 swatches wide. */
  protected openColors(event: Event) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 4 * 28 + 3 * 4 + 14;
    const x = rect.right + width + 8 <= window.innerWidth ? rect.right + 2 : Math.max(8, rect.left - width - 2);
    this.colorsAt.set({ x, y: Math.min(rect.top, window.innerHeight - 100) });
  }

  protected onMenuOver(event: Event) {
    if (!(event.target as HTMLElement).closest('.sub')) this.colorsAt.set(null);
  }

  protected setColor(color: number) {
    this.store.setColor(this.items().map(i => i.id), color);
    this.close();
  }

  private readonly menuEl = viewChild<ElementRef<HTMLElement>>('menuEl');
  /** The menu's real size once it is shown (it differs per selection and grows with new items); until then it is placed but hidden. */
  private readonly size = signal<{ w: number; h: number } | null>(null);

  constructor() {
    effect(() => {
      const open = this.store.contextMenu(), el = this.menuEl();
      if (!open || !el) { untracked(() => this.size.set(null)); return; }
      queueMicrotask(() => this.size.set({ w: el.nativeElement.offsetWidth, h: el.nativeElement.offsetHeight }));
    });
  }

  /** Keeps the whole menu inside the window: it moves left / up (to the window's edge) when it would reach beyond the right / bottom edge. */
  protected left(x: number) {
    return Math.max(8, Math.min(x, window.innerWidth - (this.size()?.w ?? 310) - 8));
  }

  protected top(y: number) {
    return Math.max(8, Math.min(y, window.innerHeight - (this.size()?.h ?? 420) - 8));
  }

  /** True when the lowest point of the selection already is at `height`. */
  protected lowestAt(height: number) {
    return this.items().length > 0 && Math.min(...this.items().map(i => i.position[2])) === height;
  }

  protected readonly allNoExport = computed(() => this.items().length > 0 && this.items().every(i => i.noExport));
  protected readonly allCentered = computed(() => this.items().length > 0 && this.items().every(i => i.centered));
  protected readonly title = computed(() => {
    const items = this.items();
    return items.length === 1 ? items[0].name : `${items.length} objects`;
  });

  /** Copy (or cut) the parts the menu was opened for; the right-click already made them the selection. */
  protected copy(cut: boolean) {
    if (cut) this.store.cutSelection();
    else this.store.copySelection();
    this.close();
  }

  protected paste() {
    this.store.pasteClipboard();
    this.close();
  }

  /** At least one of the parts has a file (a placeholder has no geometry to save). */
  protected canExport() {
    const missing = this.store.missingPaths();
    return this.items().some(i => !missing.has(i.path));
  }

  protected exportStl(placed = true) {
    this.store.exportStl(this.items().map(i => i.id), placed);
    this.close();
  }

  /** Selects the parts and zooms the view to them (the right-click already selected them; a menu opened from the list too). */
  protected showInAssembly() {
    const ids = this.items().map(i => i.id);
    this.store.selectMany(ids);
    this.store.showInAssembly?.(ids);
    this.close();
  }

  /** Some of the parts point at a file that is not in the library. */
  protected missing() {
    return this.items().some(i => this.store.missingPaths().has(i.path));
  }



  protected relink() {
    this.store.relinkRequest.set(this.items().map(i => i.id));
    this.close();
  }


  protected toggleNoExport() {
    this.store.setNoExport(this.items().map(i => i.id), !this.allNoExport());
    this.close();
  }

  /** Shows the parts' files in the file list: opens their folders, selects them and scrolls to the first. */
  protected findInBrowser() {
    this.store.findInBrowser(this.items().map(i => i.id));
    this.close();
  }

  protected toggleMuted() {
    this.store.setMuted(this.items().map(i => i.id), !this.allMuted());
    this.close();
  }

  protected toggleCentered() {
    this.store.setCentered(this.items().map(i => i.id), !this.allCentered());
    this.close();
  }

  /** Starts the pick: handles appear on the corners and side middles, the next click chooses the anchor. */
  /** Starts the two-step move: pick a corner of the selection, then a corner of another part. */
  protected moveTo() {
    this.store.beginMovePick(this.items().map(i => i.id));
    this.close();
  }

  protected moveToHeight(height: number) {
    this.store.moveToHeight(this.items().map(i => i.id), height);
    this.close();
  }

  protected snapToGrid() {
    this.store.beginSnapPick(this.items().map(i => i.id));
    this.close();
  }

  protected close() {
    this.colorsAt.set(null);
    this.store.contextMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape() {
    this.close();
  }
}
