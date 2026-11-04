import { DatePipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, output, signal, untracked, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryService } from '../core/library.service';
import { ManageService } from '../core/manage.service';
import { ManageToggle } from '../core/manage-toggle';
import { rangeBetween } from '../tree/tree-selection';
import { closeOnEscape } from '../util/escape-close';
import { highlightParts } from '../util/filter-terms';
import { ThumbnailService } from './thumbnail.service';
import { formatDims, isTooLarge } from './thumbnail.logic';
import { CatalogEntry, CatalogSortKey, displayName, filterCatalog, folderCode, folderCounts, parentFolder, siblingsOf, sortCatalog, visibleRows, withoutPaths, folderPaths, cleanFolderPath } from './catalog.logic';

const sortStorageKey = 'rasterfaster.catalogSort';
const folderViewKey = 'rasterfaster.catalogFolderView';
const specWidthKey = 'rasterfaster.catalogSpecWidth';
const defaultSpecWidth = 380;
const minSpecWidth = 260;
const minFigureWidth = 320;
const tileWidth = 232; // a tile of the strip (px): its drawing is 208 wide, so it sits on whole pixels
const cardWidth = 226;
const cardMinWidth = 150; // the narrowest a card gets (px); the columns share the width
const rowHeight = 264; // a card with its gap (px): the grid draws only the rows in view

function readSpecWidth(): number {
  try {
    const stored = Number(localStorage.getItem(specWidthKey));
    if (Number.isFinite(stored) && stored >= minSpecWidth) return Math.round(stored);
  } catch { /* storage unavailable */ }
  return defaultSpecWidth;
}

function readFolderView(): 'list' | 'strip' {
  try { return localStorage.getItem(folderViewKey) === 'strip' ? 'strip' : 'list'; } catch { return 'list'; }
}

function readSort(): { key: CatalogSortKey; ascending: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(sortStorageKey) ?? 'null');
    if (['name', 'date', 'size'].includes(stored?.key) && typeof stored.ascending === 'boolean') return stored;
  } catch { /* storage unavailable or damaged: use the default */ }
  return { key: 'name', ascending: true };
}

/**
 * The parts catalog: every STL of the library as a numbered card, in a near full-screen dialog. Filter by folder, find by name (the file list's
 * syntax), sort by name, date or size. A click (or Enter) opens the part's page: a large drawing and the facts about the file, with Add to document
 * (`add`), Find in browser (`findInBrowser`) and Reveal in Finder, and ← / → for the previous and next part. Its address is `#part=<path>`.
 * Only the cards in view exist in the page, so a library of thousands of files scrolls smoothly.
 */
