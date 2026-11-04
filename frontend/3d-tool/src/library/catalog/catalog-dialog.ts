import { DatePipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, output, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryService } from '../core/library.service';
import { closeOnEscape } from '../util/escape-close';
import { highlightParts } from '../util/filter-terms';
import { ThumbnailService } from './thumbnail.service';
import { formatDims, isTooLarge } from './thumbnail.logic';
import { CatalogEntry, CatalogSortKey, displayName, filterCatalog, folderCode, folderCounts, sortCatalog, visibleRows } from './catalog.logic';

const sortStorageKey = 'rasterfaster.catalogSort';
const cardWidth = 226; // the narrowest a card gets (px); the columns share the width
const rowHeight = 264; // a card with its gap (px): the grid draws only the rows in view

function readSort(): { key: CatalogSortKey; ascending: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(sortStorageKey) ?? 'null');
    if (['name', 'date', 'size'].includes(stored?.key) && typeof stored.ascending === 'boolean') return stored;
  } catch { /* storage unavailable or damaged: use the default */ }
  return { key: 'name', ascending: true };
}

/**
 * The parts archive: every STL of the library as a numbered card, in a near full-screen dialog. Filter by folder, find by name (the file list's
 * syntax), sort by name, date or size. A click (or Enter) opens the part's page: a large drawing and the facts about the file, with Add to document
 * (`add`), Find in browser (`findInBrowser`) and Reveal in Finder, and ← / → for the previous and next part. Its address is `#part=<path>`.
 * Only the cards in view exist in the page, so a library of thousands of files scrolls smoothly.
 */
