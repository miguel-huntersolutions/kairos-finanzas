// Medios de pago y sus orígenes (crédito, débito, efectivo).
// La tabla `tarjetas` guarda los MEDIOS: tarjetas, cuentas, PSE, efectivo. Su columna `clase` es
// el origen (FK a `origenes_pago`). Un origen con `registro_chat = false` (crédito) no se registra
// a mano por chat: sus compras llegan por correo o por el extracto.
import { z } from 'zod';
import type { Db } from './db';
import { plano } from './referencias';

export interface Medio {
  id: string;
  nombre: string;
  banco?: string | null;
  clase: string;
  tipo: string;
  persona_default: string | null;
  ultimos_4: string | null;
  alias?: string[] | null;
  canal?: string | null;
  activa?: boolean;
  origen_nombre?: string | null;
  registro_chat?: boolean | null;
}

export type Canal = 'tarjeta' | 'efectivo' | 'pse' | 'bre_b' | 'transferencia' | 'otro';
export const CANALES: Canal[] = ['tarjeta', 'efectivo', 'pse', 'bre_b', 'transferencia', 'otro'];

export async function cargarMedios(db: Db, { incluirInactivos = false } = {}): Promise<Medio[]> {
  const { rows } = await db.query<Medio>(
    `SELECT t.id, t.nombre, t.banco, t.clase, t.tipo, t.persona_default, t.ultimos_4, t.alias, t.canal, t.activa,
            o.nombre AS origen_nombre, o.registro_chat
     FROM tarjetas t LEFT JOIN origenes_pago o ON o.id = t.clase
     ${incluirInactivos ? '' : 'WHERE t.activa'}
     ORDER BY o.orden NULLS LAST, t.orden, t.nombre`,
  );
  return rows;
}

// Palabras que no identifican un medio.
const RUIDO = new Set([
  'tarjeta', 'tarjetas', 'cuenta', 'la', 'el', 'lo', 'de', 'del', 'las', 'los', 'mi', 'mis', 'su', 'con', 'desde', 'por',
  'en', 'un', 'una', 'y', 'o', 'a', 'al', 'es', 'fue', 'son', 'pago', 'pague', 'pagado', 'pagada', 'pagamos', 'todas',
  'todos', 'esas', 'estas', 'esa', 'esta', 'ese', 'este', 'que', 'se', 'hizo', 'hice', 'medio', 'metodo',
]);

/** Palabras de canal: dicen CÓMO se pagó, no con qué medio (se sacan antes de buscar el medio). */
const CANAL_PALABRAS: Array<[RegExp, Canal]> = [
  [/\bpse\b/, 'pse'],
  [/\bbre ?b\b|\bbreb\b|\bllave\b/, 'bre_b'],
  [/\btransferenci\w*|\btransferi\w*/, 'transferencia'],
  [/\befectivo\b|\bcash\b/, 'efectivo'],
];

/** Canal que menciona el texto ("pagué por PSE desde…" → pse), o null. */
export function canalDeTexto(texto: string): Canal | null {
  const t = plano(texto);
  for (const [re, canal] of CANAL_PALABRAS) if (re.test(t)) return canal;
  return null;
}

export type ResultadoMedio =
  | { tipo: 'unico'; medio: Medio; canal: Canal | null; metodo: 'ultimos_4' | 'alias' | 'palabras' | 'canal' }
  | { tipo: 'ambiguo' | 'ninguno'; candidatos: Medio[]; canal: Canal | null };

/**
 * Texto de la persona → medio de pago. Reglas, en orden:
 *  1. Cuatro dígitos → el medio con esos últimos 4.
 *  2. Alias completo ("nu kate", "débito bancolombia") → el alias más largo que aparezca.
 *  3. Palabras: TODAS las palabras significativas deben corresponder al medio (nombre, banco,
 *     origen o alias). Una palabra que no corresponde a ninguno ("nu" sin medio NU) = ninguno:
 *     nunca se adivina el medio más parecido.
 *  4. Sin palabras propias, solo el canal ("efectivo", "PSE") → el medio de ese canal.
 */
