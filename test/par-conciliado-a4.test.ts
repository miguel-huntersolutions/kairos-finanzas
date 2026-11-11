// A4: un correo conciliado con su línea del extracto es UNA compra. No se trata como duplicado y
// no se puede descartar la línea del extracto (borraría la compra). Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import * as R from '../src/lib/referencias';
import { efectosFalsos, nuevaDb } from './apoyo';

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function parConciliado() {
  const { rows: [linea] } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por)
     VALUES (CURRENT_DATE, 50000, 12, 'LINEA EXTRACTO', 'confirmado', 'visa-bancolombia', 'extracto', 'sistema') RETURNING id::text AS id`,
  );
  const { rows: [correo] } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por, conciliado_con)
     VALUES (CURRENT_DATE, 50000, 12, 'CORREO', 'confirmado', 'visa-bancolombia', 'correo', 'sistema', $1) RETURNING id::text AS id`,
    [linea.id],
  );
  return { linea: linea.id as string, correo: correo.id as string };
}

describe('A4: par conciliado', () => {
  it('el correo y su línea no son gemelas (no es un duplicado)', async () => {
    const { correo } = await parConciliado();
    const m = await R.candidatoPorId(db, correo);
    expect(await R.gemelas(db, m!)).toEqual([]);
  });

  it('descartar la línea del extracto unida a un correo no borra la compra', async () => {
    const { linea } = await parConciliado();
    const { ef } = efectosFalsos();
    // Como «duplicada» no encuentra gemelas (es un par): no descarta nada.
    const r: any = await d.descartarMovimiento(db, ef, { movimiento_id: linea, motivo: 'duplicada', instruido_por: 'Miguel' } as any);
    expect(r.aplicado).toBe(false);
    // Con otro motivo, el guard de A4 lo rechaza.
    await expect(
      d.descartarMovimiento(db, ef, { movimiento_id: linea, motivo: 'otro', instruido_por: 'Miguel' } as any),
    ).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT estado FROM movimientos WHERE id = $1', [linea])).rows[0].estado).toBe('confirmado');
  });
});