@Component({
  selector: 'app-catalog-dialog',
  imports: [DatePipe],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Parts archive">
      <header>
        <h2>PARTS ARCHIVE</h2>
        <span class="stats">{{ entries().length }} parts · {{ folders().length }} folders</span>
        <button type="button" class="close" (click)="close.emit()">CLOSE [ESC]</button>
      </header>

      <div class="list" [hidden]="!!detail()">
      <div class="row"><span class="label">FOLDER</span>
        <div class="chips folders">
          <button type="button" [class.on]="folder() === null" (click)="folder.set(null)">ALL<sup>{{ entries().length }}</sup></button>
          @for (f of folders(); track f.folder) {
            <button type="button" [class.on]="folder() === f.folder" [title]="f.folder || '(library root)'" (click)="folder.set(f.folder)">{{ f.folder ? shortFolder(f.folder) : 'ROOT' }}<sup>{{ f.count }}</sup></button>
          }
        </div>
      </div>
      <div class="row"><span class="label">SORT</span>
        <div class="chips">
          @for (s of sorts; track s.key) {
            <button type="button" [class.on]="sortKey() === s.key" (click)="sortBy(s.key)">{{ s.label }}@if (sortKey() === s.key) { {{ ascending() ? '↑' : '↓' }} }</button>
          }
        </div>
      </div>
      <div class="row"><span class="label">FIND</span>
        <input #find type="text" placeholder="name, folder …  “phrase”  -exclude   [ / ]" spellcheck="false" autocomplete="off" [value]="query()" (input)="query.set(find.value)" />
      </div>
      <div class="status"><span>SHOWING <b>{{ shown().length }}</b> / {{ entries().length }}</span><span>QUERY: {{ query().trim() ? query().trim().toUpperCase() : 'ALL' }}{{ folder() !== null ? ' · ' + (folder() || 'ROOT').toUpperCase() : '' }}</span></div>

      @if (loading()) {
        <p class="empty">Reading the library…</p>
      } @else if (failed()) {
        <p class="empty">Could not read the library. Is the API running?</p>
      } @else if (!shown().length) {
        <p class="empty">No parts match.</p>
      }
      <div #scroller class="scroller" tabindex="0" (scroll)="top.set(scroller.scrollTop)" (keydown)="onKey($event)">
        <div class="space" [style.height.px]="window().rows * rowHeight">
          <div class="grid" [style.transform]="'translateY(' + window().first * rowHeight + 'px)'" [style.grid-template-columns]="'repeat(' + window().columns + ', minmax(0, 1fr))'">
            @for (card of cards(); track card.entry.path) {
              <button type="button" class="card" [class.selected]="card.entry.path === selected()" (click)="openDetail(card.entry.path)" [title]="card.entry.path">
                <span class="top"><span>NO.{{ pad(card.number) }}</span><span>{{ code(card.entry.folder) }}</span></span>
                <span class="art">
                  @switch (thumbs.state(card.entry)) {
                    @case ('drawn') { <img [src]="thumbs.url(card.entry)" alt="" loading="lazy" draggable="false" /> }
                    @case ('large') { <span class="note">LARGE FILE · {{ kb(card.entry.size) }}</span><span class="draw" role="button" tabindex="-1" (click)="draw($event, card.entry)">DRAW ANYWAY</span> }
                    @case ('toolarge') { <span class="note">TOO LARGE · {{ kb(card.entry.size) }}</span> }
                    @case ('failed') { <span class="note">NO DRAWING</span> }
                    @default { <span class="note pending">PENDING</span> }
                  }
                </span>
                <span class="name">
                  @for (part of parts(card.entry.name); track $index) { @if (part.hit) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} } }
                </span>
                <span class="meta">{{ meta(card.entry) }}</span>
                <span class="plus" role="button" tabindex="-1" title="Add to the document" (click)="addCard($event, card.entry)">+ ADD</span>
              </button>
            }
          </div>
        </div>
      </div>
      <footer>
        <span>{{ selectedEntry()?.path ?? 'Click a part to open its page; arrow keys move, Enter opens it.' }}</span>
        @if (selectedEntry()) { <button type="button" class="add" (click)="add.emit(selectedEntry()!.path)">ADD TO DOCUMENT</button> }
      </footer>
      </div>

      @if (detailEntry(); as d) {
        <section class="detail" aria-label="Part">
          <div class="dhead"><span>NO.{{ pad(detailIndex() + 1) }} / {{ shown().length }} · {{ code(d.folder) }}</span><button type="button" class="close" (click)="closeDetail()">BACK [ESC]</button></div>
          <div class="dbody">
            <div class="fig">
              @switch (bigState()) {
                @case ('ready') { <img [src]="bigUrl()!" alt="" draggable="false" /> }
                @case ('loading') { <span class="note">DRAWING…</span> }
                @default { <span class="note">{{ tooLarge(d) ? 'TOO LARGE TO DRAW · ' + kb(d.size) : 'NO DRAWING' }}</span> }
              }
              <span class="cap l">FIG. {{ pad(detailIndex() + 1) }}</span><span class="cap r">LINE DRAWING · HIDDEN LINES REMOVED</span>
            </div>
            <div class="spec">
              <div class="where">{{ d.folder || 'LIBRARY ROOT' }}</div>
              <h3>{{ fileTitle(d) }}</h3>
              <dl>
                <div><dt>FILE</dt><dd>{{ d.name }}</dd></div>
                <div><dt>FOLDER</dt><dd>{{ d.folder || '—' }}</dd></div>
                <div><dt>SIZE</dt><dd>{{ dimsOf(d) || '…' }}</dd></div>
                <div><dt>VOLUME</dt><dd>{{ volumeOf(d) }}</dd></div>
                <div><dt>FILE SIZE</dt><dd>{{ kb(d.size) }}</dd></div>
                <div><dt>MODIFIED</dt><dd>{{ d.modified * 1000 | date: 'yyyy-MM-dd HH:mm' }}</dd></div>
                <div><dt>USED IN</dt><dd>{{ usedIn() === null ? '…' : usedIn() === 0 ? 'no document' : usedIn() + (usedIn() === 1 ? ' document' : ' documents') }}</dd></div>
                <div><dt>PATH</dt><dd class="path">{{ d.path }}</dd></div>
              </dl>
              <div class="actions">
                <button type="button" class="add" (click)="add.emit(d.path)">ADD TO DOCUMENT</button>
                <button type="button" class="ghost" (click)="findInBrowser.emit(d.path)">FIND IN BROWSER</button>
                <button type="button" class="ghost" (click)="finder(d)">REVEAL IN FINDER</button>
              </div>
              @if (actionNote()) { <p class="empty">{{ actionNote() }}</p> }
            </div>
          </div>
          <div class="dnav">
            <button type="button" [disabled]="!previous()" (click)="step(-1)">{{ previous() ? '← ' + pad(detailIndex()) + ' ' + short(previous()!.name) : '' }}</button>
            <button type="button" [disabled]="!following()" (click)="step(1)">{{ following() ? pad(detailIndex() + 2) + ' ' + short(following()!.name) + ' →' : '' }}</button>
          </div>
        </section>
      }
    </section>
  `,
  styles: `
    :host { color: #d8d8d8; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11px; letter-spacing: .02em; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 10; }
    .dialog { position: fixed; z-index: 11; inset: 16px; display: flex; flex-direction: column; padding: 14px 18px; background: #16171a; border: 1px solid #2c2d31; border-radius: 6px; box-shadow: 0 16px 50px rgba(0,0,0,.6); min-height: 0; }
    header { display: flex; align-items: baseline; gap: 16px; padding-bottom: 10px; border-bottom: 1px solid #2c2d31; }
    h2 { margin: 0; font-size: 13px; font-weight: 400; letter-spacing: .12em; } .stats { color: #888; margin-right: auto; }
    button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; padding: 2px 6px; letter-spacing: inherit; }
    .close { color: #888; } .close:hover { color: #fff; }
    .row { display: flex; align-items: baseline; gap: 12px; padding: 6px 0; border-bottom: 1px solid #2c2d31; }
    .label { flex: none; width: 56px; color: #888; }
    .chips { display: flex; flex-wrap: wrap; gap: 2px 6px; min-width: 0; } .folders { max-height: 66px; overflow: auto; }
    .chips button { color: #aaa; } .chips button:hover { color: #fff; } .chips button.on { background: #e6e6e6; color: #111; }
    sup { margin-left: 3px; font-size: 8px; opacity: .6; }
    input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: #e6e6e6; font: inherit; } input::placeholder { color: #666; }
    .status { display: flex; justify-content: space-between; padding: 8px 0; color: #888; } .status b { color: #e6e6e6; font-weight: 400; }
    .empty { color: #777; padding: 8px 0; margin: 0; }
    .list { display: flex; flex-direction: column; flex: 1; min-height: 0; } .list[hidden] { display: none; }
    .detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .dhead { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #2c2d31; color: #888; }
    .dbody { flex: 1; min-height: 0; display: flex; gap: 28px; padding: 16px 0; overflow: auto; }
    .fig { position: relative; flex: 1 1 60%; min-width: 0; min-height: 320px; display: flex; align-items: center; justify-content: center; border: 1px solid #2c2d31; overflow: auto; }
    .fig img { flex: none; } .cap { position: absolute; bottom: 8px; color: #555; font-size: 10px; } .cap.l { left: 10px; } .cap.r { right: 10px; }
    .spec { flex: 0 1 380px; min-width: 260px; } .where { color: #888; } h3 { margin: 4px 0 14px; font-size: 20px; font-weight: 400; color: #e6e6e6; word-break: break-word; }
    dl { margin: 0; } dl > div { display: flex; gap: 16px; padding: 6px 0; border-top: 1px solid #2c2d31; } dl > div:last-child { border-bottom: 1px solid #2c2d31; }
    dt { flex: none; width: 84px; color: #888; } dd { margin: 0; min-width: 0; color: #e6e6e6; word-break: break-word; } .path { font-size: 10px; color: #aaa; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; } .ghost { border: 1px solid #444; padding: 3px 10px; color: #ccc; } .ghost:hover { border-color: #888; color: #fff; }
    .dnav { display: flex; justify-content: space-between; padding-top: 10px; border-top: 1px solid #2c2d31; color: #888; } .dnav button:disabled { visibility: hidden; } .dnav button:hover { color: #fff; }
    .card .plus { position: absolute; right: 8px; bottom: 8px; display: none; padding: 1px 6px; background: #e6e6e6; color: #111; } .card { position: relative; } .card:hover .plus { display: block; } .plus:hover { background: #fff; }
    .scroller { flex: 1; min-height: 0; overflow: auto; border: 1px solid #2c2d31; outline: 0; }
    .space { position: relative; } .grid { position: absolute; left: 0; right: 0; top: 0; display: grid; }
    .card { height: ${rowHeight}px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 8px 10px; border: 0; border-right: 1px solid #2c2d31; border-bottom: 1px solid #2c2d31; background: transparent; overflow: hidden; }
    .card:hover { background: #1e2024; } .card.selected { background: #26324a; outline: 1px solid #2f6fed; outline-offset: -1px; }
    .top { display: flex; justify-content: space-between; color: #777; }
    .art { flex: none; height: 156px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; overflow: hidden; }
    .art img { flex: none; image-rendering: auto; } /* shown as drawn: a fixed size in CSS pixels, not scaled */
    .note { color: #555; font-size: 10px; letter-spacing: .1em; } .note.pending { border: 1px dashed #333; padding: 28px 22px; }
    .draw { color: #aaa; border-bottom: 1px solid #555; cursor: pointer; font-size: 10px; } .draw:hover { color: #fff; }
    .name { flex: 1; min-height: 0; color: #e6e6e6; font-size: 12px; overflow: hidden; word-break: break-word; } .meta { color: #777; }
    mark { background: #5a4a00; color: #ffe27a; }
    footer { display: flex; align-items: center; gap: 12px; padding-top: 10px; color: #888; } footer span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .add { background: #e6e6e6; color: #111; padding: 3px 10px; } .add:hover { background: #fff; }
  `,
})
export class CatalogDialog implements OnInit {
  private readonly lib = inject(LibraryService);
  protected readonly thumbs = inject(ThumbnailService);
  readonly close = output<void>();
  /** The part to add to the document (its library path). */
  readonly add = output<string>();
  /** Show this part in the file list of the app (the dialog closes). */
  readonly findInBrowser = output<string>();

  protected readonly rowHeight = rowHeight;
  protected readonly sorts: { key: CatalogSortKey; label: string }[] = [{ key: 'name', label: 'NAME' }, { key: 'date', label: 'DATE' }, { key: 'size', label: 'SIZE' }];
  private readonly stored = readSort();
  protected readonly entries = signal<CatalogEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly query = signal('');
  protected readonly folder = signal<string | null>(null);
  protected readonly sortKey = signal<CatalogSortKey>(this.stored.key);
  protected readonly ascending = signal(this.stored.ascending);
  protected readonly selected = signal<string | null>(null);
  protected readonly top = signal(0);
  /** The part whose page is open (its library path). */
  protected readonly detail = signal<string | null>(null);
  protected readonly bigUrl = signal<string | null>(null);
  protected readonly bigState = signal<'loading' | 'ready' | 'none'>('loading');
  protected readonly usedIn = signal<number | null>(null);
  protected readonly actionNote = signal('');
  private savedTop = 0;
  /** The part named in the address when the dialog opened (a reload or a link); the address is left alone until the catalog has loaded and it was looked up. */
  private pendingPart: string | null = location.hash.startsWith('#part=') ? decodeURIComponent(location.hash.slice(6)) : null;
  private readonly size = signal({ width: 800, height: 500 });

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly find = viewChild.required<ElementRef<HTMLInputElement>>('find');

  protected readonly folders = computed(() => folderCounts(this.entries()));
  protected readonly shown = computed(() => sortCatalog(filterCatalog(this.entries(), this.query(), this.folder()), this.sortKey(), this.ascending()));
  protected readonly detailEntry = computed(() => this.entries().find(e => e.path === this.detail()) ?? null);
  protected readonly detailIndex = computed(() => this.shown().findIndex(e => e.path === this.detail()));
  protected readonly previous = computed(() => this.shown()[this.detailIndex() - 1] ?? null);
  protected readonly following = computed(() => (this.detailIndex() < 0 ? null : this.shown()[this.detailIndex() + 1] ?? null));
  protected readonly selectedEntry = computed(() => this.shown().find(e => e.path === this.selected()) ?? null);
  protected readonly window = computed(() => visibleRows(this.shown().length, this.size().width, this.top(), this.size().height, cardWidth, rowHeight));
  protected readonly cards = computed(() => {
    const { columns, first, last } = this.window();
    return this.shown().slice(first * columns, last * columns).map((entry, i) => ({ entry, number: first * columns + i + 1 }));
  });

  constructor() {
    closeOnEscape(() => (this.detail() ? this.closeDetail() : this.close.emit()));
    effect(() => this.thumbs.want(this.cards().map(card => card.entry))); // draw what is in view
    effect(() => { // a new result list starts at the top
      this.shown();
      this.scroller().nativeElement.scrollTop = 0;
      this.top.set(0);
    });
    effect(() => {
      const value = JSON.stringify({ key: this.sortKey(), ascending: this.ascending() });
      try { localStorage.setItem(sortStorageKey, value); } catch { /* storage unavailable */ }
    });
    effect(onCleanup => {
      const element = this.scroller().nativeElement;
      const observer = new ResizeObserver(() => this.size.set({ width: element.clientWidth, height: element.clientHeight }));
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
    effect(onCleanup => { // the page of a part: its big drawing and where it is used
      const entry = this.detailEntry();
      this.actionNote.set('');
      this.usedIn.set(null);
      if (!entry) { this.setBig(null); return; }
      let current = true;
      onCleanup(() => { current = false; });
      this.bigState.set('loading');
      void this.thumbs.drawLarge(entry).then(svg => {
        if (!current) return;
        this.setBig(svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : null);
        this.bigState.set(svg ? 'ready' : 'none');
      });
      void firstValueFrom(this.lib.trashBatch([entry.path], true)).then( // a dry run only reports which documents use the file
        result => { if (current) this.usedIn.set(Object.keys(result.documents ?? {}).length); },
        () => { /* unknown: stays … */ });
    });
    effect(() => { // the address of the open part, so a reload (or a copied link) comes back to it
      const path = this.detail();
      if (!path && this.pendingPart) return;
      try { history.replaceState(null, '', path ? `#part=${encodeURIComponent(path)}` : location.pathname + location.search); } catch { /* not allowed here */ }
    });
    inject(DestroyRef).onDestroy(() => {
      this.setBig(null);
      try { if (location.hash.startsWith('#part=')) history.replaceState(null, '', location.pathname + location.search); } catch { /* not allowed here */ }
    });
    const slash = (event: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (event.key === '/' && !typing && !this.detail()) { event.preventDefault(); this.find().nativeElement.focus(); }
      else if (this.detail() && !typing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); this.step(event.key === 'ArrowLeft' ? -1 : 1); }
    };
    document.addEventListener('keydown', slash);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', slash));
  }

  async ngOnInit() {
    this.find().nativeElement.focus();
    try {
      const found = await firstValueFrom(this.lib.catalog());
      this.thumbs.seed(found);
      this.entries.set(found);
      const wanted = this.pendingPart;
      this.pendingPart = null;
      if (wanted && found.some(e => e.path === wanted)) this.detail.set(wanted); // a reload or a link: back on that part
      else if (wanted) history.replaceState(null, '', location.pathname + location.search); // that part is gone
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected sortBy(key: CatalogSortKey) {
    if (this.sortKey() === key) this.ascending.update(a => !a);
    else { this.sortKey.set(key); this.ascending.set(key === 'name'); } // dates and sizes start with the biggest / newest
  }

  protected onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && this.selected()) { event.preventDefault(); this.openDetail(this.selected()!); return; }
    const list = this.shown();
    if (!list.length || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const { columns } = this.window();
    const at = Math.max(0, list.findIndex(e => e.path === this.selected()));
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    const next = this.selected() ? Math.min(list.length - 1, Math.max(0, at + step)) : 0;
    this.selected.set(list[next].path);
    const element = this.scroller().nativeElement, rowTop = Math.floor(next / columns) * rowHeight;
    if (rowTop < element.scrollTop) element.scrollTop = rowTop;
    else if (rowTop + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = rowTop + rowHeight - element.clientHeight;
  }

  protected openDetail(path: string) {
    this.savedTop = this.top();
    this.selected.set(path);
    this.detail.set(path);
  }

  protected closeDetail() {
    this.detail.set(null);
    setTimeout(() => { this.scroller().nativeElement.scrollTop = this.savedTop; this.top.set(this.savedTop); }); // the list comes back where it was
  }

  protected step(direction: -1 | 1) {
    const next = direction < 0 ? this.previous() : this.following();
    if (next) { this.detail.set(next.path); this.selected.set(next.path); }
  }

  private setBig(url: string | null) {
    const old = this.bigUrl();
    if (old) URL.revokeObjectURL(old);
    this.bigUrl.set(url);
  }

  protected addCard(event: Event, entry: CatalogEntry) { event.stopPropagation(); this.add.emit(entry.path); }
  protected finder(entry: CatalogEntry) {
    this.lib.reveal(entry.path).subscribe({ next: () => this.actionNote.set('Shown in the Finder.'), error: () => this.actionNote.set('Could not show it in the Finder (it only works on the Mac that runs the API).') });
  }
  protected tooLarge(entry: CatalogEntry) { return isTooLarge(entry.size); }
  protected fileTitle(entry: CatalogEntry) { return displayName(entry.name); }
  protected dimsOf(entry: CatalogEntry) { return formatDims(this.thumbs.drawn().get(entry.path)?.dims ?? entry.dims); }
  protected volumeOf(entry: CatalogEntry) { const v = this.thumbs.drawn().get(entry.path)?.volume ?? entry.volume; return v == null ? '…' : `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)} cm³`; }
  protected short(name: string) { const n = displayName(name); return n.length > 40 ? n.slice(0, 39) + '…' : n; }
  protected draw(event: Event, entry: CatalogEntry) { event.stopPropagation(); this.thumbs.drawNow(entry); }
  protected meta(entry: CatalogEntry) {
    const dims = formatDims(this.thumbs.drawn().get(entry.path)?.dims);
    return dims ? `${dims} · ${this.kb(entry.size)}` : `${this.kb(entry.size)} · ${new Date(entry.modified * 1000).toISOString().slice(0, 10)}`;
  }
  protected parts(name: string) { return highlightParts(displayName(name), this.query()); }
  protected code(folder: string) { return folderCode(folder); }
  protected shortFolder(folder: string) { return folder.length > 26 ? folder.slice(0, 25) + '…' : folder; }
  protected pad(n: number) { return String(n).padStart(3, '0'); }
  protected kb(bytes: number) { return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
}