export function medioDeTexto(texto: string, medios: Medio[]): ResultadoMedio {
  const t = plano(texto);
  const canal = canalDeTexto(t);
  const ultimos = t.match(/(?<!\d)(\d{4})(?!\d)/)?.[1];
  if (ultimos) {
    const m = medios.filter((x) => x.ultimos_4 === ultimos);
    return m.length === 1 ? { tipo: 'unico', medio: m[0], canal, metodo: 'ultimos_4' } : { tipo: 'ninguno', candidatos: [], canal };
  }

  const rodeado = ` ${t} `;
  const porAlias = medios
    .flatMap((m) => (m.alias ?? []).map((a) => ({ m, a: plano(a) })))
    .filter(({ a }) => a && rodeado.includes(` ${a} `))
    .sort((x, y) => y.a.length - x.a.length);
  if (porAlias.length) {
    const largo = porAlias[0].a.length;
    const mejores = [...new Set(porAlias.filter((x) => x.a.length === largo).map((x) => x.m))];
    // Un alias que es solo una palabra de canal ("pse", "efectivo") no gana si hay otras palabras propias.
    const soloCanal = canalDeTexto(porAlias[0].a) !== null;
    if (mejores.length === 1 && !(soloCanal && palabrasPropias(t, porAlias[0].a).length)) {
      return { tipo: 'unico', medio: mejores[0], canal, metodo: 'alias' };
    }
  }

  const palabras = palabrasPropias(t);
  if (palabras.length) {
    const coincide = medios.filter((m) => {
      const vocab = plano([m.nombre, m.id.replaceAll('-', ' '), m.banco ?? '', m.origen_nombre ?? m.clase, ...(m.alias ?? [])].join(' ')).split(' ');
      return palabras.every((p) => vocab.some((v) => v === p || (p.length >= 3 && v.startsWith(p))));
    });
    if (coincide.length === 1) return { tipo: 'unico', medio: coincide[0], canal, metodo: 'palabras' };
    return { tipo: coincide.length ? 'ambiguo' : 'ninguno', candidatos: coincide, canal };
  }

  if (canal) {
    const delCanal = medios.filter((m) => m.canal === canal);
    if (delCanal.length === 1) return { tipo: 'unico', medio: delCanal[0], canal, metodo: 'canal' };
  }
  return { tipo: 'ninguno', candidatos: [], canal };
}

/** Palabras del texto que pueden nombrar un medio (sin ruido ni palabras de canal). */
export function palabrasPropias(t: string, quitar = ''): string[] {
  let x = ` ${t} `;
  if (quitar) x = x.replace(` ${quitar} `, ' ');
  for (const [re] of CANAL_PALABRAS) x = x.replace(new RegExp(re.source, 'g'), ' ');
  return x.split(' ').filter((p) => p && !RUIDO.has(p));
}

/** Nombre legible del medio para los mensajes: "NU Katerine (débito)", "Efectivo", "PSE". */
export function nombreMedio(m: Pick<Medio, 'nombre' | 'canal' | 'origen_nombre' | 'clase'>): string {
  if (m.canal && m.canal !== 'tarjeta') return m.nombre;
  const origen = (m.origen_nombre ?? m.clase ?? '').toLowerCase();
  return origen && !plano(m.nombre).includes(plano(origen)) ? `${m.nombre} (${origen})` : m.nombre;
}

/** Forma de pago guardada en movimientos.medio_pago para un gasto manual. */
export function medioPagoDe(m: Medio, canal: Canal | null): string {
  const c = canal ?? (m.canal as Canal | null) ?? 'tarjeta';
  if (c === 'tarjeta') return m.clase === 'efectivo' ? 'efectivo' : 'tarjeta_debito';
  return c;
}

/** Medios para mostrar al preguntar «¿con cuál?»: solo los que se registran por chat. */
export function opcionesMedio(medios: Medio[]) {
  return medios.filter((m) => m.registro_chat !== false).map((m, i) => ({ n: i + 1, medio: nombreMedio(m) }));
}

// ───────────────────────────── Tablero: configuración ─────────────────────────────

const slug = (s: string) => plano(s).replace(/ñ/g, 'n').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
const persona = z.enum(['miguel', 'katerine']);

