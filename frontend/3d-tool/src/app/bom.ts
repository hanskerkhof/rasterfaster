import { DocItem, PartStats } from './document.store';

export interface BomRow {
  path: string;
  name: string;
  quantity: number;
  /** Undefined until the STL has been loaded. */
  stats?: PartStats;
}

/**
 * One row per distinct library file, counting how often it is used. The BOM has two sections: the parts that are exported
 * (`notExported` false) and the mock parts marked "Do not export" (`notExported` true), which are listed separately.
 */
export function buildBom(items: DocItem[], stats: Record<string, PartStats>, notExported = false): BomRow[] {
  const rows = new Map<string, BomRow>();
  for (const item of items) {
    if (!!item.noExport !== notExported) continue;
    const row = rows.get(item.path);
    if (row) row.quantity++;
    else rows.set(item.path, { path: item.path, name: item.name, quantity: 1, stats: stats[item.path] });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const round = (n: number, digits = 1) => Number(n.toFixed(digits));

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvHeader = ['Part', 'Qty', 'Size X (mm)', 'Size Y (mm)', 'Size Z (mm)', 'Volume each (cm3)', 'Volume total (cm3)', 'File'];

function csvLine(cells: (string | number)[]) {
  return cells.map(csvCell).join(',');
}

function csvRows(rows: BomRow[]) {
  return rows.map(r => [
    r.name, r.quantity,
    ...(r.stats ? r.stats.size.map(v => round(v)) : ['', '', '']),
    r.stats ? round(r.stats.volumeCm3, 2) : '',
    r.stats ? round(r.stats.volumeCm3 * r.quantity, 2) : '',
    r.path,
  ]);
}

/** CSV with the exported parts and a TOTAL line, then (if any) the "Not exported" mock parts as a separate section without a total. */
export function bomToCsv(rows: BomRow[], notExportedRows: BomRow[] = []): string {
  const totalQty = rows.reduce((sum, r) => sum + r.quantity, 0);
  const totalVolume = rows.reduce((sum, r) => sum + (r.stats ? r.stats.volumeCm3 * r.quantity : 0), 0);
  const lines = [csvLine(csvHeader), ...csvRows(rows).map(csvLine), csvLine(['TOTAL', totalQty, '', '', '', '', round(totalVolume, 2), ''])];
  if (notExportedRows.length) {
    lines.push('', csvLine(['NOT EXPORTED (mock parts, set to "Do not export")']), csvLine(csvHeader), ...csvRows(notExportedRows).map(csvLine));
  }
  return lines.join('\n') + '\n';
}
