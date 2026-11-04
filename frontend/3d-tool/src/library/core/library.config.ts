import { InjectionToken } from '@angular/core';

/** What the library needs to know about where it runs. A host overrides it with `provideRfLibrary({...})`. */
export interface RfLibraryConfig {
  /** Where the library API (the `rf_library` router) is served from, without a trailing slash. */
  apiBase: string;
}

export const defaultRfLibraryConfig: RfLibraryConfig = { apiBase: '/api' };

export const RF_LIBRARY_CONFIG = new InjectionToken<RfLibraryConfig>('RF_LIBRARY_CONFIG', { providedIn: 'root', factory: () => defaultRfLibraryConfig });

/** Provides the library's settings (optional: without it the library talks to `/api`). */
export function provideRfLibrary(config: Partial<RfLibraryConfig> = {}) {
  return { provide: RF_LIBRARY_CONFIG, useValue: { ...defaultRfLibraryConfig, ...config } };
}
