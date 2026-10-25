import { Component, inject, signal, viewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { LibraryEntry, LibraryService, SortKey } from './library.service';
import { DocumentPanel } from './document-panel';
import { ObjectMenu } from './object-menu';
import { DocumentStore } from './document.store';
import { StlViewer, ViewMode } from './stl-viewer';
import { TreePanel } from './tree-panel';

const lastStlStorageKey = 'rasterfaster.lastStl';
const filterStorageKey = 'rasterfaster.filter';
const viewModeStorageKey = 'rasterfaster.viewMode';
const documentModeStorageKey = 'rasterfaster.documentMode';
const viewModes: ViewMode[] = ['solid', 'wireframe', 'hidden-removed', 'hidden-shown'];

@Component({
  selector: 'app-root',
  imports: [TreePanel, StlViewer, DocumentPanel, ObjectMenu],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly lib = inject(LibraryService);
  protected readonly store = inject(DocumentStore);

  protected readonly selected = signal<string | null>(null);
  protected readonly data = signal<ArrayBuffer | null>(null);
  protected readonly mode = signal<ViewMode>(this.readViewMode());
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly filterText = signal('');
  protected readonly filtered = signal<LibraryEntry[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly sortKey = this.lib.sortKey;
  protected readonly sortAscending = this.lib.sortAscending;
  /** Set once on startup so the tree expands to the restored file; later selections don't re-trigger it. */
  protected readonly revealPath = signal<string | null>(null);
  protected readonly documentMode = signal(this.readDocumentMode());
  private readonly viewer = viewChild.required(StlViewer);
  private readonly treePanel = viewChild(TreePanel);
  protected readonly reloading = signal(false);
  private loadedPath: string | null = null;
  private loadSub?: Subscription;
  private filterTimer?: ReturnType<typeof setTimeout>;

  protected readonly modes: { id: ViewMode; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'wireframe', label: 'Wireframe' },
    { id: 'hidden-removed', label: 'Hidden lines removed' },
    { id: 'hidden-shown', label: 'Hidden lines dashed' },
  ];

  constructor() {
    void this.store.init();
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

  private readDocumentMode() {
    try { return localStorage.getItem(documentModeStorageKey) === 'true'; } catch { return false; }
  }

  protected setDocumentMode(on: boolean) {
    this.documentMode.set(on);
    try { localStorage.setItem(documentModeStorageKey, String(on)); } catch { /* storage unavailable */ }
    const path = this.selected();
    if (!on && path && path !== this.loadedPath) this.loadPreview(path);
  }

  /** Puts a library file into the document (defaults to the selected one) and switches to the document. */
  protected addToDocument(path: string | null = this.selected()) {
    if (!path) return;
    this.selected.set(path);
    this.writeLastStl(path);
    this.setDocumentMode(true);
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
    this.writeLastStl(path);
    if (!this.documentMode()) this.loadPreview(path); // in the document the tree just chooses what to add
  }

  private loadPreview(path: string) {
    this.loading.set(true);
    this.error.set('');
    this.loadSub?.unsubscribe(); // drop a still-running download when the selection moves on
    this.loadSub = this.lib.loadStl(path).subscribe({
      next: buf => { this.data.set(buf); this.loadedPath = path; this.loading.set(false); },
      error: e => {
        this.loading.set(false);
        if (e.status === 404) { // remembered file was moved/deleted: forget it quietly
          this.writeLastStl(null);
          this.selected.set(null);
          return;
        }
        this.error.set(`Could not load: ${e.message}`);
      },
    });
  }
}
