import { Directive, DestroyRef, ElementRef, HostListener, computed, effect, inject, signal } from '@angular/core';
import { PanelDock } from './panel-dock';
import { insidePlace, watchInside } from './keep-inside';

/** Where a panel is and how big it is, in px from the top left of the view it floats in. Missing width / height: the panel's own size. `snapRight`: it stays against the right edge. */
export interface PanelGeometry { left: number; top: number; width?: number; height?: number; snapRight?: boolean }
export type EdgeMode = 'w' | 'e' | 's' | 'sw' | 'se';

/** What a panel says about itself (see `setup`). */
export interface PanelOptions {
  /** A short name: the key under which its place is remembered, and its name in the dock. */
  id: string;
  /** The least width (px) it can be given: its bar needs room for the buttons on both sides of the grip. */
  minWidth: number;
  /** Its width while it has none of its own (px, as in its CSS). */
  defaultWidth: number;
  /** The least height (px) it can be given, or `'content'`: as little as its content allows (at least 160). */
  minHeight: number | 'content';
  /** Moving a panel gives it a size of its own (the one it has) too, not only a place. */
  fixSizeOnMove?: boolean;
  /** What an earlier version of the panel remembered, once, to take over. */
  legacy?: () => { geom: PanelGeometry | null; collapsed: boolean } | null;
}

const storagePrefix = 'rasterfaster.panel.';

/**
 * The base of the floating panels (Views, Gallery, Document, and each panel to come): the place and the size (remembered in this browser), the folded state, moving by
 * the top bar, resizing by the edges (`<app-panel-edges>`), staying inside the view, and docking at the bottom (see `PanelDock`). A panel extends it, calls `setup` in its
 * constructor and puts in its template a `panel-bar` with `(pointerdown)="barDown($event)" (dblclick)="resetGeometry()"`, an `<app-panel-edges>` and a body. Its CSS is only
 * its own: the default place and width, the content.
 */
@Directive({
  host: {
    class: 'float-panel',
    '[class.placed]': 'geom() !== null',
    '[class.sized]': 'geom()?.height !== undefined',
    '[class.collapsed]': 'collapsed()',
    '[style.left]': 'leftCss()',
    '[style.top]': 'topCss()',
    '[style.width.px]': 'geom()?.width',
    '[style.height.px]': 'collapsed() ? null : geom()?.height',
    '[style.right]': "geom() ? 'auto' : null",
    '[style.max-height]': "geom()?.height !== undefined ? 'none' : null",
  },
})
export abstract class FloatingPanel {
  protected readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly dock = inject(PanelDock);
  private readonly destroyRef = inject(DestroyRef);
  private options!: PanelOptions;

  /** Where the user put the panel and how big they made it; null = its default place and size. */
  protected readonly geom = signal<PanelGeometry | null>(null);
  protected readonly collapsed = signal(false);
  /** The panel is docked: only its bar shows, in the dock row. */
  protected readonly docked = computed(() => this.dock.isDocked(this.options.id));

  protected readonly leftCss = computed(() => { const g = this.geom(); return g ? `min(${g.left}px, calc(100% - ${g.width ?? this.options.defaultWidth}px))` : null; });
  protected readonly topCss = computed(() => { const g = this.geom(); return g ? `min(${g.top}px, calc(100% - 40px))` : null; });

  /** Call it in the constructor of the panel. */
  protected setup(options: PanelOptions) {
    this.options = options;
    const key = storagePrefix + options.id;
    const stored = read(key) ?? options.legacy?.() ?? null;
    this.geom.set(stored?.geom ?? null);
    this.collapsed.set(stored?.collapsed === true);
    effect(() => { try { localStorage.setItem(key, JSON.stringify({ geom: this.geom(), collapsed: this.collapsed() })); } catch { /* storage unavailable */ } });
    watchInside((_, parent) => this.clampToParent(parent)); // the view got smaller (the window, the file panel): back inside
    this.destroyRef.onDestroy(this.dock.register(options.id, this.element.nativeElement));
  }

  @HostListener('window:resize')
  protected onWindowResize() { const parent = this.element.nativeElement.offsetParent as HTMLElement | null; if (parent) this.clampToParent(parent); }

  // --- to override -----------------------------------------------------------------------------------------------------------------------

  /** A panel that was left near an edge, or a view that got smaller: the geometry back inside the view. */
  protected clampToParent(parent: HTMLElement) {
    const g = this.geom();
    if (!g) return;
    const box = this.element.nativeElement.getBoundingClientRect();
    const width = g.width === undefined ? box.width : Math.min(g.width, parent.clientWidth), height = g.height === undefined ? box.height : Math.min(g.height, parent.clientHeight);
    const next = insidePlace(g.left, g.top, width, height, parent.clientWidth, parent.clientHeight);
    if (Math.abs(next.left - g.left) > 0.5 || Math.abs(next.top - g.top) > 0.5 || (g.width !== undefined && width !== g.width) || (g.height !== undefined && height !== g.height)) {
      this.geom.set({ ...g, ...next, ...(g.width !== undefined ? { width } : {}), ...(g.height !== undefined ? { height } : {}) });
    }
  }
  /** After a move (the magnets of a panel): the geometry it ends with. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected settleMove(g: PanelGeometry, _parentWidth: number, _parentHeight: number): PanelGeometry { return g; }
  /** After a resize: the geometry it ends with. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected settleResize(g: PanelGeometry, _parentWidth: number): PanelGeometry { return g; }
  /** How far right (px from the left of the view) a panel with its top at `top` may grow. */
  protected reach(_top: number, parentWidth: number): number { return parentWidth; }

