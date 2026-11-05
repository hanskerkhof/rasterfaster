import { Component, inject } from '@angular/core';
import { ManageService } from './manage.service';

/** The Manage switch (see ManageService), for the top bar of the app or the header of a dialog. Not shown when the library is read-only. */
@Component({
  selector: 'app-manage-toggle',
  template: `
    @if (!manage.locked()) {
      <button type="button" class="switch" role="switch" [attr.aria-checked]="manage.enabled()" [class.on]="manage.enabled()"
              [title]="manage.enabled() ? 'Manage is on: the library can be changed (rename, move, Trash). Click to switch it off.' : 'Manage is off: the library is read-only. Click to switch it on.'"
              (click)="manage.toggle()">
        <span class="track"><span class="knob"></span></span><span class="text">Manage</span>
      </button>
    }
  `,
  styles: `
    :host { display: inline-flex; }
    .switch { display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px; background: transparent; color: inherit; border: 0; border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; opacity: .75; }
    .switch:hover { opacity: 1; background: rgba(255,255,255,.08); } .switch.on { opacity: 1; }
    .track { position: relative; width: 24px; height: 12px; border-radius: 6px; background: #3a3e48; transition: background .15s; }
    .knob { position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #aab; transition: left .15s, background .15s; }
    .on .track { background: #2f6fed; } .on .knob { left: 14px; background: #fff; }
  `,
})
export class ManageToggle {
  protected readonly manage = inject(ManageService);
}
