import { Injectable, signal } from '@angular/core';

const pollMs = 5000;
const timeoutMs = 3000;
/** Consecutive failed checks before the API counts as offline, so a page load or a quick restart does not flash the banner. */
const failuresBeforeOffline = 2;

/** Watches whether the API answers: polls /api/health, and checks at once when the browser reports a network change. */
@Injectable({ providedIn: 'root' })
export class ApiStatus {
  /** True once the API has been unreachable for a few seconds. */
  readonly offline = signal(false);
  /** Bumped on every successful check, so the app can react to "the API is there" (also when it was never shown as offline). */
  readonly checks = signal(0);
  private failures = 0;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    window.setInterval(() => void this.check(), pollMs);
    window.addEventListener('online', () => void this.check());
    window.addEventListener('offline', () => void this.check());
    void this.check();
  }

  async check() {
    let ok = false;
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      ok = response.ok;
    } catch { /* unreachable */ }
    this.failures = ok ? 0 : this.failures + 1;
    this.offline.set(this.failures >= failuresBeforeOffline);
    if (ok) this.checks.update(n => n + 1);
  }
}
