import { DatePipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, output, signal, untracked, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryService } from '../core/library.service';
import { ManageService } from '../core/manage.service';
import { RF_PART_FINDERS, RfFinderResult } from '../core/part-finder';
import { ManageToggle } from '../core/manage-toggle';
import { QuickLook } from '../preview/quick-look';
import { companionColors } from '../preview/together';
import { rangeBetween } from '../tree/tree-selection';
import { closeOnEscape } from '../util/escape-close';
import { highlightParts } from '../util/filter-terms';
import { ThumbnailService } from './thumbnail.service';
import { formatDims, isTooLarge } from './thumbnail.logic';
import { CatalogEntry, CatalogSortKey, displayName, filterCatalog, folderCode, folderCounts, parentFolder, sortCatalog, visibleRows, withoutPaths, folderPaths, cleanFolderPath, isOldPath, groupCopies, remapPath, documentsOf, DuplicateGroup, crumbsOf, childFolders, filesIn, isWithin, companionsOf, companionCounts, partNumber, companionLabel } from './catalog.logic';

type CheckMode = 'exact' | 'shape';
interface ScanState { state: 'idle' | 'running' | 'done' | 'error'; scanned: number; total: number; error: string }
const idleScan: ScanState = { state: 'idle', scanned: 0, total: 0, error: '' };
const sortStorageKey = 'rasterfaster.catalogSort';
const folderViewKey = 'rasterfaster.catalogFolderView';
const figViewKey = 'rasterfaster.catalogFigView';
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

