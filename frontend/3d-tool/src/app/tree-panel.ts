import { DatePipe } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryEntry, LibraryService } from './library.service';
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
  imports: [DatePipe, QuickLook],
  template: `
    <div class="tree" tabindex="0" (keydown)="onKey($event)">
      @for (r of rows(); track r.entry.path) {
        <div class="row" [class.dir]="r.entry.type === 'dir'" [class.focus]="r.entry.path === focused()"
             [class.sel]="r.entry.type === 'file' && r.entry.path === selected()"
             [style.padding-left.px]="6 + r.depth * 14" (click)="onClick(r)" (dblclick)="onDoubleClick(r)">
          <span class="caret">{{ r.entry.type === 'dir' ? (r.open ? '▾' : '▸') : '' }}</span>
          <span class="label">
            @for (part of parts(r.entry.name); track $index) {
              @if (part.hit) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} }
            }
          </span>
          <span class="date">{{ r.entry.modified * 1000 | date: 'yyyy-MM-dd' }}</span>
        </div>
      } @empty {
        <div class="row muted">{{ results() ? '(no matches)' : 'loading…' }}</div>
      }
    </div>
    @if (quickLook() && focusedFile(); as file) {
      <app-quick-look [path]="file" [left]="popoverLeft()" [added]="addedFlash()" (closed)="quickLook.set(false)" (interacted)="focusTree()" />
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
  readonly select = output<string>();
  /** Double-click or Enter on a file: put it into the document. */
  readonly add = output<string>();

  protected readonly focused = signal<string | null>(null);
  /** Space toggles a Finder-style preview of the focused file; it then follows the focus. */
  protected readonly quickLook = signal(false);
  protected readonly popoverLeft = signal(392);
  protected readonly focusedFile = computed(() => this.rows().find(r => r.entry.path === this.focused() && r.entry.type === 'file')?.entry.path ?? null);
  private readonly cache = signal(new Map<string, LibraryEntry[]>());
  private readonly requested = new Set<string>();
  /** Dirs flipped away from their default state (default: open only in filter mode when they hold matches). */
  private readonly flippedBrowse = signal(new Set<string>());
  private readonly flippedFilter = signal(new Set<string>());
  private openTimer?: ReturnType<typeof setTimeout>;
  private flashTimer?: ReturnType<typeof setTimeout>;
  protected readonly addedFlash = signal(false);

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
    effect(() => { this.results(); this.flippedFilter.set(new Set()); this.focused.set(null); });
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
    const paths = ['', ...this.flippedBrowse()];
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

  protected onClick(r: Row) {
    this.focused.set(r.entry.path);
    if (r.entry.type === 'dir') this.setOpen(r.entry, !r.open);
    else this.select.emit(r.entry.path);
  }

  /** Gives the list keyboard focus (without scrolling), e.g. after the preview was clicked. */
  protected focusTree() {
    this.host.nativeElement.querySelector<HTMLElement>('.tree')?.focus({ preventScroll: true });
  }

  protected onDoubleClick(r: Row) {
    if (r.entry.type === 'file') this.add.emit(r.entry.path);
  }

  private focusRow(row: Row) {
    this.focused.set(row.entry.path);
    clearTimeout(this.openTimer);
    // Finder previews as you arrow through; debounce so holding ↓ doesn't fetch every file.
    if (row.entry.type === 'file') this.openTimer = setTimeout(() => this.select.emit(row.entry.path), 120);
  }

  protected onKey(ev: KeyboardEvent) {
    // ⌘↓ = "open" like Finder: put the focused file into the document (the preview stays so you can keep adding).
    if (ev.metaKey && ev.key === 'ArrowDown' && !ev.ctrlKey && !ev.altKey) {
      const file = this.focusedFile();
      if (file) {
        this.add.emit(file);
        this.addedFlash.set(true);
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => this.addedFlash.set(false), 1600);
        ev.preventDefault();
      }
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
      case 'Enter':
        if (row?.entry.type === 'file') this.add.emit(row.entry.path);
        break;
      case 'Home': this.focusRow(rows[0]); break;
      case 'End': this.focusRow(rows[rows.length - 1]); break;
      default: return;
    }
    ev.preventDefault();
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
