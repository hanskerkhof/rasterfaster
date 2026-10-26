import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryEntry, LibraryService, RenameResult, TrashResult } from './library.service';
import { QuickLook } from './quick-look';

interface Row {
  entry: LibraryEntry;
  depth: number;
  open: boolean;
  parentPath: string | null;
}

/**
 * Flat, keyboard-navigable tree (Finder list-view behaviour):
 *  ↑/↓ move   → expands a closed folder, or steps into an open one   ← collapses an open folder, or jumps to the parent
 */
@Component({
  selector: 'app-tree-panel',
  imports: [DatePipe, NgTemplateOutlet, QuickLook],
  template: `
    @if (listNotice()) { <div class="list-notice" role="status">{{ listNotice() }}</div> }
    @if (pendingTrash(); as pending) {
      <div class="list-notice confirm" role="alert">
        “{{ pending.name }}” is used by {{ pending.parts }} part{{ pending.parts === 1 ? '' : 's' }} in {{ pending.documents }} document file{{ pending.documents === 1 ? '' : 's' }}: they show as missing until you put it back from the Trash.
        <div class="buttons">
          <button type="button" (click)="confirmTrash()">Move to Trash</button>
          <button type="button" (click)="pendingTrash.set(null)">Cancel</button>
        </div>
      </div>
    }
    <div class="tree" tabindex="0" (keydown)="onKey($event)" (mousedown)="onTreeMouseDown($event)">
      @for (r of rows(); track r.entry.path) {
        <div class="row" [class.dir]="r.entry.type === 'dir'" [class.focus]="r.entry.path === focused()"
             [class.sel]="r.entry.type === 'file' && r.entry.path === selected()"
             [style.padding-left.px]="6 + r.depth * 14" (click)="onClick(r, $event)" (dblclick)="onDoubleClick(r)" (contextmenu)="onContextMenu($event, r)">
          <span class="caret">{{ r.entry.type === 'dir' ? (r.open ? '▾' : '▸') : '' }}</span>
          @if (renaming(); as edit) {
            @if (edit.path === r.entry.path) {
              <span class="label editing">
                <input #nameInput class="rename" type="text" spellcheck="false" [value]="edit.value" [disabled]="edit.busy" aria-label="New name"
                       (input)="onRenameInput($any($event.target).value)" (keydown)="onRenameKey($event)" (click)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (blur)="cancelRename()" />
                @if (r.entry.type === 'file') { <span class="ext">.stl</span> }
                @if (edit.error) { <span class="rename-error">{{ edit.error }}</span> }
              </span>
            } @else {
              <ng-container *ngTemplateOutlet="plain; context: { $implicit: r }" />
            }
          } @else {
            <ng-container *ngTemplateOutlet="plain; context: { $implicit: r }" />
          }
          <span class="date">{{ r.entry.modified * 1000 | date: 'yyyy-MM-dd' }}</span>
        </div>
      } @empty {
        <div class="row muted">{{ results() ? '(no matches)' : 'loading…' }}</div>
      }
    </div>
    <ng-template #plain let-r>
      <span class="label">
        @for (part of parts(r.entry.name); track $index) {
          @if (part.hit) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} }
        }
      </span>
    </ng-template>
    @if (menu(); as m) {
      <div class="menu-backdrop" (mousedown)="menu.set(null)" (contextmenu)="$event.preventDefault(); menu.set(null)"></div>
      <div class="menu" role="menu" [style.left.px]="m.x" [style.top.px]="m.y">
        <button type="button" role="menuitem" (click)="startRename(m.path)">Rename…<span class="key">↵</span></button>
        <button type="button" role="menuitem" (click)="requestTrash(m.path)">Move to Trash<span class="key">⌘⌫</span></button>
      </div>
    }
    @if (quickLook() && focusedFile(); as file) {
      <app-quick-look [path]="file" [left]="popoverLeft()" (closed)="quickLook.set(false)" (interacted)="focusTree()" />
    }
  `,
  styles: `
    :host { display: block; height: 100%; }
    .tree { height: 100%; overflow: auto; padding: 4px 0; outline: none; }
    .row { display: flex; gap: 4px; padding-right: 8px; line-height: 20px; cursor: default; white-space: nowrap; }
    .row:hover { background: rgba(255,255,255,.06); }
    .dir .label { font-weight: 600; }
    .caret { flex: none; width: 1em; opacity: .7; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .date { flex: none; opacity: .4; font-size: 11px; font-variant-numeric: tabular-nums; }
    .sel { box-shadow: inset 2px 0 0 #2f6fed; }
    .focus { background: rgba(255,255,255,.16) !important; }
    .tree:focus .focus { background: #2f6fed !important; color: #fff; }
    .tree:focus .focus .date { opacity: .8; }
    .muted { opacity: .5; font-style: italic; padding-left: 12px; }
    .list-notice { padding: 4px 8px; font-size: 11px; background: #3a3320; border-bottom: 1px solid #6b5a20; }
    .list-notice.confirm .buttons { display: flex; gap: 4px; margin-top: 4px; }
    .list-notice.confirm button { padding: 2px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; cursor: pointer; }
    .list-notice.confirm button:hover { background: #2f6fed; color: #fff; }
    .editing { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; overflow: visible; }
    .rename { flex: 1; min-width: 0; font: inherit; line-height: 18px; padding: 0 4px; color: #fff; background: #1b1d22; border: 1px solid #2f6fed; border-radius: 3px; outline: none; }
    .ext { flex: none; opacity: .6; }
    .rename-error { flex: 1 0 100%; color: #ff8a8a; font-size: 11px; line-height: 14px; white-space: normal; }
    .menu-backdrop { position: fixed; inset: 0; z-index: 30; }
    .menu { position: fixed; z-index: 31; min-width: 170px; padding: 4px; background: #2a2e38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 12px; }
    .menu button { display: flex; justify-content: space-between; gap: 16px; width: 100%; padding: 4px 8px; background: transparent; color: inherit; border: 0; border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }
    .menu button:hover { background: #2f6fed; color: #fff; }
    .menu .key { opacity: .5; }
    mark { background: #e3b341; color: #111; border-radius: 2px; }
  `,
})
export class TreePanel {
  private readonly lib = inject(LibraryService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Nested search results; null = browse the library lazily. */
  readonly results = input<LibraryEntry[] | null>(null);
  readonly filter = input('');
  readonly selected = input<string | null>(null);
  /** A file path to expand the tree to and focus (used to restore the last opened file). */
  readonly reveal = input<string | null>(null);
  /** A file was selected (clicked or arrowed to). Not called `select`: that is also a DOM event name, and selecting text in the rename field would fire it. */
  readonly fileSelected = output<string>();
  /** Double-click or ⌘↓ on a file: put it into the document. */
  readonly add = output<string>();
  /** A file or directory was renamed (the tree already follows; the app updates what refers to it). */
  readonly renamed = output<RenameResult>();
  /** A file or directory was moved to the Trash (the tree already dropped it). */
  readonly trashed = output<TrashResult>();

  protected readonly focused = signal<string | null>(null);
  /** The context menu (right-click on a row), and the row being renamed in place. */
  protected readonly menu = signal<{ x: number; y: number; path: string } | null>(null);
  /** A short note shown above the list (the list was out of date and has been refreshed). */
  protected readonly listNotice = signal('');
  /** A Trash move that waits for a yes because documents use the item. */
  protected readonly pendingTrash = signal<{ path: string; name: string; parts: number; documents: number } | null>(null);
  protected readonly renaming = signal<{ path: string; value: string; error: string; busy: boolean } | null>(null);
  /** Space toggles a Finder-style preview of the focused file; it then follows the focus. */
  protected readonly quickLook = signal(false);

  /** Closes the quick look popover (the app does this whenever a part is added to the document). */
  closeQuickLook() {
    this.quickLook.set(false);
  }
  protected readonly popoverLeft = signal(392);
  protected readonly focusedFile = computed(() => this.rows().find(r => r.entry.path === this.focused() && r.entry.type === 'file')?.entry.path ?? null);
  private readonly cache = signal(new Map<string, LibraryEntry[]>());
  private readonly requested = new Set<string>();
  /** Dirs flipped away from their default state (default: open only in filter mode when they hold matches). */
  private readonly flippedBrowse = signal(new Set<string>());
  private readonly flippedFilter = signal(new Set<string>());
  private openTimer?: ReturnType<typeof setTimeout>;
  /** The filter text the current search results belong to. */
  private resultsFilter = '';

  protected readonly rows = computed<Row[]>(() => {
    const out: Row[] = [];
    const walk = (entries: LibraryEntry[] | undefined, depth: number, parentPath: string | null) => {
      for (const entry of this.lib.sorted(entries ?? [])) {
        const open = entry.type === 'dir' && this.isOpen(entry);
        out.push({ entry, depth, open, parentPath });
        if (open) walk(this.childrenOf(entry), depth + 1, entry.path);
      }
    };
    walk(this.results() ?? this.cache().get(''), 0, null);
    return out;
  });

  constructor() {
    this.load('');
    // Filter results change -> different tree: forget flips and focus.
    // A different filter -> a different tree: forget flips and focus. The same filter again (the results were refreshed after a rename, say)
    // keeps the folders open and the focus where they are.
    effect(() => {
      this.results();
      const filter = untracked(() => this.filter()).trim().toLowerCase();
      if (filter === this.resultsFilter) return;
      this.resultsFilter = filter;
      this.flippedFilter.set(new Set());
      this.focused.set(null);
    });
    // Expand every ancestor folder of the revealed file and focus it.
    effect(() => {
      const path = this.reveal();
      if (!path) return;
      const folders = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
      for (const folder of folders) this.load(folder);
      this.flippedBrowse.update(s => new Set([...s, ...folders]));
      this.focused.set(path);
    });
    // Keep the focused row in view.
    effect(() => {
      this.focused(); this.rows();
      setTimeout(() => this.host.nativeElement.querySelector('.row.focus')?.scrollIntoView({ block: 'nearest' }));
    });
  }

  private load(path: string) {
    if (this.requested.has(path)) return;
    this.requested.add(path);
    this.lib.list(path).subscribe({
      next: list => this.cache.update(m => new Map(m).set(path, list)),
      error: () => this.requested.delete(path),
    });
  }

  /**
   * Re-reads the library from disk: the root and every folder that is currently open. The old rows stay on screen until the new
   * lists arrive, so the tree doesn't flicker; folders that no longer exist drop out of the cache.
   */
  async reload() {
    // every folder that was listed before (also the ones opened while filtering), so no row keeps an old name
    const paths = [...new Set(['', ...this.flippedBrowse(), ...this.cache().keys()])];
    await Promise.allSettled(paths.map(async path => {
      try {
        const list = await firstValueFrom(this.lib.list(path));
        this.requested.add(path);
        this.cache.update(m => new Map(m).set(path, list));
      } catch {
        this.requested.delete(path);
        if (path) this.cache.update(m => { const next = new Map(m); next.delete(path); return next; });
      }
    }));
  }

  private childrenOf(e: LibraryEntry) {
    return e.children?.length ? e.children : this.cache().get(e.path);
  }

  private isOpen(e: LibraryEntry) {
    const flipped = (this.results() ? this.flippedFilter() : this.flippedBrowse()).has(e.path);
    return !!e.children?.length !== flipped;
  }

  private setOpen(e: LibraryEntry, open: boolean) {
    if (this.isOpen(e) === open) return;
    (this.results() ? this.flippedFilter : this.flippedBrowse).update(s => {
      const n = new Set(s);
      n.has(e.path) ? n.delete(e.path) : n.add(e.path);
      return n;
    });
    if (open && !e.children?.length) this.load(e.path);
  }

  /** The list had keyboard focus when the mouse went down (a click that merely focuses the list never starts a rename). */
  private treeWasFocused = false;
  private lastClick = { path: '', at: 0 };
  private slowClickTimer?: ReturnType<typeof setTimeout>;
  /** Clicks closer together than this are a double-click; the system default is about half a second. */
  private static readonly doubleClickMs = 500;
  /** After a slow second click the rename starts when no double-click follows within this time. */
  private static readonly renameDelayMs = 400;

  protected onTreeMouseDown(ev: MouseEvent) {
    this.treeWasFocused = document.activeElement === ev.currentTarget;
  }

  /**
   * Like the Finder: a click selects; a second, slow click on the item that is already selected (list has focus, no double-click)
   * starts renaming it after a brief moment. A double-click or any other click or key cancels that. A folder's arrow still toggles it.
   */
  protected onClick(r: Row, ev: MouseEvent) {
    clearTimeout(this.slowClickTimer);
    const now = performance.now();
    const path = r.entry.path;
    const sinceLast = this.lastClick.path === path ? now - this.lastClick.at : Infinity;
    this.lastClick = { path, at: now };
    const plain = !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
    const onArrow = (ev.target as HTMLElement).closest('.caret') !== null;
    const slowSecondClick = path === this.focused() && this.treeWasFocused && plain && !onArrow && sinceLast > TreePanel.doubleClickMs && !this.renaming() && !this.menu();
    this.focused.set(path);
    if (slowSecondClick) {
      this.slowClickTimer = setTimeout(() => void this.startRename(path), TreePanel.renameDelayMs);
      return;
    }
    if (r.entry.type === 'dir') this.setOpen(r.entry, !r.open);
    else this.fileSelected.emit(path);
  }

  /** Gives the list keyboard focus (without scrolling), e.g. after the preview was clicked. */
  protected focusTree() {
    this.host.nativeElement.querySelector<HTMLElement>('.tree')?.focus({ preventScroll: true });
  }

  protected onDoubleClick(r: Row) {
    clearTimeout(this.slowClickTimer); // it was a double-click, not a click to rename
    if (r.entry.type === 'file') this.add.emit(r.entry.path);
  }

  private focusRow(row: Row) {
    this.focused.set(row.entry.path);
    clearTimeout(this.openTimer);
    // Finder previews as you arrow through; debounce so holding ↓ doesn't fetch every file.
    if (row.entry.type === 'file') this.openTimer = setTimeout(() => this.fileSelected.emit(row.entry.path), 120);
  }

  protected onKey(ev: KeyboardEvent) {
    clearTimeout(this.slowClickTimer);
    // ⌘↓ = "open" like Finder: put the focused file into the document (the app closes the quick look when it adds a part).
    if (ev.metaKey && ev.key === 'ArrowDown' && !ev.ctrlKey && !ev.altKey) {
      const file = this.focusedFile();
      if (file) {
        this.add.emit(file);
        ev.preventDefault();
      }
      return;
    }
    if (ev.metaKey && ev.key === 'Backspace' && !ev.ctrlKey && !ev.altKey) { // ⌘⌫: Move to Trash, like the Finder
      const path = this.focused();
      if (path && !this.renaming()) { ev.preventDefault(); void this.requestTrash(path); }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const rows = this.rows();
    if (!rows.length) return;
    const at = rows.findIndex(r => r.entry.path === this.focused());
    const row = rows[at];
    switch (ev.key) {
      case 'ArrowDown': this.focusRow(rows[Math.min(at + 1, rows.length - 1)]); break;
      case 'ArrowUp': this.focusRow(rows[at < 0 ? 0 : Math.max(at - 1, 0)]); break;
      case 'ArrowRight':
        if (!row || row.entry.type !== 'dir') break;
        if (!row.open) this.setOpen(row.entry, true);
        else if (rows[at + 1]?.parentPath === row.entry.path) this.focusRow(rows[at + 1]);
        break;
      case 'ArrowLeft':
        if (!row) break;
        if (row.entry.type === 'dir' && row.open) this.setOpen(row.entry, false);
        else if (row.parentPath !== null) this.focusRow(rows.find(r => r.entry.path === row.parentPath)!);
        break;
      case ' ':
        if (row?.entry.type !== 'file') break;
        this.popoverLeft.set(Math.round(this.host.nativeElement.getBoundingClientRect().right) + 12);
        this.quickLook.update(open => !open);
        break;
      case 'Escape':
        if (!this.quickLook()) return;
        this.quickLook.set(false);
        break;
      case 'Enter': // like the Finder: Enter edits the name of the focused row (Enter again or Esc cancels, Enter after typing saves)
      case 'F2':
        if (row) this.startRename(row.entry.path);
        break;
      case 'Home': this.focusRow(rows[0]); break;
      case 'End': this.focusRow(rows[rows.length - 1]); break;
      default: return;
    }
    ev.preventDefault();
  }

  // --- Move to Trash (like the Finder: ⌘⌫, no question asked unless documents use it) ----------------------------------------------

  /** Moves the row to the Trash; when documents use it the user is asked first. */
  protected async requestTrash(path: string) {
    this.menu.set(null);
    this.pendingTrash.set(null);
    const row = this.rows().find(r => r.entry.path === path);
    if (!row) return;
    try {
      const dry = await firstValueFrom(this.lib.trash(path, true));
      const parts = Object.entries(dry.documents).filter(([file]) => !file.includes('.versions/')); // the working copies are what the user sees
      if (parts.length) {
        this.pendingTrash.set({ path, name: row.entry.name, parts: parts.reduce((sum, [, n]) => sum + n, 0), documents: parts.length });
        return;
      }
    } catch { /* the real call below reports what is wrong */ }
    await this.doTrash(path);
  }

  protected async confirmTrash() {
    const pending = this.pendingTrash();
    this.pendingTrash.set(null);
    if (pending) await this.doTrash(pending.path);
  }

  private async doTrash(path: string) {
    const rows = this.rows();
    const at = rows.findIndex(r => r.entry.path === path);
    const next = rows.slice(at + 1).find(r => r.parentPath === rows[at]?.parentPath) ?? rows[at - 1]; // the row that takes its place
    try {
      const result = await firstValueFrom(this.lib.trash(path));
      this.closeQuickLook();
      await this.reload();
      this.focused.set(next && next.entry.path !== path && !next.entry.path.startsWith(path + '/') ? next.entry.path : null);
      this.focusTree();
      this.trashed.emit(result);
    } catch (error) {
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      if ((error as { status?: number }).status === 404) await this.reload();
      this.listNotice.set(typeof detail === 'string' ? `Could not move it to the Trash: ${detail}` : 'Could not move it to the Trash');
      setTimeout(() => this.listNotice.set(''), 6000);
    }
  }

  // --- context menu and rename -----------------------------------------------------------------------------------------------

  protected onContextMenu(ev: MouseEvent, r: Row) {
    ev.preventDefault();
    this.focused.set(r.entry.path);
    this.menu.set({ x: Math.min(ev.clientX, innerWidth - 190), y: Math.min(ev.clientY, innerHeight - 50), path: r.entry.path });
  }

  /** Turns the row into a text field with the name (a file without its .stl) selected. */
  protected async startRename(path: string) {
    this.menu.set(null);
    const row = this.rows().find(r => r.entry.path === path);
    if (!row) return;
    this.closeQuickLook();
    // the list can be out of date (something else renamed or moved it): check the folder it is in before offering the field
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    try {
      const current = await firstValueFrom(this.lib.list(parent));
      if (!current.some(entry => entry.path === path)) {
        await this.reload();
        this.listNotice.set(`“${row.entry.name}” is no longer there under that name: the list was refreshed, try again.`);
        setTimeout(() => this.listNotice.set(''), 6000);
        return;
      }
    } catch { /* offline: the rename itself will say so */ }
    const name = row.entry.type === 'file' ? row.entry.name.replace(/\.stl$/i, '') : row.entry.name;
    this.renaming.set({ path, value: name, error: '', busy: false });
    setTimeout(() => {
      const input = this.host.nativeElement.querySelector<HTMLInputElement>('input.rename');
      input?.focus();
      input?.select();
    });
  }

  protected onRenameInput(value: string) {
    this.renaming.update(edit => (edit ? { ...edit, value, error: '' } : edit));
  }

  protected onRenameKey(ev: KeyboardEvent) {
    ev.stopPropagation(); // arrows and Space belong to the text field, not to the tree
    if (ev.key === 'Escape') { ev.preventDefault(); this.cancelRename(); this.focusTree(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); void this.commitRename(); }
  }

  protected cancelRename() {
    if (this.renaming()?.busy) return;
    this.renaming.set(null);
  }

  private async commitRename() {
    const edit = this.renaming();
    if (!edit || edit.busy) return;
    const row = this.rows().find(r => r.entry.path === edit.path);
    const name = edit.value.trim();
    if (!row || !name || name === (row.entry.type === 'file' ? row.entry.name.replace(/\.stl$/i, '') : row.entry.name)) { this.renaming.set(null); this.focusTree(); return; } // unchanged: same as cancelling
    this.renaming.set({ ...edit, busy: true });
    try {
      const result = await firstValueFrom(this.lib.rename(edit.path, name));
      this.renaming.set(null);
      this.followRename(result);
      await this.reload();
      this.focusTree();
      this.renamed.emit(result);
    } catch (error) {
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      if ((error as { status?: number }).status === 404) { // it is not there under that name: the list was out of date
        this.renaming.set(null);
        await this.reload();
        this.listNotice.set('That file is no longer there under that name: the list was refreshed, try again.');
        setTimeout(() => this.listNotice.set(''), 6000);
        return;
      }
      this.renaming.set({ ...edit, busy: false, error: typeof detail === 'string' ? detail : 'rename failed' });
      setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('input.rename')?.focus());
    }
  }

  /** Moves the tree's own state (open folders, focus) from the old path to the new one. */
  private followRename(result: RenameResult) {
    const underOld = (path: string) => path === result.from || path.startsWith(result.from + '/');
    const map = (path: string) => (underOld(path) ? result.to + path.slice(result.from.length) : path);
    this.flippedBrowse.update(s => new Set([...s].map(map)));
    this.flippedFilter.update(s => new Set([...s].map(map)));
    this.focused.update(path => (path ? map(path) : path));
    // listings of folders at or below the old name are of folders that do not exist any more
    this.cache.update(m => new Map([...m].filter(([path]) => !underOld(path))));
    for (const path of [...this.requested]) if (underOld(path)) this.requested.delete(path);
    // the folders that are open now (under their new names) are listed again
    for (const path of [...this.flippedBrowse(), ...this.flippedFilter()]) if (!this.requested.has(path)) this.load(path);
  }

  protected parts(text: string) {
    const f = this.filter().trim().toLowerCase();
    if (!f) return [{ text, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    const lower = text.toLowerCase();
    let i = 0;
    for (let at = lower.indexOf(f); at >= 0; at = lower.indexOf(f, i)) {
      if (at > i) out.push({ text: text.slice(i, at), hit: false });
      out.push({ text: text.slice(at, at + f.length), hit: true });
      i = at + f.length;
    }
    if (i < text.length) out.push({ text: text.slice(i), hit: false });
    return out;
  }
}
