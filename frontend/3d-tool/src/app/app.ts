import { Component, DestroyRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { LibraryEntry, LibraryService, SortKey } from './library.service';
import { DocumentPanel } from './document-panel';
import { ObjectMenu } from './object-menu';
import { DocumentStore } from './document.store';
import { StlViewer, ViewMode } from './stl-viewer';
import { TreePanel } from './tree-panel';
import { ApiStatus } from './api-status';
import { APP_VERSION } from './build-info';

const lastStlStorageKey = 'rasterfaster.lastStl';
const filterStorageKey = 'rasterfaster.filter';
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

@Component({
  selector: 'app-root',
  imports: [TreePanel, StlViewer, DocumentPanel, ObjectMenu],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '[style.grid-template-columns]': 'columnsCss()', '[style.--panel-w]': 'panelWidthCss()', '[class.sliding]': 'sliding()' },
})
export class App {
  private readonly lib = inject(LibraryService);
  protected readonly store = inject(DocumentStore);

  protected readonly selected = signal<string | null>(null);
  protected readonly mode = signal<ViewMode>(this.readViewMode());
  protected readonly error = signal('');
  protected readonly filterText = signal('');
  protected readonly filtered = signal<LibraryEntry[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly sortKey = this.lib.sortKey;
  protected readonly sortAscending = this.lib.sortAscending;
  /** Set once on startup so the tree expands to the restored file; later selections don't re-trigger it. */
  protected readonly revealPath = signal<string | null>(null);
  private readonly viewer = viewChild.required(StlViewer);
  private readonly treePanel = viewChild(TreePanel);
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
    this.watchForUpdates();
    this.api.start();
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

  protected setMode(mode: ViewMode) {
    this.mode.set(mode);
    try { localStorage.setItem(viewModeStorageKey, mode); } catch { /* storage unavailable */ }
  }

  /** Puts a library file into the document (defaults to the selected one). */
  protected addToDocument(path: string | null = this.selected()) {
    if (!path) return;
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

  private runSearch(text: string) {
    this.lib.search(text.trim()).subscribe({
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

  protected clearFilter() {
    this.onFilter('');
  }

  protected open(path: string) {
    this.selected.set(path);
    this.writeLastStl(path); // the tree just chooses what to add; Space opens a quick look
  }
}
