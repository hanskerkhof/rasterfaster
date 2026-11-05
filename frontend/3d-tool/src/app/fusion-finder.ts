import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { RfFinderHit, RfFinderResult, RfPartFinder } from '@rasterfaster/library';

interface FusionStatus { folder: string; folderExists: boolean; indexed: number; pending: number; state: 'idle' | 'running' | 'done' | 'error'; done: number; total: number; current: string; error: string; zstandard: boolean }
interface FusionFind {
  found: boolean; query: string; queries: string[]; moreDesigns: number; indexed: number;
  designs: { design: string; path: string; folder: string; source: string; matches: { name: string; places: string[]; exact: boolean }[]; moreMatches: number; exact: boolean; note: string }[];
}

/** FIND IN FUSION: in which of the Fusion 360 files (scripts/f3dsearch.py, behind /api/fusion/*) a part is a component or body. */
@Injectable({ providedIn: 'root' })
export class FusionFinder implements RfPartFinder {
  private readonly http = inject(HttpClient);
  readonly id = 'fusion';
  readonly label = 'FIND IN FUSION';

  async find(path: string, progress: (text: string) => void): Promise<RfFinderResult> {
    let status = await firstValueFrom(this.http.get<FusionStatus>('/api/fusion/status'));
    if (!status.zstandard) throw new Error('The API cannot read Fusion files: zstandard is not installed.');
    if (!status.indexed) { // nothing to search yet: read the Fusion files first
      if (!status.folderExists && !status.pending) throw new Error(`There is no Fusion folder (${status.folder}) and no Fusion cache to search.`);
      await this.index(progress);
      status = await firstValueFrom(this.http.get<FusionStatus>('/api/fusion/status'));
    }
    return this.search(path, status.pending);
  }

  async reveal(path: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/fusion/reveal', { path }));
  }

  /** The search itself, with the index as it is (quick); when files are new or changed since, the result says so and can be made again after reading them. */
  private async search(path: string, pending: number): Promise<RfFinderResult> {
    const found = await firstValueFrom(this.http.get<FusionFind>('/api/fusion/find', { params: { path } }));
    const hits: RfFinderHit[] = found.designs.map(d => ({
      title: d.design, subtitle: d.folder + (d.source === 'fusion cache' ? '  (Fusion cache)' : ''), matches: d.matches, moreMatches: d.moreMatches, note: d.note, path: d.path, exact: d.exact,
    }));
    const result: RfFinderResult = {
      found: found.found,
      summary: found.found
        ? `“${found.query}” is in ${hits.length}${found.moreDesigns ? '+' : ''} Fusion design${hits.length === 1 ? '' : 's'}${hits.some(h => h.exact) ? '' : ' (only as part of longer names)'}`
        : `“${found.query}” was not found in ${found.indexed} indexed Fusion designs`,
      hits, more: found.moreDesigns,
    };
    if (pending) {
      result.hint = `${pending} Fusion file${pending === 1 ? ' is' : 's are'} new or changed since the last index${found.found ? '' : ': the part may be in one of them'}.`;
      result.refreshLabel = 'READ THEM AND SEARCH AGAIN';
      result.refresh = async (progress: (text: string) => void) => { await this.index(progress); return this.search(path, 0); };
    }
    return result;
  }

  /** Reads the new and changed Fusion files on the API (in the background there) and waits, telling how far it is. */
  private async index(progress: (text: string) => void): Promise<void> {
    await firstValueFrom(this.http.post('/api/fusion/index', {}));
    for (;;) {
      const status = await firstValueFrom(this.http.get<FusionStatus>('/api/fusion/status'));
      progress(`READING FUSION FILES… ${status.done} / ${status.total}${status.current ? ' · ' + status.current.replace(/^indexed /, '') : ''}`);
      if (status.state === 'error') throw new Error(status.error || 'Reading the Fusion files failed.');
      if (status.state !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}
