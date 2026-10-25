import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, output } from '@angular/core';
import { BomRow, bomToCsv, buildBom } from './bom';
import { DocumentStore } from './document.store';

@Component({
  selector: 'app-bom-dialog',
  imports: [DecimalPipe, NgTemplateOutlet],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" role="dialog" aria-label="Bill of materials" (keydown.escape)="close.emit()">
      <header>
        <h2>Bill of materials <small>{{ store.doc().name }}</small></h2>
        <button type="button" class="x" aria-label="Close" (click)="close.emit()">✕</button>
      </header>
      @if (rows().length) {
        <table>
          <thead><ng-container *ngTemplateOutlet="head" /></thead>
          <tbody><ng-container *ngTemplateOutlet="body; context: { $implicit: rows() }" /></tbody>
          <tfoot><tr><td>Total</td><td class="n">{{ totalQuantity() }}</td><td></td><td></td><td class="n">{{ totalVolume() | number: '1.1-1' }} cm³</td></tr></tfoot>
        </table>
      } @else if (mockRows().length) {
        <p class="empty">Every part is set to “Do not export”.</p>
      } @else {
        <p class="empty">The document is empty. Add parts first.</p>
      }
      @if (mockRows().length) {
        <h3>Not exported <small>mock parts, set to “Do not export”: not in the 3MF / SVG exports</small></h3>
        <table class="mock">
          <thead><ng-container *ngTemplateOutlet="head" /></thead>
          <tbody><ng-container *ngTemplateOutlet="body; context: { $implicit: mockRows() }" /></tbody>
        </table>
      }
      <ng-template #head>
        <tr><th>Part</th><th class="n">Qty</th><th class="n">Size X × Y × Z (mm)</th><th class="n">Volume each</th><th class="n">Volume total</th></tr>
      </ng-template>
      <ng-template #body let-list>
        @for (r of list; track r.path) {
          <tr>
            <td><span class="name">{{ r.name }}</span><span class="path">{{ r.path }}</span></td>
            <td class="n">{{ r.quantity }}</td>
            <td class="n">{{ size(r) }}</td>
            <td class="n">{{ r.stats ? (r.stats.volumeCm3 | number: '1.1-1') + ' cm³' : '…' }}</td>
            <td class="n">{{ r.stats ? (r.stats.volumeCm3 * r.quantity | number: '1.1-1') + ' cm³' : '…' }}</td>
          </tr>
        }
      </ng-template>
      <footer>
        <button type="button" [disabled]="!hasAnything()" (click)="downloadCsv()">Download CSV</button>
        <button type="button" [disabled]="!hasAnything()" (click)="copyCsv()">{{ copied ? 'Copied ✓' : 'Copy CSV' }}</button>
        <span class="note">Volumes are solid model volume, before infill/shells.</span>
      </footer>
    </section>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
    .dialog { position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(760px, 92vw); max-height: 80vh; overflow: auto;
              padding: 16px; background: #23262d; color: #dde1e8; border: 1px solid rgba(255,255,255,.15); border-radius: 8px; font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 16px; } h2 small { font-weight: 400; opacity: .6; margin-left: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
    .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .name { display: block; font-weight: 600; } .path { display: block; opacity: .45; font-size: 11px; word-break: break-all; }
    tfoot td { font-weight: 700; border-bottom: 0; }
    .empty { opacity: .6; font-style: italic; }
    h3 { margin: 18px 0 6px; font-size: 13px; } h3 small { font-weight: 400; opacity: .55; margin-left: 6px; font-size: 11px; }
    table.mock { opacity: .75; }
    footer { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    button { padding: 5px 12px; background: #31353f; color: inherit; border: 1px solid #000; border-radius: 4px; cursor: pointer; font: inherit; }
    button:hover:not(:disabled) { background: #2f6fed; color: #fff; } button:disabled { opacity: .35; cursor: default; }
    .x { padding: 2px 8px; background: transparent; border: 0; }
    .note { margin-left: auto; opacity: .5; font-size: 11px; }
  `,
})
export class BomDialog {
  protected readonly store = inject(DocumentStore);
  readonly close = output<void>();
  protected copied = false;

  protected readonly rows = computed(() => buildBom(this.store.doc().items, this.store.partStats()));
  protected readonly mockRows = computed(() => buildBom(this.store.doc().items, this.store.partStats(), true));
  protected readonly hasAnything = computed(() => this.rows().length > 0 || this.mockRows().length > 0);
  protected readonly totalQuantity = computed(() => this.rows().reduce((sum, r) => sum + r.quantity, 0));
  protected readonly totalVolume = computed(() => this.rows().reduce((sum, r) => sum + (r.stats ? r.stats.volumeCm3 * r.quantity : 0), 0));

  protected size(r: BomRow) {
    return r.stats ? r.stats.size.map(v => v.toFixed(1)).join(' × ') : '…';
  }

  protected downloadCsv() {
    const blob = new Blob([bomToCsv(this.rows(), this.mockRows())], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.store.doc().name.replace(/[^\w.-]+/g, '_')}-bom.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  protected async copyCsv() {
    await navigator.clipboard.writeText(bomToCsv(this.rows(), this.mockRows()));
    this.copied = true;
    setTimeout(() => (this.copied = false), 1500);
  }
}
