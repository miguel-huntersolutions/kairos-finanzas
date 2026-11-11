// Borrado de compras desde el tablero: irreversible, con guardas y constancia en la bitácora.
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { ErrorDominio, borrarMovimientoTablero } from '../src/lib/dominio';
import { nuevaDb } from './apoyo';

let db: Db;
const QUIEN = { correo: 'ana@ejemplo.com', persona: 'miguel' as const };

beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function compra(extra: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO movimientos (fecha, descripcion_original, valor, tarjeta_id, estado, fuente, persona, moneda, medio_pago)
     VALUES ('2026-11-02', 'Tienda de prueba', 45000, 'visa-bancolombia', 'confirmado', 'manual', 'miguel', 'COP', 'tarjeta_debito')
     RETURNING id::text AS id`,
  );
  const id = rows[0].id;
  if (Object.keys(extra).length) {
    const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(`UPDATE movimientos SET ${sets} WHERE id = $1`, [id, ...Object.values(extra)]);
  }
  return id;
}

describe('borrar compra desde el tablero', () => {
  it('borra la fila y deja copia de lo borrado en la bitácora', async () => {
    const id = await compra();
    expect(await borrarMovimientoTablero(db, { movimiento_id: id, confirmar: true }, QUIEN)).toEqual({ aplicado: true, borrado: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos WHERE id = $1`, [id])).rows[0].n).toBe(0);
    const b = (await db.query(`SELECT accion, actor, antes FROM bitacora WHERE accion = 'borrar_tablero'`)).rows[0];
    expect(b.actor).toBe('miguel');
    expect(b.antes).toMatchObject({ valor: 45000, comercio: 'Tienda de prueba', tarjeta: 'VISA', persona: 'miguel' });
  });

  it('sin confirmar: 400 y no borra nada', async () => {
    const id = await compra();
    await expect(borrarMovimientoTablero(db, { movimiento_id: id }, QUIEN)).rejects.toMatchObject({ status: 400 });
    await expect(borrarMovimientoTablero(db, { movimiento_id: id, confirmar: false }, QUIEN)).rejects.toMatchObject({ status: 400 });
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos WHERE id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('no borra una compra conciliada con el extracto (se descarta)', async () => {
    const id = await compra({ conciliado_en: new Date().toISOString() });
    const otra = await compra();
    await db.query(`UPDATE movimientos SET conciliado_con = $1 WHERE id = $2`, [id, otra]);
    const err = await borrarMovimientoTablero(db, { movimiento_id: id, confirmar: true }, QUIEN).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorDominio);
    expect(err).toMatchObject({ status: 409 });
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos WHERE id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('la pareja del extracto tampoco se borra sola', async () => {
    const pareja = await compra({ conciliado_en: new Date().toISOString() });
    const extracto = await compra();
    await db.query(`UPDATE movimientos SET conciliado_con = $1 WHERE id = $2`, [pareja, extracto]);
    await expect(borrarMovimientoTablero(db, { movimiento_id: extracto, confirmar: true }, QUIEN)).rejects.toMatchObject({ status: 409 });
  });

  it('una compra que no existe: 404', async () => {
    await expect(borrarMovimientoTablero(db, { movimiento_id: '00000000-0000-4000-8000-000000000000', confirmar: true }, QUIEN))
      .rejects.toMatchObject({ status: 404 });
  });

  it('borra también sus recordatorios pendientes (no quedan huérfanos)', async () => {
    const id = await compra();
    await db.query(`INSERT INTO recordatorios_pendientes (movimiento_id, pregunta_codigo, proxima_revision) VALUES ($1, 'AB12', now())`, [id]);
    await borrarMovimientoTablero(db, { movimiento_id: id, confirmar: true }, QUIEN);
    expect((await db.query(`SELECT count(*)::int AS n FROM recordatorios_pendientes`)).rows[0].n).toBe(0);
  });
});
