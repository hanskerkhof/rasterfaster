import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { DocItem, RfDocument } from './document.store';

export interface DocumentSummary {
  id: string;
  name: string;
  itemCount: number;
  modified: number;
}

/** One line of the report that comes with an imported 3MF: how a part was linked to a library file. */
export interface Import3mfLine { name: string; path: string; matchedBy: string; count: number; note: string }

export interface StoredDocument extends RfDocument {
  id: string;
  modified: number;
  /** The newest saved version (v1, v2, ...), 0 when none was saved yet, and whether the working copy differs from it. */
  version?: number;
  changedSinceVersion?: boolean;
}

export interface VersionSummary {
  version: number;
  savedAt: number;
  name: string;
  itemCount: number;
}

@Injectable({ providedIn: 'root' })
export class DocumentApi {
  private readonly http = inject(HttpClient);

  list() {
    return this.http.get<DocumentSummary[]>('/api/documents');
  }

  get(id: string) {
    return this.http.get<StoredDocument>(`/api/documents/${id}`);
  }

  create(doc: { name: string; items: DocItem[] }) {
    return this.http.post<StoredDocument>('/api/documents', doc);
  }

  /** `baseModified`: the `modified` this client last saw; the API refuses with 409 when the document changed since. */
  update(id: string, doc: RfDocument, baseModified?: number) {
    const params = baseModified === undefined ? undefined : new HttpParams().set('baseModified', baseModified);
    return this.http.put<StoredDocument>(`/api/documents/${id}`, { name: doc.name, items: doc.items }, { params });
  }

  versions(id: string) {
    return this.http.get<VersionSummary[]>(`/api/documents/${id}/versions`);
  }

  /** Snapshots the saved working copy as the next version; `created` is false when nothing changed since the newest one. */
  saveVersion(id: string) {
    return this.http.post<VersionSummary & { created: boolean }>(`/api/documents/${id}/versions`, {});
  }

  getVersion(id: string, version: number) {
    return this.http.get<VersionSummary & { items: DocItem[] }>(`/api/documents/${id}/versions/${version}`);
  }

  /** Makes an older version the working copy again and saves it as the new latest version. */
  promote(id: string, version: number) {
    return this.http.post<StoredDocument>(`/api/documents/${id}/versions/${version}/promote`, {});
  }

  /** Recovers a saved document file (raw JSON text). Answers 409 when a document with that id exists and no `onConflict` was given. */
  importFile(text: string, onConflict?: 'replace' | 'copy') {
    const params = onConflict ? new HttpParams().set('onConflict', onConflict) : undefined;
    return this.http.post<StoredDocument>('/api/documents/import', text, { params, headers: { 'Content-Type': 'application/json' } });
  }

  /** Makes a new document from a 3MF (the raw bytes): the parts are linked to the library's STL files. */
  import3mf(data: ArrayBuffer, name: string) {
    return this.http.post<{ document: StoredDocument; report: Import3mfLine[] }>('/api/documents/import-3mf', data, {
      params: new HttpParams().set('name', name), headers: { 'Content-Type': 'model/3mf' },
    });
  }

  delete(id: string) {
    return this.http.delete<void>(`/api/documents/${id}`);
  }
}
