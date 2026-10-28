import { Component, DestroyRef, inject, input, output } from '@angular/core';
import { closeOnEscape } from './escape-close';

/** "Delete Immediately": a small modal question. Enter confirms, Esc (or a click outside) cancels. */
@Component({
  selector: 'app-delete-dialog',
  template: `
    <div class="backdrop" (mousedown)="cancel.emit()"></div>
    <section class="dialog" role="alertdialog" aria-label="Delete immediately">
      <p class="title">{{ title() }}</p>
      <p class="text">{{ text() }}</p>
      @if (warning()) { <p class="warning">{{ warning() }}</p> }
      <div class="buttons">
        <button type="button" (click)="cancel.emit()">Cancel <kbd>Esc</kbd></button>
        <button type="button" class="danger" (click)="confirm.emit()">Delete <kbd>↩</kbd></button>
      </div>
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 50; }
    .dialog { position: fixed; z-index: 51; top: 30%; left: 50%; transform: translateX(-50%); width: min(420px, 92vw); box-sizing: border-box; padding: 16px;
              background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.18); border-radius: 10px; box-shadow: 0 14px 44px rgba(0,0,0,.55); font-size: 13px; }
    .title { margin: 0 0 6px; font-size: 15px; font-weight: 600; word-break: break-word; }
    .text { margin: 0; opacity: .8; } .warning { margin: 8px 0 0; padding: 6px 8px; background: #3a3320; border: 1px solid #6b5a20; border-radius: 6px; font-size: 12px; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    button { padding: 5px 12px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 5px; cursor: pointer; font: inherit; }
    button:hover { background: #3b404c; } button.danger { background: #b03a3a; color: #fff; } button.danger:hover { background: #cc4a4a; }
    kbd { margin-left: 6px; font: inherit; font-size: 11px; opacity: .65; }
  `,
})
export class DeleteDialog {
  readonly title = input.required<string>();
  readonly text = input('It cannot be undone: the files do not go to the Trash.');
  readonly warning = input('');
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  constructor() {
    closeOnEscape(() => this.cancel.emit());
    const onEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.confirm.emit();
    };
    document.addEventListener('keydown', onEnter, true);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onEnter, true));
  }
}
