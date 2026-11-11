// Excel SINTÉTICO para las pruebas del lector de reportes: un zip mínimo (deflate + crc32)
// con la misma forma que el export «Movimientos de tus tarjetas» (hoja con r:id="rId4",
// textos compartidos y fechas como número de serie). Comercios y valores inventados.
import { deflateRawSync } from 'node:zlib';

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Zip con las entradas dadas (deflate, o sin comprimir si `guardar`). */
export function crearZip(entradas: Record<string, string | Buffer>, guardar = false): Uint8Array {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;
  for (const [nombre, contenido] of Object.entries(entradas)) {
    const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
    const comp = guardar ? datos : deflateRawSync(datos);
    const n = Buffer.from(nombre, 'utf8');
    const crc = crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(guardar ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(guardar ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locales.push(local, n, comp);
    centrales.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(entradas).length, 8);
  fin.writeUInt16LE(Object.keys(entradas).length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locales, dir, fin]));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letra = (i: number) => String.fromCharCode(65 + i);

/**
 * xlsx con una hoja. Celdas: número → <v>; texto → texto compartido (o inline si `inline`);
 * null → celda omitida.
 */
export function crearXlsx(filas: Array<Array<string | number | null>>, opciones: { inline?: boolean; guardar?: boolean } = {}): Uint8Array {
  const compartidos: string[] = [];
  const indice = (s: string) => {
    let i = compartidos.indexOf(s);
    if (i < 0) i = compartidos.push(s) - 1;
    return i;
  };
  const filasXml = filas
    .map((f, r) => {
      const celdas = f
        .map((c, j) => {
          const ref = `${letra(j)}${r + 1}`;
          if (c == null) return '';
          if (typeof c === 'number') return `<c r="${ref}"${j === 0 && r > 0 ? ' s="2"' : ''}><v>${c}</v></c>`;
          if (opciones.inline) return `<c r="${ref}" t="inlineStr"><is><t>${xml(c)}</t></is></c>`;
          return `<c r="${ref}" t="s"><v>${indice(c)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${celdas}</row>`;
    })
    .join('');
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return crearZip(
    {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet sheetId="1" name="Hoja 1" state="visible" r:id="rId4"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="styles" Target="styles.xml"/><Relationship Id="rId4" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst ${ns}>${compartidos.map((s) => `<si><t>${xml(s)}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${filasXml}</sheetData></worksheet>`,
    },
    opciones.guardar,
  );
}

/** Número de serie de Excel de una fecha aaaa-mm-dd. */
export const serie = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
