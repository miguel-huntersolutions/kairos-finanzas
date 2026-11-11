// Cifras de ingresos y reembolsos pendientes. Sin dependencias del dominio: las usan el resumen
// (dominio.ts) y las herramientas de ingresos (ingresos.ts).
import type { Db } from './db';
import { idsQueNoSuman } from './efectivos';

export type TipoIngreso = 'salario' | 'reembolso' | 'otro';
export const NOMBRE_TIPO: Record<TipoIngreso, string> = { salario: 'Salario', reembolso: 'Reembolso de la empresa', otro: 'Otro ingreso' };

export interface CompraReembolsable {
  n: number;
  movimiento_id: string;
  fecha: string;
  comercio: string;
  valor: number;
}

/**
 * Compras reembolsables que la empresa aún no paga, de la más vieja a la más nueva.
 * Sin doble conteo: una compra por correo con su fila del extracto cuenta una vez. El orden
 * (fecha, creación, id) es estable: los números de la lista sirven entre dos llamadas.
 */
export async function reembolsablesPendientes(db: Db): Promise<CompraReembolsable[]> {
  const noSuman = await idsQueNoSuman(db);
  const { rows } = await db.query(
    `SELECT m.id::text AS movimiento_id, m.fecha::text AS fecha, COALESCE(c.nombre, m.descripcion_original, 'Compra') AS comercio,
            m.valor::bigint AS valor
     FROM movimientos m LEFT JOIN comercios c ON c.id = m.comercio_id
     WHERE m.reembolsable AND m.reembolso_id IS NULL AND m.estado <> 'descartado' AND NOT (m.id = ANY($1::uuid[]))
     ORDER BY m.fecha, m.creado_en, m.id`,
    [noSuman],
  );
  return rows.map((r: any, i: number) => ({ n: i + 1, movimiento_id: r.movimiento_id, fecha: r.fecha, comercio: r.comercio, valor: Number(r.valor) }));
}

export interface CifrasIngresos {
  total: number;
  /** Lo que entró sin contar reembolsos (salario y otros). */
  propios: number;
  reembolsos: number;
  por_persona: Array<{ persona: string; total: number }>;
  por_tipo: Array<{ tipo: TipoIngreso; total: number }>;
  cantidad: number;
}

/** Ingresos confirmados de un mes (aaaa-mm), opcionalmente de una persona. */
export async function cifrasIngresos(db: Db, mes: string, persona?: string): Promise<CifrasIngresos> {
  const params: unknown[] = [`${mes}-01`];
  let filtro = '';
  if (persona) {
    params.push(persona);
    filtro = ' AND persona = $2';
  }
  const where = `WHERE estado = 'confirmado' AND fecha >= $1::date AND fecha < ($1::date + interval '1 month')${filtro}`;
  const [tot] = (await db.query(
    `SELECT COALESCE(SUM(valor), 0)::bigint AS total, COUNT(*)::int AS cantidad,
            COALESCE(SUM(valor) FILTER (WHERE tipo = 'reembolso'), 0)::bigint AS reembolsos FROM ingresos ${where}`,
    params,
  )).rows;
  const porPersona = (await db.query(`SELECT persona, SUM(valor)::bigint AS total FROM ingresos ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
  const porTipo = (await db.query(`SELECT tipo, SUM(valor)::bigint AS total FROM ingresos ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
  const total = Number(tot.total);
  const reembolsos = Number(tot.reembolsos);
  return {
    total,
    propios: total - reembolsos,
    reembolsos,
    cantidad: tot.cantidad,
    por_persona: porPersona.map((r: any) => ({ persona: r.persona, total: Number(r.total) })),
    por_tipo: porTipo.map((r: any) => ({ tipo: r.tipo, total: Number(r.total) })),
  };
}
