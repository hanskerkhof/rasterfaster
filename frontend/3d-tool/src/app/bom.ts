import { DocItem, PartStats } from './document.store';

export interface BomRow {
  path: string;
  name: string;
  quantity: number;
  /** Undefined until the STL has been loaded. */
  stats?: PartStats;
}

/** One row per distinct library file, counting how often it is used. Parts marked "Do not export" are left out. */
export function buildBom(items: DocItem[], stats: Record<string, PartStats>): BomRow[] {
  const rows = new Map<string, BomRow>();
  for (const item of items) {
    if (item.noExport) continue; // mock parts that are not printed
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

export function bomToCsv(rows: BomRow[]): string {
  const header = ['Part', 'Qty', 'Size X (mm)', 'Size Y (mm)', 'Size Z (mm)', 'Volume each (cm3)', 'Volume total (cm3)', 'File'];
  const lines = rows.map(r => [
    r.name, r.quantity,
    ...(r.stats ? r.stats.size.map(v => round(v)) : ['', '', '']),
    r.stats ? round(r.stats.volumeCm3, 2) : '',
    r.stats ? round(r.stats.volumeCm3 * r.quantity, 2) : '',
    r.path,
  ]);
  const totalQty = rows.reduce((sum, r) => sum + r.quantity, 0);
  const totalVolume = rows.reduce((sum, r) => sum + (r.stats ? r.stats.volumeCm3 * r.quantity : 0), 0);
  lines.push(['TOTAL', totalQty, '', '', '', '', round(totalVolume, 2), '']);
  return [header, ...lines].map(line => line.map(csvCell).join(',')).join('\n') + '\n';
}
