import { Injectable, computed, inject, signal } from '@angular/core';
import { RF_LIBRARY_CONFIG } from './library.config';

const storageKey = 'rasterfaster.manage';

function read(): boolean {
  try { return localStorage.getItem(storageKey) !== 'false'; } catch { return true; } // on unless it was switched off
}

/**
 * The Manage switch of the library: on, the library can be changed (rename, move, duplicate, new folder, Trash) in the file list and in the
 * catalog; off, it can only be browsed. It belongs to the library and to nothing else (documents, parts list and exports ignore it).
 * A host that publishes the library read-only sets `readOnly` in the config: the switch is then off for good and the toggle is not shown.
 */
@Injectable({ providedIn: 'root' })
export class ManageService {
  private readonly config = inject(RF_LIBRARY_CONFIG);
  private readonly switchedOn = signal(read());

  /** Changing the library is allowed now. */
  readonly enabled = computed(() => !this.config.readOnly && this.switchedOn());
  /** The host has made the library read-only: there is nothing to switch. */
  readonly locked = computed(() => !!this.config.readOnly);

  set(on: boolean) {
    this.switchedOn.set(on);
    try { localStorage.setItem(storageKey, String(on)); } catch { /* storage unavailable */ }
  }

  toggle() {
    this.set(!this.switchedOn());
  }
}
