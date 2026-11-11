// Acceso a Postgres. Las funciones necesitan transacciones, transiciones
// atómicas (UPDATE … WHERE estado = …) y pg_trgm, que el query builder no
// cubre; por eso usan SQL directo con DATABASE_URL. Ninguna tabla se expone a
// usuarios finales.
import { Pool } from 'pg';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

let pool: Pool | null = null;

export function dbDesdeEntorno(): Db {
  // DATABASE_URL (pruebas) o, en Vercel, la URL con pooler de la integración de
  // Neon, que llega con prefijo del proyecto. El valor siempre viene del entorno.
  const url = process.env.DATABASE_URL || process.env.KAIROS_AGENT_DATABASE_URL;
  if (!url) throw new Error('falta DATABASE_URL o KAIROS_AGENT_DATABASE_URL');
  // Serverless (Vercel): una instancia abre pocas conexiones y las cierra al quedar ociosa.
  // Con el pooler de Neon, `max` bajo es lo correcto.
  pool ??= new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 2),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  const p = pool;
  return {
    query: (sql, params) => p.query(sql, params as any[]) as any,
    async tx(fn) {
      const c = await p.connect();
      const db: Db = {
        query: (sql, params) => c.query(sql, params as any[]) as any,
        tx: (f) => f(db),
      };
      try {
        await c.query('BEGIN');
        const r = await fn(db);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
