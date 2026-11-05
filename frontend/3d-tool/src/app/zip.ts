/** A minimal ZIP writer (stored, no compression: STL-sized exports are mostly binary and already small enough). */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; data: Uint8Array }

/** The bytes of a zip file holding these entries (names are UTF-8, the time is `date`). */
export function buildZip(entries: ZipEntry[], date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const names = entries.map(e => encoder.encode(e.name));
  const size = entries.reduce((sum, e, i) => sum + 30 + names[i].length + e.data.length + 46 + names[i].length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const central: { offset: number; crc: number }[] = [];
  entries.forEach((entry, i) => {
    const crc = crc32(entry.data);
    central.push({ offset, crc });
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, 0, true); // stored
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, names[i].length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(names[i], offset + 30);
    out.set(entry.data, offset + 30 + names[i].length);
    offset += 30 + names[i].length + entry.data.length;
  });
  const centralStart = offset;
  entries.forEach((entry, i) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, dosTime, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, central[i].crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, names[i].length, true);
    view.setUint32(offset + 42, central[i].offset, true);
    out.set(names[i], offset + 46);
    offset += 46 + names[i].length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return out;
}
