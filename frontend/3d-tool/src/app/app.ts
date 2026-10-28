import { Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter, firstValueFrom } from 'rxjs';
import { LibraryEntry, LibraryService, MoveBatchResult, RenameResult, SortKey, TrashBatchResult } from './library.service';
import { DocumentPanel } from './document-panel';
import { ObjectMenu } from './object-menu';
import { ReleaseFocus } from './release-focus';
import { DocItem, DocumentStore } from './document.store';
import { StlViewer, ViewMode } from './stl-viewer';
import { TreePanel } from './tree-panel';
import { TrashDialog } from './trash-dialog';
import { ApiStatus } from './api-status';
import { APP_VERSION } from './build-info';

const lastStlStorageKey = 'rasterfaster.lastStl';
const filterStorageKey = 'rasterfaster.filter';
const filterModeStorageKey = 'rasterfaster.filterMode';
/** Width of the file panel on the left, remembered per browser. */
const panelWidthStorageKey = 'rasterfaster.panelWidth';
const defaultPanelWidthPx = 360;
/** Whether the file panel is hidden (⌘B or the icon button), remembered per browser. */
const panelHiddenStorageKey = 'rasterfaster.panelHidden';
/** How long the slide in / out takes (ms); the CSS transition uses the same value. */
const panelSlideMs = 160;
const minPanelWidthPx = 240;
/** The panel never takes more than this share of the window (also enforced live in CSS, so a smaller window can't hide the view). */
const maxPanelShare = 0.7;

function readPanelHidden(): boolean {
  try { return localStorage.getItem(panelHiddenStorageKey) === 'true'; } catch { return false; }
}

function loadPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(panelWidthStorageKey));
    if (Number.isFinite(n) && n >= minPanelWidthPx) return Math.round(n);
  } catch { /* storage unavailable: use the default */ }
  return defaultPanelWidthPx;
}
const viewModeStorageKey = 'rasterfaster.viewMode';
const viewModes: ViewMode[] = ['solid', 'wireframe', 'hidden-removed', 'hidden-shown'];

function readFilterMode(): 'any' | 'all' {
  try { return localStorage.getItem(filterModeStorageKey) === 'all' ? 'all' : 'any'; } catch { return 'any'; }
}

@Component({
  selector: 'app-root',
  imports: [TreePanel, TrashDialog, StlViewer, DocumentPanel, ObjectMenu, ReleaseFocus],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '[style.grid-template-columns]': 'columnsCss()', '[style.--panel-w]': 'panelWidthCss()', '[class.sliding]': 'sliding()' },
})
export class App {
  protected readonly lib = inject(LibraryService);
  protected readonly store = inject(DocumentStore);

  protected readonly selected = signal<string | null>(null);
  protected readonly mode = signal<ViewMode>(this.readViewMode());
  protected readonly error = signal('');
  protected readonly filterText = signal('');
  /** Several terms in the filter: a name matches when it has any of them ('any') or all of them ('all'). */
  protected readonly matchMode = signal<'any' | 'all'>(readFilterMode());
  protected readonly filtered = signal<LibraryEntry[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly sortKey = this.lib.sortKey;
  protected readonly sortAscending = this.lib.sortAscending;
  /** Set once on startup so the tree expands to the restored file; later selections don't re-trigger it. */
  protected readonly revealPath = signal<string | null>(null);
  /** "Find in browser" (part menu) on its way to the file list; a filter is cleared first, the file may not match it. */
  protected readonly findRequest = signal<{ paths: string[]; seq: number; ids?: string[] } | null>(null);
  /** The distinct library paths the document's parts use (a string, so that moving a part does not count as a change). */
  private readonly partPathsKey = computed(() => [...new Set(this.store.doc().items.map(item => item.path))].join('\n'));
  /** Bumped whenever the library changes under the document (rename, move, trash, put back): the missing files are looked up again. */
  private readonly libraryTick = signal(0);
  private missingTimer?: ReturnType<typeof setTimeout>;
  private readonly viewer = viewChild.required(StlViewer);
  protected readonly treePanel = viewChild(TreePanel);
  protected readonly reloading = signal(false);
  /** Null when there is no service worker (dev server, tests). */
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  /** True once the service worker has downloaded a newer build in the background; an installed PWA otherwise keeps the old one. */
  protected readonly updateAvailable = signal(false);
  /** Version of the downloaded build (from ngsw-config.json appData), null when unknown. */
  protected readonly updateVersion = signal<string | null>(null);
  protected readonly appVersion = APP_VERSION;
  protected readonly api = inject(ApiStatus);
  protected readonly panelWidthPx = signal(loadPanelWidth());
  /** The panel's width, as a CSS length that never exceeds its share of the window. */
  protected readonly panelWidthCss = computed(() => `min(${this.panelWidthPx()}px, ${maxPanelShare * 100}vw)`);
  protected readonly panelHidden = signal(readPanelHidden());
  /** True only while the panel slides, so the width animates for ⌘B / the button but follows the pointer instantly when dragging. */
  protected readonly sliding = signal(false);
  private slidingTimer?: ReturnType<typeof setTimeout>;
  protected readonly columnsCss = computed(() => `${this.panelHidden() ? '0px' : this.panelWidthCss()} 1fr`);
  protected readonly resizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private filterTimer?: ReturnType<typeof setTimeout>;

  protected readonly modes: { id: ViewMode; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'wireframe', label: 'Wireframe' },
    { id: 'hidden-removed', label: 'Hidden lines removed' },
    { id: 'hidden-shown', label: 'Hidden lines dashed' },
  ];

