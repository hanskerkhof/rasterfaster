import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, output } from '@angular/core';
import { DocumentStore } from './document.store';

/** The versions of the open document (v1, v2, ...): look at an older one (read-only) or promote it to the newest, like Fusion 360. */
@Component({
  selector: 'app-versions-dialog',
  imports: [DatePipe],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Versions" (keydown.escape)="close.emit()">
      <header>
        <h2>Versions <small>{{ store.doc().name }}</small></h2>
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      <div class="actions">
        <button type="button" [disabled]="store.viewing() !== null || !store.changedSinceVersion()" (click)="save()">
          Save as v{{ store.version() + 1 }}
        </button>
        <span class="hint">{{ store.changedSinceVersion() ? 'The working copy has changes since ' + (store.version() ? 'v' + store.version() : 'the start') + '.' : 'No changes since v' + store.version() + '.' }}</span>
      </div>
      @if (store.versions().length) {
        <table>
          <tbody>
            @for (v of store.versions(); track v.version) {
              <tr [class.viewing]="store.viewing() === v.version">
                <td class="v">v{{ v.version }}@if (v.version === store.version()) { <span class="latest">latest</span> }</td>
                <td>{{ v.savedAt * 1000 | date: 'd MMM y, HH:mm' }}</td>
                <td class="n">{{ v.itemCount }} parts</td>
                <td class="buttons">
                  <button type="button" [disabled]="store.viewing() === v.version" (click)="view(v.version)">{{ store.viewing() === v.version ? 'Viewing' : 'View' }}</button>
                  <button type="button" [disabled]="v.version === store.version() && !store.changedSinceVersion()" title="Make this the working copy and save it as the newest version" (click)="promote(v.version)">Promote</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="empty">No versions yet. “Save as v1” snapshots the document as it is now.</p>
      }
      @if (store.viewing() !== null) {
        <footer><button type="button" (click)="back()">Back to the working copy</button></footer>
      }
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
    .dialog { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(560px, 92vw); max-height: 80vh; overflow: auto;
              padding: 16px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    .actions { display: flex; align-items: center; gap: 10px; margin: 6px 0 10px; }
    .hint { opacity: .6; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: middle; }
    tr.viewing { background: rgba(47,111,237,.18); }
    .v { font-weight: 700; white-space: nowrap; } .latest { margin-left: 6px; font-size: 10px; font-weight: 600; color: #7fd18b; }
    .n { opacity: .65; white-space: nowrap; } .buttons { text-align: right; white-space: nowrap; }
    .empty { opacity: .6; font-style: italic; }
    footer { margin-top: 12px; }
    button { padding: 4px 11px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; margin-left: 4px; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; } button:disabled { opacity: .4; cursor: default; }
    .x { padding: 2px 8px; background: transparent; border: 0; }
  `,
})
export class VersionsDialog implements OnInit {
  protected readonly store = inject(DocumentStore);
  readonly close = output<void>();

  ngOnInit() {
    void this.store.refreshVersions();
  }

  protected save() {
    return this.store.saveVersion();
  }

  protected async view(version: number) {
    await this.store.viewVersion(version);
    this.close.emit();
  }

  protected async promote(version: number) {
    await this.store.promoteVersion(version);
  }

  protected async back() {
    await this.store.backToWorkingCopy();
    this.close.emit();
  }
}
