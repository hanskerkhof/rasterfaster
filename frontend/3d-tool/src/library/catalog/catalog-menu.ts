import { Component, DestroyRef, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';

/** One row of a context menu: an action (`id`), a separator, or a row that opens a flyout with `children`. */
export interface MenuItem {
  id?: string;
  label?: string;
  icon?: string;
  hint?: string;
  title?: string;
  disabled?: boolean;
  sep?: boolean;
  children?: MenuItem[];
}

/**
 * A context menu in the style of the app's own (the object menu of the 3D view): a small title, rows with an icon, a label and a grey hint, separators and
 * flyouts to the right (or the left when there is no room). It knows nothing about parts: it shows `items` and says which `id` was chosen.
 * Esc, a click outside or another right-click closes it.
 */
@Component({
  selector: 'app-catalog-menu',
  template: `
    <div class="backdrop" (mousedown)="closed.emit()" (contextmenu)="$event.preventDefault(); closed.emit()"></div>
    <div #menuEl class="menu" role="menu" (mouseover)="onOver($event)">
      @if (heading()) { <div class="title">{{ heading() }}</div> }
      @for (item of items(); track $index) {
        @if (item.sep) { <div class="sep"></div> }
        @else if (item.children) {
          <button type="button" role="menuitem" class="sub" [disabled]="item.disabled" [title]="item.title ?? ''" (mouseenter)="openFlyout($event, item)" (click)="openFlyout($event, item)">
            <span class="icon">{{ item.icon }}</span>{{ item.label }}<span class="hint">{{ item.hint }}</span><span class="hint key">▸</span>
          </button>
        } @else {
          <button type="button" role="menuitem" [disabled]="item.disabled" [title]="item.title ?? ''" (click)="choose(item)">
            <span class="icon">{{ item.icon }}</span>{{ item.label }}<span class="hint">{{ item.hint }}</span>
          </button>
        }
      }
    </div>
    @if (flyout(); as fly) {
      <div class="flyout" role="menu" [style.left.px]="fly.x" [style.top.px]="fly.y" (mouseenter)="keepFlyout()">
        @for (child of fly.children; track $index) {
          <button type="button" role="menuitem" [disabled]="child.disabled" [title]="child.title ?? ''" (click)="choose(child)">
            <span class="icon">{{ child.icon }}</span>{{ child.label }}<span class="hint">{{ child.hint }}</span>
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host { font-family: system-ui, sans-serif; font-size: 13px; line-height: normal; letter-spacing: normal; color: #dde1e8; }
    .backdrop { position: fixed; inset: 0; z-index: 40; }
    .menu { position: fixed; z-index: 41; max-height: calc(100vh - 16px); overflow-y: auto; width: max-content; min-width: 300px; max-width: calc(100vw - 16px); padding: 4px; background: #2b2f38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18);
            border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); visibility: hidden; }
    .title { padding: 4px 8px 6px; font-size: 11px; opacity: .55; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { white-space: nowrap; display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; color: inherit; border: 0; border-radius: 5px; text-align: left; cursor: pointer; font: inherit; }
    .sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,.12); }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; }
    button:disabled { opacity: .4; cursor: default; }
    .flyout { position: fixed; z-index: 42; min-width: 220px; padding: 4px; background: #2b2f38; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .icon { width: 1em; text-align: center; }
    .hint { margin-left: auto; opacity: .5; font-size: 11px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; padding-left: 12px; }
    .hint + .hint { margin-left: 10px; min-width: 14px; text-align: right; opacity: .75; }
  `,
})
export class CatalogMenu {
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly heading = input('');
  readonly items = input.required<MenuItem[]>();
  /** The `id` of the row that was chosen. */
  readonly chosen = output<string>();
  readonly closed = output<void>();

  private readonly menuEl = viewChild.required<ElementRef<HTMLElement>>('menuEl');
  protected readonly flyout = signal<{ x: number; y: number; children: MenuItem[] } | null>(null);
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // put the menu at the pointer, moved back into the window when it would stick out, then show it
    effect(() => {
      const el = this.menuEl().nativeElement;
      this.items(); // the rows decide the size
      const x = this.x(), y = this.y();
      queueMicrotask(() => {
        const rect = el.getBoundingClientRect();
        el.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
        el.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
        el.style.visibility = 'visible';
      });
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation(); // closes the menu only, not the catalog behind it
      this.closed.emit();
    };
    document.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => { document.removeEventListener('keydown', onKey, true); clearTimeout(this.closeTimer); });
  }

  protected choose(item: MenuItem) {
    if (item.id && !item.disabled) this.chosen.emit(item.id);
  }

  /** Opens the flyout to the right of the row (to the left when there is no room). */
  protected openFlyout(event: Event, item: MenuItem) {
    if (item.disabled || !item.children) return;
    this.keepFlyout();
    const row = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 260, height = item.children.length * 30 + 12;
    const x = row.right + width + 8 <= window.innerWidth ? row.right + 2 : Math.max(8, row.left - width - 2);
    this.flyout.set({ x, y: Math.max(8, Math.min(row.top - 4, window.innerHeight - height - 8)), children: item.children });
  }

  /** Leaving the row on the way to the flyout closes it only after a moment, so it can be reached. */
  protected onOver(event: Event) {
    if ((event.target as HTMLElement).closest('.sub')) { this.keepFlyout(); return; }
    if (this.flyout() && this.closeTimer === undefined) this.closeTimer = setTimeout(() => { this.closeTimer = undefined; this.flyout.set(null); }, 350);
  }

  protected keepFlyout() {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }
}
