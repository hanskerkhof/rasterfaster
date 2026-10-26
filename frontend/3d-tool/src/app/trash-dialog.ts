import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryService, TrashItem } from './library.service';

/** The Trash of the library, like the Finder's: Put Back, Delete Immediately and Empty Trash. */
@Component({
  selector: 'app-trash-dialog',
  imports: [DatePipe],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Trash" (keydown.escape)="close.emit()">
      <header>
        <h2>Trash <small>{{ items().length }} item{{ items().length === 1 ? '' : 's' }}</small></h2>
        @if (items().length) {
          @if (confirmEmpty()) {
            <span class="ask">Delete {{ items().length }} item{{ items().length === 1 ? '' : 's' }} for good?
              <button type="button" class="danger" (click)="empty()">Empty Trash</button>
              <button type="button" (click)="confirmEmpty.set(false)">Cancel</button></span>
          } @else {
            <button type="button" (click)="confirmEmpty.set(true)">Empty Trash…</button>
          }
        }
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      @if (message()) { <p class="message">{{ message() }}</p> }
      @if (items().length) {
        <table>
          <tbody>
            @for (item of items(); track item.id) {
              <tr>
                <td class="what"><span class="name">{{ item.kind === 'directory' ? '▸ ' : '' }}{{ item.name }}</span><span class="from">{{ item.originalPath }}</span></td>
                <td class="n">{{ size(item.size) }}<br />{{ item.deletedAt * 1000 | date: 'd MMM, HH:mm' }}</td>
                <td class="buttons">
                  @if (conflict() === item.id) {
                    <span class="ask">Its place is taken.
                      <button type="button" (click)="putBack(item, 'rename')">Put back as “(restored)”</button>
                      <button type="button" (click)="conflict.set(null)">Cancel</button></span>
                  } @else {
                    <button type="button" [disabled]="item.missing" (click)="putBack(item)">Put Back</button>
                    <button type="button" class="danger" (click)="deleteNow(item)">Delete Immediately</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="empty">The Trash is empty. “Move to Trash” (⌘⌫) in the file list puts files and folders here.</p>
      }
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
    .dialog { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(720px, 94vw); max-height: 80vh; overflow: auto;
              padding: 16px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    h2 { margin: 0 auto 0 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: middle; }
    .what { max-width: 360px; } .name { display: block; font-weight: 600; word-break: break-all; } .from { display: block; opacity: .5; font-size: 11px; word-break: break-all; }
    .n { opacity: .65; white-space: nowrap; font-size: 11px; font-variant-numeric: tabular-nums; } .buttons { text-align: right; }
    .message { margin: 4px 0 8px; padding: 6px 8px; background: #3a3320; border: 1px solid #6b5a20; border-radius: 6px; font-size: 12px; }
    .empty { opacity: .6; font-style: italic; } .ask { font-size: 12px; }
    button { padding: 3px 10px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; margin-left: 4px; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; } button.danger:hover:not(:disabled) { background: #b03a3a; }
    button:disabled { opacity: .4; cursor: default; } .x { padding: 2px 8px; background: transparent; border: 0; }
  `,
})
export class TrashDialog implements OnInit {
  protected readonly lib = inject(LibraryService);
  readonly close = output<void>();
  /** Something was put back (the file list has to look again). */
  readonly changed = output<void>();
  protected readonly items = signal<TrashItem[]>([]);
  protected readonly message = signal('');
  protected readonly conflict = signal<string | null>(null);
  protected readonly confirmEmpty = signal(false);

  ngOnInit() {
    void this.refresh();
  }

  private async refresh() {
    this.items.set(await firstValueFrom(this.lib.trashList()));
    this.lib.trashCount.set(this.items().length);
  }

  protected size(bytes: number) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  protected async putBack(item: TrashItem, onConflict?: 'rename') {
    this.message.set('');
    try {
      const back = await firstValueFrom(this.lib.putBack(item.id, onConflict));
      this.conflict.set(null);
      this.message.set(`Put back as ${back.path}`);
      this.changed.emit();
    } catch (error) {
      if ((error as { status?: number }).status === 409) { this.conflict.set(item.id); return; }
      const detail = (error as { error?: { detail?: unknown } }).error?.detail;
      this.message.set(typeof detail === 'string' ? `Could not put it back: ${detail}` : 'Could not put it back');
    }
    await this.refresh();
  }

  protected async deleteNow(item: TrashItem) {
    this.message.set('');
    try { await firstValueFrom(this.lib.deleteImmediately(item.id)); } catch { this.message.set('Could not delete it'); }
    await this.refresh();
  }

  protected async empty() {
    this.confirmEmpty.set(false);
    try { await firstValueFrom(this.lib.emptyTrash()); } catch { this.message.set('Could not empty the Trash'); }
    await this.refresh();
  }
}