@Component({
  selector: 'app-catalog-dialog',
  imports: [DatePipe, ManageToggle],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Parts catalog">
      <header>
        <h2>PARTS CATALOG</h2>
        <span class="stats">{{ entries().length }} parts · {{ folders().length }} folders</span>
        <app-manage-toggle />
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
          <div class="grid" [style.transform]="'translateY(' + window().first * rowHeight + 'px)'" [style.grid-template-columns]="'repeat(' + window().columns + ', ' + columnWidth() + 'px)'">
            @for (card of cards(); track card.entry.path) {
              <button type="button" class="card" [class.selected]="card.entry.path === selected()" [class.picked]="isPicked(card.entry.path)" (click)="onCardClick($event, card.entry)" [title]="card.entry.path">
                <span class="top"><span class="l">@if (manage.enabled()) { <span class="check" role="checkbox" [attr.aria-checked]="isPicked(card.entry.path)" [class.on]="isPicked(card.entry.path)" title="Select (Shift: a range)" (click)="pick($event, card.entry)">{{ isPicked(card.entry.path) ? '✓' : '' }}</span> }NO.{{ pad(card.number) }}</span><span>{{ code(card.entry.folder) }}</span></span>
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
      @if (manage.enabled() && picked().size) {
        <footer class="bar">
          <span><b>{{ picked().size }}</b> SELECTED{{ picked().size === shown().length ? ' (ALL SHOWN)' : '' }}</span>
          <button type="button" class="ghost" (click)="pickAll()">SELECT ALL {{ shown().length }} SHOWN</button>
          <button type="button" class="ghost" (click)="picked.set(none)">CLEAR</button>
          <button type="button" class="ghost" (click)="openMover(pickedPaths())">MOVE…</button>
          <button type="button" class="danger" (click)="requestTrash(pickedPaths())">MOVE TO TRASH</button>
        </footer>
      } @else {
        <footer>
          <span>{{ undoable() ? undoable()!.label : actionNote() || (selectedEntry()?.path ?? 'Click a part to open its page; arrow keys move, Enter opens it.') }}</span>
          @if (undoable()) { <button type="button" class="ghost" (click)="undoTrash()">UNDO</button> }
          @else if (selectedEntry()) { <button type="button" class="add" (click)="add.emit(selectedEntry()!.path)">ADD TO DOCUMENT</button> }
        </footer>
      }
      </div>

      @if (detailEntry(); as d) {
        <section class="detail" aria-label="Part">
          <div class="dhead"><span>NO.{{ number() }} / {{ shown().length }} · {{ code(d.folder) }}</span><button type="button" class="close" (click)="closeDetail()">BACK [ESC]</button></div>
          <div class="dbody">
            <div class="left">
            <div class="fig">
              @switch (bigState()) {
                @case ('ready') { <img [src]="bigUrl()!" alt="" draggable="false" /> }
                @case ('loading') { <span class="note">DRAWING…</span> }
                @default { <span class="note">{{ tooLarge(d) ? 'TOO LARGE TO DRAW · ' + kb(d.size) : 'NO DRAWING' }}</span> }
              }
              <span class="cap l">FIG. {{ number() }}</span><span class="cap r">LINE DRAWING · HIDDEN LINES REMOVED</span>
            </div>
            <div class="siblings" [class.as-strip]="siblingView() === 'strip'">
              <div class="shead">
                <span>IN THIS FOLDER · {{ folderOf(d) }}</span>
                <span class="right">
                  <span>{{ siblings().length ? siblings().length + (siblings().length === 1 ? ' OTHER FILE' : ' OTHER FILES') : 'NO OTHER FILES' }}</span>
                  <span class="chips"><button type="button" [class.on]="siblingView() === 'list'" (click)="setSiblingView('list')">LIST</button><button type="button" [class.on]="siblingView() === 'strip'" (click)="setSiblingView('strip')">STRIP</button></span>
                </span>
              </div>
              @if (siblingView() === 'list') {
                <div class="listbox">
                  @for (s of siblings(); track s.path) {
                    <button type="button" class="sib" [title]="s.path" (click)="detail.set(s.path)"><span class="n">{{ fileTitle(s) }}</span><span class="k">{{ kb(s.size) }}</span></button>
                  }
                </div>
              } @else if (siblings().length) {
                <div class="stripbox">
                  @if (stripBack()) { <button type="button" class="arrow l" aria-label="Previous files" (click)="page(-1)">‹</button> }
                  <div #strip class="strip" (scroll)="measureStrip()">
                    @for (s of siblings(); track s.path) {
                      <button type="button" class="tile" [title]="s.path" (click)="detail.set(s.path)">
                        <span class="art">
                          @switch (thumbs.state(s)) {
                            @case ('drawn') { <img [src]="thumbs.url(s)" alt="" draggable="false" /> }
                            @case ('large') { <span class="note">LARGE FILE · {{ kb(s.size) }}</span> }
                            @case ('toolarge') { <span class="note">TOO LARGE · {{ kb(s.size) }}</span> }
                            @case ('failed') { <span class="note">NO DRAWING</span> }
                            @default { <span class="note pending">PENDING</span> }
                          }
                        </span>
                        <span class="name">{{ fileTitle(s) }}</span>
                        <span class="meta">{{ meta(s) }}</span>
                      </button>
                    }
                  </div>
                  @if (stripForward()) { <button type="button" class="arrow r" aria-label="Next files" (click)="page(1)">›</button> }
                </div>
              }
            </div>
            </div>
            <div class="grip" [class.active]="resizing()" role="separator" aria-orientation="vertical" [attr.aria-valuenow]="specWidth()"
                 title="Drag to resize · double-click for the default width"
                 (pointerdown)="onGripDown($event)" (pointermove)="onGripMove($event)" (pointerup)="onGripUp($event)" (pointercancel)="onGripUp($event)" (dblclick)="setSpecWidth(defaultWidth)"></div>
            <div class="spec" [style.width.px]="specWidth()">
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
              @if (manage.enabled()) {
                <div class="manage">
                  <div class="mlabel"><span>MANAGE</span><span>CHANGES THE LIBRARY</span></div>
                  <div class="actions">
                    <button type="button" class="mg" (click)="openRename(d)">RENAME…</button>
                    <button type="button" class="mg" [disabled]="busy()" (click)="duplicate(d)">DUPLICATE</button>
                    <button type="button" class="mg" (click)="openMover([d.path])">MOVE…</button>
                    <button type="button" class="danger" (click)="requestTrash([d.path])">MOVE TO TRASH</button>
                  </div>
                </div>
              }
              @if (actionNote()) { <p class="empty">{{ actionNote() }}</p> }
            </div>
          </div>
          <div class="dnav">
            <button type="button" [disabled]="!previous()" (click)="step(-1)">{{ previous() ? '← ' + pad(detailIndex()) + ' ' + short(previous()!.name) : '' }}</button>
            <button type="button" [disabled]="!following()" (click)="step(1)">{{ following() ? pad(detailIndex() + 2) + ' ' + short(following()!.name) + ' →' : '' }}</button>
          </div>
        </section>
      }
      @if (renaming(); as r) {
        <div class="shade"></div>
        <div class="confirm" role="dialog" aria-label="Rename">
          <h4>RENAME</h4>
          <p class="n">{{ r.path }}</p>
          <input class="field" type="text" spellcheck="false" autocomplete="off" [value]="r.name" (input)="renameText($any($event.target).value)" (keydown.enter)="renameNow()" />
          <p class="hint">The .stl is added when it is left out. Documents that use the file follow the new name.</p>
          @if (r.error) { <p class="warn">{{ r.error }}</p> }
          <div class="actions"><button type="button" class="add" [disabled]="busy()" (click)="renameNow()">RENAME</button><button type="button" class="ghost" (click)="renaming.set(null)">CANCEL [ESC]</button></div>
        </div>
      }
      @if (mover(); as m) {
        <div class="shade"></div>
        <div class="confirm mover" role="dialog" aria-label="Move">
          <h4>MOVE {{ m.paths.length === 1 ? '1 PART' : m.paths.length + ' PARTS' }} TO …</h4>
          <input class="field" type="text" spellcheck="false" autocomplete="off" placeholder="a folder, or a new one: new/folder" [value]="m.text" (input)="moverText($any($event.target).value)" (keydown.enter)="moveFirst()" />
          <div class="folders-list">
            @if (moverCreate(); as create) { <button type="button" class="pick create" (click)="moveTo(create, true)">CREATE “{{ create }}” AND MOVE HERE</button> }
            @for (f of moverFolders(); track f.path) {
              <button type="button" class="pick" [disabled]="f.here" (click)="moveTo(f.path, false)">{{ f.path || 'LIBRARY ROOT' }}@if (f.here) { <small> · already there</small> }</button>
            } @empty { @if (!moverCreate()) { <p class="hint">No folder matches.</p> } }
          </div>
          @if (m.error) { <p class="warn">{{ m.error }}</p> }
          <div class="actions"><button type="button" class="ghost" (click)="mover.set(null)">CANCEL [ESC]</button></div>
        </div>
      }
      @if (confirm(); as c) {
        <div class="shade"></div>
        <div class="confirm" role="alertdialog" aria-label="Move to Trash">
          <h4>MOVE {{ c.paths.length === 1 ? '1 PART' : c.paths.length + ' PARTS' }} TO THE TRASH?</h4>
          @if (c.paths.length === 1) { <p class="n">{{ c.paths[0] }}</p> }
          @if (c.documents.length) {
            <p class="warn">{{ c.parts }} part{{ c.parts === 1 ? '' : 's' }} in {{ c.documents.length }} document{{ c.documents.length === 1 ? '' : 's' }} use{{ c.parts === 1 ? 's' : '' }} {{ c.paths.length === 1 ? 'it' : 'these' }} ({{ c.documents.join(', ') }}): they will show a ⚠ until you Put Back.</p>
          } @else {
            <p>No document uses {{ c.paths.length === 1 ? 'it' : 'them' }}. Put Back in the Trash undoes this.</p>
          }
          <div class="actions"><button type="button" class="danger" [disabled]="busy()" (click)="trashNow(c.paths)">MOVE TO TRASH</button><button type="button" class="ghost" (click)="confirm.set(null)">CANCEL [ESC]</button></div>
        </div>
      }
    </section>
  `,
  styles: `
    :host { color: #d8d8d8; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11px; line-height: 16px; letter-spacing: .02em; } /* whole-pixel lines: every height in the dialog is a whole number of pixels */
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
    .dbody { flex: 1; min-height: 0; display: flex; gap: 0; padding: 16px 0; overflow: auto; }
    .left { flex: 1 1 60%; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
    .siblings { flex: none; height: 260px; display: flex; flex-direction: column; border: 1px solid #2c2d31; overflow: hidden; } /* the same height as a list and as a strip: nothing jumps when you switch */
    .listbox { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .shead .right { display: flex; align-items: baseline; gap: 14px; } .shead .chips button { color: #888; } .shead .chips button.on { background: #e6e6e6; color: #111; }
    .stripbox { position: relative; flex: 1 1 auto; min-height: 0; } .strip { height: 100%; display: flex; overflow-x: auto; scrollbar-width: none; } .strip::-webkit-scrollbar { display: none; }
    .tile { flex: none; box-sizing: border-box; width: ${tileWidth}px; display: flex; flex-direction: column; padding: 8px 12px; text-align: left; border: 0; box-shadow: inset -1px 0 #2c2d31; background: transparent; overflow: hidden; }
    .tile:hover { background: #1e2024; } .tile .art { margin-bottom: 4px; } .tile .name { flex: none; max-height: 32px; color: #e6e6e6; font-size: 12px; overflow: hidden; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; } /* two lines, like the cards: the sizes line up across the tiles */ .tile .meta { flex: none; margin-top: 2px; color: #777; }
    .arrow { position: absolute; top: 0; bottom: 0; width: 44px; display: flex; align-items: center; justify-content: center; font-size: 30px; color: #fff; background: rgba(22,23,26,.82); border: 0; z-index: 1; } .arrow:hover { background: rgba(38,50,74,.95); }
    .arrow.l { left: 0; } .arrow.r { right: 0; }
    .shead { flex: none; display: flex; justify-content: space-between; padding: 6px 10px; background: #16171a; border-bottom: 1px solid #2c2d31; color: #888; }
    .sib { display: flex; justify-content: space-between; gap: 16px; width: 100%; box-sizing: border-box; padding: 3px 10px; text-align: left; color: #bbb; } .sib:hover { background: #1e2024; color: #fff; }
    .sib .n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .sib .k { flex: none; color: #666; }
    .fig { position: relative; flex: 1 1 auto; min-width: 0; min-height: 320px; display: flex; align-items: center; justify-content: center; border: 1px solid #2c2d31; overflow: auto; }
    .fig img { flex: none; } .cap { position: absolute; bottom: 8px; color: #555; font-size: 10px; } .cap.l { left: 10px; } .cap.r { right: 10px; }
    .spec { flex: none; min-width: 0; }
    .grip { position: relative; flex: none; width: 28px; cursor: col-resize; touch-action: none; } .grip::after { content: ''; position: absolute; top: 0; bottom: 0; left: 13px; width: 2px; background: transparent; transition: background .12s; } .grip:hover::after, .grip.active::after { background: #2f6fed; } .where { color: #888; } h3 { margin: 4px 0 14px; font-size: 20px; font-weight: 400; color: #e6e6e6; word-break: break-word; }
    dl { margin: 0; } dl > div { display: flex; gap: 16px; padding: 6px 0; border-top: 1px solid #2c2d31; } dl > div:last-child { border-bottom: 1px solid #2c2d31; }
    dt { flex: none; width: 84px; color: #888; } dd { margin: 0; min-width: 0; color: #e6e6e6; word-break: break-word; } .path { font-size: 10px; color: #aaa; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; } .ghost { border: 1px solid #444; padding: 3px 10px; color: #ccc; } .ghost:hover { border-color: #888; color: #fff; }
    .dnav { display: flex; justify-content: space-between; padding-top: 10px; border-top: 1px solid #2c2d31; color: #888; } .dnav button:disabled { visibility: hidden; } .dnav button:hover { color: #fff; }
    .card .plus { position: absolute; right: 8px; bottom: 8px; display: none; padding: 1px 6px; background: #e6e6e6; color: #111; } .card { position: relative; } .card:hover .plus { display: block; } .plus:hover { background: #fff; }
    .card .l { display: inline-flex; align-items: center; gap: 6px; } .check { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; box-sizing: border-box; border: 1px solid #555; color: #111; font-size: 10px; line-height: 10px; } .check:hover { border-color: #aaa; } .check.on { background: #e6e6e6; border-color: #e6e6e6; }
    .card.picked { background: #1f2a3e; }
    footer.bar { gap: 14px; } footer.bar b { color: #e6e6e6; font-weight: 400; } footer.bar span { flex: 1; }
    .danger { border: 1px solid #7a3a3a; padding: 3px 10px; color: #f0b4b4; } .danger:hover:not(:disabled) { background: #b03a3a; color: #fff; } .danger:disabled { opacity: .4; }
    .shade { position: absolute; inset: 0; background: rgba(0,0,0,.55); z-index: 5; }
    .confirm { position: absolute; z-index: 6; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, 90%); padding: 16px 18px; background: #1c1d21; border: 1px solid #3a3b40; border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.6); }
    .confirm h4 { margin: 0 0 8px; font-size: 12px; font-weight: 400; letter-spacing: .1em; } .confirm p { margin: 6px 0; color: #aaa; word-break: break-word; } .confirm .n { color: #e6e6e6; } .confirm .warn { color: #e8c470; }
    .manage { margin-top: 18px; padding: 8px 10px 10px; border: 1px dashed #6b5a2a; border-radius: 4px; background: rgba(232,196,112,.04); }
    .mlabel { display: flex; justify-content: space-between; color: #c9a64e; font-size: 10px; letter-spacing: .1em; } .mlabel span:last-child { color: #7d6a3a; }
    .manage .actions { margin-top: 8px; }
    .mg { padding: 3px 10px; border: 1px solid #6b5a2a; color: #e8c470; } .mg:hover:not(:disabled) { background: #3a3320; color: #ffe27a; border-color: #c9a64e; } .mg:disabled { opacity: .4; }
    .confirm .field { width: 100%; box-sizing: border-box; margin: 6px 0; padding: 6px 8px; background: #111; border: 1px solid #3a3b40; color: #e6e6e6; } .confirm .field:focus { border-color: #2f6fed; }
    .confirm .hint { font-size: 10px; color: #777; } .folders-list { max-height: 240px; overflow: auto; margin-top: 6px; border: 1px solid #2c2d31; }
    .pick { display: block; width: 100%; box-sizing: border-box; padding: 4px 10px; text-align: left; color: #ccc; word-break: break-all; } .pick:hover:not(:disabled) { background: #26324a; color: #fff; } .pick:disabled { opacity: .35; cursor: default; } .pick.create { color: #9ad29a; }
    .confirm .actions { display: flex; gap: 8px; margin-top: 14px; }
    .scroller { flex: 1; min-height: 0; overflow: auto; border: 1px solid #2c2d31; outline: 0; }
    .space { position: relative; } .grid { position: absolute; left: 0; right: 0; top: 0; display: grid; }
    .card { height: ${rowHeight}px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 8px 11px 8px 10px; border: 0; border-right: 1px solid #2c2d31; border-bottom: 1px solid #2c2d31; background: transparent; overflow: hidden; }
    .card:hover { background: #1e2024; } .card.selected { background: #26324a; outline: 1px solid #2f6fed; outline-offset: -1px; }
    .top { flex: none; height: 16px; display: flex; justify-content: space-between; color: #777; }
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
  protected readonly manage = inject(ManageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly close = output<void>();
  /** The part to add to the document (its library path). */
  readonly add = output<string>();
  /** Show this part in the file list of the app (the dialog closes). */
  readonly findInBrowser = output<string>();
  /** Parts were moved to the Trash or put back: the app refreshes the file list. */
  readonly changed = output<void>();

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
  /** The parts ticked for Manage actions (their library paths). */
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly none: ReadonlySet<string> = new Set();
  private pickAnchor: string | null = null;
  protected readonly pickedPaths = computed(() => this.shown().filter(e => this.picked().has(e.path)).map(e => e.path));
  /** The Move to Trash waiting for a yes: what it is, and which documents use those files (from a dry run). */
  protected readonly confirm = signal<{ paths: string[]; documents: string[]; parts: number } | null>(null);
  protected readonly busy = signal(false);
  /** The width of the facts column of a part's page (px), dragged with the bar between it and the drawing; remembered. */
  protected readonly specWidth = signal(readSpecWidth());
  protected readonly resizing = signal(false);
  protected readonly defaultWidth = defaultSpecWidth;
  private gripStart: { x: number; width: number } | null = null;
  protected readonly renaming = signal<{ path: string; name: string; error: string } | null>(null);
  protected readonly mover = signal<{ paths: string[]; text: string; error: string } | null>(null);
  /** The folders a move can go to: those matching what was typed, and whether the parts are all there already. */
  protected readonly moverFolders = computed(() => {
    const m = this.mover();
    if (!m) return [];
    const needle = m.text.trim().toLowerCase();
    const here = new Set(m.paths.map(parentFolder));
    return ['', ...folderPaths(this.entries())].filter(path => !needle || path.toLowerCase().includes(needle)).map(path => ({ path, here: here.size === 1 && here.has(path) }));
  });
  /** What was typed names a folder that does not exist yet: offered as "create and move here". */
  protected readonly moverCreate = computed(() => {
    const m = this.mover();
    const path = m ? cleanFolderPath(m.text) : null;
    return path && !['', ...folderPaths(this.entries())].some(f => f.toLowerCase() === path.toLowerCase()) ? path : null;
  });
  /** The last Move to Trash, to undo from the bottom bar. */
  protected readonly undoable = signal<{ ids: string[]; label: string } | null>(null);
  private savedTop = 0;
  /** The other files of the folder on a part's page: a list, or a strip of drawings that pages left and right. */
  protected readonly siblingView = signal<'list' | 'strip'>(readFolderView());
  private readonly stripRef = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly stripLeft = signal(0);
  private readonly stripSize = signal({ width: 0, total: 0 });
  protected readonly stripBack = computed(() => this.stripLeft() > 0);
  protected readonly stripForward = computed(() => this.stripLeft() + this.stripSize().width < this.stripSize().total - 1);
  /** The tiles in view and one page more, in the order to draw them. */
  private readonly stripWanted = computed(() => {
    const first = Math.floor(this.stripLeft() / tileWidth), perPage = Math.max(1, Math.ceil(this.stripSize().width / tileWidth));
    return this.siblings().slice(first, first + 2 * perPage + 1);
  });
  /** The part named in the address when the dialog opened (a reload or a link); the address is left alone until the catalog has loaded and it was looked up. */
  private pendingPart: string | null = location.hash.startsWith('#part=') ? decodeURIComponent(location.hash.slice(6)) : null;
  private readonly size = signal({ width: 800, height: 500 });

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly find = viewChild.required<ElementRef<HTMLInputElement>>('find');

  protected readonly folders = computed(() => folderCounts(this.entries()));
  protected readonly shown = computed(() => sortCatalog(filterCatalog(this.entries(), this.query(), this.folder()), this.sortKey(), this.ascending()));
  /** The open part; the same object for the same file, so a reload of the list does not draw its big picture again. */
  protected readonly detailEntry = computed(() => this.entries().find(e => e.path === this.detail()) ?? null,
    { equal: (a, b) => a?.path === b?.path && a?.modified === b?.modified && a?.size === b?.size });
  private keepNote = false; // a note about an action stays when the action itself moved the page to another path
  protected readonly detailIndex = computed(() => this.shown().findIndex(e => e.path === this.detail()));
  protected readonly siblings = computed(() => { const path = this.detail(); return path ? siblingsOf(this.entries(), path) : []; });
  protected readonly previous = computed(() => this.shown()[this.detailIndex() - 1] ?? null);
  protected readonly following = computed(() => (this.detailIndex() < 0 ? null : this.shown()[this.detailIndex() + 1] ?? null));
  protected readonly selectedEntry = computed(() => this.shown().find(e => e.path === this.selected()) ?? null);
  protected readonly window = computed(() => visibleRows(this.shown().length, this.size().width, this.top(), this.size().height, cardWidth, rowHeight));
  /** Whole, even pixels per column (the rest of the width stays empty at the right): the drawings then sit on whole pixels and their thin lines stay sharp. */
  protected readonly columnWidth = computed(() => Math.max(cardMinWidth, 2 * Math.floor(this.size().width / this.window().columns / 2)));
  protected readonly cards = computed(() => {
    const { columns, first, last } = this.window();
    return this.shown().slice(first * columns, last * columns).map((entry, i) => ({ entry, number: first * columns + i + 1 }));
  });

  constructor() {
    closeOnEscape(() => (this.renaming() ? this.renaming.set(null) : this.mover() ? this.mover.set(null) : this.confirm() ? this.confirm.set(null) : this.detail() ? this.closeDetail() : this.picked().size ? this.picked.set(this.none) : this.close.emit()));
    effect(() => { if (!this.manage.enabled()) this.picked.set(this.none); }); // Manage off: nothing stays ticked
    effect(() => { // draw what is in view: the strip of a part's page when it is shown, else the cards
      if (this.detail() && this.siblingView() === 'strip') this.thumbs.want(this.stripWanted());
      else this.thumbs.want(this.cards().map(card => card.entry));
    });
    effect(onCleanup => { // measure the strip when it appears, changes its files or its width; a new folder starts at its first file
      this.siblings(); this.siblingView();
      const element = this.stripRef()?.nativeElement;
      if (!element) return;
      element.scrollLeft = 0;
      const observer = new ResizeObserver(() => this.measureStrip());
      observer.observe(element);
      const timer = setTimeout(() => this.measureStrip());
      onCleanup(() => { observer.disconnect(); clearTimeout(timer); });
    });
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
    effect(() => { this.detail(); untracked(() => { if (this.keepNote) this.keepNote = false; else this.actionNote.set(''); }); }); // a note is about the page it was made on
    effect(onCleanup => { // the page of a part: its big drawing and where it is used
      const entry = this.detailEntry();
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
    if (this.manage.enabled() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); this.pickAll(); return; }
    if (this.manage.enabled() && event.metaKey && event.key === 'Backspace') {
      event.preventDefault();
      const target = this.picked().size ? this.pickedPaths() : this.selected() ? [this.selected()!] : [];
      void this.requestTrash(target);
      return;
    }
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

  protected isPicked(path: string) { return this.picked().has(path); }

  /** A click on a card: its page opens; with ⌘ (or Ctrl) it ticks the part instead (Manage on). */
  protected onCardClick(event: MouseEvent, entry: CatalogEntry) {
    if (this.manage.enabled() && (event.metaKey || event.ctrlKey)) { this.pick(event, entry); return; }
    this.openDetail(entry.path);
  }

  /** The tick box of a card: one part in or out; with Shift every part from the last one ticked to this one. */
  protected pick(event: MouseEvent, entry: CatalogEntry) {
    event.stopPropagation();
    const next = new Set(this.picked());
    if (event.shiftKey && this.pickAnchor) for (const path of rangeBetween(this.shown().map(e => e.path), this.pickAnchor, entry.path)) next.add(path);
    else { if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); this.pickAnchor = entry.path; }
    this.picked.set(next);
  }

  protected pickAll() { this.picked.set(new Set(this.shown().map(e => e.path))); }

  /** Asks what would happen (a dry run: which documents use these files), then waits for a yes. */
  protected async requestTrash(paths: string[]) {
    if (!this.manage.enabled() || !paths.length) return;
    this.actionNote.set('');
    try {
      const dry = await firstValueFrom(this.lib.trashBatch(paths, true));
      const documents = Object.keys(dry.documents ?? {});
      this.confirm.set({ paths, documents, parts: Object.values(dry.documents ?? {}).reduce((sum, n) => sum + n, 0) });
    } catch {
      this.actionNote.set('Could not check which documents use these files. Is the API running?');
    }
  }

  protected async trashNow(paths: string[]) {
    if (!this.manage.enabled()) return;
    this.busy.set(true);
    try {
      const result = await firstValueFrom(this.lib.trashBatch(paths));
      const gone = result.results.map(r => r.path);
      const open = this.detail();
      const next = open && gone.includes(open) ? (this.following() ?? this.previous())?.path ?? null : open;
      this.entries.update(list => withoutPaths(list, gone));
      this.picked.update(set => new Set([...set].filter(path => !gone.includes(path))));
      if (open && next !== open) { if (next) this.detail.set(next); else this.closeDetail(); }
      const ids = result.results.map(r => r.id).filter((id): id is string => !!id);
      const failed = result.failed.length;
      this.undoable.set(ids.length ? { ids, label: `Moved ${ids.length === 1 ? '1 part' : ids.length + ' parts'} to the Trash${failed ? `; ${failed} could not be moved` : ''}.` } : null);
      if (!ids.length && failed) this.actionNote.set(`Could not move ${failed} to the Trash: ${result.failed[0].error}`);
      this.confirm.set(null);
      void this.lib.refreshTrash();
      this.changed.emit();
    } catch {
      this.confirm.set(null);
      this.actionNote.set('Could not move them to the Trash.');
    } finally {
      this.busy.set(false);
    }
  }

  protected openRename(entry: CatalogEntry) {
    this.renaming.set({ path: entry.path, name: displayName(entry.name), error: '' });
    this.focusField();
  }

  protected renameText(name: string) { this.renaming.update(r => r && { ...r, name, error: '' }); }

  protected async renameNow() {
    const r = this.renaming();
    if (!r || !this.manage.enabled() || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await firstValueFrom(this.lib.rename(r.path, r.name));
      this.renaming.set(null);
      this.undoable.set(null);
      this.actionNote.set(`Renamed to ${result.to.split('/').pop()}${this.documentNote(result.documents)}.`);
      await this.reload();
      if (this.detail() === r.path) { this.keepNote = true; this.detail.set(result.to); }
      this.changed.emit();
    } catch (error) {
      this.renaming.update(now => now && { ...now, error: this.reason(error, 'Could not rename it.') });
    } finally {
      this.busy.set(false);
    }
  }

  protected async duplicate(entry: CatalogEntry) {
    if (!this.manage.enabled() || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await firstValueFrom(this.lib.duplicate(entry.path));
      await this.reload();
      this.keepNote = true;
      this.detail.set(result.path); // the copy opens
      this.actionNote.set(`Duplicated: this is the copy of ${displayName(entry.name)}.`);
      this.changed.emit();
    } catch (error) {
      this.actionNote.set(this.reason(error, 'Could not duplicate it.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected openMover(paths: string[]) {
    if (!this.manage.enabled() || !paths.length) return;
    this.mover.set({ paths, text: '', error: '' });
    this.focusField();
  }

  protected moverText(text: string) { this.mover.update(m => m && { ...m, text, error: '' }); }

  /** Enter in the move box: the folder typed (new or old), else the first folder in the list. */
  protected moveFirst() {
    const create = this.moverCreate();
    if (create) { void this.moveTo(create, true); return; }
    const first = this.moverFolders().find(f => !f.here);
    if (first) void this.moveTo(first.path, false);
  }

  /** Moves the parts into `folder` ('' is the library root), after making the folder (and the ones above it) when it is new. */
  protected async moveTo(folder: string, create: boolean) {
    const m = this.mover();
    if (!m || !this.manage.enabled() || this.busy()) return;
    this.busy.set(true);
    try {
      if (create) {
        let parent = '';
        for (const part of folder.split('/')) {
          try { await firstValueFrom(this.lib.newFolder(parent, part)); } catch (error) { if ((error as { status?: number }).status !== 409) throw error; } // 409: it is there already
          parent = parent ? `${parent}/${part}` : part;
        }
      }
      const result = await firstValueFrom(this.lib.move(m.paths, folder));
      const moved = new Map(result.results.map(r => [r.from, r.to]));
      const open = this.detail();
      this.mover.set(null);
      this.picked.set(this.none);
      this.undoable.set(null);
      const changed = result.results.reduce((sum, r) => sum + Object.values(r.documents).reduce((a, n) => a + n, 0), 0);
      const failed = result.failed.length;
      this.actionNote.set(`Moved ${moved.size} part${moved.size === 1 ? '' : 's'} to ${folder || 'the library root'}${changed ? ` (${changed} part${changed === 1 ? '' : 's'} in documents updated)` : ''}${failed ? `; ${failed} could not be moved: ${result.failed[0].error}` : ''}.`);
      await this.reload();
      if (open && moved.has(open)) { this.keepNote = true; this.detail.set(moved.get(open)!); }
      this.changed.emit();
    } catch (error) {
      this.mover.update(now => now && { ...now, error: this.reason(error, 'Could not move them.') });
    } finally {
      this.busy.set(false);
    }
  }

  private documentNote(documents: Record<string, number>) {
    const parts = Object.values(documents).reduce((sum, n) => sum + n, 0);
    return parts ? ` (${parts} part${parts === 1 ? '' : 's'} in documents updated)` : '';
  }

  private reason(error: unknown, fallback: string) {
    const detail = (error as { error?: { detail?: unknown } }).error?.detail;
    return typeof detail === 'string' ? detail.charAt(0).toUpperCase() + detail.slice(1) + '.' : fallback;
  }

  private focusField() {
    setTimeout(() => { const field = this.host.nativeElement.querySelector('.confirm .field') as HTMLInputElement | null; field?.focus(); field?.select(); });
  }

  /** Puts the parts of the last Move to Trash back (the oldest first, as they went in) and reads the library again. */
  protected async undoTrash() {
    const last = this.undoable();
    if (!last) return;
    this.undoable.set(null);
    for (const id of [...last.ids].reverse()) { try { await firstValueFrom(this.lib.putBack(id, 'rename')); } catch { /* it stays in the Trash */ } }
    await this.reload();
    void this.lib.refreshTrash();
    this.changed.emit();
  }

  /** Reads the library again (after a change) and keeps the drawings that are still current. */
  private async reload() {
    try {
      const found = await firstValueFrom(this.lib.catalog());
      this.thumbs.seed(found);
      this.entries.set(found);
    } catch { /* the list stays as it was */ }
  }

  protected setSpecWidth(width: number, save = true) {
    const room = (this.host.nativeElement.querySelector('.dbody') as HTMLElement | null)?.clientWidth ?? 1200;
    const next = Math.round(Math.max(minSpecWidth, Math.min(width, room - minFigureWidth - 28)));
    this.specWidth.set(next);
    if (save) { try { localStorage.setItem(specWidthKey, String(next)); } catch { /* storage unavailable */ } }
  }

  protected onGripDown(event: PointerEvent) {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.gripStart = { x: event.clientX, width: this.specWidth() };
    this.resizing.set(true);
  }

  protected onGripMove(event: PointerEvent) {
    if (this.gripStart) this.setSpecWidth(this.gripStart.width - (event.clientX - this.gripStart.x), false); // the bar moves left: the column grows
  }

  protected onGripUp(event: PointerEvent) {
    if (!this.gripStart) return;
    this.gripStart = null;
    this.resizing.set(false);
    try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch { /* already released */ }
    this.setSpecWidth(this.specWidth()); // keep it
  }

  protected setSiblingView(view: 'list' | 'strip') {
    this.siblingView.set(view);
    try { localStorage.setItem(folderViewKey, view); } catch { /* storage unavailable */ }
  }

  protected measureStrip() {
    const element = this.stripRef()?.nativeElement;
    if (!element) return;
    this.stripLeft.set(element.scrollLeft);
    this.stripSize.set({ width: element.clientWidth, total: element.scrollWidth });
  }

  /** One page left or right (as many whole tiles as fit), scrolled smoothly, like a row of films. */
  protected page(direction: -1 | 1) {
    const element = this.stripRef()?.nativeElement;
    if (!element) return;
    const perPage = Math.max(1, Math.floor(element.clientWidth / tileWidth));
    const target = (Math.round(element.scrollLeft / tileWidth) + direction * perPage) * tileWidth;
    element.scrollTo({ left: Math.max(0, Math.min(element.scrollWidth - element.clientWidth, target)), behavior: 'smooth' });
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
  /** The place of the open part in the list ('—' when the filter has left it out, which a part picked from its folder can be). */
  protected number() { return this.detailIndex() < 0 ? '—' : this.pad(this.detailIndex() + 1); }
  protected folderOf(entry: CatalogEntry) { return parentFolder(entry.path) || 'LIBRARY ROOT'; }
  protected tooLarge(entry: CatalogEntry) { return isTooLarge(entry.size); }
  protected fileTitle(entry: CatalogEntry) { return displayName(entry.name); }
  protected dimsOf(entry: CatalogEntry) { return formatDims(this.thumbs.drawn().get(entry.path)?.dims ?? this.thumbs.measured().get(entry.path)?.dims ?? entry.dims); }
  protected volumeOf(entry: CatalogEntry) { const v = this.thumbs.drawn().get(entry.path)?.volume ?? this.thumbs.measured().get(entry.path)?.volume ?? entry.volume; return v == null ? '…' : `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)} cm³`; }
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
