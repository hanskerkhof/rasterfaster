import { Component, input } from '@angular/core';

/**
 * The mode of a saved view as a small icon: a cube for a Design view, a camera for a Render view (blue-grey and warm clay), nothing but an empty
 * space of the same width for a view saved before the mode was kept, so the names of all rows start at the same place.
 */
@Component({
  selector: 'app-view-mode-icon',
  template: `
    @if (mode() === 'design') {
      <svg class="design" viewBox="0 0 16 16" width="13" height="13" aria-label="Design view" role="img"><path d="M8 1.5 14 5v6L8 14.5 2 11V5z M2 5l6 3.5L14 5 M8 8.5v6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
    } @else if (mode() === 'render') {
      <svg class="render" viewBox="0 0 16 16" width="13" height="13" aria-label="Render view" role="img"><path d="M2 5h2.5l1-1.5h5L11.5 5H14v8H2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="9" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    } @else { <span class="none"></span> }
  `,
  styles: `
    :host { display: inline-flex; flex: none; width: 13px; height: 13px; }
    svg, .none { width: 13px; height: 13px; }
    .design { color: #8fb0d8; } .render { color: #e0a07a; }
  `,
})
export class ViewModeIcon {
  readonly mode = input<string | null | undefined>(null);
}

/** The words for the hover text of a view: `Design view`, `Render view`, or '' for a view without a mode. */
export function viewModeName(mode: string | null | undefined): string {
  return mode === 'render' ? 'Render view' : mode === 'design' ? 'Design view' : '';
}
