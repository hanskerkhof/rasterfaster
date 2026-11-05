import { Component, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { DocumentStore } from './document.store';
import { ReleaseFocus } from './release-focus';
import { ViewModeIcon, viewModeName } from './view-mode-icon';

const storageKey = 'rasterfaster.viewsPanel';
const panelWidth = 230; // as in the styles

interface Spot { left: number; top: number }

function read(): { spot: Spot | null; collapsed: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const spot = stored && Number.isFinite(stored.left) && Number.isFinite(stored.top) ? { left: stored.left, top: stored.top } : null;
    return { spot, collapsed: stored?.collapsed === true };
  } catch { return { spot: null, collapsed: false }; }
}

/** The saved views of the document in a small floating panel: drag it by its title, fold it with the arrow. */
@Component({
  selector: 'app-views-panel',
  imports: [ReleaseFocus, ViewModeIcon],
  host: { '[style.left]': 'leftCss()', '[style.top]': 'topCss()', '[class.placed]': 'spot() !== null', '[class.collapsed]': 'collapsed()' },
  template: `
    <div class="head" (pointerdown)="startDrag($event)" title="Drag to move the panel">
      <button type="button" class="fold" releaseFocus [attr.aria-expanded]="!collapsed()" [title]="collapsed() ? 'Expand the views' : 'Collapse the views'" (pointerdown)="$event.stopPropagation()" (click)="toggle()">{{ collapsed() ? '▸' : '▾' }}</button>
      <span class="title">Views</span>
      @if (store.doc().views?.length) { <span class="count">{{ store.doc().views!.length }}</span> }
      <button type="button" class="add" releaseFocus title="Save the camera, display mode, light and ground as a view (keys 1 – 9 go to the first nine)" (pointerdown)="$event.stopPropagation()" (click)="save()">+ Save view</button>
    </div>
    @if (!collapsed()) {
      <div class="list">
        @for (view of store.doc().views ?? []; track view.id; let i = $index) {
          <div class="view" [class.active]="view.id === activeId()" [class.from]="view.id === fromId()" [attr.aria-current]="view.id === activeId() ? 'true' : null" (click)="store.goToSavedView(view.id)" (dblclick)="startRename(view.id)" [title]="rowTitle(view)">
            <span class="num">{{ i < 9 ? i + 1 : '' }}</span>
            <app-view-mode-icon [mode]="view.appMode" />
            @if (editing() === view.id) {
              <input #nameInput class="rename" [value]="view.name" maxlength="80" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (keydown)="onKey($event, view.id, nameInput)" (blur)="commit(view.id, nameInput.value)" />
            } @else if (view.id === fromId()) { <span class="label back"><span class="was">{{ view.name }}</span><span class="now">Restore</span></span> } @else { <span class="label">{{ view.name }}</span> }
            @if (view.id === fromId()) { <button type="button" class="changed" title="The camera has moved on from this view: click to save the view as you see it now (the same as ⟳)" (click)="update($event, view.id)"><span class="was">changed</span><span class="now">save</span></button> }
            <button type="button" class="x replace" title="Replace this view by what you see now (⇧ + its number)" (click)="update($event, view.id)">⟳</button>
            <button type="button" class="x" title="Delete this view" (click)="remove($event, view.id)">✕</button>
          </div>
        }
        @for (slot of freeSlots(); track slot; let first = $first) {
          <div class="view slot" [class.next]="first" [attr.title]="first ? 'Empty: click to save the current view here (key ' + slot + ' then goes to it)' : 'Empty'" (click)="first && save()">
            <span class="num">{{ slot }}</span><span class="label">empty</span>
          </div>
        }
      </div>
      <details class="keys"><summary>Keys and mouse</summary>
        <div class="hint">+ Save view: keeps the camera (position, zoom, perspective or orthographic), the display mode, the light direction and the ground and grid options under a name · click a view: go there (the camera glides) · double-click its name: rename it in place (Enter keeps, Esc cancels) · ⟳ (or ⇧ and its number) replaces it by what you see now · ✕ deletes it · keys 1 – 9: go to the first nine views, ⇧1 – ⇧9 replace them by the current view (the list or the 3D view must have focus) · drag the title bar: move the panel · ▾: fold it · the views are saved with the document, its versions and the document file</div>
      </details>
    }
  `,
  styles: `
    :host { position: absolute; left: 12px; bottom: 36px; z-index: 5; width: 230px; max-height: 50%; display: flex; flex-direction: column; box-sizing: border-box; font-size: 12px; color: #dde1e8;
            background: rgba(35,38,45,.92); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; }
    :host(.placed) { bottom: auto; }
    .head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: grab; user-select: none; touch-action: none; }
    .head:active { cursor: grabbing; }
    .title { font-weight: 600; } .count { color: #8a93a2; font-size: 11px; } .head .add { margin-left: auto; }
    button { background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; padding: 2px 8px; cursor: pointer; }
    button:hover { background: #2f6fed; color: #fff; }
    .fold { padding: 0 4px; background: transparent; border: 0; } .fold:hover { background: transparent; color: #fff; }
    .list { overflow-y: auto; padding: 0 4px 6px; display: flex; flex-direction: column; gap: 2px; }
    .view { display: flex; align-items: center; gap: 6px; padding: 3px 6px; cursor: pointer; border-radius: 4px; } .view:hover { background: rgba(255,255,255,.08); }
    .view.active { background: rgba(47,111,237,.35); box-shadow: inset 3px 0 0 #2f6fed; } .view.active:hover { background: rgba(47,111,237,.45); } .view.active .num { color: #fff; }
    .view.from { background: rgba(224,160,48,.14); box-shadow: inset 3px 0 0 #e0a030; } .view.from:hover { background: rgba(224,160,48,.24); } .view.from .num { color: #e0a030; }
    .changed { flex: none; font: inherit; font-size: 10px; letter-spacing: .02em; color: #e0a030; background: transparent; border: 1px dashed #e0a030; border-radius: 8px; padding: 0 6px; cursor: pointer; }
    .changed { display: inline-grid; } .changed span { grid-area: 1 / 1; text-align: center; } .changed .now { visibility: hidden; } /* both words in one cell: the tag keeps its width when "changed" turns into "save" */
    .changed:hover { background: #e0a030; color: #1b1d23; border-style: solid; } .changed:hover .was { visibility: hidden; } .changed:hover .now { visibility: visible; font-weight: 600; }
    .label.back { display: inline-grid; } .label.back span { grid-area: 1 / 1; } .label.back .now { visibility: hidden; font-style: italic; color: #e0a030; } .view.from:hover .label.back .was { visibility: hidden; } .view.from:hover .label.back .now { visibility: visible; } /* the name is swapped for a hint, in the same space */
    .view.from .replace { opacity: 1; color: #e0a030; }
    .view.active app-view-mode-icon { filter: brightness(1.25); }
    .num { flex: none; width: 12px; text-align: center; color: #8a93a2; font-size: 11px; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { padding: 0 5px; background: transparent; border: 0; opacity: .6; } .x:hover { opacity: 1; background: transparent; color: #fff; }
    .rename { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; color: inherit; background: #1b1d23; border: 1px solid #2f6fed; border-radius: 3px; padding: 1px 4px; outline: none; }
    .replace { font-size: 17px; line-height: 1; padding: 0 4px; }
    .keys { flex: none; padding: 0 6px 6px; } .keys summary { cursor: pointer; opacity: .6; font-size: 11px; user-select: none; } .keys summary:hover { opacity: 1; } .keys[open] .hint { margin-top: 4px; }
    .keys .hint { font-size: 11px; line-height: 1.45; opacity: .75; }
    .slot { cursor: default; color: #6b7382; font-style: italic; } .slot:hover { background: transparent; } .slot.next { cursor: pointer; } .slot.next:hover { background: rgba(255,255,255,.08); color: #dde1e8; }
  `,
})
export class ViewsPanel {
  protected readonly store = inject(DocumentStore);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly initial = read();
  protected readonly spot = signal<Spot | null>(this.initial.spot);
  protected readonly collapsed = signal(this.initial.collapsed);

