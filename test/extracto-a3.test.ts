// A3: una compra marcada «no aparece» en un corte se empareja en el corte siguiente y no suma dos veces.
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { idsQueNoSuman } from "../src/lib/efectivos";
import { procesarExtracto } from "../src/lib/extracto";
import { nuevaDb } from './apoyo';

const pdf = (marca: string) => new TextEncoder().encode(`%PDF-1.7\n% extracto sintético ${marca}\n%%EOF`);
const lectorDe = (lineas: Array<{ fecha: string; descripcion: string; valor: number }>, fecha_corte: string) =>
  async () => ({ tarjeta_ultimos_4: '1111', fecha_corte, lineas, total_compras: lineas.reduce((s, l) => s + l.valor, 0) });

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

describe('A3: no aparece → se cobra en el corte siguiente', () => {
  it('la compra del correo se empareja en el corte siguiente y el total no se duplica', async () => {
    // Compra por correo del 10/10 de 50.000 que el corte del 25/10 no trae.
    await db.query(
      `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por)
       VALUES ('2026-10-10', 50000, 12, 'COMPRA CORREO', 'confirmado', 'visa-bancolombia', 'correo', 'sistema')`,
    );
    await procesarExtracto(db, pdf('corte-octubre'), lectorDe([{ fecha: '2026-10-20', descripcion: 'OTRA TIENDA', valor: 9_000 }], '2026-10-25'), 'Miguel', new Date('2026-10-26T12:00:00Z'));
    const marcada = (await db.query(`SELECT no_aparece_en_extracto IS NOT NULL AS marcada FROM movimientos WHERE fuente = 'correo'`)).rows[0];
    expect(marcada.marcada).toBe(true);

    // El corte del 05/11 trae la compra del 10/10.
    await procesarExtracto(db, pdf('corte-noviembre'), lectorDe([{ fecha: '2026-10-10', descripcion: 'COMPRA CORREO', valor: 50_000 }], '2026-11-05'), 'Miguel', new Date('2026-11-06T12:00:00Z'));
    const correo = (await db.query(`SELECT conciliado_con IS NOT NULL AS unido, no_aparece_en_extracto FROM movimientos WHERE fuente = 'correo'`)).rows[0];
    expect(correo.unido).toBe(true);
    expect(correo.no_aparece_en_extracto).toBeNull();
    const noSuman = await idsQueNoSuman(db);
    const total = Number((await db.query(`SELECT COALESCE(SUM(valor), 0)::int AS t FROM movimientos WHERE estado <> 'descartado' AND fecha = '2026-10-10' AND NOT (id = ANY($1::uuid[]))`, [noSuman])).rows[0].t);
    expect(total).toBe(50_000); // el correo y su línea del extracto cuentan como UNA compra
  });
});
