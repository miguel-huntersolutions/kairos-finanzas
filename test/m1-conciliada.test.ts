// M1 y B5: correo y línea del extracto conciliados son UNA compra. Valor, fecha y tarjeta salen del
// extracto; categoría y persona se copian a la pareja; la bitácora guarda el comercio anterior. SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { nuevaDb } from './apoyo';

const quien = { correo: 'ana@ejemplo.com', persona: 'miguel' as const };
let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function parConciliado() {
  const { rows: [linea] } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por)
     VALUES ('2026-10-10', 50000, 12, 'LINEA EXTRACTO', 'confirmado', 'visa-bancolombia', 'extracto', 'sistema') RETURNING id::text AS id`,
  );
  const { rows: [correo] } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por, conciliado_con)
     VALUES ('2026-10-10', 50000, 12, 'CORREO', 'confirmado', 'visa-bancolombia', 'correo', 'sistema', $1) RETURNING id::text AS id`,
    [linea.id],
  );
  return { linea: linea.id as string, correo: correo.id as string };
}

describe('M1: compra conciliada', () => {
  it('cambiar el valor de la compra conciliada se rechaza (409) y no cambia nada', async () => {
    const { correo } = await parConciliado();
    await expect(d.editarMovimientoTablero(db, { movimiento_id: correo, valor: 70_000 }, quien)).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT valor FROM movimientos WHERE id = $1', [correo])).rows[0].valor).toBe(50000);
  });

  it('cambiar la categoría se copia a la fila del extracto (la que suma)', async () => {
    const { correo, linea } = await parConciliado();
    await d.editarMovimientoTablero(db, { movimiento_id: correo, categoria_id: 3 }, quien);
    const filas = (await db.query('SELECT id, categoria_id FROM movimientos WHERE id = ANY($1::uuid[]) ORDER BY fuente', [[correo, linea]])).rows;
    expect(filas.every((f: any) => f.categoria_id === 3)).toBe(true);
  });

  it('la bitácora guarda el comercio anterior en «antes»', async () => {
    const { correo } = await parConciliado();
    await d.editarMovimientoTablero(db, { movimiento_id: correo, comercio: 'Tienda Nueva' }, quien);
    const b = (await db.query(`SELECT antes FROM bitacora WHERE movimiento_id = $1 AND accion = 'editar_tablero' ORDER BY id DESC LIMIT 1`, [correo])).rows[0];
    expect(b.antes.comercio).not.toBe('Tienda Nueva');
  });
});