  // --- fold, reset -----------------------------------------------------------------------------------------------------------------------

  protected toggleCollapsed() { this.collapsed.update(v => !v); }
  protected resetGeometry() { this.geom.set(null); }

  // --- move and resize -------------------------------------------------------------------------------------------------------------------

  /** Pressing the top bar (not a button in it) moves the panel; on a docked panel it pulls it out of the dock when moved up. */
  protected barDown(event: PointerEvent) {
    if ((event.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    if (this.docked()) { this.dock.dragUp(event, this.options.id); return; }
    this.startMove(event);
  }

  protected startMove(event: PointerEvent) { this.pointerDrag(event, 'move'); }
  protected startResize(event: PointerEvent, mode: EdgeMode) { this.pointerDrag(event, mode); }

  private pointerDrag(event: PointerEvent, mode: 'move' | EdgeMode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const host = this.element.nativeElement, parent = host.offsetParent as HTMLElement | null;
    if (!parent) return;
    const box = host.getBoundingClientRect(), area = parent.getBoundingClientRect();
    const start: Required<Pick<PanelGeometry, 'left' | 'top' | 'width' | 'height'>> = { left: box.left - area.left, top: box.top - area.top, width: box.width, height: box.height };
    if (this.options.fixSizeOnMove) start.height = Math.min(start.height, Math.max(120, parent.clientHeight - start.top - 40)); // a panel with a size of its own fits in the view from where it is, 40 px short of the bottom (one touching it would count as docked at once)
    const before = this.geom(); // where it was: a dock gives it back
    if (mode !== 'move' || this.options.fixSizeOnMove) this.geom.set({ ...start }); // from now on the panel has a size of its own
    else this.geom.update(g => g ?? { left: start.left, top: start.top });
    const minHeight = this.options.minHeight === 'content' ? Math.max(160, this.contentFloor(host)) : this.options.minHeight;
    const minWidth = this.options.minWidth;
    let atBottom = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY;
      let { left, top, width, height } = start;
      if (mode === 'move') {
        left = Math.max(0, Math.min(start.left + dx, parent.clientWidth - width));
        top = Math.max(0, Math.min(start.top + dy, parent.clientHeight - height)); // never out of the view
        // the panel has been dragged down until its bottom edge is at the bottom of the view (and the pointer wants to go on): it would be docked
        atBottom = dy > 8 && start.top + dy >= parent.clientHeight - height;
        this.dock.hint.set(atBottom);
        this.geom.update(g => ({ ...g, left, top }));
        return;
      }
      if (mode.includes('w')) { width = Math.max(minWidth, Math.min(start.width - dx, start.left + start.width)); left = start.left + start.width - width; }
      if (mode.includes('e')) width = Math.max(minWidth, Math.min(start.width + dx, this.reach(start.top, parent.clientWidth) - start.left));
      if (mode.includes('s')) height = Math.max(minHeight, Math.min(start.height + dy, parent.clientHeight - start.top));
      this.geom.set({ left, top, width, height });
    };
    const end = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
      this.dock.hint.set(false);
      const g = this.geom();
      if (mode === 'move') {
        if (atBottom && this.dock.dock(this.options.id, () => this.geom.set(before))) return; // let go at the bottom: docked (it keeps the place it had before)
        if (g) this.geom.set(this.settleMove({ ...g }, parent.clientWidth, parent.clientHeight));
      } else if (g) this.geom.set(this.settleResize({ ...g }, parent.clientWidth));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  /** The least height of a panel: everything fits and its list shows 3 parts (measured: the host's min-height is its min-content). */
  private contentFloor(host: HTMLElement): number {
    const keep = host.style.height;
    host.style.height = '1px';
    const floor = host.offsetHeight;
    host.style.height = keep;
    return floor;
  }
}

function read(key: string): { geom: PanelGeometry | null; collapsed: boolean } | null {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!stored) return null;
    const g = stored.geom;
    const geom = g && Number.isFinite(g.left) && Number.isFinite(g.top)
      ? { left: g.left, top: g.top, ...(Number.isFinite(g.width) ? { width: g.width } : {}), ...(Number.isFinite(g.height) ? { height: g.height } : {}), ...(g.snapRight ? { snapRight: true } : {}) } : null;
    return { geom, collapsed: stored.collapsed === true };
  } catch { return null; }
}
