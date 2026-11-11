// Envoltura común de las funciones-herramienta (modo HTTP).
// Autenticación: Bearer FINANZAS_API_TOKEN (solo lo tiene finanzas-mcp).
// Validación: se repite el esquema estricto de la herramienta (barrera real).
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Db, dbDesdeEntorno } from './db';
import { type Efectos, ErrorDominio } from './dominio';
import { efectosDesdeEntorno } from './efectos';
import { CONTEXTO, type Contexto, ESQUEMAS, type Entrada, type Herramienta } from './esquemas';
import { REGISTRO } from './registro';

export interface EventoHttp {
  __evento_http?: boolean;
  method?: string;
  headers?: Record<string, string[] | string>;
  body?: string;
  is_base64_encoded?: boolean;
}

export const responder = (statusCode: number, cuerpo: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(cuerpo),
});

export function tokenValido(suministrado: string, esperado: string | undefined): boolean {
  if (!esperado || !suministrado) return false;
  const a = createHash('sha256').update(suministrado).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

export function cabecera(ev: EventoHttp, nombre: string): string {
  const h = ev.headers ?? {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === nombre);
  const v = k ? h[k] : undefined;
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export function cuerpoTexto(ev: EventoHttp): string {
  const b = ev.body ?? '';
  return ev.is_base64_encoded ? Buffer.from(b, 'base64').toString('utf8') : b;
}

/** Herramientas que no escriben: no guardan operacion_id. */
const SOLO_LECTURA = new Set<Herramienta>(['resumen', 'repaso', 'pendientes', 'reembolsos']);
const OPERACION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ejecuta una herramienta con validación; separado del transporte para probarlo.
 * Con `operacion_id` (lo genera el MCP en cada escritura) la llamada es idempotente:
 * - repetida con el mismo contenido → devuelve la respuesta original sin aplicar nada;
 * - repetida con otro contenido → 409;
 * - repetida mientras la primera sigue en curso → 409 con `en_curso: true`.
 * Un 5xx no se guarda: el reintento vuelve a ejecutar (las operaciones fallan dentro de su transacción).
 */
export async function ejecutarHerramienta(
  nombre: Herramienta,
  entradaCruda: unknown,
  contextoCrudo: unknown,
  db: Db,
  ef: Efectos,
  operacion_id?: unknown,
) {
  const entrada = ESQUEMAS[nombre].safeParse(entradaCruda ?? {});
  if (!entrada.success) return responder(400, { error: 'entrada inválida', detalle: entrada.error.issues });
  const ctx = CONTEXTO.safeParse(contextoCrudo ?? {});
  if (!ctx.success) return responder(400, { error: 'contexto inválido' });
  if (operacion_id !== undefined && (typeof operacion_id !== 'string' || !OPERACION.test(operacion_id)))
    return responder(400, { error: 'operacion_id inválido' });
  const op = typeof operacion_id === 'string' && !SOLO_LECTURA.has(nombre) ? operacion_id : null;
  const huella = createHash('sha256').update(`${nombre}\n${JSON.stringify(entrada.data)}`).digest('hex');
  if (op) {
    const { rows } = await db.query(
      `INSERT INTO operaciones (id, herramienta, huella) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [op, nombre, huella],
    );
    if (!rows[0]) {
      const previa = (await db.query(`SELECT herramienta, huella, status, respuesta FROM operaciones WHERE id = $1`, [op])).rows[0];
      if (!previa || previa.herramienta !== nombre || previa.huella !== huella)
        return responder(409, { error: 'operacion_id repetido con otro contenido' });
      if (previa.status == null) return responder(409, { error: 'operación en curso', en_curso: true });
      return responder(previa.status, previa.respuesta);
    }
  }
  let res: ReturnType<typeof responder>;
  try {
    const fn = REGISTRO[nombre] as (db: Db, ef: Efectos, e: Entrada<typeof nombre>, c: Contexto) => Promise<unknown>;
    res = responder(200, await fn(db, ef, entrada.data as any, ctx.data));
  } catch (e) {
    if (e instanceof ErrorDominio) res = responder(e.status, { error: e.message });
    else {
      console.error(`[${nombre}]`, e);
      res = responder(500, { error: 'error interno' });
    }
  }
  if (op) {
    if (res.statusCode >= 500) await db.query(`DELETE FROM operaciones WHERE id = $1`, [op]);
    else await db.query(`UPDATE operaciones SET status = $2, respuesta = $3 WHERE id = $1`, [op, res.statusCode, res.body]);
  }
  return res;
}

export function herramienta(nombre: Herramienta) {
  return async (ev: EventoHttp) => {
    if (!ev?.__evento_http) return responder(400, { error: 'solo HTTP' });
    if ((ev.method ?? '').toUpperCase() !== 'POST') return responder(405, { error: 'usar POST' });
    const auth = cabecera(ev, 'authorization');
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!tokenValido(token, process.env.FINANZAS_API_TOKEN)) return responder(401, { error: 'no autorizado' });
    let cuerpo: { entrada?: unknown; contexto?: unknown; operacion_id?: unknown };
    try {
      cuerpo = JSON.parse(cuerpoTexto(ev) || '{}');
    } catch {
      return responder(400, { error: 'cuerpo no es JSON' });
    }
    return ejecutarHerramienta(nombre, cuerpo.entrada, cuerpo.contexto, dbDesdeEntorno(), efectosDesdeEntorno(), cuerpo.operacion_id);
  };
}
