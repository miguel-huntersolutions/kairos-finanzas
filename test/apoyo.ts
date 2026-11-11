// Base de pruebas: PGlite (Postgres en proceso) con las MISMAS migraciones.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Db } from '../src/lib/db';
import type { Efectos, EventoHook } from '../src/lib/dominio';
// @ts-ignore módulo .mjs sin tipos
import { bloques } from '../scripts/partir-migraciones.mjs';

function adaptar(q: { query: PGlite['query'] }): Db {
  const db: Db = {
    query: (sql, params) => q.query(sql, params as any[]) as any,
    tx: (fn) => fn(db),
  };
  return db;
}

export async function nuevaDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  for (const { sql } of bloques() as Array<{ sql: string }>) await pg.query(sql);
  // Datos de prueba SINTÉTICOS: últimos 4 y destinos inventados.
  await pg.query(`UPDATE tarjetas SET ultimos_4 = CASE id
      WHEN 'visa-bancolombia' THEN '1111' WHEN 'plata-pay-miguel' THEN '2222'
      WHEN 'davibank' THEN '3333' WHEN 'plata-pay-katerine' THEN '4444' END
    WHERE id IN ('visa-bancolombia', 'plata-pay-miguel', 'davibank', 'plata-pay-katerine')`);
  await pg.query(`UPDATE config SET valor = CASE clave
      WHEN 'destino_grupo' THEN '"grupo-prueba@g.us"' WHEN 'destino_miguel' THEN '"+570000000001"'
      WHEN 'destino_katerine' THEN '"+570000000002"' ELSE valor END`);
  const db: Db = {
    query: (sql, params) => pg.query(sql, params as any[]) as any,
    tx: (fn) => pg.transaction((t) => fn(adaptar(t as any))),
  };
  return { db, pg };
}

export function efectosFalsos(extractor?: Efectos['extractor']) {
  const hooks: Array<{ movimiento_id: string; evento: EventoHook }> = [];
  const ef: Efectos = {
    avisarHook: async (p) => void hooks.push({ movimiento_id: p.movimiento_id, evento: p.evento }),
    extractor,
  };
  return { ef, hooks };
}

const dd = (n: number) => String(n).padStart(2, '0');
export const HOY = new Date();
export const fechaTexto = (d = HOY) => `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()}`;
export const mesActual = (d = HOY) => `${d.getFullYear()}-${dd(d.getMonth() + 1)}`;