  constructor() {
    void this.store.init();
    effect(() => { if (this.store.relinkRequest()) untracked(() => this.startRelinkMode()); });
    effect(() => { this.store.docId(); untracked(() => this.store.relinkRequest.set(null)); }); // another document: no relink mode
    this.watchForUpdates();
    this.api.start();
    void this.lib.refreshTrash();
    let wasOffline = false;
    effect(() => {
      const offline = this.api.offline();
      if (wasOffline && !offline) void this.reloadFiles(); // the API is back: refresh what was loaded from it
      wasOffline = offline;
    });
    let lastStamp: number | null = null;
    effect(() => {
      // Another window saved a document: check whether it is the open one (and reload it, or ask when this window has unsaved edits).
      const stamp = this.api.documentsStamp();
      if (lastStamp !== null && stamp !== lastStamp) void this.store.checkRemote();
      lastStamp = stamp;
    });
    effect(() => {
      // Every time the API answers: if the document never loaded (the API started after the app) or a save failed, recover now.
      if (this.api.checks() > 0 && (!this.store.docId() || this.store.saveState() === 'error')) void this.store.recover();
    });
    effect(() => { // which parts use a file that is not in the library (the parts list marks them)
      const key = this.partPathsKey();
      this.lib.trashCount(); this.libraryTick();
      untracked(() => this.scheduleMissingCheck(key ? key.split('\n') : []));
    });
    effect(() => {
      const request = this.store.browserRequest();
      if (!request) return;
      untracked(() => {
        const show = () => {
          this.findRequest.set(request);
          if (request.paths.length === 1) this.open(request.paths[0]); // the file is the selected one of the browser, like after a click
        };
        if (this.filterText().trim()) { this.onFilter(''); setTimeout(show, 200); } else show(); // the list resets with the filter: ask after that
      });
    });
    try {
      const storedFilter = localStorage.getItem(filterStorageKey);
      if (storedFilter) this.onFilter(storedFilter); // restore the filter and its results
    } catch { /* storage unavailable */ }
    const last = this.readLastStl();
    if (last) {
      this.revealPath.set(last);
      this.open(last);
    }
  }

  private readViewMode(): ViewMode {
    try {
      const stored = localStorage.getItem(viewModeStorageKey) as ViewMode | null;
      if (stored && viewModes.includes(stored)) return stored;
    } catch { /* storage unavailable */ }
    return 'solid';
  }

  /** The file list's notice "Relink…": the parts that were looked up and whose file is missing get a new file. */
  protected onRelink(ids: string[]) {
    const missing = this.store.missingPaths();
    const lost = this.store.doc().items.filter(i => ids.includes(i.id) && missing.has(i.path)).map(i => i.id);
    this.store.relinkRequest.set(lost.length ? lost : ids);
  }

  // --- relink mode: the file browser (filter, sort, preview ...) picks another file for some parts -----------------------------

