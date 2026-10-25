import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { DocItem, RfDocument } from './document.store';

export interface DocumentSummary {
  id: string;
  name: string;
  itemCount: number;
  modified: number;
}

export interface StoredDocument extends RfDocument {
  id: string;
  modified: number;
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

  update(id: string, doc: RfDocument) {
    return this.http.put<StoredDocument>(`/api/documents/${id}`, { name: doc.name, items: doc.items });
  }

  delete(id: string) {
    return this.http.delete<void>(`/api/documents/${id}`);
  }
}
