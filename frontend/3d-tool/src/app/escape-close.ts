import { DestroyRef, inject } from '@angular/core';

/**
 * Esc closes the dialog (or menu) that is open, and nothing else: the listener sits on the document in the capture phase, so it runs before
 * every other Esc handler (the 3D view's "deselect", the list's "clear the filter") and stops the key there. Call it in a constructor.
 * `isOpen` tells whether it is open now (a dialog that only exists while it is open can leave it out).
 */
export function closeOnEscape(close: () => void, isOpen: () => boolean = () => true) {
  const handler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey || !isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  document.addEventListener('keydown', handler, true);
  inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', handler, true));
}