function readFigView(): 'drawing' | '3d' | 'together' {
  try { const stored = localStorage.getItem(figViewKey); return stored === '3d' || stored === 'together' ? stored : 'drawing'; } catch { return 'drawing'; }
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
  imports: [DatePipe, ManageToggle, QuickLook],
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
      @if (manage.enabled() && folder()) {
        <div class="row folderbar"><span class="label">FOLDER</span>
          <div class="chips"><span class="fname" [title]="folder()!">“{{ folder() }}”</span>
            <button type="button" class="mg" (click)="openRenameFolder(folder()!)">RENAME…</button>
            <button type="button" class="mg" (click)="openMover([folder()!])">MOVE…</button>
            <button type="button" class="danger" (click)="requestTrash([folder()!])">MOVE TO TRASH</button>
          </div>
        </div>
      }
      <div class="row"><span class="label">CLEAN UP</span>
        <div class="chips">
          <button type="button" [class.on]="cleanFilters().has('old')" title="Names with old, backup, bak or copy in them, or (1)" (click)="toggleClean('old')">_OLD<sup>{{ oldCount() }}</sup></button>
          <button type="button" [class.on]="cleanFilters().has('unused')" title="Parts that no document uses (the saved versions of documents count as using them)" (click)="toggleClean('unused')">UNUSED@if (used()) {<sup>{{ unusedCount() }}</sup>}</button>
          <span class="bar-sep">|</span>
          @for (m of checkModes; track m.key; let first = $first) {
            @if (!first) { <span class="bar-sep">|</span> }
            @if (scanBy()[m.key].state === 'running') {
              <span class="busy">{{ m.busy }}… {{ scanBy()[m.key].scanned }} / {{ scanBy()[m.key].total }}</span>
            } @else {
              <button type="button" class="tool" [title]="m.title" (click)="check(m.key)">{{ groupsBy()[m.key] ? m.again : m.check }}</button>
              @if (groupsBy()[m.key]) { <button type="button" [class.on]="viewDoubles() === m.key" [title]="'Show the groups of ' + m.what" (click)="viewDoubles.set(viewDoubles() === m.key ? null : m.key)">{{ m.chip }}<sup>{{ groupsBy()[m.key]!.length }}</sup></button> }
              @if (staleBy()[m.key]) { <span class="warn" title="Parts were copied or put back since the check">OUT OF DATE</span> }
            }
            @if (scanBy()[m.key].state === 'error') { <span class="warn">Could not check: {{ scanBy()[m.key].error }}</span> }
          }
        </div>
      </div>
      <div class="row"><span class="label">FIND</span>
        <input #find type="text" placeholder="name, folder …  “phrase”  -exclude   [ / ]" spellcheck="false" autocomplete="off" [value]="query()" (input)="query.set(find.value)" />
      </div>
      <div class="status"><span>@if (activeGroups()) { SHOWING <b>{{ doubleGroups().length }}</b> / {{ activeGroups()!.length }} GROUPS OF {{ activeMode().what }} } @else { SHOWING <b>{{ shown().length }}</b> / {{ entries().length }} }</span><span>QUERY: {{ query().trim() ? query().trim().toUpperCase() : 'ALL' }}{{ folder() !== null ? ' · ' + (folder() || 'ROOT').toUpperCase() : '' }}</span></div>

      @if (loading()) {
        <p class="empty">Reading the library…</p>
      } @else if (failed()) {
        <p class="empty">Could not read the library. Is the API running?</p>
      } @else if (!shown().length && !activeGroups()) {
        <p class="empty">No parts match.</p>
      }
      <div class="groupsview" [hidden]="!activeGroups()">
        @for (g of doubleGroups(); track $index; let n = $index) {
          <div class="group">
            <div class="ghead"><span>GROUP {{ pad(n + 1) }}</span><span>{{ g.length }} {{ activeMode().files }}{{ viewDoubles() === 'exact' ? ' · ' + kb(g[0].size) + ' EACH' : '' }}</span></div>
            @for (c of g; track c.path) {
              <div class="copy">
                <button type="button" class="where" [title]="c.path" (click)="openIdentical(c.path)"><span class="dir">{{ folderOf(c) }}</span><span class="file">{{ fileTitle(c) }}</span></button>
                <span class="when">{{ kb(c.size) }} · {{ c.modified * 1000 | date: 'yyyy-MM-dd HH:mm' }}</span>
                <span class="cacts">
                  <button type="button" class="ghost" (click)="openIdentical(c.path)">OPEN</button>
                  @if (manage.enabled()) {
                    <button type="button" class="mg" (click)="openRename(c)">RENAME…</button>
                    <button type="button" class="mg" (click)="openMover([c.path])">MOVE…</button>
                    <button type="button" class="danger" (click)="requestTrash([c.path])">MOVE TO TRASH</button>
                  }
                </span>
              </div>
            }
          </div>
        } @empty {
          <p class="empty">No {{ activeMode().files.toLowerCase() }}{{ query().trim() || folder() !== null || cleanFilters().size ? ' that match the filters' : '' }}.</p>
        }
      </div>
      <div #scroller class="scroller" [hidden]="!!activeGroups()" tabindex="0" (scroll)="top.set(scroller.scrollTop)" (keydown)="onKey($event)">
        <div class="space" [style.height.px]="window().rows * rowHeight">
          <div class="grid" [style.transform]="'translateY(' + window().first * rowHeight + 'px)'" [style.grid-template-columns]="'repeat(' + window().columns + ', ' + columnWidth() + 'px)'">
            @for (card of cards(); track card.entry.path) {
              <button type="button" class="card" [class.selected]="card.entry.path === selected()" [class.picked]="isPicked(card.entry.path)" (click)="onCardClick($event, card.entry)" [title]="card.entry.path">
                <span class="top"><span class="l">@if (manage.enabled()) { <span class="check" role="checkbox" [attr.aria-checked]="isPicked(card.entry.path)" [class.on]="isPicked(card.entry.path)" title="Select (Shift: a range)" (click)="pick($event, card.entry)">{{ isPicked(card.entry.path) ? '✓' : '' }}</span> }NO.{{ pad(card.number) }}</span><span>{{ code(card.entry.folder) }}</span></span>
                <span class="art">
                  @if (companionCount().get(card.entry.path); as n) { <span class="partsbadge" [title]="partsTitle(n)">{{ n }} PARTS</span> }
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
            <div class="dcols">
            <div class="left">
            <div class="fig">
              @if (figShown() !== 'drawing') {
                @if (tooLarge(d)) { <span class="note">TOO LARGE TO PREVIEW · {{ kb(d.size) }}</span> }
                @else { <div class="viewer3d"><app-quick-look [path]="d.path" [together]="togetherPaths()" [labels]="togetherLabels()" [embedded]="true" /></div> }
              } @else {
                @switch (bigState()) {
                  @case ('ready') { <img [src]="bigUrl()!" alt="" draggable="false" /> }
                  @case ('loading') { <span class="note">DRAWING…</span> }
                  @default { <span class="note">{{ tooLarge(d) ? 'TOO LARGE TO DRAW · ' + kb(d.size) : 'NO DRAWING' }}</span> }
                }
              }
              <span class="figmode chips" role="group" aria-label="Picture"><button type="button" [class.on]="figShown() === 'drawing'" (click)="setFigView('drawing')">DRAWING</button><button type="button" [class.on]="figShown() === '3d'" (click)="setFigView('3d')">3D</button>@if (companions().length) { <button type="button" [class.on]="figShown() === 'together'" title="This part and the parts that belong with it (the names differ only in LEFT / RIGHT, TOP / BOTTOM, FRONT / BACK or UPPER / LOWER, or they are numbered parts P1, P2, P3 of one set), at the places their STL files give them" (click)="setFigView('together')">TOGETHER {{ companions().length + 1 }}</button> }</span>
              <span class="cap l">FIG. {{ number() }}</span><span class="cap r">{{ figShown() === 'together' ? companions().length + 1 + ' PARTS AT THEIR OWN PLACES · DRAG TO ORBIT' : figShown() === '3d' ? '3D PREVIEW · DRAG TO ORBIT · SCROLL TO ZOOM' : 'LINE DRAWING · HIDDEN LINES REMOVED' }}</span>
            </div>
            <div class="siblings" [class.as-strip]="siblingView() === 'strip'">
              <div class="shead">
                <span class="crumbs" role="navigation" aria-label="Folders">
                  @for (c of crumbs(); track c.path; let last = $last) {
                    <button type="button" class="crumb" [class.on]="c.path === browse()" [class.ahead]="isAhead(c.path)" [title]="c.path || 'The library'" (click)="goFolder(c.path)">{{ c.name }}</button>@if (!last) { <span class="sepc">›</span> }
                    @if (c.path === browse() && crumbFolders().length) {
                      <span class="subs">
                        @if (last) { <span class="sepc">›</span> }
                        @for (f of crumbFolders().slice(0, 8); track f.path) { <button type="button" class="crumb sub" [title]="f.path + ' · ' + f.count + (f.count === 1 ? ' part' : ' parts')" (click)="goFolder(f.path)">▸ {{ f.name }}</button> }
                        @if (crumbFolders().length > 8) { <span class="sepc" title="The others are in the list below">+{{ crumbFolders().length - 8 }}</span> }
                        @if (!last) { <span class="sepc">|</span> }
                      </span>
                    }
                  }
                </span>
                <span class="right">
                  <span>{{ browseFolders().length ? browseFolders().length + (browseFolders().length === 1 ? ' FOLDER · ' : ' FOLDERS · ') : '' }}{{ browseFiles().length ? browseFiles().length + (browseFiles().length === 1 ? ' FILE' : ' FILES') : 'NO FILES' }}</span>
                  <span class="chips"><button type="button" [class.on]="siblingView() === 'list'" (click)="setSiblingView('list')">LIST</button><button type="button" [class.on]="siblingView() === 'strip'" (click)="setSiblingView('strip')">STRIP</button></span>
                </span>
              </div>
              @if (siblingView() === 'list') {
                <div class="listbox">
                  @for (f of browseFolders(); track f.path) {
                    <button type="button" class="sib dirrow" [title]="f.path" (click)="goFolder(f.path)"><span class="n">▸ {{ f.name }}</span><span class="k">{{ f.count }} {{ f.count === 1 ? 'PART' : 'PARTS' }}</span></button>
                  }
                  @for (s of browseFiles(); track s.path) {
                    <button type="button" class="sib" [class.current]="s.path === detail()" [class.together]="togetherColor().has(s.path)" [style.--tc]="togetherColor().get(s.path)" [title]="s.path" (click)="detail.set(s.path)"><span class="n">{{ fileTitle(s) }}</span><span class="k">{{ s.path === detail() ? 'OPEN · ' : '' }}{{ kb(s.size) }}</span></button>
                  }
                </div>
              } @else if (browseFiles().length || browseFolders().length) {
                <div class="stripbox">
                  @if (stripBack()) { <button type="button" class="arrow l" aria-label="Previous files" (click)="page(-1)">‹</button> }
                  <div #strip class="strip" (scroll)="measureStrip()">
                    @for (f of browseFolders(); track f.path) {
                      <button type="button" class="tile dirtile" [title]="f.path" (click)="goFolder(f.path)">
                        <span class="art"><span class="folder-glyph">▸</span></span>
                        <span class="name">{{ f.name }}</span>
                        <span class="meta">{{ f.count }} {{ f.count === 1 ? 'PART' : 'PARTS' }}</span>
                      </button>
                    }
                    @for (s of browseFiles(); track s.path) {
                      <button type="button" class="tile" [class.current]="s.path === detail()" [class.together]="togetherColor().has(s.path)" [style.--tc]="togetherColor().get(s.path)" [title]="s.path" (click)="detail.set(s.path)">
                        <span class="art">
                          @if (companionCount().get(s.path); as n) { <span class="partsbadge" [title]="partsTitle(n)">{{ n }} PARTS</span> }
                          @switch (thumbs.state(s)) {
                            @case ('drawn') { <img [src]="thumbs.url(s)" alt="" draggable="false" /> }
                            @case ('large') { <span class="note">LARGE FILE · {{ kb(s.size) }}</span> }
                            @case ('toolarge') { <span class="note">TOO LARGE · {{ kb(s.size) }}</span> }
                            @case ('failed') { <span class="note">NO DRAWING</span> }
                            @default { <span class="note pending">PENDING</span> }
                          }
                        </span>
                        <span class="name">{{ fileTitle(s) }}</span>
                        <span class="meta">{{ s.path === detail() ? 'OPEN · ' : '' }}{{ meta(s) }}</span>
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
                <div><dt>DOUBLES</dt><dd class="check-row">
                  @if (partChecking() === d.path) { <span class="busy">CHECKING…</span> }
                  @else { <button type="button" class="tool" title="Looks for files that are exactly the same as this part, and for files with its shape (a re-export, or the same part at another place). Only files of the same size are read." (click)="checkPart(d)">{{ partChecks()[d.path] ? 'CHECK AGAIN' : 'CHECK THIS PART' }}</button> }
                  @if (partChecks()[d.path]; as r) { <span class="result">{{ r.identical.length + r.sameShape.length ? (r.identical.length ? r.identical.length + ' IDENTICAL' : '') + (r.identical.length && r.sameShape.length ? ' · ' : '') + (r.sameShape.length ? r.sameShape.length + ' SAME SHAPE' : '') : 'NONE FOUND' }}</span> }
                  @if (partError() && partChecking() !== d.path) { <span class="warn">{{ partError() }}</span> }
                </dd></div>
                @for (row of sameRows(); track row.label) {
                  <div><dt>{{ row.label }}</dt><dd class="same">@for (other of row.paths.slice(0, 6); track other) { <button type="button" class="link" [title]="other" (click)="openIdentical(other)">{{ other }}</button> } @if (row.paths.length > 6) { <span>+ {{ row.paths.length - 6 }} more</span> }</dd></div>
                }
                @if (companions().length) {
                  <div><dt>TOGETHER</dt><dd class="same">
                    <span class="check-row"><button type="button" class="tool" title="Show this part with the parts that belong with it, at the places their STL files give them" (click)="setFigView('together')">VIEW TOGETHER</button><span class="result">{{ companions().length + 1 }} PARTS</span></span>
                    @for (c of companions(); track c.path) { <button type="button" class="link" [title]="c.path" (click)="openIdentical(c.path)">{{ fileTitle(c) }}</button> }
                  </dd></div>
                }
                @for (finder of finders; track finder.id) {
                  <div><dt>{{ finder.id.toUpperCase() }}</dt><dd class="check-row">
                    @if (finderBusy() === finderKey(finder.id, d.path)) { <span class="busy">{{ finderProgress() || 'SEARCHING…' }}</span> }
                    @else { <button type="button" class="tool" (click)="runFinder(finder.id, d)">{{ finderResults()[finderKey(finder.id, d.path)] ? 'SEARCH AGAIN' : finder.label }}</button> }
                    @if (finderResults()[finderKey(finder.id, d.path)]; as r) { <span class="result">{{ r.found ? r.hits.length + (r.more ? '+' : '') + ' FOUND' : 'NOT FOUND' }}</span> }
                    @if (finderError()[finderKey(finder.id, d.path)]; as e) { <span class="warn">{{ e }}</span> }
                  </dd></div>
                }
                <div><dt>PATH</dt><dd class="path">{{ d.path }}</dd></div>
              </dl>
              @for (finder of finders; track finder.id) {
                @if (finderResults()[finderKey(finder.id, d.path)]; as r) {
                  <div class="finds">
                    <div class="fhead"><span>{{ finder.id.toUpperCase() }}</span><span>{{ r.summary }}</span></div>
                    @for (hit of r.hits; track hit.path ?? hit.title) {
                      <div class="hit" [class.exact]="hit.exact">
                        <div class="hline"><b>{{ hit.title }}</b>@if (hit.badge; as badge) { <small class="badge" [class]="'badge tone-' + badge.tone" [title]="badge.title">{{ badge.label }}</small> }@if (hit.exact) { <small class="tag">EXACT NAME</small> }@if (finder.reveal && hit.path) { <button type="button" class="link" title="Show the file in the Finder" (click)="revealHit(finder.id, hit.path)">REVEAL</button> }</div>
                        <div class="hsub" [title]="hit.subtitle">{{ hit.subtitle }}</div>
                        @for (m of hit.matches; track m.name) {
                          <div class="hmatch"><span [class.exactname]="m.exact">{{ m.name }}</span>@if (m.places.length) { <small>in {{ m.places.join(' · ') }}</small> }</div>
                        }
                        @if (hit.moreMatches) { <div class="hsub">+ {{ hit.moreMatches }} more names</div> }
                        @if (hit.note) { <div class="hsub">{{ hit.note }}</div> }
                      </div>
                    } @empty { <div class="hsub">Nothing found.</div> }
                    @if (r.more) { <div class="hsub">+ {{ r.more }} more designs</div> }
                    @if (r.hint) { <div class="hint-line"><span class="warn">{{ r.hint }}</span>@if (r.refresh) { <button type="button" class="tool" [disabled]="finderBusy() !== null" (click)="refreshFinder(finder.id, d)">{{ r.refreshLabel }}</button> }</div> }
                  </div>
                }
              }
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
                    @if (figShown() === 'together') {
                      <button type="button" class="danger" title="Move this part and the parts it is shown together with to the Trash" (click)="trashTogether(d)">MOVE ALL {{ companions().length + 1 }} TOGETHER TO TRASH</button>
                      <button type="button" class="danger" (click)="requestTrash([d.path])">ONLY THIS ONE TO TRASH</button>
                    } @else {
                      <button type="button" class="danger" (click)="requestTrash([d.path])">MOVE TO TRASH</button>
                    }
                    @for (row of sameRows(); track row.label) { <button type="button" class="danger" (click)="requestTrash(row.paths, 'This file stays; the files ' + row.what + ' go.')" [title]="'Keep this file and move the files ' + row.what + ' to the Trash'">KEEP THIS, TRASH THE {{ row.paths.length === 1 ? 'OTHER' : row.paths.length + ' OTHERS' }}{{ row.label === 'SAME SHAPE' ? ' (SAME SHAPE)' : '' }}</button> }
                  </div>
                  @if (folderPathOf(d)) {
                    <div class="mlabel thisfolder"><span>THIS FOLDER</span><span [title]="folderPathOf(d)">{{ folderPathOf(d) }}</span></div>
                    <div class="actions">
                      <button type="button" class="mg" (click)="openRenameFolder(folderPathOf(d))">RENAME FOLDER…</button>
                      <button type="button" class="mg" (click)="openMover([folderPathOf(d)])">MOVE FOLDER…</button>
                      <button type="button" class="danger" (click)="requestTrash([folderPathOf(d)])">TRASH FOLDER…</button>
                    </div>
                  }
                </div>
              }
              @if (actionNote()) { <p class="empty">{{ actionNote() }}</p> }
            </div>
            </div>
          </div>
          <div class="dnav">
            <button type="button" [disabled]="!previous()" (click)="step(-1)">{{ previous() ? '← ' + numberOf(previous()!) + ' ' + short(previous()!.name) : '' }}</button>
            <button type="button" [disabled]="!following()" (click)="step(1)">{{ following() ? numberOf(following()!) + ' ' + short(following()!.name) + ' →' : '' }}</button>
          </div>
        </section>
      }
      @if (renaming(); as r) {
        <div class="shade"></div>
        <div class="confirm" role="dialog" aria-label="Rename">
          <h4>RENAME {{ r.folder ? 'FOLDER' : 'PART' }}</h4>
          <p class="n">{{ r.path }}</p>
          <input class="field" type="text" spellcheck="false" autocomplete="off" [value]="r.name" (input)="renameText($any($event.target).value)" (keydown.enter)="renameNow()" />
          <p class="hint">{{ r.folder ? 'Documents that use parts in the folder follow the new name.' : 'The .stl is added when it is left out. Documents that use the file follow the new name.' }}</p>
          @if (r.error) { <p class="warn">{{ r.error }}</p> }
          <div class="actions"><button type="button" class="add" [disabled]="busy()" (click)="renameNow()">RENAME</button><button type="button" class="ghost" (click)="renaming.set(null)">CANCEL [ESC]</button></div>
        </div>
      }
      @if (mover(); as m) {
        <div class="shade"></div>
        <div class="confirm mover" role="dialog" aria-label="Move">
          <h4>MOVE {{ m.paths.length === 1 ? (isFolder(m.paths[0]) ? '1 FOLDER' : '1 PART') : m.paths.length + ' ITEMS' }} TO …</h4>
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
          <h4>MOVE {{ c.paths.length === 1 ? (isFolder(c.paths[0]) ? '1 FOLDER' : '1 PART') : c.paths.length + ' ITEMS' }} TO THE TRASH?</h4>
          @if (c.paths.length === 1) { <p class="n">{{ c.paths[0] }}</p> }
          @if (c.paths.length > 1 && c.paths.length <= 8) { @for (path of c.paths; track path) { <p class="n list">{{ path }}</p> } }
          @if (c.paths.length === 1 && isFolder(c.paths[0])) { <p>The folder and the {{ partsUnder(c.paths[0]) }} part{{ partsUnder(c.paths[0]) === 1 ? '' : 's' }} in it.</p> }
          @if (c.note) { <p>{{ c.note }}</p> }
          @if (c.documents.length) {
            <p class="warn">{{ c.parts }} part{{ c.parts === 1 ? '' : 's' }} in {{ c.documents.length }} document{{ c.documents.length === 1 ? '' : 's' }} use{{ c.parts === 1 ? 's' : '' }} {{ c.paths.length === 1 ? 'it' : 'these' }} ({{ c.documents.join(', ') }}): they will show a ⚠ until you Put Back.</p>
          } @else {
            <p>No document uses {{ c.paths.length === 1 ? 'it' : 'them' }}. Put Back in the Trash undoes this.</p>
          }
          <div class="actions"><button type="button" class="danger" [disabled]="busy()" (click)="trashNow(c.paths)">MOVE TO TRASH [ENTER]</button><button type="button" class="ghost" (click)="confirm.set(null)">CANCEL [ESC]</button></div>
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
    .label { flex: none; width: 64px; color: #888; }
    .chips { display: flex; flex-wrap: wrap; gap: 2px 6px; min-width: 0; } .folders { max-height: 66px; overflow: auto; }
    .chips button { color: #aaa; } .chips button:hover { color: #fff; } .chips button.on { background: #e6e6e6; color: #111; }
    sup { margin-left: 3px; font-size: 8px; opacity: .6; }
    input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; color: #e6e6e6; font: inherit; } input::placeholder { color: #666; }
    .status { display: flex; justify-content: space-between; padding: 8px 0; color: #888; } .status b { color: #e6e6e6; font-weight: 400; }
    .empty { color: #777; padding: 8px 0; margin: 0; }
    .list { display: flex; flex-direction: column; flex: 1; min-height: 0; } .list[hidden] { display: none; }
    .detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .dhead { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #2c2d31; color: #888; }
    .dbody { flex: 1; min-height: 0; padding: 16px 0; overflow: auto; container-type: size; }
    .dcols { display: flex; min-height: 100cqh; } /* as tall as the longest column, so the resize bar runs along all of a long facts column */
    .left { flex: 1 1 60%; min-width: 0; display: flex; flex-direction: column; gap: 12px; max-height: 100cqh; } /* the drawing column is never taller than the window, however long the facts are */
    .siblings { flex: none; height: 260px; display: flex; flex-direction: column; border: 1px solid #2c2d31; overflow: hidden; } /* the same height as a list and as a strip: nothing jumps when you switch */
    .listbox { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .shead > span:first-child { min-width: 0; } .crumbs { flex: 1; display: flex; align-items: center; gap: 0; overflow-x: auto; scrollbar-width: none; white-space: nowrap; } .crumbs::-webkit-scrollbar { display: none; }
    .subs { display: inline-flex; align-items: center; } .crumb.sub { color: #9db7f0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; } .crumb.sub:hover { color: #fff; }
    .crumb { padding: 0 5px; color: #aaa; } .crumb:hover { color: #fff; } .crumb.on { background: #e6e6e6; color: #111; } .crumb.ahead { color: #666; } .crumb.ahead:hover { color: #fff; } .sepc { color: #555; }
    .tile.together { box-shadow: inset 0 4px 0 var(--tc), inset -1px 0 #2c2d31; } .tile.together:not(.current) { outline: 2px solid var(--tc); outline-offset: -2px; background: color-mix(in srgb, var(--tc) 10%, transparent); }
    .sib.together { box-shadow: inset 4px 0 0 var(--tc); background: color-mix(in srgb, var(--tc) 10%, transparent); } .sib.together.current { background: #26324a; }
    .sib.dirrow .n { color: #9db7f0; } .sib.current { background: #26324a; color: #fff; } .tile.current { background: #26324a; outline: 2px solid #2f6fed; outline-offset: -2px; } .tile.current .name { color: #fff; } .tile.current .meta { color: #9db7f0; } .tile.dirtile .art { color: #9db7f0; } .folder-glyph { font-size: 40px; }
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
    .viewer3d { position: absolute; inset: 0; } .figmode { position: absolute; top: 6px; left: 6px; z-index: 2; } .figmode button { color: #888; } .figmode button.on { background: #e6e6e6; color: #111; } .fig .cap { z-index: 2; pointer-events: none; }
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
    .finds { margin-top: 12px; border: 1px solid #2c2d31; } .fhead { display: flex; justify-content: space-between; gap: 12px; padding: 5px 10px; background: #1a1b1f; color: #888; } .fhead span:last-child { color: #e8c470; text-align: right; }
    .hit { padding: 6px 10px; border-top: 1px solid #2c2d31; } .hit.exact { background: rgba(154,210,154,.05); } .hline { display: flex; align-items: baseline; gap: 10px; } .hline b { font-weight: 400; color: #e6e6e6; word-break: break-all; } .tag { color: #9ad29a; font-size: 9px; letter-spacing: .08em; }
    .badge { padding: 0 6px; border: 1px solid; border-radius: 3px; font-size: 9px; letter-spacing: .08em; cursor: help; } .tone-blue { color: #9db7f0; border-color: #3a4a6a; background: rgba(61,90,160,.18); } .tone-green { color: #8fd0a0; border-color: #2f6a47; background: rgba(60,150,90,.16); } .tone-amber { color: #e8c470; border-color: #6b5a2a; } .tone-grey { color: #aaa; border-color: #444; }
    .hsub { color: #777; font-size: 10px; word-break: break-all; } .hmatch { padding-left: 10px; color: #bbb; } .hmatch small { color: #777; margin-left: 8px; } .exactname { color: #9ad29a; }
    .hint-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid #2c2d31; }
    .check-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } .check-row .result { color: #e8c470; }
    .warn { color: #e8c470; } .busy { color: #9db7f0; } .bar-sep { color: #444; }
    .tool { border: 1px solid #3a4a6a; padding: 0 8px; color: #9db7f0; } .tool:hover { background: #26324a; color: #fff; }
    .folderbar .fname { color: #e6e6e6; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thisfolder { margin-top: 10px; } .thisfolder span:last-child { max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .groupsview { flex: 1; min-height: 0; overflow: auto; border: 1px solid #2c2d31; } .groupsview[hidden] { display: none; }
    .group { border-bottom: 1px solid #2c2d31; } .ghead { display: flex; justify-content: space-between; padding: 6px 12px; background: #1a1b1f; color: #888; }
    .copy { display: flex; align-items: center; gap: 12px; padding: 4px 12px; } .copy:hover { background: #1e2024; }
    .where { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; padding: 2px 0; } .where .dir { color: #777; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .where .file { color: #e6e6e6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .when { flex: none; color: #777; } .cacts { flex: none; display: flex; gap: 6px; }
    .link { padding: 0; color: #9db7f0; text-align: left; word-break: break-all; font-size: 10px; } .link:hover { color: #fff; text-decoration: underline; } .same { display: flex; flex-direction: column; gap: 2px; }
    .confirm .field { width: 100%; box-sizing: border-box; margin: 6px 0; padding: 6px 8px; background: #111; border: 1px solid #3a3b40; color: #e6e6e6; } .confirm .field:focus { border-color: #2f6fed; }
    .confirm .hint { font-size: 10px; color: #777; } .folders-list { max-height: 240px; overflow: auto; margin-top: 6px; border: 1px solid #2c2d31; }
    .pick { display: block; width: 100%; box-sizing: border-box; padding: 4px 10px; text-align: left; color: #ccc; word-break: break-all; } .pick:hover:not(:disabled) { background: #26324a; color: #fff; } .pick:disabled { opacity: .35; cursor: default; } .pick.create { color: #9ad29a; }
    .confirm .n.list { margin: 2px 0; font-size: 11px; }
    .confirm .actions { display: flex; gap: 8px; margin-top: 14px; }
    .scroller { flex: 1; min-height: 0; overflow: auto; border: 1px solid #2c2d31; outline: 0; }
    .space { position: relative; } .grid { position: absolute; left: 0; right: 0; top: 0; display: grid; }
    .card { height: ${rowHeight}px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 8px 11px 8px 10px; border: 0; border-right: 1px solid #2c2d31; border-bottom: 1px solid #2c2d31; background: transparent; overflow: hidden; }
    .card:hover { background: #1e2024; } .card.selected { background: #26324a; outline: 1px solid #2f6fed; outline-offset: -1px; }
    .top { flex: none; height: 16px; display: flex; justify-content: space-between; color: #777; }
    .art { flex: none; height: 156px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; overflow: hidden; }
    .art { position: relative; } .partsbadge { position: absolute; top: 4px; right: 4px; z-index: 1; padding: 1px 6px; border: 1px solid #3a4a6a; border-radius: 3px; background: rgba(22,23,26,.88); color: #9db7f0; font-size: 9px; letter-spacing: .08em; line-height: 14px; cursor: help; }
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
  protected readonly confirm = signal<{ paths: string[]; documents: string[]; parts: number; note: string } | null>(null);
  protected readonly busy = signal(false);
  /** Ways to look for the part somewhere else (the host app provides them: FIND IN FUSION). */
  protected readonly finders = inject(RF_PART_FINDERS);
  protected readonly finderResults = signal<Record<string, RfFinderResult>>({});
  protected readonly finderError = signal<Record<string, string>>({});
  protected readonly finderBusy = signal<string | null>(null);
  protected readonly finderProgress = signal('');
  /** What "Check this part" found for the parts checked on their page (by path): identical files and files with the same shape. */
  protected readonly partChecks = signal<Record<string, { identical: string[]; sameShape: string[] }>>({});
  protected readonly partChecking = signal<string | null>(null);
  protected readonly partError = signal('');
  /** Clean-up filters (they combine): old-looking names, identical files, parts no document uses. */
  protected readonly cleanFilters = signal<ReadonlySet<'old' | 'unused'>>(new Set());
  /** The result of the doubles check is shown (a list of groups) instead of the cards. */
  protected readonly viewDoubles = signal<CheckMode | null>(null);
  /** The two checks: files that are exactly the same, and files with the same shape (a re-export, or the same part at another place). Each has its groups (null until it has run), its progress and whether it is out of date. */
  protected readonly checkModes: { key: CheckMode; check: string; again: string; chip: string; busy: string; title: string; what: string; files: string }[] = [
    { key: 'exact', check: 'CHECK FOR DOUBLES', again: 'CHECK DOUBLES AGAIN', chip: 'DOUBLES', busy: 'CHECKING FOR DOUBLES', what: 'IDENTICAL FILES', files: 'IDENTICAL FILES',
      title: 'Looks for files that are exactly the same (same size first, then the content). Nothing is changed; you decide what to do with the result.' },
    { key: 'shape', check: 'CHECK FOR SAME SHAPE', again: 'CHECK SAME SHAPE AGAIN', chip: 'SAME SHAPE', busy: 'CHECKING THE SHAPES', what: 'FILES WITH THE SAME SHAPE', files: 'FILES WITH THE SAME SHAPE',
      title: 'Looks for files with the same shape: a part exported again, triangulated differently, or at another place of an assembly (any file size, position, header or triangle order; the box, volume, surface and centre of mass agree). Nothing is changed.' },
  ];
  protected readonly groupsBy = signal<Record<CheckMode, DuplicateGroup[] | null>>({ exact: null, shape: null });
  protected readonly scanBy = signal<Record<CheckMode, ScanState>>({ exact: { ...idleScan }, shape: { ...idleScan } });
  protected readonly staleBy = signal<Record<CheckMode, boolean>>({ exact: false, shape: false });
  /** The groups the list shows (null: the cards are shown), and which check they are from. */
  protected readonly activeGroups = computed(() => { const mode = this.viewDoubles(); return mode ? this.groupsBy()[mode] : null; });
  protected readonly activeMode = computed(() => this.checkModes.find(m => m.key === (this.viewDoubles() ?? 'exact'))!);
  protected readonly used = signal<ReadonlySet<string> | null>(null);
  private destroyed = false;
  /** The width of the facts column of a part's page (px), dragged with the bar between it and the drawing; remembered. */
  protected readonly specWidth = signal(readSpecWidth());
  protected readonly resizing = signal(false);
  protected readonly defaultWidth = defaultSpecWidth;
  private gripStart: { x: number; width: number } | null = null;
  protected readonly renaming = signal<{ path: string; name: string; error: string; folder: boolean } | null>(null);
  protected readonly mover = signal<{ paths: string[]; text: string; error: string } | null>(null);
  /** The folders a move can go to: those matching what was typed, and whether the parts are all there already. */
  protected readonly moverFolders = computed(() => {
    const m = this.mover();
    if (!m) return [];
    const needle = m.text.trim().toLowerCase();
    const here = new Set(m.paths.map(parentFolder));
    const inside = (path: string) => m.paths.some(moved => path === moved || path.startsWith(moved + '/')); // a folder cannot go into itself
    return ['', ...folderPaths(this.entries())].filter(path => !inside(path) && (!needle || path.toLowerCase().includes(needle))).map(path => ({ path, here: here.size === 1 && here.has(path) }));
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
    const fromFile = Math.max(0, first - this.browseFolders().length); // the folder tiles come first and have no drawing
    return this.browseFiles().slice(fromFile, fromFile + 2 * perPage + 1);
  });
  /** The part named in the address when the dialog opened (a reload or a link); the address is left alone until the catalog has loaded and it was looked up. */
  private pendingPart: string | null = location.hash.startsWith('#part=') ? decodeURIComponent(location.hash.slice(6)) : null;
  private readonly size = signal({ width: 800, height: 500 });

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly find = viewChild.required<ElementRef<HTMLInputElement>>('find');

  protected readonly folders = computed(() => folderCounts(this.entries()));
  protected readonly oldCount = computed(() => this.entries().filter(entry => isOldPath(entry.path)).length);
  protected readonly unusedCount = computed(() => { const used = this.used(); return used ? this.entries().filter(entry => !used.has(entry.path)).length : 0; });
  /** Does the part pass what is typed in Find, the folder and the clean-up filters? */
  private passes(entry: CatalogEntry): boolean {
    if (!filterCatalog([entry], this.query(), this.folder()).length) return false;
    const filters = this.cleanFilters();
    if (filters.has('old') && !isOldPath(entry.path)) return false;
    const used = this.used();
    return !(filters.has('unused') && used && used.has(entry.path));
  }
  protected readonly shown = computed(() => {
    let list = filterCatalog(this.entries(), this.query(), this.folder());
    const filters = this.cleanFilters();
    if (filters.has('old')) list = list.filter(entry => isOldPath(entry.path));
    if (filters.has('unused') && this.used()) { const used = this.used()!; list = list.filter(entry => !used.has(entry.path)); }
    return sortCatalog(list, this.sortKey(), this.ascending());
  });
  /** The groups of identical files as lists of entries (by path). */
  private readonly groupsOfCopies = computed(() => { const groups = this.activeGroups(); return groups ? groupCopies(this.entries(), groups) : []; });
  /** The groups to show: those with at least one copy that passes the filters (all their copies are listed). */
  protected readonly doubleGroups = computed(() => this.groupsOfCopies().filter(copies => copies.some(copy => this.passes(copy))));
  /** What is the same as the part on the open page, from the checks that have run: identical files, and files with the same shape (the identical ones left out of those). */
  protected readonly sameRows = computed(() => {
    const path = this.detail();
    if (!path) return [];
    const fromChecks = (mode: CheckMode) => {
      const groups = this.groupsBy()[mode];
      const group = groups ? groupCopies(this.entries(), groups).find(copies => copies.some(copy => copy.path === path)) : null;
      return group ? group.filter(copy => copy.path !== path).map(copy => copy.path) : [];
    };
    const mine = this.partChecks()[path];
    const exists = (other: string) => this.entries().some(entry => entry.path === other);
    const exact = [...new Set([...fromChecks('exact'), ...(mine?.identical ?? []).filter(exists)])].sort();
    const shape = [...new Set([...fromChecks('shape'), ...(mine?.sameShape ?? []).filter(exists)])].filter(other => !exact.includes(other)).sort();
    return [...(exact.length ? [{ label: 'IDENTICAL', what: 'identical to it', paths: exact }] : []), ...(shape.length ? [{ label: 'SAME SHAPE', what: 'with the same shape', paths: shape }] : [])];
  });
  /** The open part; the same object for the same file, so a reload of the list does not draw its big picture again. */
  protected readonly detailEntry = computed(() => this.entries().find(e => e.path === this.detail()) ?? null,
    { equal: (a, b) => a?.path === b?.path && a?.modified === b?.modified && a?.size === b?.size });
  private keepNote = false; // a note about an action stays when the action itself moved the page to another path
  protected readonly detailIndex = computed(() => this.shown().findIndex(e => e.path === this.detail()));
  /** The folder shown in the folder panel of a part's page, and the trail of crumbs: the whole path of the part's folder when the page opened, kept while you go up it, extended or replaced when you go below it or into another folder. */
  protected readonly browse = signal('');
  protected readonly trail = signal('');
  protected readonly crumbs = computed(() => crumbsOf(this.trail()));
  private readonly pageOpen = computed(() => !!this.detail()); // the lists below must not be made again for every other part that is opened: the strip would jump
  /** The folders in the folder shown, for the breadcrumb (the one the trail goes on into is already a crumb). */
  protected readonly crumbFolders = computed(() => {
    const crumbs = this.crumbs(), at = crumbs.findIndex(c => c.path === this.browse());
    const next = at >= 0 ? crumbs[at + 1]?.path : undefined;
    return this.browseFolders().filter(folder => folder.path !== next);
  });
  /** How many parts the set of each part that belongs together with others has (for the badge on its thumbnail). */
  protected readonly companionCount = computed(() => companionCounts(this.entries()));
  protected partsTitle(n: number) { return `One of ${n} parts that belong together (their names differ only in LEFT / RIGHT, TOP / BOTTOM, FRONT / BACK or UPPER / LOWER, or they are numbered parts P1, P2, P3 of one set). Open it and choose TOGETHER to see them in one scene.`; }
  protected readonly browseFolders = computed(() => (this.pageOpen() ? childFolders(this.entries(), this.browse()) : []));
  protected readonly browseFiles = computed(() => (this.pageOpen() ? filesIn(this.entries(), this.browse()) : []));
  /** The files of the open part's own folder in the order the folder panel shows them (by name): what the arrow keys, ← and → and the buttons at the bottom walk through. */
  private readonly ownFolderFiles = computed(() => { const path = this.detail(); return path ? filesIn(this.entries(), parentFolder(path)) : []; });
  private readonly ownIndex = computed(() => this.ownFolderFiles().findIndex(file => file.path === this.detail()));
  protected readonly previous = computed(() => (this.ownIndex() > 0 ? this.ownFolderFiles()[this.ownIndex() - 1] : null));
  protected readonly following = computed(() => (this.ownIndex() < 0 ? null : this.ownFolderFiles()[this.ownIndex() + 1] ?? null));
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
    effect(onCleanup => { // measure the strip when it appears, changes its files or its width
      this.browseFiles(); this.browseFolders(); this.siblingView();
      const element = this.stripRef()?.nativeElement;
      if (!element) return;
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
    effect(() => { // the open part stays in view in the strip or the list of its folder (and a new folder starts at its beginning)
      const open = this.detail(), folder = this.browse(), view = this.siblingView();
      this.stripRef(); this.browseFiles(); this.browseFolders();
      if (open) untracked(() => setTimeout(() => this.revealCurrent(folder, view)));
    });
    effect(() => { // a page opens on its own folder, with the whole path as the trail
      const path = this.detail();
      untracked(() => { const folder = path ? parentFolder(path) : ''; this.browse.set(folder); this.trail.set(folder); });
    });
    effect(() => { this.detail(); untracked(() => { if (this.keepNote) this.keepNote = false; else this.actionNote.set(''); }); }); // a note is about the page it was made on
    effect(onCleanup => { // the page of a part: its big drawing and where it is used
      const entry = this.detailEntry();
      this.usedIn.set(null);
      if (!entry) { this.setBig(null); return; }
      let current = true;
      onCleanup(() => { current = false; });
      void firstValueFrom(this.lib.trashBatch([entry.path], true)).then( // a dry run only reports which documents use the file
        result => { if (current) this.usedIn.set(Object.keys(result.documents ?? {}).length); },
        () => { /* unknown: stays … */ });
      this.bigState.set('loading');
      if (this.figView() !== 'drawing') return; // the drawing is made when the picture is switched back to it (the 3D view loads the file itself)
      void this.thumbs.drawLarge(entry).then(svg => {
        if (!current) return;
        this.setBig(svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : null);
        this.bigState.set(svg ? 'ready' : 'none');
      });
    });
    effect(() => { // the address of the open part, so a reload (or a copied link) comes back to it
      const path = this.detail();
      if (!path && this.pendingPart) return;
      try { history.replaceState(null, '', path ? `#part=${encodeURIComponent(path)}` : location.pathname + location.search); } catch { /* not allowed here */ }
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.setBig(null);
      try { if (location.hash.startsWith('#part=')) history.replaceState(null, '', location.pathname + location.search); } catch { /* not allowed here */ }
    });
    const slash = (event: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (event.key === '/' && !typing && !this.detail()) { event.preventDefault(); this.find().nativeElement.focus(); }
      else if (this.detail() && !typing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); this.step(event.key === 'ArrowLeft' ? -1 : 1); }
    };
    const confirmEnter = (event: KeyboardEvent) => { // Enter says yes to the question before a Move to Trash
      const c = this.confirm();
      if (event.key !== 'Enter' || !c || this.busy() || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.trashNow(c.paths);
    };
    document.addEventListener('keydown', confirmEnter, true);
    document.addEventListener('keydown', slash);
    inject(DestroyRef).onDestroy(() => { document.removeEventListener('keydown', slash); document.removeEventListener('keydown', confirmEnter, true); });
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
  /** TOGETHER is shown: the part and the parts shown with it go to the Trash as one batch (one Put Back brings them all back). */
  protected trashTogether(entry: CatalogEntry) {
    const paths = [entry.path, ...this.companions().map(c => c.path)];
    void this.requestTrash(paths, 'These parts belong together (their names differ only in LEFT / RIGHT, TOP / BOTTOM, FRONT / BACK or UPPER / LOWER, or they are numbered parts P1, P2, P3 of one set).');
  }

  protected async requestTrash(paths: string[], note = '') {
    if (!this.manage.enabled() || !paths.length) return;
    this.actionNote.set('');
    try {
      const dry = await firstValueFrom(this.lib.trashBatch(paths, true));
      const used = documentsOf(dry.documents ?? {});
      this.confirm.set({ paths, documents: used.ids, parts: used.parts, note });
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
      const openGone = !!open && gone.some(path => open === path || open.startsWith(path + '/'));
      // after the open part is trashed: the next thumbnail or row of the folder panel, else the one before it, else the next part of the whole list
      const inFolder = this.ownFolderFiles().map(file => file.path);
      const at = inFolder.indexOf(open ?? '');
      const folderNext = at < 0 ? undefined : [...inFolder.slice(at + 1), ...inFolder.slice(0, at).reverse()].find(path => !gone.some(g => path === g || path.startsWith(g + '/')));
      const next = openGone ? (gone.some(path => open!.startsWith(path + '/')) ? null : folderNext ?? (this.following() ?? this.previous())?.path ?? null) : open;
      const before = this.entries().length;
      this.entries.update(list => withoutPaths(list, gone));
      const parts = before - this.entries().length;
      if (this.folder() !== null && gone.includes(this.folder()!)) this.folder.set(null);
      this.picked.update(set => new Set([...set].filter(path => !gone.some(g => path === g || path.startsWith(g + '/')))));
      this.groupsBy.update(by => ({ exact: this.withoutGone(by.exact, gone), shape: this.withoutGone(by.shape, gone) }));
      this.mapPartChecks(path => (gone.some(g => path === g || path.startsWith(g + '/')) ? null : path));
      if (open && openGone) { if (next) this.detail.set(next); else this.closeDetail(); }
      const ids = result.results.map(r => r.id).filter((id): id is string => !!id);
      const failed = result.failed.length;
      this.undoable.set(ids.length ? { ids, label: `Moved ${ids.length === 1 && !paths.some(p => this.isFolder(p)) ? '1 part' : paths.some(p => this.isFolder(p)) ? `${ids.length === 1 ? '1 item' : ids.length + ' items'} (${parts} part${parts === 1 ? '' : 's'})` : ids.length + ' parts'} to the Trash${failed ? `; ${failed} could not be moved` : ''}.` } : null);
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

  protected toggleClean(key: 'old' | 'unused') {
    const next = new Set(this.cleanFilters());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.cleanFilters.set(next);
    if (next.has(key) && key === 'unused' && !this.used()) void this.loadUsed();
  }

  /** A "Check for ..." button: starts that check (again) and shows its result when it is done. Nothing is changed by it. */
  protected async check(mode: CheckMode) {
    if (this.scanBy()[mode].state === 'running') return;
    this.staleBy.update(by => ({ ...by, [mode]: false }));
    await this.startScan(mode);
    if (this.groupsBy()[mode]) this.viewDoubles.set(mode);
  }

  /** "Check this part": looks for files identical to this part, and for files with its shape, among the files of its size (quick: no scan of the library). */
  protected finderKey(id: string, path: string) { return `${id}|${path}`; }

  /** A finder's button: looks for the part (what is read is remembered by the host) and shows where it was found. */
  protected async runFinder(id: string, entry: CatalogEntry, again?: (progress: (text: string) => void) => Promise<RfFinderResult>) {
    const finder = this.finders.find(f => f.id === id);
    const key = this.finderKey(id, entry.path);
    if (!finder || this.finderBusy()) return;
    this.finderBusy.set(key);
    this.finderProgress.set('');
    this.finderError.update(all => ({ ...all, [key]: '' }));
    try {
      const result = await (again ? again(text => this.finderProgress.set(text)) : finder.find(entry.path, text => this.finderProgress.set(text)));
      this.finderResults.update(all => ({ ...all, [key]: result }));
    } catch (error) {
      this.finderError.update(all => ({ ...all, [key]: (error as { error?: { detail?: string }; message?: string }).error?.detail ?? (error as Error).message ?? 'The search failed.' }));
    } finally {
      this.finderBusy.set(null);
    }
  }

  protected refreshFinder(id: string, entry: CatalogEntry) {
    const refresh = this.finderResults()[this.finderKey(id, entry.path)]?.refresh;
    if (refresh) void this.runFinder(id, entry, refresh);
  }

  protected revealHit(id: string, path: string) {
    void this.finders.find(f => f.id === id)?.reveal?.(path).catch(() => this.actionNote.set('Could not show it in the Finder.'));
  }

  protected async checkPart(entry: CatalogEntry) {
    if (this.partChecking()) return;
    this.partChecking.set(entry.path);
    this.partError.set('');
    try {
      const found = await firstValueFrom(this.lib.matches(entry.path));
      this.partChecks.update(all => ({ ...all, [entry.path]: { identical: found.identical, sameShape: found.sameShape } }));
    } catch (error) {
      this.partError.set(this.reason(error, 'Could not check it.'));
    } finally {
      this.partChecking.set(null);
    }
  }

  /** The results of "Check this part" after paths changed: `change` gives a path's new path, or null when it is gone. */
  private mapPartChecks(change: (path: string) => string | null) {
    this.partChecks.update(all => {
      const next: Record<string, { identical: string[]; sameShape: string[] }> = {};
      for (const [path, result] of Object.entries(all)) {
        const key = change(path);
        if (key !== null) next[key] = { identical: result.identical.map(change).filter((p): p is string => p !== null), sameShape: result.sameShape.map(change).filter((p): p is string => p !== null) };
      }
      return next;
    });
  }

  private setScan(mode: CheckMode, state: ScanState) { this.scanBy.update(by => ({ ...by, [mode]: state })); }

  /** Starts a check on the API (it runs in the background there) and waits for the answer. */
  private async startScan(mode: CheckMode) {
    this.setScan(mode, { state: 'running', scanned: 0, total: 0, error: '' });
    try {
      await firstValueFrom(this.lib.startDuplicateScan(mode));
      for (;;) {
        const answer = await firstValueFrom(this.lib.duplicates(mode));
        if (this.destroyed) return;
        this.setScan(mode, { state: answer.state, scanned: answer.scanned, total: answer.total, error: answer.error });
        if (answer.state === 'done') { this.groupsBy.update(by => ({ ...by, [mode]: answer.groups })); return; }
        if (answer.state !== 'running') return;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
    } catch {
      this.setScan(mode, { state: 'error', scanned: 0, total: 0, error: 'is the API running?' });
    }
  }

  private withoutGone(groups: DuplicateGroup[] | null, gone: string[]): DuplicateGroup[] | null {
    return groups && groups.map(group => ({ ...group, paths: group.paths.filter(path => !gone.some(g => path === g || path.startsWith(g + '/'))) })).filter(group => group.paths.length > 1);
  }

  private async loadUsed() {
    try { this.used.set(new Set((await firstValueFrom(this.lib.usedPaths())).paths)); } catch { /* the filter stays empty */ }
  }

  /** After a rename or move: the groups, the folder filter and the page follow the new paths, so the result of the check stays right without a new check. */
  private follow(moves: { from: string; to: string; kind?: string }[]) {
    const remap = (groups: DuplicateGroup[] | null) => groups && groups.map(group => ({ ...group, paths: group.paths.map(path => remapPath(path, moves)) }));
    this.groupsBy.update(by => ({ exact: remap(by.exact), shape: remap(by.shape) }));
    this.mapPartChecks(path => remapPath(path, moves));
    this.finderResults.set({}); // the names of the parts changed
    const folder = this.folder();
    if (folder) { const to = remapPath(folder, moves); if (to !== folder) this.folder.set(to.includes('/') ? null : to); }
    if (this.used()) void this.loadUsed(); // documents follow renamed files
  }

  protected openIdentical(path: string) { this.detail.set(path); this.selected.set(path); }

  protected openRename(entry: CatalogEntry) {
    this.renaming.set({ path: entry.path, name: displayName(entry.name), error: '', folder: false });
    this.focusField();
  }

  protected openRenameFolder(path: string) {
    if (!this.manage.enabled()) return;
    this.renaming.set({ path, name: path.split('/').pop()!, error: '', folder: true });
    this.focusField();
  }

  protected isFolder(path: string) { return !path.toLowerCase().endsWith('.stl'); }
  /** The folder of a part, as a library path ('' for a part at the root). */
  protected folderPathOf(entry: CatalogEntry) { return parentFolder(entry.path); }
  protected partsUnder(folder: string) { return this.entries().filter(entry => entry.path.startsWith(folder + '/')).length; }

  protected renameText(name: string) { this.renaming.update(r => r && { ...r, name, error: '' }); }

  protected async renameNow() {
    const r = this.renaming();
    if (!r || !this.manage.enabled() || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await firstValueFrom(this.lib.rename(r.path, r.name));
      this.renaming.set(null);
      this.undoable.set(null);
      this.actionNote.set(`Renamed ${r.folder ? 'folder ' : ''}to ${result.to.split('/').pop()}${this.documentNote(result.documents)}.`);
      const moves = [{ from: r.path, to: result.to, kind: r.folder ? 'directory' : 'file' }];
      await this.reload();
      this.follow(moves);
      const open = this.detail();
      if (open && remapPath(open, moves) !== open) { this.keepNote = true; this.detail.set(remapPath(open, moves)); }
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
      this.staleBy.update(by => ({ exact: by.exact || !!this.groupsBy().exact, shape: by.shape || !!this.groupsBy().shape })); // the copy is identical to its original
      this.partChecks.set({});
      if (this.used()) void this.loadUsed();
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
      const moves = result.results.map(r => ({ from: r.from, to: r.to, kind: r.kind }));
      const moved = new Map(result.results.map(r => [r.from, r.to]));
      const open = this.detail();
      this.mover.set(null);
      this.picked.set(this.none);
      this.undoable.set(null);
      const changed = result.results.reduce((sum, r) => sum + Object.values(r.documents).reduce((a, n) => a + n, 0), 0);
      const failed = result.failed.length;
      this.actionNote.set(`Moved ${moved.size} item${moved.size === 1 ? '' : 's'} to ${folder || 'the library root'}${changed ? ` (${changed} part${changed === 1 ? '' : 's'} in documents updated)` : ''}${failed ? `; ${failed} could not be moved: ${result.failed[0].error}` : ''}.`);
      await this.reload();
      this.follow(moves);
      if (open && remapPath(open, moves) !== open) { this.keepNote = true; this.detail.set(remapPath(open, moves)); }
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
    this.staleBy.update(by => ({ exact: by.exact || !!this.groupsBy().exact, shape: by.shape || !!this.groupsBy().shape })); // copies may be back
    this.partChecks.set({});
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

  /** The picture of a part's page: the line drawing, or the part in 3D (the preview of the file list's Quick Look, to orbit). */
  protected readonly figView = signal<'drawing' | '3d' | 'together'>(readFigView());
  /** The parts that belong with the open one by their names (LEFT / RIGHT, TOP / BOTTOM ...), in its folder. */
  protected readonly companions = computed(() => { const path = this.detail(); return path ? companionsOf(this.entries(), path) : []; });
  /** What the picture shows: TOGETHER only when the part has companions (else the plain 3D view). */
  protected readonly figShown = computed(() => (this.figView() === 'together' && !this.companions().length ? '3d' : this.figView()));
  /** The files of the together view (the open part and its companions, not too large to preview), in a fixed order so each keeps its colour whichever of them is open. */
  protected readonly togetherPaths = computed(() => {
    const open = this.detail();
    if (this.figShown() !== 'together' || !open) return [];
    const names = [open, ...this.companions().filter(c => !isTooLarge(c.size)).map(c => c.path)];
    // numbered parts in the order of their numbers (P1, P2, P3 ...), else by name: every part keeps its colour whichever of them is open
    return names.sort((a, b) => (partNumber(a.split('/').pop()!) ?? Infinity) - (partNumber(b.split('/').pop()!) ?? Infinity) || a.localeCompare(b));
  });
  /** The legend names of the together view (`P1 BOTTOM`, `FRONT`), or null when a part has none (the viewer then shows what differs in the names). */
  protected readonly togetherLabels = computed(() => {
    const labels = this.togetherPaths().map(path => companionLabel(path.split('/').pop()!));
    return labels.length && labels.every(label => label !== null) ? (labels as string[]) : null;
  });
  /** In the TOGETHER view: the colour of each part in the 3D view (a swatch of the legend), to mark its thumbnail or row in the same colour. */
  protected readonly togetherColor = computed(() => {
    const map = new Map<string, string>();
    this.togetherPaths().forEach((path, i) => map.set(path, '#' + companionColors[i % companionColors.length].toString(16).padStart(6, '0')));
    return map;
  });
  protected setFigView(view: 'drawing' | '3d' | 'together') {
    this.figView.set(view);
    try { localStorage.setItem(figViewKey, view); } catch { /* storage unavailable */ }
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
  /** The catalog number of a part (its place in the list of all parts), '—' when the filters have left it out. */
  protected numberOf(entry: CatalogEntry) { const i = this.shown().findIndex(e => e.path === entry.path); return i < 0 ? '—' : this.pad(i + 1); }
  protected number() { return this.detailIndex() < 0 ? '—' : this.pad(this.detailIndex() + 1); }
  private lastRevealed = '';
  /** Scrolls the strip (or the list) of the folder panel so that the open part is in view, one tile of context before it; leaves it alone when it is already there. */
  private revealCurrent(folder: string, view: 'list' | 'strip') {
    const open = this.detail();
    const folderChanged = this.lastRevealed !== `${folder}|${view}`;
    this.lastRevealed = `${folder}|${view}`;
    const index = this.browseFiles().findIndex(file => file.path === open);
    if (view === 'list') {
      (this.host.nativeElement.querySelector('.listbox .sib.current') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const element = this.stripRef()?.nativeElement;
    if (!element) return;
    if (index < 0) { if (folderChanged) element.scrollLeft = 0; return; } // another folder than the part's: from its start
    const left = (this.browseFolders().length + index) * tileWidth;
    if (left >= element.scrollLeft && left + tileWidth <= element.scrollLeft + element.clientWidth) return; // in view already: a click on a tile must not move the strip
    element.scrollTo({ left: Math.max(0, Math.min(element.scrollWidth - element.clientWidth, left - tileWidth)), behavior: folderChanged ? 'auto' : 'smooth' });
  }

  /** Shows another folder in the folder panel without leaving the page. Going up the trail keeps the crumbs below it; going elsewhere changes the trail. */
  protected goFolder(path: string) {
    this.browse.set(path);
    if (!isWithin(this.trail(), path)) this.trail.set(path);
  }

  /** A crumb below the folder shown: still on the trail, to go back down to. */
  protected isAhead(path: string) { return path !== this.browse() && isWithin(path, this.browse()); }

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
