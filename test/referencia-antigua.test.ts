// Reclasificar por WhatsApp una compra de más de 30 días (p. ej. cargada con el extracto
// de octubre): con valor o fecha en la referencia, la búsqueda no se limita a 30 días.
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { nuevaDb } from './apoyo';

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

const haceDias = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

async function delExtracto(fecha: string, valor: number, descripcion: string) {
  const { rows } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por)
     VALUES ($1, $2, 12, $3, 'confirmado', 'visa-bancolombia', 'extracto', 'sistema') RETURNING id::text AS id`,
    [fecha, valor, descripcion],
  );
  return rows[0].id as string;
}

describe('referencia a una compra de hace más de 30 días', () => {
  it('con el valor, encuentra la compra del extracto y la clasifica', async () => {
    const id = await delExtracto(haceDias(45), 4_330_948, 'IC LOS ANGELES DOWNTOW');
    const r: any = await d.clasificar(db, {
      referencia: 'la de 4.330.948 de Los Angeles', categoria: 'reembolsable', numero_remitente: '+570000000001', canal: 'privado',
    });
    expect(r.aplicado).toBe(true);
    expect((await db.query('SELECT reembolsable, estado FROM movimientos WHERE id = $1', [id])).rows[0]).toMatchObject({ reembolsable: true, estado: 'confirmado' });
  });

  it('solo con el comercio (sin valor ni fecha) también la encuentra', async () => {
    await delExtracto(haceDias(45), 4_330_948, 'IC LOS ANGELES DOWNTOW');
    const r: any = await d.clasificar(db, {
      referencia: 'la del hotel Los Angeles Downtow', categoria: 'reembolsable', numero_remitente: '+570000000001', canal: 'privado',
    });
    expect(r.aplicado).toBe(true);
  });

  it('con otra compra pendiente, nombrar el comercio viejo no clasifica la pendiente por error', async () => {
    const vieja = await delExtracto(haceDias(45), 4_330_948, 'IC LOS ANGELES DOWNTOW');
    const { rows } = await db.query(
      `INSERT INTO movimientos (fecha, valor, descripcion_original, estado, tarjeta_id, fuente, pregunta_codigo, preguntado_a, destino)
       VALUES (current_date, 25000, 'FARMACIA X', 'esperando_respuesta', 'visa-bancolombia', 'correo', 'K7', 'grupo', 'grupo') RETURNING id::text AS id`,
    );
    const r: any = await d.clasificar(db, {
      referencia: 'la de Los Angeles', categoria: 'reembolsable', numero_remitente: '+570000000001', canal: 'privado',
    });
    expect(r.aplicado).toBe(true);
    expect((await db.query('SELECT reembolsable FROM movimientos WHERE id = $1', [vieja])).rows[0].reembolsable).toBe(true);
    expect((await db.query('SELECT estado FROM movimientos WHERE id = $1', [rows[0].id])).rows[0].estado).toBe('esperando_respuesta');
  });

  it('sin ningún criterio sigue usando solo las pendientes (no toca compras viejas)', async () => {
    await delExtracto(haceDias(45), 4_330_948, 'IC LOS ANGELES DOWNTOW');
    const r: any = await d.clasificar(db, { categoria: 'mercado', numero_remitente: '+570000000001', canal: 'privado' });
    expect(r.aplicado).toBe(false);
  });
});
