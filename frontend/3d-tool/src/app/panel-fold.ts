import { Component, computed, inject, input, output } from '@angular/core';
import { ReleaseFocus } from './release-focus';
import { PanelDock } from './panel-dock';

/**
 * The collapse / expand button of a floating panel, always the last thing on the right of its top bar (`panel-bar`): a chevron that points up while the
 * panel is open (click: fold it to its bar) and down while it is folded. `label` names the panel for the hover text; `hint` adds a key.
 */
@Component({
  selector: 'app-panel-fold',
  imports: [ReleaseFocus],
  template: `
    @if (docked()) {
      <button type="button" class="undock" [title]="'Undock ' + label() + ': back to where it was'" (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (click)="dock.undock(dockId())">
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.5h3.5V5M10.5 1.5 6.5 5.5M5 2.5H2v7.5h7.5V7"/></svg>
      </button>
    } @else {
    <button type="button" releaseFocus [attr.aria-expanded]="!collapsed()" [title]="(collapsed() ? 'Expand ' : 'Collapse ') + label() + (hint() ? ' (' + hint() + ')' : '')" (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (click)="toggle.emit()">
      <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        @if (collapsed()) { <path d="M2.5 4.5 6 8l3.5-3.5"/> } @else { <path d="M2.5 7.5 6 4l3.5 3.5"/> }
      </svg>
    </button>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; align-self: stretch; }
    button { width: 26px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; color: inherit; border: 0; border-radius: 4px; opacity: .55; cursor: pointer; }
    button:hover { opacity: 1; background: transparent; color: #fff; }
  `,
})
export class PanelFold {
  readonly collapsed = input(false);
  readonly label = input('the panel');
  readonly hint = input('');
  /** The panel's name in the dock (see `PanelDock`): while it is docked, this button undocks it instead of folding it. */
  readonly dockId = input('');
  protected readonly dock = inject(PanelDock);
  protected readonly docked = computed(() => !!this.dockId() && this.dock.isDocked(this.dockId()));
  readonly toggle = output<void>();
}