export async function datosMedios(db: Db) {
  const { rows: origenes } = await db.query(
    `SELECT o.id, o.nombre, o.registro_chat, o.activo, o.orden,
            (SELECT count(*)::int FROM tarjetas t WHERE t.clase = o.id) AS medios
     FROM origenes_pago o ORDER BY o.orden, o.nombre`,
  );
  const { rows: medios } = await db.query(
    `SELECT t.id, t.nombre, t.banco, t.clase AS origen, t.tipo, t.persona_default, t.ultimos_4, t.alias, t.canal,
            t.dia_corte, t.activa,
            (SELECT count(*)::int FROM movimientos m WHERE m.tarjeta_id = t.id AND m.estado <> 'descartado') AS movimientos
     FROM tarjetas t LEFT JOIN origenes_pago o ON o.id = t.clase
     ORDER BY o.orden NULLS LAST, t.orden, t.nombre`,
  );
  return { origenes, medios, canales: CANALES };
}

export class ErrorMedios extends Error {
  constructor(public status: number, mensaje: string) {
    super(mensaje);
  }
}

const EsquemaOrigen = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  nombre: z.string().trim().min(2).max(40),
  registro_chat: z.boolean().optional(),
  activo: z.boolean().optional(),
}).strict();

export async function guardarOrigen(db: Db, e: unknown, quien: { correo: string; persona: string }) {
  const E = EsquemaOrigen.safeParse(e);
  if (!E.success) throw new ErrorMedios(400, 'entrada inválida: nombre de 2 a 40 caracteres');
  const v = E.data;
  return db.tx(async (tx) => {
    const choca = await tx.query(`SELECT id FROM origenes_pago WHERE lower(nombre) = lower($1) AND id IS DISTINCT FROM $2`, [v.nombre, v.id ?? null]);
    if (choca.rows[0]) throw new ErrorMedios(409, 'ya hay un origen con ese nombre');
    let fila;
    if (v.id) {
      const { rows } = await tx.query(`SELECT * FROM origenes_pago WHERE id = $1 FOR UPDATE`, [v.id]);
      if (!rows[0]) throw new ErrorMedios(404, 'el origen no existe');
      if (v.activo === false) {
        const { rows: uso } = await tx.query(`SELECT count(*)::int AS n FROM tarjetas WHERE clase = $1 AND activa`, [v.id]);
        if (uso[0].n > 0) throw new ErrorMedios(409, 'tiene medios de pago activos: desactívalos o muévelos primero');
      }
      ({ rows: [fila] } = await tx.query(
        `UPDATE origenes_pago SET nombre = $2, registro_chat = COALESCE($3, registro_chat), activo = COALESCE($4, activo)
         WHERE id = $1 RETURNING *`,
        [v.id, v.nombre, v.registro_chat ?? null, v.activo ?? null],
      ));
    } else {
      const id = slug(v.nombre);
      if (id.length < 2) throw new ErrorMedios(400, 'nombre inválido');
      const { rows: ya } = await tx.query(`SELECT 1 FROM origenes_pago WHERE id = $1`, [id]);
      if (ya[0]) throw new ErrorMedios(409, 'ya hay un origen con ese nombre');
      ({ rows: [fila] } = await tx.query(
        `INSERT INTO origenes_pago (id, nombre, registro_chat, activo) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, v.nombre, v.registro_chat ?? true, v.activo ?? true],
      ));
    }
    await tx.query(
      `INSERT INTO bitacora (actor, instruido_por, accion, despues) VALUES ($1, $2, 'guardar_origen_pago', $3)`,
      [quien.persona, quien.correo, JSON.stringify(fila)],
    );
    return { aplicado: true, origen: fila };
  });
}

const EsquemaMedio = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  nombre: z.string().trim().min(2).max(40),
  origen: z.string().regex(/^[a-z0-9-]{2,40}$/),
  banco: z.string().trim().max(40).nullable().optional(),
  tipo: z.enum(['individual', 'compartida']),
  persona_default: persona.nullable().optional(),
  ultimos_4: z.string().regex(/^\d{4}$/).nullable().optional(),
  alias: z.array(z.string().trim().min(2).max(40)).max(12).optional(),
  canal: z.enum(CANALES as [Canal, ...Canal[]]).optional(),
  dia_corte: z.number().int().min(1).max(31).nullable().optional(),
  activa: z.boolean().optional(),
}).strict();

export async function guardarMedio(db: Db, e: unknown, quien: { correo: string; persona: string }) {
  const E = EsquemaMedio.safeParse(e);
  if (!E.success) throw new ErrorMedios(400, 'entrada inválida: revisa nombre, origen y tipo');
  const v = E.data;
  if (v.tipo === 'individual' && !v.persona_default) throw new ErrorMedios(400, 'un medio individual necesita a su dueña o dueño');
  const personaDefault = v.tipo === 'individual' ? v.persona_default! : null;
  const alias = [...new Set((v.alias ?? []).map((a) => plano(a)).filter((a) => a.length >= 2))];
  return db.tx(async (tx) => {
    const { rows: o } = await tx.query(`SELECT id, activo FROM origenes_pago WHERE id = $1`, [v.origen]);
    if (!o[0]) throw new ErrorMedios(400, 'el origen no existe');
    if (!o[0].activo) throw new ErrorMedios(400, 'el origen está inactivo');
    if (v.dia_corte && v.origen !== 'credito') throw new ErrorMedios(400, 'el día de corte solo aplica a tarjetas de crédito');
    if (v.ultimos_4) {
      const { rows: u } = await tx.query(`SELECT id FROM tarjetas WHERE ultimos_4 = $1 AND id IS DISTINCT FROM $2`, [v.ultimos_4, v.id ?? null]);
      if (u[0]) throw new ErrorMedios(409, 'otro medio ya tiene esos últimos 4 dígitos');
    }
    // Un alias no puede ser de dos medios: el chat no sabría cuál es.
    const { rows: chocan } = await tx.query(
      `SELECT nombre FROM tarjetas WHERE id IS DISTINCT FROM $1 AND alias && $2::text[] LIMIT 1`,
      [v.id ?? null, alias],
    );
    if (chocan[0]) throw new ErrorMedios(409, `ese alias ya lo usa ${chocan[0].nombre}`);

    let fila;
    if (v.id) {
      const { rows } = await tx.query(`SELECT * FROM tarjetas WHERE id = $1 FOR UPDATE`, [v.id]);
      const previo = rows[0];
      if (!previo) throw new ErrorMedios(404, 'el medio de pago no existe');
      if (previo.clase !== v.origen) {
        const { rows: uso } = await tx.query(`SELECT count(*)::int AS n FROM movimientos WHERE tarjeta_id = $1 AND estado <> 'descartado'`, [v.id]);
        if (uso[0].n > 0) throw new ErrorMedios(409, 'ya tiene movimientos: no se le puede cambiar el origen (crea otro medio)');
      }
      ({ rows: [fila] } = await tx.query(
        `UPDATE tarjetas SET nombre = $2, clase = $3, banco = $4, tipo = $5, persona_default = $6, ultimos_4 = $7, alias = $8,
           canal = COALESCE($9, canal), dia_corte = $10, activa = COALESCE($11, activa)
         WHERE id = $1 RETURNING *`,
        [v.id, v.nombre, v.origen, v.banco ?? null, v.tipo, personaDefault, v.ultimos_4 ?? null, alias, v.canal ?? null,
          v.dia_corte ?? null, v.activa ?? null],
      ));
    } else {
      const id = slug(v.nombre);
      if (id.length < 2) throw new ErrorMedios(400, 'nombre inválido');
      const { rows: ya } = await tx.query(`SELECT 1 FROM tarjetas WHERE id = $1`, [id]);
      if (ya[0]) throw new ErrorMedios(409, 'ya hay un medio con ese nombre');
      ({ rows: [fila] } = await tx.query(
        `INSERT INTO tarjetas (id, nombre, clase, banco, tipo, persona_default, ultimos_4, alias, canal, dia_corte, activa)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, v.nombre, v.origen, v.banco ?? null, v.tipo, personaDefault, v.ultimos_4 ?? null, alias,
          v.canal ?? (v.origen === 'efectivo' ? 'efectivo' : 'tarjeta'), v.dia_corte ?? null, v.activa ?? true],
      ));
    }
    await tx.query(
      `INSERT INTO bitacora (actor, instruido_por, accion, despues) VALUES ($1, $2, 'guardar_medio_pago', $3)`,
      [quien.persona, quien.correo, JSON.stringify({ ...fila, ultimos_4: fila.ultimos_4 ? '****' : null })],
    );
    return { aplicado: true, medio: fila };
  });
}
