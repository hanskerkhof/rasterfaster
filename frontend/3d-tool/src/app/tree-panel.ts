import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { highlightParts } from './filter-terms';
import { LibraryEntry, LibraryService, MoveBatchResult, RenameResult, TrashBatchResult } from './library.service';
import { QuickLook } from './quick-look';
import { actedOn, pruned, rangeBetween, toggled } from './tree-selection';

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
    @if (listNotice()) {
      <div class="list-notice" role="status">{{ listNotice() }}
        @if (listNoticeAction()) { <button type="button" class="notice-action" (click)="openTrash.emit()">Open Trash</button> }
        @if (noticeRelink(); as ids) { <button type="button" class="notice-action" title="Pick another library file for the part" (click)="relink.emit(ids)">Relink…</button> }
      </div>
    }
    @if (pendingTrash(); as pending) {
      <div class="list-notice confirm" role="alert">
        {{ pending.what }} used by {{ pending.parts }} part{{ pending.parts === 1 ? '' : 's' }} in {{ pending.documents }} document file{{ pending.documents === 1 ? '' : 's' }}: they show as missing until you put {{ pending.paths.length === 1 ? 'it' : 'them' }} back from the Trash.
        <div class="buttons">
          <button type="button" (click)="confirmTrash()">Move to Trash</button>
          <button type="button" (click)="pendingTrash.set(null)">Cancel</button>
        </div>
      </div>
    }
    <div class="tree" [class.drop-root]="dropTarget() === ''" tabindex="0" (keydown)="onKey($event)" (mousedown)="onTreeMouseDown($event)" (contextmenu)="onEmptyContextMenu($event)"
         (dragover)="onDragOver($event, null)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event, null)">
      @for (r of rows(); track r.entry.path) {
        <div class="row" [class.dir]="r.entry.type === 'dir'" [class.focus]="r.entry.path === focused()" [class.picked]="isPicked(r.entry.path)" [class.drop]="dropTarget() === r.entry.path"
             draggable="true" (dragstart)="onDragStart($event, r)" (dragend)="endDrag()" (dragover)="onDragOver($event, r)" (drop)="onDrop($event, r)"
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
        @if (m.paths.length) {
          <button type="button" role="menuitem" [disabled]="!m.files.length" (click)="addFromMenu(m.files)">{{ m.files.length > 1 ? 'Add ' + m.files.length + ' Files to Document' : 'Add to Document' }}<span class="key">⌘↓</span></button>
          <div class="sep"></div>
          <button type="button" role="menuitem" [disabled]="m.paths.length > 1" (click)="startRename(m.paths[0])">Rename…<span class="key">↵</span></button>
          <button type="button" role="menuitem" [disabled]="m.paths.length > 1 || !m.files.length" (click)="duplicateFile(m.paths[0])">Duplicate</button>
        }
        <button type="button" role="menuitem" [disabled]="m.paths.length > 1" (click)="newFolder(m.paths[0] ?? null)">New Folder</button>
        @if (m.paths.length) {
          <div class="sep"></div>
          <button type="button" role="menuitem" [disabled]="m.paths.length > 1" (click)="revealInFinder(m.paths[0])">Reveal in Finder</button>
          <button type="button" role="menuitem" (click)="copyPaths(m.paths, true)">{{ m.paths.length > 1 ? 'Copy Paths' : 'Copy Path' }}</button>
          <button type="button" role="menuitem" (click)="copyPaths(m.paths, false)">{{ m.paths.length > 1 ? 'Copy Relative Paths' : 'Copy Relative Path' }}</button>
          <div class="sep"></div>
          <button type="button" role="menuitem" (click)="requestTrash(m.paths)">{{ m.paths.length > 1 ? 'Move ' + m.paths.length + ' Items to Trash' : 'Move to Trash' }}<span class="key">⌘⌫</span></button>
        }
      </div>
    }
    @if (quickLook() && focusedFile(); as file) {
      <app-quick-look [path]="file" [left]="popoverLeft()" (closed)="quickLook.set(false)" (interacted)="focusTree()" />
    }
  `,
  styles: `
    :host { display: block; height: 100%; }
    .tree { height: 100%; overflow: auto; padding: 4px 0; outline: none; }
    /* room to scroll past the last row (as in a code editor): a file near the end of a long list (Find in browser) can be scrolled up to the middle */
    .tree::after { content: ''; display: block; height: 50%; }
    .row { display: flex; gap: 4px; padding-right: 8px; line-height: 20px; cursor: default; white-space: nowrap; }
    .row:hover { background: rgba(255,255,255,.06); }
    .dir .label { font-weight: 600; }
    .caret { flex: none; width: 1em; opacity: .7; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .date { flex: none; opacity: .4; font-size: 11px; font-variant-numeric: tabular-nums; }
    .sel { box-shadow: inset 2px 0 0 #2f6fed; }
    .focus { background: rgba(255,255,255,.16) !important; }
    .picked { background: rgba(255,255,255,.16); }
    .tree:focus .picked { background: #2f6fed; color: #fff; }
    .tree:focus .picked .date { opacity: .8; }
    .menu button:disabled { opacity: .35; cursor: default; }
    .menu button:disabled:hover { background: transparent; color: inherit; }
    .tree:focus .focus { background: #2f6fed !important; color: #fff; }
    .tree:focus .focus .date { opacity: .8; }
    .muted { opacity: .5; font-style: italic; padding-left: 12px; }
    .list-notice { padding: 4px 8px; font-size: 11px; background: #3a3320; border-bottom: 1px solid #6b5a20; }
    .list-notice.confirm .buttons { display: flex; gap: 4px; margin-top: 4px; }
    .list-notice.confirm button { padding: 2px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; cursor: pointer; }
    .list-notice.confirm button:hover { background: #2f6fed; color: #fff; }
    .list-notice .notice-action { margin-left: 8px; padding: 1px 8px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; font: inherit; cursor: pointer; }
    .list-notice .notice-action:hover { background: #2f6fed; color: #fff; }
    .editing { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; overflow: visible; }
    .rename { flex: 1; min-width: 0; font: inherit; line-height: 18px; padding: 0 4px; color: #fff; background: #1b1d22; border: 1px solid #2f6fed; border-radius: 3px; outline: none; }
    .ext { flex: none; opacity: .6; }
    .rename-error { flex: 1 0 100%; color: #ff8a8a; font-size: 11px; line-height: 14px; white-space: normal; }
    .menu-backdrop { position: fixed; inset: 0; z-index: 30; }
    .menu { position: fixed; z-index: 31; min-width: 170px; padding: 4px; background: #2a2e38; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 12px; }
    .menu button { display: flex; justify-content: space-between; gap: 16px; width: 100%; padding: 4px 8px; background: transparent; color: inherit; border: 0; border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }
    .menu button:hover { background: #2f6fed; color: #fff; }
    .menu .key { opacity: .5; }
    .menu .sep { height: 1px; margin: 4px 2px; background: rgba(255,255,255,.12); }
    .row.drop { background: #2f6fed; color: #fff; }
    .tree.drop-root { box-shadow: inset 0 0 0 2px #2f6fed; }
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
  /** "Find in browser": open the folders above these files, select them, scroll to the first (`seq` makes the same request count again). */
  readonly find = input<{ paths: string[]; seq: number; ids?: string[] } | null>(null);
  /** A file was selected (clicked or arrowed to). Not called `select`: that is also a DOM event name, and selecting text in the rename field would fire it. */
  readonly fileSelected = output<string>();
  /** Double-click or ⌘↓ on a file: put it into the document. */
  readonly add = output<string>();
  /** ⌘↓ with the selection: put all selected files into the document (a folder in the selection is ignored). */
  readonly addMany = output<string[]>();
  /** A file or directory was renamed (the tree already follows; the app updates what refers to it). */
  readonly renamed = output<RenameResult>();
  /** One or more files or directories were moved to the Trash (the tree already dropped them). */
  readonly trashed = output<TrashBatchResult>();
  /** Files or directories were moved into another folder (the tree already follows; the app updates what refers to them). */
  readonly moved = output<MoveBatchResult>();
  /** The list is filtered and a new folder would not show (it matches nothing): the app should clear the filter. */
  readonly showAll = output<void>();
  /** The notice's "Open Trash" button: the app opens the Trash dialog. */
  readonly openTrash = output<void>();
  /** The notice's "Relink…" button: the parts (document item ids) that were looked up get another file. */
  readonly relink = output<string[]>();
  /** Ids of the document parts the notice is about (for its Relink button); null when the notice has none. */
  protected readonly noticeRelink = signal<string[] | null>(null);

  protected readonly focused = signal<string | null>(null);
  /** The context menu (right-click on a row), and the row being renamed in place. */
  protected readonly menu = signal<{ x: number; y: number; paths: string[]; files: string[] } | null>(null);
  /** A short note shown above the list (the list was out of date and has been refreshed). */
  protected readonly listNotice = signal('');
  /** The notice has a button that opens the Trash (the missing file is in it). */
  protected readonly listNoticeAction = signal(false);
  /** A Trash move that waits for a yes because documents use the item. */
  protected readonly pendingTrash = signal<{ paths: string[]; what: string; parts: number; documents: number } | null>(null);
  protected readonly renaming = signal<{ path: string; value: string; error: string; busy: boolean } | null>(null);
  /** Space toggles a Finder-style preview of the focused file; it then follows the focus. */
  protected readonly quickLook = signal(false);

  /** Closes the quick look popover (the app does this whenever a part is added to the document). */
  closeQuickLook() {
    this.quickLook.set(false);
  }
  protected readonly popoverLeft = signal(392);
  readonly focusedFile = computed(() => this.rows().find(r => r.entry.path === this.focused() && r.entry.type === 'file')?.entry.path ?? null);
  private readonly cache = signal(new Map<string, LibraryEntry[]>());
  private readonly requested = new Set<string>();
  /** Dirs flipped away from their default state (default: open only in filter mode when they hold matches). */
  private readonly flippedBrowse = signal(new Set<string>());
  private readonly flippedFilter = signal(new Set<string>());
  /**
   * The selected rows (the Finder's selection). `focused` is the row the keyboard cursor is on (its file is the one the app shows), `anchor`
   * is where a Shift-range starts. Plain click and plain arrows select just the focused row.
   */
  protected readonly selection = signal<ReadonlySet<string>>(new Set());
  private anchor: string | null = null;
  private openTimer?: ReturnType<typeof setTimeout>;
  /** The filter text the current search results belong to. */
  private resultsFilter = '';
  /** The last non-empty filter results, to tell files from folders when the filter is cleared. */
  private lastResults: LibraryEntry[] | null = null;
  /** The selected paths that must survive the switch from the filtered list to the whole list (until their rows show up, at most 4 s). */
  private keepAfterClear: ReadonlySet<string> | null = null;
  private keepTimer?: ReturnType<typeof setTimeout>;
  /** The path to scroll to the middle of the list the next time its row is there (Find in browser). */
  private centreOn: string | null = null;

  private readonly visiblePaths = computed(() => this.rows().map(r => r.entry.path));

  /** The selected files (not folders) in row order, when more than one row is selected; empty otherwise. */
  readonly pickedFiles = computed(() => {
    if (this.selection().size < 2) return [];
    return this.rows().filter(r => r.entry.type === 'file' && this.selection().has(r.entry.path)).map(r => r.entry.path);
  });

  /** Highlighted as part of a multi-selection (a single selection is just the focused row). */
  protected isPicked(path: string) {
    return this.selection().size > 1 && this.selection().has(path);
  }

  private selectOnly(path: string | null) {
    this.selection.set(path === null ? new Set() : new Set([path]));
    this.anchor = path;
  }

  /** What an action (Move to Trash...) acts on: the selection when the focused row is in it, else just the focused row. */
  private targets(): string[] {
    const focused = this.focused();
    if (focused !== null && this.selection().has(focused)) return actedOn(this.visiblePaths(), this.selection());
    return focused === null ? [] : [focused];
  }

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
    // keeps the folders open and the focus where they are. A filter that is cleared while something is selected keeps the selection and opens
    // the folders it is in: the list goes back to the whole library with the chosen file (or folder) in view.
    effect(() => {
      const results = this.results();
      if (results) this.lastResults = results;
      const filter = untracked(() => this.filter()).trim().toLowerCase();
      if (filter === this.resultsFilter) return;
      const cleared = filter === '' && this.resultsFilter !== '';
      this.resultsFilter = filter;
      this.flippedFilter.set(new Set());
      if (cleared && untracked(() => this.selection().size || this.selected())) {  // the open file counts too: the selection of the list is reset by every change of the filter text
        untracked(() => this.revealAfterClear());
        return;
      }
      this.focused.set(null);
      this.selectOnly(null);
    });
    // Rows that are gone (reloaded, filtered away) leave the selection. Not while a selection is being brought back after the filter was
    // cleared: its rows only appear once their folders are open and listed.
    effect(() => {
      const visible = this.visiblePaths();
      untracked(() => {
        if (this.keepAfterClear) {
          const shown = new Set(visible);
          if (![...this.keepAfterClear].every(path => shown.has(path))) return;
          this.keepAfterClear = null;
        }
        this.selection.update(s => (s.size ? pruned(visible, s) : s));
      });
    });
    // "Find in browser" from the part menu: open the folders above the files, select them, focus the first (the focus effect below scrolls to it).
    effect(() => {
      const request = this.find();
      if (!request?.paths.length) return;
      untracked(() => {
        const folders = new Set<string>();
        for (const path of request.paths) {
          const parts = path.split('/');
          for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
        }
        for (const folder of folders) this.load(folder);
        this.flippedBrowse.update(s => new Set([...s, ...folders]));
        this.centreOn = request.paths[0];
        this.focused.set(request.paths[0]);
        this.selection.set(new Set(request.paths));
        this.anchor = request.paths[0];
        this.holdSelection(request.paths);
        this.closeQuickLook();
        setTimeout(() => this.scrollToFocused()); // the focus may not change (already on that file): scroll anyway; else the effect does it when the row appears
        setTimeout(() => this.focusTree(), 60); // the selected rows are blue while the list has the keyboard focus
        void this.explainMissing(request.paths, request.ids); // a file that is not in the library (any more) cannot be shown: say why
      });
    });
    // Expand every ancestor folder of the revealed file and focus it.
    effect(() => {
      const path = this.reveal();
      if (!path) return;
      const folders = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
      for (const folder of folders) this.load(folder);
      this.flippedBrowse.update(s => new Set([...s, ...folders]));
      this.focused.set(path);
      this.selectOnly(path);
    });
    // Keep the focused row in view. A file that was asked for ("Find in browser") is put in the middle of the list, once its row exists (its
    // folders may still be loading), so that it is not left at the very bottom edge with nothing below it to look at.
    effect(() => {
      this.focused(); this.rows();
      setTimeout(() => this.scrollToFocused());
    });
  }

  private typeInResults(path: string, entries: LibraryEntry[] | null = this.lastResults): 'file' | 'dir' | null {
    for (const entry of entries ?? []) {
      if (entry.path === path) return entry.type;
      if (entry.children?.length && path.startsWith(entry.path + '/')) {
        const found = this.typeInResults(path, entry.children);
        if (found) return found;
      }
    }
    return null;
  }

  /** The filter was cleared with a selection: open the folders above every selected path (and a selected folder itself), keep the selection and the focus. */
  private revealAfterClear() {
    const paths = [...this.selection()];
    const focused = this.focused();
    if (focused && !paths.includes(focused)) paths.push(focused);
    const openFile = this.selected();
    if (openFile && !paths.includes(openFile)) { // the file that is open in the app: when the list lost its own selection, it gets it back
      paths.push(openFile);
      if (!this.selection().size) { this.focused.set(openFile); this.selectOnly(openFile); }
    }
    const open = new Set<string>();
    for (const path of paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
      if (this.typeInResults(path) === 'dir') open.add(path);
    }
    for (const folder of open) this.load(folder);
    this.flippedBrowse.update(flipped => new Set([...flipped, ...open]));
    this.holdSelection(paths);
  }

  /** Says which of these files are not in the library, and when they are in the Trash where and how to get them back. */
  private async explainMissing(paths: string[], ids?: string[]) {
    try {
      let missing: string[];
      try {
        missing = await this.lib.missing(paths);
      } catch { // an API that is older than this front end has no such endpoint: what the list shows has to do
        missing = paths.filter(path => !this.visiblePaths().includes(path));
      }
      if (!missing.length) return;
      await this.lib.refreshTrash();
      const items = missing.map(path => this.lib.trashedFrom(path));
      const inTrash = items.filter(item => item !== null).length;
      const name = (path: string) => `“${path.split('/').pop()}”`;
      let message: string;
      if (missing.length === 1) {
        const item = items[0];
        message = item ? `${name(missing[0])} is in the Trash${item.kind === 'directory' ? `, inside “${item.name}”` : ''}: put it back to find it here.` : `${name(missing[0])} is not in the library (moved or deleted outside the app?).`;
      } else {
        message = inTrash === missing.length ? `${missing.length} files are in the Trash: put them back to find them here.`
          : `${missing.length} files are not in the library${inTrash ? ` (${inTrash} of them in the Trash)` : ''}.`;
      }
      this.note(message, inTrash > 0, ids?.length ? ids : null);
    } catch { /* offline: no explanation */ }
  }

  /** The rows of these paths appear only once their folders are open and listed: until then (at most 4 s) the selection is not pruned. */
  private holdSelection(paths: string[]) {
    this.keepAfterClear = new Set(paths);
    clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepAfterClear = null;
      this.selection.update(s => (s.size ? pruned(this.visiblePaths(), s) : s));
    }, 4000);
  }

  /** Scrolls the focused row into view (to the middle of the list when it was asked for by Find in browser and its row exists). */
  private scrollToFocused() {
    const row = this.host.nativeElement.querySelector('.row.focus');
    if (!row) return;
    const centre = this.centreOn !== null && this.centreOn === this.focused();
    row.scrollIntoView({ block: centre ? 'center' : 'nearest' });
    if (centre) this.centreOn = null;
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
    if (this.listNoticeAction()) { this.listNotice.set(''); this.listNoticeAction.set(false); } // "it is in the Trash": the Trash has just changed, the list was re-read
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

  protected addFromMenu(files: string[]) {
    this.menu.set(null);
    if (files.length > 1) this.addMany.emit(files);
    else if (files.length === 1) this.add.emit(files[0]);
  }

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
    const alone = this.selection().size <= 1;
    const slowSecondClick = path === this.focused() && this.treeWasFocused && plain && alone && !onArrow && sinceLast > TreePanel.doubleClickMs && !this.renaming() && !this.menu();
    if (ev.shiftKey && !onArrow) { // Shift-click: everything from the anchor to here
      this.selection.set(new Set(rangeBetween(this.visiblePaths(), this.anchor ?? this.focused(), path)));
      this.focused.set(path);
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !onArrow) { // ⌘-click: this row in or out of the selection
      this.selection.update(s => toggled(s, path));
      this.anchor = path;
      this.focused.set(path);
      return;
    }
    this.focused.set(path);
    if (!slowSecondClick) this.selectOnly(path);
    if (slowSecondClick) {
      this.slowClickTimer = setTimeout(() => void this.startRename(path), TreePanel.renameDelayMs);
      return;
    }
    if (r.entry.type === 'dir') this.setOpen(r.entry, !r.open);
    else this.fileSelected.emit(path);
  }

  /** Gives the list keyboard focus (without scrolling), e.g. after the preview was clicked. */
  focusTree() {
    this.host.nativeElement.querySelector<HTMLElement>('.tree')?.focus({ preventScroll: true });
  }

  protected onDoubleClick(r: Row) {
    clearTimeout(this.slowClickTimer); // it was a double-click, not a click to rename
    if (r.entry.type === 'file') this.add.emit(r.entry.path);
  }

  private focusRow(row: Row, extend = false) {
    this.focused.set(row.entry.path);
    if (extend) { // Shift+arrow: the selection grows from the anchor to the new row
      this.selection.set(new Set(rangeBetween(this.visiblePaths(), this.anchor ?? row.entry.path, row.entry.path)));
      return;
    }
    this.selectOnly(row.entry.path);
    clearTimeout(this.openTimer);
    // Finder previews as you arrow through; debounce so holding ↓ doesn't fetch every file.
    if (row.entry.type === 'file') this.openTimer = setTimeout(() => this.fileSelected.emit(row.entry.path), 120);
  }

  protected onKey(ev: KeyboardEvent) {
    clearTimeout(this.slowClickTimer);
    // ⌘↓ = "open" like Finder: put the focused file into the document (the app closes the quick look when it adds a part).
    if (ev.metaKey && ev.key === 'ArrowDown' && !ev.ctrlKey && !ev.altKey) {
      const files = this.pickedFiles();
      if (files.length > 1) {
        this.addMany.emit(files);
        ev.preventDefault();
      } else if (this.focusedFile()) {
        this.add.emit(this.focusedFile()!);
        ev.preventDefault();
      }
      return;
    }
    if (ev.metaKey && ev.key === 'Backspace' && !ev.ctrlKey && !ev.altKey) { // ⌘⌫: Move to Trash, like the Finder
      if (!this.renaming()) { ev.preventDefault(); void this.requestTrash(this.targets()); }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === 'a') { // ⌘A: select all rows
      ev.preventDefault();
      this.selection.set(new Set(this.visiblePaths()));
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const rows = this.rows();
    if (!rows.length) return;
    const at = rows.findIndex(r => r.entry.path === this.focused());
    const row = rows[at];
    switch (ev.key) {
      case 'ArrowDown': this.focusRow(rows[Math.min(at + 1, rows.length - 1)], ev.shiftKey); break;
      case 'ArrowUp': this.focusRow(rows[at < 0 ? 0 : Math.max(at - 1, 0)], ev.shiftKey); break;
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
        if (this.menu()) this.menu.set(null);
        else if (this.quickLook()) this.quickLook.set(false);
        else if (this.selection().size > 1) this.selectOnly(this.focused()); // back to the focused row alone
        else return;
        break;
      case 'Enter': // like the Finder: Enter edits the name of the focused row (Enter again or Esc cancels, Enter after typing saves)
      case 'F2':
        if (this.selection().size > 1) this.note('Select one item to rename it.');
        else if (row) this.startRename(row.entry.path);
        break;
      case 'Home': this.focusRow(rows[0]); break;
      case 'End': this.focusRow(rows[rows.length - 1]); break;
      default: return;
    }
    ev.preventDefault();
  }

  // --- Move to Trash (like the Finder: ⌘⌫, no question asked unless documents use it) ----------------------------------------------

  /** Moves the rows to the Trash; when documents use them the user is asked first. */
  protected async requestTrash(paths: string[]) {
    this.menu.set(null);
    this.pendingTrash.set(null);
    const chosen = actedOn(this.visiblePaths(), new Set(paths));
    if (!chosen.length) return;
    try {
      const dry = await firstValueFrom(this.lib.trashBatch(chosen, true));
      const parts = Object.entries(dry.documents ?? {}).filter(([file]) => !file.includes('.versions/')); // the working copies are what the user sees
      if (parts.length) {
        const first = this.rows().find(r => r.entry.path === chosen[0])?.entry.name ?? chosen[0];
        this.pendingTrash.set({ paths: chosen, what: chosen.length === 1 ? `“${first}” is` : `${chosen.length} items are`, parts: parts.reduce((sum, [, n]) => sum + n, 0), documents: parts.length });
        return;
      }
    } catch { /* the real call below reports what is wrong */ }
    await this.doTrash(chosen);
  }

  protected async confirmTrash() {
    const pending = this.pendingTrash();
    this.pendingTrash.set(null);
    if (pending) await this.doTrash(pending.paths);
  }

  private async doTrash(paths: string[]) {
    const rows = this.rows();
    const gone = (path: string) => paths.some(p => path === p || path.startsWith(p + '/'));
    const lastAt = Math.max(...paths.map(p => rows.findIndex(r => r.entry.path === p)));
    const firstAt = Math.min(...paths.map(p => rows.findIndex(r => r.entry.path === p)).filter(i => i >= 0));
    const next = rows.slice(lastAt + 1).find(r => !gone(r.entry.path)) ?? [...rows.slice(0, Math.max(firstAt, 0))].reverse().find(r => !gone(r.entry.path)); // the row that takes its place
    try {
      const result = await firstValueFrom(this.lib.trashBatch(paths));
      this.closeQuickLook();
      await this.reload();
      this.focused.set(next?.entry.path ?? null);
      this.selectOnly(next?.entry.path ?? null);
      this.focusTree();
      if (result.failed.length) this.note(`${result.failed.length} of ${paths.length} could not be moved to the Trash: ${result.failed[0].error}`);
      this.trashed.emit(result);
    } catch (error) {
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      if ((error as { status?: number }).status === 404) await this.reload();
      this.note(typeof detail === 'string' ? `Could not move it to the Trash: ${detail}` : 'Could not move it to the Trash');
    }
  }

  /** A note above the list for a few seconds. */
  private note(message: string, withTrashButton = false, relinkIds: string[] | null = null) {
    this.listNotice.set(message);
    this.listNoticeAction.set(withTrashButton);
    this.noticeRelink.set(relinkIds);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.listNotice.set(''); this.listNoticeAction.set(false); this.noticeRelink.set(null); }, withTrashButton || relinkIds ? 12000 : 6000);
  }
  private noticeTimer?: ReturnType<typeof setTimeout>;

  // --- context menu and rename -----------------------------------------------------------------------------------------------

  protected onContextMenu(ev: MouseEvent, r: Row) {
    ev.preventDefault();
    ev.stopPropagation();
    this.focused.set(r.entry.path);
    if (!this.selection().has(r.entry.path)) this.selectOnly(r.entry.path); // right-click inside a selection keeps it (the Finder)
    const selectedFiles = this.pickedFiles();
    const files = selectedFiles.length > 1 ? selectedFiles : r.entry.type === 'file' ? [r.entry.path] : []; // folders cannot be added
    this.menu.set({ x: Math.min(ev.clientX, innerWidth - 220), y: Math.min(ev.clientY, innerHeight - 100), paths: this.targets(), files });
  }

  /** Right-click on the empty area under the rows: only New Folder (in the library root). */
  protected onEmptyContextMenu(ev: MouseEvent) {
    ev.preventDefault();
    this.menu.set({ x: Math.min(ev.clientX, innerWidth - 220), y: Math.min(ev.clientY, innerHeight - 100), paths: [], files: [] });
  }

  /** Makes a folder at the top level of the library (the header button). */
  async newFolderAtRoot() {
    await this.newFolder(null);
  }

  /** Makes a folder inside `path` (or next to it when it is a file; in the library root without a path) and opens it for naming. */
  protected async newFolder(path: string | null) {
    this.menu.set(null);
    const row = path === null ? null : this.rows().find(r => r.entry.path === path);
    const parent = path === null ? '' : row?.entry.type === 'dir' ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (let number = 1; number < 50; number++) {
      try {
        const made = await firstValueFrom(this.lib.newFolder(parent, number === 1 ? 'untitled folder' : `untitled folder ${number}`));
        if (this.filter().trim()) { // the new folder matches no filter: show the whole list again, as the Finder shows the new folder in its window
          this.showAll.emit();
          await new Promise(resolve => setTimeout(resolve, 150)); // the app clears the filter and the tree resets its open folders and focus
        }
        const ancestors = made.path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
        for (const folder of ancestors) this.load(folder);
        this.flippedBrowse.update(s => new Set([...s, ...ancestors])); // every folder above it opens
        await this.reload();
        this.focused.set(made.path);
        this.selectOnly(made.path);
        await this.startRename(made.path);
        return;
      } catch (error) {
        if ((error as { status?: number }).status !== 409) {
          const detail = (error as { error?: { detail?: unknown } }).error?.detail;
          this.note(typeof detail === 'string' ? `Could not make a folder: ${detail}` : 'Could not make a folder');
          return;
        }
      }
    }
  }

  protected async duplicateFile(path: string) {
    this.menu.set(null);
    try {
      const made = await firstValueFrom(this.lib.duplicate(path));
      await this.reload();
      this.focused.set(made.path);
      this.selectOnly(made.path);
      this.focusTree();
    } catch (error) {
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      this.note(typeof detail === 'string' ? `Could not duplicate it: ${detail}` : 'Could not duplicate it');
    }
  }

  protected async revealInFinder(path: string) {
    this.menu.set(null);
    try { await firstValueFrom(this.lib.reveal(path)); } catch { this.note('Reveal in Finder only works on the Mac that runs the API'); }
  }

  /** Puts the path of the items on the clipboard as text: the full path on this machine, or the path inside the library; one per line for several. */
  protected async copyPaths(paths: string[], absolute: boolean) {
    this.menu.set(null);
    try {
      const root = absolute ? await this.lib.rootPath() : '';
      await navigator.clipboard.writeText(paths.map(path => (absolute ? `${root}/${path}` : path)).join('\n'));
      this.note(paths.length > 1 ? `${paths.length} paths copied` : 'Path copied');
    } catch {
      this.note('Could not copy the path');
    }
  }

  // --- drag and drop: move the selection into a folder ----------------------------------------------------------------------------

  /** The folder under the pointer while dragging ('' is the library root), and what is being dragged. */
  protected readonly dropTarget = signal<string | null>(null);
  private dragPaths: string[] = [];
  private hoverTimer?: ReturnType<typeof setTimeout>;

  protected onDragStart(ev: DragEvent, r: Row) {
    if (this.renaming()) { ev.preventDefault(); return; }
    if (!this.selection().has(r.entry.path)) { this.focused.set(r.entry.path); this.selectOnly(r.entry.path); }
    this.dragPaths = actedOn(this.visiblePaths(), this.selection());
    ev.dataTransfer?.setData('text/plain', this.dragPaths.join('\n'));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  protected endDrag() {
    this.dragPaths = [];
    this.dropTarget.set(null);
    clearTimeout(this.hoverTimer);
  }

  /** The folder a drop on this row lands in: the folder itself, the folder of a file, or the root. */
  private dropFolder(r: Row | null): string {
    if (!r) return '';
    return r.entry.type === 'dir' ? r.entry.path : r.parentPath ?? '';
  }

  private canDrop(folder: string): boolean {
    if (!this.dragPaths.length) return false;
    return this.dragPaths.every(p => {
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return parent !== folder && folder !== p && !folder.startsWith(p + '/');
    });
  }

  protected onDragOver(ev: DragEvent, r: Row | null) {
    const folder = this.dropFolder(r);
    if (!this.canDrop(folder)) { this.dropTarget.set(null); return; }
    ev.preventDefault();
    ev.stopPropagation();
    if (this.dropTarget() !== folder) {
      this.dropTarget.set(folder);
      clearTimeout(this.hoverTimer);
      if (r?.entry.type === 'dir' && !r.open) this.hoverTimer = setTimeout(() => this.setOpen(r.entry, true), 700); // hover opens a closed folder
    }
  }

  protected onDragLeave(ev: DragEvent) {
    if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node | null)) this.dropTarget.set(null);
  }

  protected async onDrop(ev: DragEvent, r: Row | null) {
    const folder = this.dropFolder(r);
    const paths = this.dragPaths;
    if (!this.canDrop(folder)) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.endDrag();
    try {
      const result = await firstValueFrom(this.lib.move(paths, folder));
      for (const item of result.results) this.followRename(item);
      if (folder) this.flippedBrowse.update(s => (this.rows().some(row => row.entry.path === folder && row.open) ? s : new Set([...s, folder])));
      this.closeQuickLook();
      await this.reload();
      if (result.failed.length) this.note(`${result.failed.length} of ${paths.length} could not be moved: ${result.failed[0].error}`);
      this.focusTree();
      this.moved.emit(result);
    } catch (error) {
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      if ((error as { status?: number }).status === 404) await this.reload();
      this.note(typeof detail === 'string' ? `Could not move it: ${detail}` : 'Could not move it');
    }
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
    this.selection.update(s => new Set([...s].map(map)));
    if (this.anchor) this.anchor = map(this.anchor);
    // listings of folders at or below the old name are of folders that do not exist any more
    this.cache.update(m => new Map([...m].filter(([path]) => !underOld(path))));
    for (const path of [...this.requested]) if (underOld(path)) this.requested.delete(path);
    // the folders that are open now (under their new names) are listed again
    for (const path of [...this.flippedBrowse(), ...this.flippedFilter()]) if (!this.requested.has(path)) this.load(path);
  }

  protected parts(text: string) {
    return highlightParts(text, this.filter());
  }
}
