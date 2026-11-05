import { InjectionToken } from '@angular/core';

/** One place a part was found in (a design file, say) and what matched in it. */
export interface RfFinderHit {
  title: string;
  /** Where it is (a folder), shown under the title. */
  subtitle: string;
  /** What matched: names, and where each sits. */
  matches: { name: string; places: string[]; exact: boolean }[];
  moreMatches: number;
  /** A note about the hit (older versions, ...). */
  note: string;
  /** A small label on the hit (where it comes from: a cache, one of your own files ...), with a colour and a tooltip. */
  badge?: { label: string; tone: 'blue' | 'green' | 'amber' | 'grey'; title: string };
  /** A path `reveal` can show in the Finder. */
  path?: string;
  /** The name is exactly the part's name, not only part of a longer one. */
  exact: boolean;
}

export interface RfFinderResult {
  found: boolean;
  /** One line: what was looked for and how many places have it. */
  summary: string;
  hits: RfFinderHit[];
  /** More hits than are listed. */
  more: number;
  /** A warning about the result (the index is behind), with what to do about it: `refresh` makes the result again. */
  hint?: string;
  refreshLabel?: string;
  refresh?: (progress: (text: string) => void) => Promise<RfFinderResult>;
}

/** A way to look for a library part somewhere else (the Fusion 360 files, say): the host provides it, the part's page shows a button and the answer. */
export interface RfPartFinder {
  id: string;
  /** The button, e.g. `FIND IN FUSION`. */
  label: string;
  /** Looks for the part with this library path. `progress` tells what is going on while it takes long. */
  find(path: string, progress: (text: string) => void): Promise<RfFinderResult>;
  /** Shows what a hit points at in the Finder. */
  reveal?(path: string): Promise<void>;
}

/** The finders of the host app (multi provider). Without any, the page has no such buttons. */
export const RF_PART_FINDERS = new InjectionToken<RfPartFinder[]>('RF_PART_FINDERS', { providedIn: 'root', factory: () => [] });
