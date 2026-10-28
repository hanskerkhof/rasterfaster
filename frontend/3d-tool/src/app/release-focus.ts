import { Directive, Injectable, inject } from '@angular/core';

/** Where the keyboard goes when a control lets go of it: the 3D view registers its focusable element here. */
@Injectable({ providedIn: 'root' })
export class ViewFocus {
  target: HTMLElement | null = null;

  /** Takes the focus off whatever has it and gives it to the 3D view, so its shortcuts (Space, arrows ...) keep working. */
  release() {
    (document.activeElement as HTMLElement | null)?.blur();
    this.target?.focus({ preventScroll: true });
  }
}

/**
 * Add `releaseFocus` to a button or dropdown that must not keep the keyboard focus after it was used:
 * `<button releaseFocus (click)="...">`. Buttons release on click, dropdowns once a value is chosen.
 */
@Directive({
  selector: '[releaseFocus]',
  host: { '(click)': 'onClick($event)', '(change)': 'viewFocus.release()' },
})
export class ReleaseFocus {
  protected readonly viewFocus = inject(ViewFocus);

  protected onClick(event: Event) {
    // A click on a dropdown only opens it: it releases on `change`.
    if ((event.currentTarget as HTMLElement).tagName !== 'SELECT') this.viewFocus.release();
  }
}
