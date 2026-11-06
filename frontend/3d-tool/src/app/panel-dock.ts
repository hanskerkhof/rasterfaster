import { Directive, ElementRef, Injectable, OnDestroy, OnInit, computed, effect, inject, input, signal } from '@angular/core';

const storageKey = 'rasterfaster.dockedPanels';
const slotGap = 6, edge = 6, maxSlotWidth = 260; // the height and the place from the bottom are in src/styles.scss (.float-panel.docked)
const animationMs = 280;

function readDocked(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/**
 * Docking of the floating panels. A panel dragged to the very bottom of the view is docked: it shrinks to its top bar and takes a place in a row along the bottom
 * (side by side, in the order they were docked); the undock button on the bar sends it back to where it was, shown in full. Docking only changes how a panel
 * is drawn (the class `docked` and the variables `--dock-left`, `--dock-width`, see `src/styles.scss`): a panel's own place and size are not touched, so it
 * comes back to them by itself. A panel registers itself under a name; a docked panel that is not on the screen takes no place in the row.
 */
@Injectable({ providedIn: 'root' })
export class PanelDock {
  /** The names of the docked panels, in the order they were docked (kept in this browser). */
  readonly dockedIds = signal<string[]>(readDocked());
  /** A panel is being dragged against the bottom edge: it would be docked when it is let go. */
  readonly hint = signal(false);

  private readonly panels = signal<{ id: string; el: HTMLElement }[]>([]);
  private readonly parentWidth = signal(0);
  private readonly observed = new Set<Element>();

  /** The panels in the dock row, in order, with their place. */
  private readonly row = computed(() => {
    const here = new Set(this.panels().map(p => p.id));
    const ids = this.dockedIds().filter(id => here.has(id));
    const width = this.parentWidth(), n = ids.length;
    const slotWidth = n ? Math.min(maxSlotWidth, Math.max(120, (width - 2 * edge - slotGap * (n - 1)) / n)) : 0; // side by side, none wider than a panel
    return ids.map((id, i) => ({ id, left: edge + i * (slotWidth + slotGap), width: slotWidth }));
  });

  constructor() {
    effect(() => {
      const row = this.row();
      for (const { id, el } of this.panels()) {
        const slot = row.find(r => r.id === id);
        el.classList.toggle('docked', !!slot);
        if (slot) { el.style.setProperty('--dock-left', slot.left + 'px'); el.style.setProperty('--dock-width', slot.width + 'px'); }
      }
    });
    effect(() => { try { localStorage.setItem(storageKey, JSON.stringify(this.dockedIds())); } catch { /* storage unavailable */ } });
  }

  /** A panel (its outer element) says it is on the screen. Returns the function that says it is gone. */
  register(id: string, el: HTMLElement): () => void {
    this.panels.update(list => [...list.filter(p => p.id !== id), { id, el }]);
    setTimeout(() => { // the container is known once the panel is in the page
      const parent = el.offsetParent;
      if (!parent || this.observed.has(parent)) { if (parent) this.parentWidth.set(parent.clientWidth); return; }
      this.observed.add(parent);
      new ResizeObserver(() => this.parentWidth.set(parent.clientWidth)).observe(parent);
      this.parentWidth.set(parent.clientWidth);
    });
    return () => this.panels.update(list => list.filter(p => p.el !== el));
  }

  isDocked(id: string): boolean {
    return this.dockedIds().includes(id) && this.panels().some(p => p.id === id);
  }

  /**
   * A drag of a panel has ended against the bottom edge: put the panel back where it was before the drag (`restore`) and dock it, gliding from where it was let go.
   * Returns whether it was docked.
   */
  dock(id: string, restore: () => void): boolean {
    const el = this.panels().find(p => p.id === id)?.el;
    if (!el) return false;
    const first = el.getBoundingClientRect();
    restore();
    this.hint.set(false);
    this.dockedIds.update(list => [...list.filter(x => x !== id), id]);
    this.glide(el, first);
    return true;
  }

  /** Undocks a panel: it glides from its place in the dock row back to the place and size it had. */
  undock(id: string) {
    const el = this.panels().find(p => p.id === id)?.el;
    if (!el) return;
    const first = el.getBoundingClientRect();
    this.dockedIds.update(list => list.filter(x => x !== id));
    this.glide(el, first);
  }

  /** Pressing a docked bar and moving up undocks the panel (a way besides the button). */
  dragUp(event: PointerEvent, id: string) {
    if ((event.target as HTMLElement).closest('button')) return;
    const y0 = event.clientY;
    const move = (e: PointerEvent) => { if (y0 - e.clientY > 8) { stop(); this.undock(id); } };
    const stop = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
  }

  /** A moderate move: the panel is drawn at its new place (and size) as it is now, from where it was (`first`), over a fraction of a second. */
  private glide(el: HTMLElement, first: DOMRect) {
    setTimeout(() => { // after the page has been updated
      const last = el.getBoundingClientRect();
      if (!last.width || !last.height || (first.left === last.left && first.top === last.top && first.width === last.width && first.height === last.height)) return;
      const base = getComputedStyle(el).transform;
      const rest = base === 'none' ? '' : ' ' + base;
      const from = `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})${rest}`;
      el.animate([{ transform: from, transformOrigin: '0 0' }, { transform: base === 'none' ? 'none' : base, transformOrigin: '0 0' }], { duration: animationMs, easing: 'cubic-bezier(.22, .8, .24, 1)' });
    }, 30);
  }
}

/** For a panel that is made in a template (the render progress panel): `<div dockable="render">` registers it for docking while it is there. */
// eslint-disable-next-line @angular-eslint/directive-selector
@Directive({ selector: '[dockable]' })
export class Dockable implements OnInit, OnDestroy {
  readonly dockable = input.required<string>();
  private readonly dock = inject(PanelDock);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private off: (() => void) | null = null;
  ngOnInit() { this.off = this.dock.register(this.dockable(), this.el.nativeElement); }
  ngOnDestroy() { this.off?.(); }
}
