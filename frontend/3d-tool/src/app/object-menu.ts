import { Component, HostListener, computed, inject } from '@angular/core';
import { DocumentStore } from './document.store';

/** Right-click menu for document objects. Shown at the pointer; acts on the items the store names. */
@Component({
  selector: 'app-object-menu',
  template: `
    @if (store.contextMenu(); as menu) {
      <div class="backdrop" (mousedown)="close()" (contextmenu)="$event.preventDefault(); close()"></div>
      <div class="menu" role="menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
        <div class="title">{{ title() }}</div>
        <button type="button" role="menuitem" (click)="toggleMuted()">
          <span class="icon">◌</span>{{ allMuted() ? 'Show normally' : 'Dim (mute)' }}
          <span class="hint">{{ allMuted() ? '' : 'barely visible, ignores clicks' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="toggleCentered()">
          <span class="icon">{{ allCentered() ? '✓' : '⌖' }}</span>Center on grid
          <span class="hint">{{ allCentered() ? 'on: stays centered while moving' : 'middle of the nearest 20 × 20 cell' }}</span>
        </button>
        <button type="button" role="menuitem" (click)="snapToGrid()">
          <span class="icon">⊞</span>Snap to grid…
          <span class="hint">pick which corner or side</span>
        </button>
        <button type="button" role="menuitem" [disabled]="!hasOthers()" (click)="moveTo()">
          <span class="icon">⇥</span>Move to…
          <span class="hint">{{ hasOthers() ? 'a corner onto a corner of another part' : 'needs another part' }}</span>
        </button>
      </div>
    }
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 30; }
    .menu { position: fixed; z-index: 31; min-width: 220px; padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18);
            border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; }
    .title { padding: 4px 8px 6px; font-size: 11px; opacity: .55; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; text-align: left; cursor: pointer; font: inherit; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    button:disabled { opacity: .4; cursor: default; }
    .icon { width: 1em; text-align: center; }
    .hint { margin-left: auto; opacity: .5; font-size: 11px; }
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
  protected readonly allCentered = computed(() => this.items().length > 0 && this.items().every(i => i.centered));
  protected readonly title = computed(() => {
    const items = this.items();
    return items.length === 1 ? items[0].name : `${items.length} objects`;
  });

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

  protected snapToGrid() {
    this.store.beginSnapPick(this.items().map(i => i.id));
    this.close();
  }

  protected close() {
    this.store.contextMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape() {
    this.close();
  }
}
