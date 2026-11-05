import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { RF_PART_FINDERS } from '@rasterfaster/library';
import { FusionFinder } from './fusion-finder';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    { provide: RF_PART_FINDERS, useExisting: FusionFinder, multi: true }, // the part's page in the catalog gets a FIND IN FUSION button
    // Makes the app installable and loadable offline. Only in a production build (ng serve is a dev build: no service worker),
    // registered once the app is stable so it never competes with the first load.
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:30000' }),
  ],
};