  protected readonly relinkParts = computed(() => {
    const ids = this.store.relinkRequest();
    return ids ? this.store.doc().items.filter(i => ids.includes(i.id)) : [];
  });
  /** How many parts of the document use the file(s) of the parts being relinked. */
  protected readonly relinkSharing = computed(() => {
    const paths = new Set(this.relinkParts().map(i => i.path));
    return this.store.doc().items.filter(i => paths.has(i.path)).length;
  });
  protected readonly relinkFile = computed(() => this.treePanel()?.focusedFile() ?? null);

  /** Library files whose names resemble the old file's name, best first (click one to relink at once). */
  protected readonly relinkSuggestions = signal<{ path: string; name: string; folder: string }[]>([]);
  private suggestionSeq = 0;

  private async suggestFiles(part: DocItem) {
    const mine = ++this.suggestionSeq;
    this.relinkSuggestions.set([]);
    const stem = part.path.startsWith('embedded:') ? part.name : part.path.split('/').pop()!.replace(/\.stl$/i, '');
    const words = [...new Set(stem.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2))];
    if (!words.length) return;
    try {
      const found = (await firstValueFrom(this.lib.search(words.join(' '), 'any'))).filter(e => e.type === 'file' && e.path !== part.path);
      const score = (name: string) => {
        const have = new Set(name.toLowerCase().replace(/\.stl$/i, '').split(/[^a-z0-9]+/));
        const shared = words.filter(w => have.has(w) || [...have].some(h => h.length >= 3 && (h.startsWith(w) || w.startsWith(h)))).length;
        return shared / words.length + shared / (have.size || 1) * 0.5 + (name.toLowerCase().startsWith(stem.toLowerCase()) ? 1 : 0);
      };
      const ranked = found.map(e => ({ e, score: score(e.name) })).sort((a, b) => b.score - a.score).slice(0, 8);
      if (mine === this.suggestionSeq) this.relinkSuggestions.set(ranked.map(({ e }) => ({ path: e.path, name: e.name, folder: e.path.split('/').slice(0, -1).join(' / ') })));
    } catch { /* offline: no suggestions */ }
  }

  private startRelinkMode() {
    const part = this.relinkParts()[0];
    if (!part) return;
    void this.suggestFiles(part);
    this.store.relinkAll.set(true);
    if (this.panelHidden()) this.togglePanel();
    const stem = part.path.startsWith('embedded:') ? part.name : part.path.split('/').pop()!.replace(/\.stl$/i, '');
    this.onFilter(stem.replace(/[_.-]+/g, ' ').trim()); // the renamed file usually still looks like the old one: start with it (the filter can be changed or cleared)
    setTimeout(() => this.treePanel()?.focusTree(), 100);
  }

  /** Points the parts at the chosen file and leaves relink mode. */
  protected doRelink(path: string | null = this.relinkFile()) {
    const ids = this.store.relinkRequest();
    if (!ids || !path) return;
    const changed = this.store.relink(ids, path, this.store.relinkAll() && this.relinkSharing() > this.relinkParts().length);
    this.store.announce(changed ? `Relinked ${changed} part${changed === 1 ? '' : 's'} to ${path.split('/').pop()}` : 'Those parts already use that file');
    this.store.relinkRequest.set(null);
  }

  protected cancelRelink() {
    this.store.relinkRequest.set(null);
  }

  @HostListener('document:keydown', ['$event'])
  protected onRelinkKey(event: KeyboardEvent) {
    if (!this.store.relinkRequest()) return;
    const typing = (event.target as HTMLElement | null)?.closest('input, textarea, select');
    if (event.key === 'Escape' && !typing) { event.preventDefault(); this.cancelRelink(); }
    else if (event.key === 'Enter' && !typing && this.relinkFile() && (event.target as HTMLElement | null)?.closest('.tree')) { event.preventDefault(); this.doRelink(); }
  }

  protected setMode(mode: ViewMode) {
    this.mode.set(mode);
    try { localStorage.setItem(viewModeStorageKey, mode); } catch { /* storage unavailable */ }
  }

  /** A file or directory was renamed: follow it with the selection, refresh the search and let open documents pick up their new paths. */
  protected async onRenamed(result: RenameResult) {
    this.libraryTick.update(n => n + 1);
    const selected = this.selected();
    if (selected === result.from) this.selected.set(result.to);
    else if (selected?.startsWith(result.from + '/')) this.selected.set(result.to + selected.slice(result.from.length));
    const now = this.selected();
    if (now !== selected) this.writeLastStl(now);
    if (this.filterText().trim()) this.onFilter(this.filterText()); // the search results hold the old name
    await this.store.checkRemote(); // the documents that use it were rewritten on the server (its own message comes first, ours replaces it)
    const changed = Object.values(result.documents).reduce((sum, n) => sum + n, 0);
    this.store.announce(result.backedUp ? `Renamed. The original is kept in ${result.backup}` : `Renamed${changed ? ` (${changed} part${changed === 1 ? '' : 's'} in documents updated)` : ''}`, 7000);
  }

  /** Files or directories were moved into another folder: follow them with the selection and let open documents pick up the new paths. */
  protected async onMoved(result: MoveBatchResult) {
    this.libraryTick.update(n => n + 1);
    const selected = this.selected();
    let now = selected;
    for (const item of result.results) {
      if (now === item.from) now = item.to;
      else if (now?.startsWith(item.from + '/')) now = item.to + now.slice(item.from.length);
    }
    if (now !== selected) { this.selected.set(now); this.writeLastStl(now); }
    if (this.filterText().trim()) this.onFilter(this.filterText());
    await this.store.checkRemote();
    const changed = result.results.reduce((sum, r) => sum + Object.values(r.documents).reduce((a, n) => a + n, 0), 0);
    const backups = result.results.filter(r => r.backedUp).length;
    this.store.announce(`Moved ${result.results.length} item${result.results.length === 1 ? '' : 's'}${changed ? ` (${changed} part${changed === 1 ? '' : 's'} in documents updated)` : ''}${backups ? `; ${backups} original${backups === 1 ? '' : 's'} kept in the backup folder` : ''}`, 7000);
  }

  protected readonly trashOpen = signal(false);
  /** The last Move to Trash, offered for undo for a few seconds (the Finder's "Undo Move to Trash"). */
  protected readonly undoTrash = signal<{ ids: string[]; label: string } | null>(null);
  private undoTimer?: ReturnType<typeof setTimeout>;

  /** Items were moved to the Trash: forget them as the selection, refresh the search and offer Undo for the whole batch. */
  protected onTrashed(result: TrashBatchResult) {
    this.libraryTick.update(n => n + 1);
    const selected = this.selected();
    if (selected && result.results.some(r => selected === r.path || selected.startsWith(r.path + '/'))) { this.selected.set(null); this.writeLastStl(null); }
    if (this.filterText().trim()) this.onFilter(this.filterText());
    void this.lib.refreshTrash();
    if (result.results.length) {
      const label = result.results.length === 1 ? `“${result.results[0].name}”` : `${result.results.length} items`;
      this.undoTrash.set({ ids: result.results.map(r => r.id).filter((id): id is string => !!id), label });
      clearTimeout(this.undoTimer);
      this.undoTimer = setTimeout(() => this.undoTrash.set(null), 10000);
    }
  }

  protected async undoMoveToTrash() {
    const undo = this.undoTrash();
    if (!undo) return;
    this.undoTrash.set(null);
    let back = 0;
    let taken = 0;
    for (const id of [...undo.ids].reverse()) {
      try { await firstValueFrom(this.lib.putBack(id)); back++; } catch (error) { if ((error as { status?: number }).status === 409) taken++; }
    }
    const missed = undo.ids.length - back;
    this.store.announce(missed === 0 ? `Put back ${undo.label}` : `Put back ${back} of ${undo.ids.length}: ${taken ? 'a place is taken' : 'some could not be put back'} (see the Trash)`, missed ? 7000 : 4000);
    await this.treePanel()?.reload();
    if (this.filterText().trim()) this.onFilter(this.filterText());
    void this.lib.refreshTrash();
  }

  /** Something was put back from the Trash dialog: the list has to look again. */
  protected async onTrashChanged() {
    this.libraryTick.update(n => n + 1); // Put Back, Delete Immediately, Empty Trash: the missing files change
    await this.treePanel()?.reload();
    if (this.filterText().trim()) this.onFilter(this.filterText());
  }

  /** The selected files of a multi-selection (what ⌘↓ and the Add button put into the document). */
  /** An .stl file is selected in the file browser (the cursor is on a file, not a folder), so it can be added. */
  protected readonly canAdd = computed(() => !!this.treePanel()?.focusedFile() || this.pickedFiles().length > 0);
  protected readonly pickedFiles = computed(() => this.treePanel()?.pickedFiles() ?? []);

  /** Puts several library files next to each other into the document as one undo step. */
  protected addFilesToDocument(paths: string[]) {
    if (!paths.length || this.store.relinkRequest()) return;
    this.selected.set(paths[paths.length - 1]);
    this.writeLastStl(paths[paths.length - 1]);
    this.treePanel()?.closeQuickLook();
    this.viewer().addObjects(paths).catch(e => this.error.set(`Could not add: ${e.message ?? e}`));
  }

  /** Puts a library file into the document (defaults to the selected one). */
  protected addToDocument(path: string | null = this.selected()) {
    if (!path) return;
    if (this.store.relinkRequest()) { this.doRelink(path); return; } // relink mode: double-click / ⌘↓ / the Add button choose the file for the parts instead
    this.selected.set(path);
    this.writeLastStl(path);
    this.treePanel()?.closeQuickLook(); // adding a part (any way) closes the quick look
    this.viewer().addObject(path).catch(e => this.error.set(`Could not add: ${e.message ?? e}`));
  }

  private readLastStl() {
    try { return localStorage.getItem(lastStlStorageKey); } catch { return null; }
  }

  private writeLastStl(path: string | null) {
    try { path ? localStorage.setItem(lastStlStorageKey, path) : localStorage.removeItem(lastStlStorageKey); } catch { /* storage unavailable */ }
  }

  /** The header button: a new folder at the top level of the library (the filter is cleared first when one is active: the new folder would not match it). */
  protected newTopLevelFolder() {
    void this.treePanel()?.newFolderAtRoot();
  }

  protected setSort(key: SortKey) {
    this.lib.setSort(key);
  }

  protected onFilter(text: string) {
    this.filterText.set(text);
    try { text ? localStorage.setItem(filterStorageKey, text) : localStorage.removeItem(filterStorageKey); } catch { /* storage unavailable */ }
    clearTimeout(this.filterTimer);
    if (!text.trim()) { this.filtered.set(null); this.searching.set(false); return; }
    this.searching.set(true);
    this.filterTimer = setTimeout(() => this.runSearch(text), 200);
  }

  protected toggleMatchMode() {
    const next = this.matchMode() === 'any' ? 'all' : 'any';
    this.matchMode.set(next);
    try { localStorage.setItem(filterModeStorageKey, next); } catch { /* the choice just is not remembered */ }
    const text = this.filterText();
    if (text.trim()) { this.searching.set(true); this.runSearch(text); }
  }

  private runSearch(text: string) {
    this.lib.search(text.trim(), this.matchMode()).subscribe({
      next: flat => {
        if (this.filterText() !== text) return; // stale response
        this.filtered.set(this.lib.nest(flat));
        this.searching.set(false);
      },
      error: () => this.searching.set(false),
    });
  }

  // --- updates (PWA) ------------------------------------------------------------------------------------------------------------

  private watchForUpdates() {
    const sw = this.swUpdate;
    if (!sw?.isEnabled) return;
    sw.versionUpdates.pipe(filter((event): event is VersionReadyEvent => event.type === 'VERSION_READY'), takeUntilDestroyed()).subscribe(event => {
      const appData = event.latestVersion.appData as { version?: unknown } | undefined;
      this.updateVersion.set(typeof appData?.version === 'string' ? appData.version : null);
      this.updateAvailable.set(true);
    });
    void sw.checkForUpdate();
    const timer = window.setInterval(() => void sw.checkForUpdate(), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected reloadPage() {
    location.reload();
  }

  /** Switch to the downloaded build: activate it and reload. */
  protected async applyUpdate() {
    try { await this.swUpdate?.activateUpdate(); } catch { /* reload anyway */ }
    location.reload();
  }

  // --- hiding / showing the file panel ---------------------------------------------------------------------------------------

  /** Slides the file panel out or in (icon button or ⌘B) and remembers the choice. */
  protected togglePanel() {
    const hidden = !this.panelHidden();
    this.sliding.set(true);
    clearTimeout(this.slidingTimer);
    this.slidingTimer = setTimeout(() => this.sliding.set(false), panelSlideMs + 40);
    this.panelHidden.set(hidden);
    try { localStorage.setItem(panelHiddenStorageKey, String(hidden)); } catch { /* the choice just is not remembered */ }
    if (hidden) (document.activeElement as HTMLElement | null)?.blur(); // focus must not stay inside the hidden panel
  }

  @HostListener('document:keydown', ['$event'])
  protected onGlobalKey(event: KeyboardEvent) {
    if (event.code === 'KeyB' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      this.togglePanel();
    }
    const digit = /^Digit([1-9])$/.exec(event.code); // ⌥1 … ⌥4: the view modes in the order of the buttons (event.code: ⌥ changes the typed character)
    if (digit && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && this.modes[+digit[1] - 1]) {
      event.preventDefault();
      this.setMode(this.modes[+digit[1] - 1].id);
    }
    if (event.code === 'KeyS' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault(); // not the browser's "save page": ⌘S saves a new version of the document
      void this.store.saveVersion();
    }
  }

  // --- resizing the file panel (drag its right edge) ---------------------------------------------------------------------------

  protected onResizeDown(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = Math.min(this.panelWidthPx(), window.innerWidth * maxPanelShare);
    this.resizing.set(true);
  }

  protected onResizeMove(event: PointerEvent) {
    if (!this.resizing()) return;
    this.setPanelWidth(this.resizeStartWidth + (event.clientX - this.resizeStartX));
  }

  /** Also used for pointercancel: whatever width the drag reached is kept and remembered. */
  protected onResizeUp(event: PointerEvent) {
    if (!this.resizing()) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.resizing.set(false);
    this.storePanelWidth();
  }

  /** Keyboard: ← → move the edge by 20 px (Shift: 100 px), Home resets. */
  protected onResizeKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 100 : 20;
    if (event.key === 'ArrowLeft') this.setPanelWidth(this.panelWidthPx() - step);
    else if (event.key === 'ArrowRight') this.setPanelWidth(this.panelWidthPx() + step);
    else if (event.key === 'Home') this.setPanelWidth(defaultPanelWidthPx);
    else return;
    event.preventDefault();
    this.storePanelWidth();
  }

  protected resetPanelWidth() {
    this.setPanelWidth(defaultPanelWidthPx);
    this.storePanelWidth();
  }

  private setPanelWidth(px: number) {
    const max = Math.max(minPanelWidthPx, window.innerWidth * maxPanelShare);
    this.panelWidthPx.set(Math.round(Math.max(minPanelWidthPx, Math.min(px, max))));
  }

  private storePanelWidth() {
    try { localStorage.setItem(panelWidthStorageKey, String(this.panelWidthPx())); } catch { /* the width just is not remembered */ }
  }

  /** Reload button: re-read the file list from disk (and redo the search when a filter is active). */
  protected async reloadFiles() {
    this.reloading.set(true);
    try {
      const text = this.filterText();
      if (text.trim()) this.runSearch(text);
      await this.treePanel()?.reload();
    } finally {
      this.reloading.set(false);
    }
  }

  /** The ✕ button and Esc: clears the filter and gives the keyboard focus to the list, so the selected row is blue (active), not grey. */
  protected clearFilter() {
    const had = this.filterText().trim() !== '';
    this.onFilter('');
    if (had) setTimeout(() => this.treePanel()?.focusTree(), 50);
  }

  private scheduleMissingCheck(paths: string[]) {
    clearTimeout(this.missingTimer);
    if (!paths.length) { this.store.missingPaths.set(new Set()); return; }
    this.missingTimer = setTimeout(async () => {
      try {
        this.store.missingPaths.set(new Set(await this.lib.missing(paths)));
        if (this.store.missingPaths().size) void this.lib.refreshTrash(); // so that the marker can say that a file is in the Trash
      } catch {
        try { // no such endpoint (an API older than this front end): the files that are in the Trash are still known
          await this.lib.refreshTrash();
          this.store.missingPaths.set(new Set(paths.filter(path => this.lib.trashedFrom(path))));
        } catch { /* offline: keep what is shown */ }
      }
    }, 300);
  }

  protected open(path: string) {
    this.selected.set(path);
    this.writeLastStl(path); // the tree just chooses what to add; Space opens a quick look
  }
}
