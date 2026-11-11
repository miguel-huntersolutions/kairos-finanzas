// El resumen del agente y el tablero no cuentan dos veces una compra que llegó por
// correo y luego en el extracto (misma regla que el tablero: conciliacion.ts). SINTÉTICO.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { resumen } from '../src/lib/dominio';
import { idsQueNoSuman } from '../src/lib/efectivos';
import { datosTablero } from '../src/lib/tablero';
import { nuevaDb } from './apoyo';

describe('sin doble conteo entre correo y extracto', () => {
  let db: Db;
  const ids: Record<string, string> = {};
  async function mov(clave: string, fecha: string, valor: number, fuente: string, extra: { reembolsable?: boolean; conciliado_con?: string } = {}) {
    const { rows } = await db.query(
      `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, clasificado_por, reembolsable, conciliado_con)
       VALUES ($1, $2, 2, $3, 'confirmado', 'visa-bancolombia', $4, 'sistema', $5, $6) RETURNING id`,
      [fecha, valor, `COMERCIO ${clave}`, fuente, extra.reembolsable ?? false, extra.conciliado_con ?? null],
    );
    ids[clave] = rows[0].id;
  }

  beforeEach(async () => {
    ({ db } = await nuevaDb());
    await mov('ext', '2026-10-10', 100_000, 'extracto', { reembolsable: true });
    await mov('dup', '2026-10-08', 100_000, 'correo', { reembolsable: true }); // misma compra, 2 días antes
    await mov('sola', '2026-10-15', 30_000, 'correo'); // sin extracto: suma
    await mov('ext2', '2026-10-20', 50_000, 'extracto');
    await mov('conc', '2026-10-21', 50_000, 'correo', { conciliado_con: ids.ext2 }); // ya conciliada
  });

  it('idsQueNoSuman: el posible duplicado y la ya conciliada', async () => {
    expect((await idsQueNoSuman(db)).sort()).toEqual([ids.dup, ids.conc].sort());
  });

  it('resumen cuenta cada compra una sola vez', async () => {
    const r = await resumen(db, { mes: '2026-10' });
    expect(r.total).toBe(180_000); // 100.000 + 30.000 + 50.000
    expect(r.cantidad).toBe(3);
    expect(r.reembolsable).toBe(100_000);
    const nov = await resumen(db, { mes: '2026-11' });
    expect(nov.variaciones_fuertes).toEqual([]); // el mes anterior tampoco cuenta doble
  });

  it('tablero: tendencia y categorías sin doble conteo; la fila duplicada no suma', async () => {
    const t = await datosTablero(db, '2026-10');
    expect(t.tendencia.at(-1)).toMatchObject({ mes: '2026-10', total: 180_000, cantidad: 3, reembolsable: 100_000 });
    expect(t.categorias_por_mes.reduce((s: number, c: any) => s + c.total, 0)).toBe(180_000);
    expect(t.movimientos.find((m: any) => m.id === ids.dup)).toMatchObject({ suma: false });
    expect(t.reembolsables.map((m: any) => m.id)).toEqual([ids.ext]);
  });
});
