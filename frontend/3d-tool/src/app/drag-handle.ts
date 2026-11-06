import { Component, input } from '@angular/core';

/**
 * The mark of a panel that can be moved: six dots (a grip), in the top bar. It takes the colour of its text; a panel makes it brighter while the pointer
 * is over its bar. Put it first in the bar of a panel (`vertical`, 2 × 3 dots) or in the middle of a bar that has room (`horizontal`, 3 × 2 dots).
 */
@Component({
  selector: 'app-drag-handle',
  template: `
    @if (horizontal()) {
      <svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="2.5" r="1.3"/><circle cx="8" cy="2.5" r="1.3"/><circle cx="13" cy="2.5" r="1.3"/><circle cx="3" cy="7.5" r="1.3"/><circle cx="8" cy="7.5" r="1.3"/><circle cx="13" cy="7.5" r="1.3"/></g></svg>
    } @else {
      <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; align-items: center; justify-content: center; color: #8a93a2; opacity: .85; pointer-events: none; }
  `,
})
export class DragHandle {
  readonly horizontal = input(false);
}