  constructor() {
    effect(() => this.remember(this.spot(), this.collapsed()));
  }

  /** Where the panel is, as the 3D view allows: when the view gets narrower (the file panel opens) the panel keeps inside it, and goes back when the view is wide again. */
  protected readonly leftCss = computed(() => (this.spot() ? `min(${this.spot()!.left}px, calc(100% - ${panelWidth}px))` : null));
  protected readonly topCss = computed(() => (this.spot() ? `min(${this.spot()!.top}px, calc(100% - 40px))` : null));

  private remember(spot: Spot | null, collapsed: boolean) {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...spot, collapsed })); } catch { /* storage unavailable */ }
  }

  protected toggle() { this.collapsed.update(v => !v); }
  protected save() { this.store.saveCurrentView(); }
  /** The hover text of a row: the mode of the view, then what a click does. */
  protected rowTitle(view: { appMode?: string | null }) {
    const mode = viewModeName(view.appMode);
    return (mode ? mode + ' · ' : '') + 'Click: go to this view · double-click: rename · the camera, display mode, light and ground are kept';
  }
  protected update(event: Event, id: string) { event.stopPropagation(); this.store.updateSavedView(id); }
  protected remove(event: Event, id: string) { event.stopPropagation(); this.store.removeSavedView(id); }
  /** The saved view the camera is on now, and the one it came from when it has moved on (both from the store: the Render dialog marks them too). */
  protected readonly activeId = this.store.activeViewId;

  /** The numbers of the keys 1 – 9 that have no view yet: shown as placeholders. */
  protected readonly freeSlots = computed(() => Array.from({ length: Math.max(0, 9 - (this.store.doc().views?.length ?? 0)) }, (_, i) => (this.store.doc().views?.length ?? 0) + i + 1));

  protected readonly fromId = this.store.fromViewId;

  /** The view whose name is being edited in place. */
  protected readonly editing = signal<string | null>(null);

  protected startRename(id: string) {
    this.editing.set(id);
    setTimeout(() => { const input = this.element.nativeElement.querySelector<HTMLInputElement>('input.rename'); input?.focus(); input?.select(); });
  }

  protected onKey(event: KeyboardEvent, id: string, input: HTMLInputElement) {
    event.stopPropagation(); // typing a name is not a shortcut (1 – 9, V, R …)
    if (event.key === 'Enter') input.blur();
    else if (event.key === 'Escape') { input.value = this.store.doc().views?.find(v => v.id === id)?.name ?? ''; input.blur(); }
  }

  protected commit(id: string, name: string) {
    if (this.editing() !== id) return;
    this.editing.set(null);
    this.store.renameSavedView(id, name);
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
