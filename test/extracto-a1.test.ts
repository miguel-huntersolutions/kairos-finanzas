// A1: volver a subir el mismo corte con otra huella NO duplica las compras. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { procesarExtracto } from '../src/lib/extracto';
import { nuevaDb } from './apoyo';

const HOY = new Date('2026-11-07T15:00:00Z');
const pdf = (marca: string) => new TextEncoder().encode(`%PDF-1.7\n% extracto sintético ${marca}\n%%EOF`);
const lectura = {
  tarjeta_ultimos_4: '1111', fecha_corte: '2026-10-25',
  lineas: [
    { fecha: '2026-10-11', descripcion: 'TIENDA UNO', valor: 60_000 },
    { fecha: '2026-10-12', descripcion: 'TIENDA DOS', valor: 60_000 },
  ],
  total_compras: 120_000,
};
const lector = async () => lectura;

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

describe('A1: mismo corte con otra huella', () => {
  it('la segunda subida se marca repetida y no suma otra vez', async () => {
    const primera = await procesarExtracto(db, pdf('descarga-1'), lector, 'Miguel', HOY);
    expect(primera.repetido).toBe(false);
    const segunda = await procesarExtracto(db, pdf('descarga-2-otros-metadatos'), lector, 'Miguel', HOY);
    expect(segunda.repetido).toBe(true);

    const extractos = Number((await db.query(`SELECT count(*)::int AS n FROM extractos WHERE fecha_corte = '2026-10-25'`)).rows[0].n);
    expect(extractos).toBe(1);
    const filas = Number((await db.query(`SELECT count(*)::int AS n FROM movimientos WHERE fuente = 'extracto'`)).rows[0].n);
    expect(filas).toBe(2);
    const total = Number((await db.query(`SELECT COALESCE(SUM(valor), 0)::int AS t FROM movimientos WHERE fuente = 'extracto'`)).rows[0].t);
    expect(total).toBe(120_000);
  });
});
