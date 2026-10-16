import { deflateRawSync } from 'node:zlib';

/**
 * A minimal .xlsx writer for one sheet of TEXT cells.
 *
 * Why this exists instead of a library: the only spreadsheet ZET writes is
 * the Sofia export — one sheet, every cell text, a handful of rows. exceljs
 * did that, but it is unmaintained (last release 2023) and drags in a tree
 * of deprecated packages that npm audit flags. What we need is small enough
 * to own outright.
 *
 * An .xlsx is a zip holding a few XML files. This writes exactly the parts
 * Excel requires, plus shared strings and one text style:
 *
 *   [Content_Types].xml          what each part is
 *   _rels/.rels                  where the workbook is
 *   xl/workbook.xml              the sheet list
 *   xl/_rels/workbook.xml.rels   where the sheet, styles and strings are
 *   xl/styles.xml                style 1 = number format 49, which is «@»
 *   xl/sharedStrings.xml         every cell's text, once
 *   xl/worksheets/sheet1.xml     the grid
 *
 * Every column carries the text style too, so anything typed into an empty
 * cell later is also text — the same as the template, where Excel would
 * otherwise turn "09/2026" into a date.
 *
 * No dependencies beyond node:zlib (deflate). CRC-32 is computed here so it
 * does not depend on a Node version that ships zlib.crc32.
 */

export interface TextSheet {
  name: string;
  rows: string[][];
  /** Column widths in Excel's character units, by column index. */
  widths?: Record<number, number>;
  /** How many columns carry the text style and a width. */
  columnCount: number;
}

// ── XML ────────────────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escapes text for XML, and drops control characters XML 1.0 forbids
 *  (a pasted invoice number can carry one; Excel refuses the file). */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA, 33 → AH. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(sheet: TextSheet, stringIndex: (s: string) => number): string {
  const cols: string[] = [];
  for (let c = 0; c < sheet.columnCount; c++) {
    const w = sheet.widths?.[c] ?? 8;
    cols.push(`<col min="${c + 1}" max="${c + 1}" width="${w}" style="1" customWidth="1"/>`);
  }
  const rows = sheet.rows.map((row, r) => {
    const cells = row
      .map((value, c) =>
        value === ''
          ? ''
          : `<c r="${columnLetter(c)}${r + 1}" s="1" t="s"><v>${stringIndex(value)}</v></c>`
      )
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  });
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<cols>${cols.join('')}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

function partsFor(sheet: TextSheet): Array<[string, string]> {
  const strings: string[] = [];
  const seen = new Map<string, number>();
  const stringIndex = (s: string) => {
    let i = seen.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      seen.set(s, i);
    }
    return i;
  };
  let cellCount = 0;
  for (const row of sheet.rows) for (const v of row) if (v !== '') cellCount++;

  const worksheet = sheetXml(sheet, stringIndex);
  const shared =
    XML_HEAD +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${cellCount}" uniqueCount="${strings.length}">` +
    strings
      .map((s) => `<si><t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${xmlText(s)}</t></si>`)
      .join('') +
    '</sst>';

  return [
    [
      '[Content_Types].xml',
      XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlText(sheet.name)}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '</Relationships>',
    ],
    [
      'xl/styles.xml',
      XML_HEAD +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    ],
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', worksheet],
  ];
}

// ── Zip ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as zip headers store them. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(files: Array<[string, Uint8Array]>, when = new Date()): Buffer {
  const { time, date } = dosDateTime(when);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all 0
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

export function textXlsx(sheet: TextSheet, when?: Date): Buffer {
  return zip(
    partsFor(sheet).map(([name, xml]) => [name, Buffer.from(xml, 'utf8')]),
    when
  );
}
