import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from './zip';

describe('zip', () => {
  it('has the standard CRC-32 of "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes entries that can be found again through the central directory', () => {
    const zip = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }]);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    let at = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
      names.push(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)));
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      at += 46 + nameLength;
    }
    expect(names).toEqual(['a.txt', 'dir/b.bin']);
  });
});
