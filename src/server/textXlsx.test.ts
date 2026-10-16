import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { columnLetter, crc32, textXlsx, xmlText } from './textXlsx';

/** Reads our own zip back through its central directory. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const endAt = buf.length - 22;
  expect(buf.readUInt32LE(endAt)).toBe(0x06054b50);
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26);
    const data = inflateRawSync(buf.subarray(dataAt, dataAt + size));
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

describe('textXlsx', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('names columns the way Excel does', () => {
    expect([0, 25, 26, 33].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AH']);
  });

  it('escapes XML and drops characters XML cannot hold', () => {
    expect(xmlText('A & <B> "C"\u0001')).toBe('A &amp; &lt;B&gt; &quot;C&quot;');
  });

  it('writes every part Excel needs, with every cell as text', () => {
    const files = unzip(
      textXlsx({ name: 'Sheet1', rows: [['CBS', '', '09/2026'], ['**********']], columnCount: 3 })
    );
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A1" s="1" t="s"><v>0</v></c>');
    expect(sheet).toContain('<c r="C1" s="1" t="s"><v>1</v></c>');
    expect(sheet).not.toContain('r="B1"'); // empty stays empty
    expect(sheet).toContain('<c r="A2" s="1" t="s"><v>2</v></c>');
    expect(files.get('xl/sharedStrings.xml')).toContain('<si><t>09/2026</t></si>');
    expect(files.get('xl/styles.xml')).toContain('numFmtId="49"');
  });

  it('keeps Greek text intact', () => {
    const files = unzip(textXlsx({ name: 'Sheet1', rows: [['ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ €']], columnCount: 1 }));
    expect(files.get('xl/sharedStrings.xml')).toContain('ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ €');
  });
});
