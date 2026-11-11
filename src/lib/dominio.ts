// Lógica determinista de Kairos Finanzas. Todo lo que decide estados, reglas,
// destinos y cifras vive aquí; el agente solo llama herramientas tipadas.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db';
import type { Contexto, Entrada } from './esquemas';
import { type Extractor, MODELO_EXTRACTOR, validarExtraccion } from './extractor';
import { type Interpretacion, interpretarCorreo } from './parser';
import * as R from './referencias';
import { idsQueNoSuman } from './efectivos';
import { cifrasIngresos, reembolsablesPendientes } from './ingresos-cifras';
import { esGenerico, nombreComercioNuevo, normalizar, normalizarCategoria } from './texto';

export class ErrorDominio extends Error {
  constructor(public status: number, mensaje: string) {
    super(mensaje);
  }
}

export type EventoHook = 'nuevo' | 'recordatorio' | 'alerta_no_reconocida';

export interface Efectos {
  /** Aviso al hook de OpenClaw: SOLO el movimiento_id y el evento, nunca texto del correo. */
  /** `intento` distingue los reintentos: OpenClaw descarta avisos repetidos con la misma clave de idempotencia. */
  avisarHook(p: { movimiento_id: string; evento: EventoHook; intento?: string }): Promise<void>;
  /** Aviso de corte de una tarjeta (pide el extracto). Solo el id de la tarjeta. */
  avisarCorte?(tarjeta_id: string, intento?: number): Promise<void>;
  extractor?: Extractor;
  /** TRM vigente en una fecha (datos.gov.co). null si la fuente no la tiene; lanza si falla. */
  obtenerTrm?(fecha: string): Promise<{ valor: number; fuente: string } | null>;
  /** Lector de capturas en cuarentena (Haiku): imagen, PDF o texto de un reporte. Salida cruda, sin validar. */
  leerCaptura?(contenido: Uint8Array | string, mime: string): Promise<unknown>;
}

type Actor = 'sistema' | 'agente' | 'miguel' | 'katerine';
const UMBRAL_DEFAULT = 5;
const ARRENDAMIENTO = "interval '10 minutes'";

export async function bitacora(
  db: Db,
  b: {
    movimiento_id?: string | null;
    actor: Actor;
    accion: string;
    instruido_por?: string | null;
    antes?: unknown;
    despues?: unknown;
    ctx?: Contexto;
  },
) {
  await db.query(
    `INSERT INTO bitacora (movimiento_id, actor, instruido_por, accion, antes, despues, modelo, sesion_openclaw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      b.movimiento_id ?? null,
      b.actor,
      b.instruido_por ?? null,
      b.accion,
      b.antes === undefined ? null : JSON.stringify(b.antes),
      b.despues === undefined ? null : JSON.stringify(b.despues),
      b.ctx?.modelo ?? null,
      b.ctx?.sesion_openclaw ?? null,
    ],
  );
}

async function config<T>(db: Db, clave: string, defecto: T): Promise<T> {
  const { rows } = await db.query<{ valor: T }>('SELECT valor FROM config WHERE clave = $1', [clave]);
  return rows[0]?.valor ?? defecto;
}

export async function patronesGenericos(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ patron: string }>('SELECT patron FROM comercios_genericos');
  return rows.map((r) => r.patron);
}

async function comercioEsGenerico(db: Db, comercioId: number | null): Promise<boolean> {
  if (!comercioId) return false;
  const { rows } = await db.query<{ nombre: string }>('SELECT nombre FROM comercios WHERE id = $1', [comercioId]);
  return rows[0] ? esGenerico(rows[0].nombre, await patronesGenericos(db)) : false;
}

// ───────────────────────────── Flujo 1: correo ─────────────────────────────

export interface CorreoEntrante {
  correo_id: string;
  remitente: string;
  asunto: string;
  fecha_correo: Date;
  texto: string; // ya limpio, ≤ 4.000 caracteres
}

export interface ResultadoCorreo {
  correo_id: string;
  duplicado?: boolean;
  movimiento_id?: string | null;
  estado?: string;
  tipo?: string;
}

export async function ingresarCorreo(db: Db, ef: Efectos, c: CorreoEntrante): Promise<ResultadoCorreo> {
  const parse = interpretarCorreo(c.remitente, c.texto, c.fecha_correo);
  // La TRM (red) se busca ANTES de abrir la transacción.
  const trm = parse.ok && parse.datos?.moneda === 'USD' ? await trmPara(db, ef, parse.datos.fecha) : null;
  const r = await db.tx(async (tx) => {
    const ins = await tx.query(
      `INSERT INTO correos (correo_id, remitente, asunto, fecha_correo, texto, banco)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (correo_id) DO NOTHING RETURNING correo_id`,
      [c.correo_id, c.remitente.slice(0, 200), c.asunto.slice(0, 300), c.fecha_correo, c.texto, parse.banco],
    );
    if (ins.rows.length === 0) {
      const { rows } = await tx.query('SELECT id, estado FROM movimientos WHERE correo_id = $1', [c.correo_id]);
      return { correo_id: c.correo_id, duplicado: true, movimiento_id: rows[0]?.id ?? null, estado: rows[0]?.estado };
    }
    // SEC-002: remitente con nombre de banco pero dominio ajeno: no crea compra ni pasa al extractor.
    if (!parse.ok && parse.motivo === 'remitente no verificado') {
      await tx.query(`UPDATE correos SET resultado_parser = 'fallo', error = $2, estado = 'ignorado' WHERE correo_id = $1`, [
        c.correo_id,
        parse.motivo,
      ]);
      return { correo_id: c.correo_id, tipo: 'otro', movimiento_id: null };
    }
    if (parse.ok && parse.datos === null) {
      await tx.query(
        `UPDATE correos SET tipo = 'otro', resultado_parser = 'ok', fuente_interpretacion = 'regex', estado = 'ignorado'
         WHERE correo_id = $1`,
        [c.correo_id],
      );
      return { correo_id: c.correo_id, tipo: 'otro', movimiento_id: null };
    }
    if (parse.ok && parse.datos) {
      await tx.query(`UPDATE correos SET resultado_parser = 'ok', fuente_interpretacion = 'regex' WHERE correo_id = $1`, [
        c.correo_id,
      ]);
      return procesarInterpretacion(tx, c.correo_id, parse.datos, 'regex', null, trm);
    }
    await tx.query(`UPDATE correos SET resultado_parser = 'fallo', error = $2 WHERE correo_id = $1`, [
      c.correo_id,
      parse.motivo,
    ]);
    const { rows } = await tx.query(
      `INSERT INTO movimientos (correo_id, descripcion_original, estado, fuente)
       VALUES ($1, $2, 'requiere_interpretacion', 'correo') RETURNING id`,
      // SEC-001: el asunto del correo no entra a la compra (lo leería el modelo). Texto fijo.
      [c.correo_id, 'Correo pendiente de interpretar'],
    );
    await bitacora(tx, { movimiento_id: rows[0].id, actor: 'sistema', accion: 'requiere_interpretacion', despues: { motivo: parse.motivo } });
    return { correo_id: c.correo_id, movimiento_id: rows[0].id as string, estado: 'requiere_interpretacion' };
  });

  if (r.estado === 'requiere_interpretacion' && !r.duplicado) return intentarExtractor(db, ef, c.correo_id);
  if (r.estado === 'por_preguntar' && !r.duplicado && r.movimiento_id)
    await ef.avisarHook({ movimiento_id: r.movimiento_id, evento: 'nuevo' });
  return r;
}

/** Extractor en cuarentena: máximo 2 intentos por correo. */
export async function intentarExtractor(db: Db, ef: Efectos, correo_id: string): Promise<ResultadoCorreo> {
  const { rows: movs } = await db.query(
    `SELECT id FROM movimientos WHERE correo_id = $1 AND estado = 'requiere_interpretacion'`,
    [correo_id],
  );
  const movId: string | undefined = movs[0]?.id;
  if (!movId) return { correo_id };

  const revisar = async (motivo: string) => {
    await db.tx(async (tx) => {
      await tx.query(`UPDATE correos SET estado = 'requiere_revision', error = $2 WHERE correo_id = $1`, [correo_id, motivo]);
      await tx.query(
        `UPDATE movimientos SET estado = 'requiere_revision', nota = $2, actualizado_en = now()
         WHERE id = $1 AND estado = 'requiere_interpretacion'`,
        [movId, `extractor: ${motivo}`],
      );
      await bitacora(tx, { movimiento_id: movId, actor: 'sistema', accion: 'requiere_revision', despues: { motivo }, ctx: { modelo: MODELO_EXTRACTOR } });
    });
    return { correo_id, movimiento_id: movId, estado: 'requiere_revision' };
  };

  if (!ef.extractor) return revisar('extractor no configurado');
  const { rows } = await db.query(
    `UPDATE correos SET intentos_extractor = intentos_extractor + 1
     WHERE correo_id = $1 AND intentos_extractor < 2 RETURNING texto, fecha_correo, intentos_extractor`,
    [correo_id],
  );
  if (!rows[0]) return revisar('sin intentos del extractor');
  const { texto, fecha_correo, intentos_extractor } = rows[0];

  let bruto: unknown;
  try {
    bruto = await ef.extractor(texto);
  } catch (e) {
    // Falla de red o de API: el respaldo reintenta; al segundo fallo, revisión.
    if (intentos_extractor >= 2) return revisar(`llamada falló: ${(e as Error).message}`);
    return { correo_id, movimiento_id: movId, estado: 'requiere_interpretacion' };
  }
  const { rows: tarjetas } = await db.query<{ ultimos_4: string }>(
    'SELECT ultimos_4 FROM tarjetas WHERE ultimos_4 IS NOT NULL AND activa',
  );
  const v = validarExtraccion(bruto, new Date(fecha_correo), tarjetas.map((t) => t.ultimos_4));
  if (!v.ok) return revisar(v.motivo);

  const trm = v.datos.moneda === 'USD' ? await trmPara(db, ef, v.datos.fecha) : null;
  const r = await db.tx(async (tx) => {
    await tx.query(
      `UPDATE correos SET fuente_interpretacion = 'llm_cuarentena' WHERE correo_id = $1`,
      [correo_id],
    );
    return procesarInterpretacion(tx, correo_id, v.datos, 'llm_cuarentena', movId, trm);
  });
  if (r.estado === 'por_preguntar' && r.movimiento_id) await ef.avisarHook({ movimiento_id: r.movimiento_id, evento: 'nuevo' });
  return r;
}

export async function resolverComercio(db: Db, descripcion: string) {
  const { rows } = await db.query<{ id: number; nombre: string; patrones: string[]; categoria_semilla_id: number | null; verificado: boolean }>(
    'SELECT id, nombre, patrones, categoria_semilla_id, verificado FROM comercios',
  );
  const hallado = normalizar(descripcion, rows);
  if (hallado) return hallado;
  const nombre = nombreComercioNuevo(descripcion);
  const { rows: nuevo } = await db.query(
    `INSERT INTO comercios (nombre, patrones, verificado) VALUES ($1, $2, false)
     ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id, nombre, patrones, categoria_semilla_id, verificado`,
    [nombre, [descripcion.toUpperCase().replace(/\s{2,}/g, ' ').trim()]],
  );
  return nuevo[0] as (typeof rows)[number];
}

export interface Trm {
  valor: number;
  fecha: string; // aaaa-mm-dd de la compra (TRM vigente ese día)
}

/** TRM vigente en la fecha: primero la caché; si no, la API. Nunca se inventa: null si no hay. */
export async function trmPara(db: Db, ef: Efectos, fecha: string): Promise<Trm | null> {
  const { rows } = await db.query<{ valor: string }>('SELECT valor::text AS valor FROM trm WHERE fecha = $1', [fecha]);
  if (rows[0]) return { valor: Number(rows[0].valor), fecha };
  if (!ef.obtenerTrm) return null;
  let r: { valor: number; fuente: string } | null = null;
  try {
    r = await ef.obtenerTrm(fecha);
  } catch {
    r = null;
  }
  if (!r || !Number.isFinite(r.valor) || r.valor <= 0) return null;
  await db.query(
    `INSERT INTO trm (fecha, valor, fuente) VALUES ($1, $2, $3) ON CONFLICT (fecha) DO NOTHING`,
    [fecha, r.valor, r.fuente.slice(0, 200)],
  );
  return { valor: r.valor, fecha };
}

const valorCOPde = (d: { valor: number; moneda: string }, trm: Trm | null): number | null =>
  d.moneda === 'COP' ? d.valor : trm ? Math.round(d.valor * trm.valor) : null;

/** Decisión determinista de una compra: ¿se confirma sola por regla o hay que preguntar? */
async function decidirCompra(tx: Db, comercio: any, tarjeta: any) {
  const generico = esGenerico(comercio.nombre, await patronesGenericos(tx));
  const { rows: reglas } = await tx.query('SELECT * FROM reglas_comercio WHERE comercio_id = $1', [comercio.id]);
  const regla = reglas[0];
  const confirmada = regla?.estado === 'confirmada';
  const modo = await config<string>(tx, 'modo_preguntas', 'por_comercio');
  const persona: string | null =
    tarjeta.tipo === 'individual' ? tarjeta.persona_default : confirmada ? regla.persona_default ?? null : null;
  let categoria: number | null = null;
  let reglaId: number | null = null;
  if (!generico && confirmada && regla.categoria_id) {
    categoria = regla.categoria_id;
    reglaId = regla.id;
  } else if (!generico && comercio.verificado && comercio.categoria_semilla_id) {
    categoria = comercio.categoria_semilla_id;
  }
  const auto = modo === 'por_comercio' && !generico && categoria !== null && persona !== null;
  const reembolsable = confirmada && regla.reembolsable_default != null ? regla.reembolsable_default : categoria === 12;
  return { generico, persona, auto, categoria: auto ? categoria : null, reglaId: auto ? reglaId : null, reembolsable: Boolean(auto && reembolsable) };
}

async function procesarInterpretacion(
  tx: Db,
  correo_id: string,
  d: Interpretacion,
  fuente: 'regex' | 'llm_cuarentena',
  placeholderId: string | null,
  trm: Trm | null,
): Promise<ResultadoCorreo> {
  const { rows: tars } = await tx.query('SELECT * FROM tarjetas WHERE ultimos_4 = $1 AND activa', [d.ultimos_4_tarjeta]);
  const tarjeta = tars[0];
  const usd = d.moneda === 'USD';
  const cop = valorCOPde(d, trm);
  const trmCampos = [d.moneda, d.valor, usd && trm ? trm.valor : null, usd && trm ? trm.fecha : null];

  if (d.tipo === 'otro') {
    if (placeholderId) await tx.query('DELETE FROM movimientos WHERE id = $1', [placeholderId]);
    await tx.query(`UPDATE correos SET tipo = 'otro', estado = 'ignorado' WHERE correo_id = $1`, [correo_id]);
    return { correo_id, tipo: 'otro', movimiento_id: null };
  }
  if (!tarjeta) {
    const nota = `tarjeta *${d.ultimos_4_tarjeta} no registrada`;
    await tx.query(`UPDATE correos SET tipo = $2, estado = 'requiere_revision', error = $3 WHERE correo_id = $1`, [correo_id, d.tipo, nota]);
    const { rows } = placeholderId
      ? await tx.query(
          `UPDATE movimientos SET estado = 'requiere_revision', nota = $2, valor = $3, fecha = $4, descripcion_original = $5,
             moneda = $6, valor_original = $7, trm = $8, trm_fecha = $9, actualizado_en = now() WHERE id = $1 RETURNING id`,
          [placeholderId, nota, cop, d.fecha, d.comercio, ...trmCampos],
        )
      : await tx.query(
          `INSERT INTO movimientos (correo_id, estado, nota, valor, fecha, descripcion_original, fuente_interpretacion,
             moneda, valor_original, trm, trm_fecha)
           VALUES ($1, 'requiere_revision', $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [correo_id, nota, cop, d.fecha, d.comercio, fuente, ...trmCampos],
        );
    return { correo_id, movimiento_id: rows[0].id, estado: 'requiere_revision', tipo: d.tipo };
  }

  const comercio = await resolverComercio(tx, d.comercio);

  if (d.tipo === 'reverso' || d.tipo === 'rechazo') {
    if (placeholderId) await tx.query('DELETE FROM movimientos WHERE id = $1', [placeholderId]);
    const motivo = d.tipo === 'reverso' ? 'reversada' : 'rechazada';
    // Se empareja en la moneda original (un reverso en USD contra la compra en USD).
    const { rows: pareja } = await tx.query(
      `SELECT id, estado FROM movimientos
       WHERE tarjeta_id = $1 AND moneda = $6 AND COALESCE(valor_original, valor::numeric) = $2 AND comercio_id = $3
         AND estado <> 'descartado' AND fecha BETWEEN ($4::date - 7) AND ($4::date + 1) AND correo_id IS DISTINCT FROM $5
       ORDER BY fecha DESC, creado_en DESC LIMIT 1 FOR UPDATE`,
      [tarjeta.id, d.valor, comercio.id, d.fecha, correo_id, d.moneda],
    );
    if (!pareja[0]) {
      await tx.query(`UPDATE correos SET tipo = $2, estado = 'sin_pareja' WHERE correo_id = $1`, [correo_id, d.tipo]);
      return { correo_id, tipo: d.tipo, movimiento_id: null, estado: 'sin_pareja' };
    }
    await tx.query(
      `UPDATE movimientos SET estado = 'descartado', motivo_descarte = $2, en_proceso_hasta = NULL, actualizado_en = now() WHERE id = $1`,
      [pareja[0].id, motivo],
    );
    await tx.query(`UPDATE correos SET tipo = $2, estado = 'procesado' WHERE correo_id = $1`, [correo_id, d.tipo]);
    await bitacora(tx, { movimiento_id: pareja[0].id, actor: 'sistema', accion: 'descartar', antes: { estado: pareja[0].estado }, despues: { estado: 'descartado', motivo, correo_id } });
    return { correo_id, tipo: d.tipo, movimiento_id: pareja[0].id, estado: 'descartado' };
  }

  // Compra. En USD sin TRM: queda en requiere_trm (sin valor COP) hasta que el respaldo la obtenga.
  const dec = await decidirCompra(tx, comercio, tarjeta);
  const sinTrm = cop === null;
  const estado = sinTrm ? 'requiere_trm' : dec.auto ? 'confirmado' : 'por_preguntar';
  const auto = !sinTrm && dec.auto;
  const campos = [d.fecha, comercio.id, d.comercio, cop, tarjeta.id, dec.persona, auto ? dec.categoria : null, auto && dec.reembolsable,
    estado, fuente, auto ? dec.reglaId : null, auto ? 'sistema' : null, ...trmCampos];
  const { rows } = placeholderId
    ? await tx.query(
        `UPDATE movimientos SET fecha = $2, comercio_id = $3, descripcion_original = $4, valor = $5, tarjeta_id = $6,
           persona = $7, categoria_id = $8, reembolsable = $9, estado = $10, fuente_interpretacion = $11, regla_id = $12,
           clasificado_por = $13, moneda = $14, valor_original = $15, trm = $16, trm_fecha = $17, actualizado_en = now()
         WHERE id = $1 RETURNING id`,
        [placeholderId, ...campos],
      )
    : await tx.query(
        `INSERT INTO movimientos (correo_id, fecha, comercio_id, descripcion_original, valor, tarjeta_id, persona,
           categoria_id, reembolsable, estado, fuente_interpretacion, regla_id, clasificado_por, moneda, valor_original, trm, trm_fecha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
        [correo_id, ...campos],
      );
  await tx.query(`UPDATE correos SET tipo = 'compra', estado = 'procesado' WHERE correo_id = $1`, [correo_id]);
  await bitacora(tx, {
    movimiento_id: rows[0].id,
    actor: 'sistema',
    accion: auto ? 'confirmar_por_regla' : sinTrm ? 'requiere_trm' : 'registrar',
    despues: { estado, categoria_id: auto ? dec.categoria : null, persona: dec.persona, regla_id: auto ? dec.reglaId : null, fuente,
      generico: dec.generico, moneda: d.moneda, valor_original: d.valor, trm: trmCampos[2] },
  });
  return { correo_id, movimiento_id: rows[0].id, estado, tipo: 'compra' };
}

/** Reintenta la TRM de las compras en USD pendientes (respaldo y resumen). Nunca inventa una TRM. */
export async function reintentarTrm(db: Db, ef: Efectos): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, fecha::text AS fecha FROM movimientos WHERE estado = 'requiere_trm' ORDER BY creado_en LIMIT 20`,
  );
  let resueltos = 0;
  for (const r of rows) {
    const trm = await trmPara(db, ef, r.fecha);
    if (!trm) continue;
    const estado = await db.tx(async (tx) => {
      const { rows: ms } = await tx.query(
        `SELECT * FROM movimientos WHERE id = $1 AND estado = 'requiere_trm' FOR UPDATE`,
        [r.id],
      );
      const m = ms[0];
      if (!m) return null;
      const { rows: c } = await tx.query('SELECT * FROM comercios WHERE id = $1', [m.comercio_id]);
      const { rows: t } = await tx.query('SELECT * FROM tarjetas WHERE id = $1', [m.tarjeta_id]);
      const dec = await decidirCompra(tx, c[0], t[0]);
      const nuevo = dec.auto ? 'confirmado' : 'por_preguntar';
      const cop = Math.round(Number(m.valor_original) * trm.valor);
      await tx.query(
        `UPDATE movimientos SET valor = $2, trm = $3, trm_fecha = $4, estado = $5, persona = COALESCE(persona, $6),
           categoria_id = $7, reembolsable = $8, regla_id = $9, clasificado_por = $10, actualizado_en = now()
         WHERE id = $1`,
        [m.id, cop, trm.valor, trm.fecha, nuevo, dec.persona, dec.categoria, dec.reembolsable, dec.reglaId, dec.auto ? 'sistema' : null],
      );
      await bitacora(tx, { movimiento_id: m.id, actor: 'sistema', accion: 'trm_obtenida', antes: { estado: 'requiere_trm' }, despues: { estado: nuevo, valor: cop, trm: trm.valor, trm_fecha: trm.fecha } });
      return nuevo;
    });
    if (!estado) continue;
    resueltos++;
    if (estado === 'por_preguntar') await ef.avisarHook({ movimiento_id: r.id, evento: 'nuevo' });
  }
  return resueltos;
}

// ───────────────────────────── Flujo 2: preguntar ─────────────────────────────

const VISTA = `
  SELECT m.id AS movimiento_id, m.estado, m.fecha::text AS fecha, m.valor::int AS valor, m.cuotas,
         c.id AS comercio_id, c.nombre AS comercio, t.nombre AS tarjeta, t.tipo AS tipo_tarjeta,
         m.persona, m.categoria_id, m.reembolsable, m.pregunta_codigo, m.preguntado_a, m.destino,
         c.categoria_semilla_id AS categoria_sugerida_id, m.fuente_interpretacion,
         m.moneda, m.valor_original::float8 AS valor_original, m.trm::float8 AS trm, m.trm_fecha::text AS trm_fecha,
         m.tarjeta_id, m.descripcion_original, m.categorias_sugeridas
  FROM movimientos m
  LEFT JOIN comercios c ON c.id = m.comercio_id
  LEFT JOIN tarjetas t ON t.id = m.tarjeta_id`;

const fmt = (n: number, dec = 0) =>
  new Intl.NumberFormat('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);

/** Texto del valor para el agente: en USD muestra el original y su equivalente en COP con la TRM. */
export function valorTexto(m: { moneda?: string; valor?: number | null; valor_original?: number | null; trm?: number | null; trm_fecha?: string | null }): string {
  if (m.moneda === 'USD') {
    const usd = `USD ${fmt(Number(m.valor_original), 2)}`;
    return m.valor != null && m.trm
      ? `${usd} (≈ $${fmt(Number(m.valor))} COP con TRM $${fmt(Number(m.trm), 2)} del ${m.trm_fecha})`
      : `${usd} (equivalente en COP pendiente: falta la TRM)`;
  }
  return m.valor != null ? `$${fmt(Number(m.valor))} COP` : 'valor pendiente';
}
const conTexto = <T extends Record<string, any>>(m: T) => (m ? { ...m, valor_texto: valorTexto(m) } : m);

export async function tomarMovimiento(db: Db, { movimiento_id }: Entrada<'tomar_movimiento'>) {
  const { rows } = await db.query(
    `UPDATE movimientos SET estado = 'en_proceso', en_proceso_hasta = now() + ${ARRENDAMIENTO}, actualizado_en = now(),
       intentos_preguntar = intentos_preguntar + 1
     WHERE id = $1 AND (estado = 'por_preguntar' OR (estado = 'en_proceso' AND en_proceso_hasta < now()))
     RETURNING id`,
    [movimiento_id],
  );
  if (!rows[0]) return { tomado: false };
  const { rows: v } = await db.query(`${VISTA} WHERE m.id = $1`, [movimiento_id]);
  const generico = await comercioEsGenerico(db, v[0].comercio_id);
  const sugeridas = await R.sugerirCategorias(db, v[0] as any, generico);
  return {
    tomado: true,
    movimiento: { ...conTexto(v[0]), comercio_generico: generico },
    categorias_sugeridas: await listaSugeridas(db, sugeridas),
    siguiente: 'Llama preguntar con este movimiento_id y SIN texto: el servidor arma la pregunta con las categorías numeradas.',
  };
}

async function listaSugeridas(db: Db, ids: number[]) {
  const nombres = new Map((await R.nombresCategorias(db)).map((c) => [c.id, c.nombre]));
  return ids.filter((id) => nombres.has(id)).map((id, i) => ({ n: i + 1, categoria_id: id, nombre: nombres.get(id)! }));
}

/** "¿De qué fue esta compra de $147.750 en Farmatodo (VISA)?\n1. Salud…\nResponde con el número o dime qué fue." */
function textoPregunta(encabezado: string, sugeridas: Array<{ n: number; nombre: string }>) {
  const lista = sugeridas.map((s) => `${s.n}. ${s.nombre}`).join('\n');
  return `${encabezado}${lista ? `\n${lista}` : ''}\nResponde con el número o dime qué fue.`;
}

async function nuevoCodigo(db: Db): Promise<string> {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 40; i++) {
    const b = randomBytes(2);
    const codigo = `${letras[b[0] % letras.length]}${2 + (b[1] % 8)}${i >= 20 ? letras[b[1] % letras.length] : ''}`;
    const { rows } = await db.query(
      `SELECT 1 FROM movimientos WHERE pregunta_codigo = $1 AND estado IN ('en_proceso', 'esperando_respuesta')`,
      [codigo],
    );
    if (!rows[0]) return codigo;
  }
  throw new ErrorDominio(503, 'no hay códigos libres');
}

async function destinoDe(db: Db, m: Record<string, any>) {
  const { rows } = await db.query('SELECT tipo, persona_default FROM tarjetas WHERE id = $1', [m.tarjeta_id]);
  const t = rows[0];
  let persona: string | null = null;
  if (t?.tipo === 'individual') persona = t.persona_default;
  else {
    const { rows: r } = await db.query(
      `SELECT persona_default FROM reglas_comercio WHERE comercio_id = $1 AND estado = 'confirmada'`,
      [m.comercio_id],
    );
    persona = r[0]?.persona_default ?? null;
  }
  return persona ? { destino: 'privado' as const, preguntado_a: persona } : { destino: 'grupo' as const, preguntado_a: 'grupo' };
}

async function targetDe(db: Db, preguntado_a: string): Promise<string> {
  const clave = `destino_${preguntado_a}`;
  const t = await config<string | null>(db, clave, null);
  if (!t) throw new ErrorDominio(409, `config ${clave} sin definir`);
  return t;
}

const conCodigo = (texto: string, codigo: string) => `${texto}\n(#${codigo})`;

export async function preguntar(db: Db, e: Entrada<'preguntar'>) {
  try {
    return await prepararPregunta(db, e);
  } catch (err) {
    // El fallo queda visible: motivo en el movimiento y en la bitácora. El movimiento
    // sigue en en_proceso; al vencer el arrendamiento el respaldo lo devuelve y lo lista.
    if (err instanceof ErrorDominio && err.status !== 404) {
      const motivo = err.message.slice(0, 200);
      await db.query(`UPDATE movimientos SET ultimo_error = $2, actualizado_en = now() WHERE id = $1`, [e.movimiento_id, motivo]);
      await bitacora(db, { movimiento_id: e.movimiento_id, actor: 'agente', accion: 'error_preguntar', despues: { motivo, status: err.status } });
    }
    throw err;
  }
}

async function prepararPregunta(db: Db, { movimiento_id }: Entrada<'preguntar'>) {
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM movimientos WHERE id = $1 FOR UPDATE`, [movimiento_id]);
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (m.estado !== 'en_proceso') throw new ErrorDominio(409, `estado ${m.estado}: primero tomar_movimiento`);
    const d = await destinoDe(tx, m);
    const target = await targetDe(tx, d.preguntado_a);
    const codigo = await nuevoCodigo(tx);
    // Una sola pregunta: "¿De qué fue?" con 2–3 categorías numeradas (se guardan para entender "1", "la 2").
    const { rows: v } = await tx.query(`${VISTA} WHERE m.id = $1`, [movimiento_id]);
    const generico = await comercioEsGenerico(tx, m.comercio_id);
    const sugeridas = await listaSugeridas(tx, await R.sugerirCategorias(tx, v[0] as any, generico));
    // SEC-006/SEC-001: el encabezado lo arma el servidor; nunca usa texto del modelo ni del correo.
    const encabezado = `¿De qué fue esta compra de ${R.valorCorto(v[0] as any)} en ${v[0].comercio ?? 'un comercio'}${v[0].tarjeta ? ` (${v[0].tarjeta})` : ''}?`;
    const cuerpo = textoPregunta(encabezado, sugeridas);
    await tx.query(
      `UPDATE movimientos SET pregunta_codigo = $2, pregunta_texto = $3, preguntado_a = $4, destino = $5,
         categorias_sugeridas = $6, en_proceso_hasta = now() + ${ARRENDAMIENTO}, actualizado_en = now() WHERE id = $1`,
      [movimiento_id, codigo, cuerpo, d.preguntado_a, d.destino, sugeridas.map((s) => s.categoria_id)],
    );
    return { pregunta_codigo: codigo, destino: d.destino, preguntado_a: d.preguntado_a, target, mensaje: conCodigo(cuerpo, codigo) };
  });
}

/** Espera del recordatorio: 4 horas desde el envío de la pregunta. */
export const ESPERA_RECORDATORIO_MS = 4 * 3600_000;

/**
 * Programa el recordatorio de una pregunta: una fila en recordatorios_pendientes.
 * Idempotente por (movimiento, código): repetirlo no duplica. Lo procesa el cron
 * /api/cron/recordatorios (src/lib/recordatorios-cron.ts).
 */
export async function encolarRecordatorio(db: Db, movimiento_id: string, pregunta_codigo: string, ahora = Date.now()) {
  await db.query(
    `INSERT INTO recordatorios_pendientes (movimiento_id, pregunta_codigo, proxima_revision)
     VALUES ($1, $2, $3) ON CONFLICT (movimiento_id, pregunta_codigo) DO NOTHING`,
    [movimiento_id, pregunta_codigo, new Date(ahora + ESPERA_RECORDATORIO_MS)],
  );
}

export async function confirmarEnvio(db: Db, ef: Efectos, e: Entrada<'confirmar_envio'>, ctx: Contexto = {}) {
  const codigo = e.pregunta_codigo.replace('#', '').toUpperCase();
  const { rows } = await db.query(
    `UPDATE movimientos SET estado = 'esperando_respuesta', whatsapp_message_id = $3, preguntado_en = now(),
       recordado = false, en_proceso_hasta = NULL, ultimo_error = NULL, actualizado_en = now()
     WHERE id = $1 AND pregunta_codigo = $2
       AND (estado IN ('en_proceso', 'esperando_respuesta')
            -- Confirmación tardía: el plazo venció y el respaldo la devolvió, pero el mensaje sí salió.
            OR (estado = 'por_preguntar' AND whatsapp_message_id IS NULL))
     RETURNING id, preguntado_a, destino`,
    [e.movimiento_id, codigo, e.whatsapp_message_id],
  );
  if (!rows[0]) throw new ErrorDominio(409, 'la pregunta ya no está abierta con ese código');
  await bitacora(db, { movimiento_id: e.movimiento_id, actor: 'agente', accion: 'preguntar', despues: { codigo, ...rows[0] }, ctx });
  await encolarRecordatorio(db, e.movimiento_id, codigo);
  return { estado: 'esperando_respuesta', FIN: true };
}

/**
 * Recordatorio: lo pide el cron (vía hook) mientras la pregunta siga abierta y sin recordar.
 * El texto lo arma el servidor con la pregunta original (el modelo no redacta nada); `texto`
 * se acepta por compatibilidad y se ignora. Queda «recordado» solo con el recibo del envío
 * (`confirmar_recordatorio`): si el envío falla, el cron lo vuelve a intentar.
 */
export async function recordar(db: Db, { movimiento_id }: Entrada<'recordar'>) {
  const { rows } = await db.query(
    `SELECT pregunta_codigo, preguntado_a, pregunta_texto FROM movimientos
     WHERE id = $1 AND estado = 'esperando_respuesta' AND NOT recordado`,
    [movimiento_id],
  );
  if (!rows[0]) throw new ErrorDominio(409, 'no hay recordatorio pendiente para este movimiento');
  const target = await targetDe(db, rows[0].preguntado_a);
  const cuerpo = `Recordatorio: ${rows[0].pregunta_texto ?? '¿De qué fue esta compra?'}`;
  return { target, mensaje: conCodigo(cuerpo, rows[0].pregunta_codigo), pregunta_codigo: rows[0].pregunta_codigo, FIN: true };
}

/** Recibo del recordatorio enviado: marca la compra y cierra la fila del cron. Idempotente. */
export async function confirmarRecordatorio(db: Db, e: Entrada<'confirmar_recordatorio'>, ctx: Contexto = {}) {
  const codigo = e.pregunta_codigo.replace('#', '').toUpperCase();
  const { rows } = await db.query(
    `SELECT estado, pregunta_codigo, recordado FROM movimientos WHERE id = $1`,
    [e.movimiento_id],
  );
  const m = rows[0];
  if (!m || m.pregunta_codigo !== codigo) throw new ErrorDominio(409, 'la pregunta ya no está abierta con ese código');
  const marcado = await marcarRecordatorio(db, e.movimiento_id, codigo);
  if (marcado) await bitacora(db, { movimiento_id: e.movimiento_id, actor: 'agente', accion: 'recordar', despues: { codigo, whatsapp_message_id: e.whatsapp_message_id }, ctx });
  await db.query(
    `UPDATE recordatorios_pendientes SET estado = 'hecho', en_proceso_hasta = NULL, actualizado_en = now(),
       datos = jsonb_build_object('resultado', 'recordado', 'whatsapp_message_id', $3::text)
     WHERE movimiento_id = $1 AND pregunta_codigo = $2 AND estado <> 'hecho'`,
    [e.movimiento_id, codigo, e.whatsapp_message_id],
  );
  return { recordado: true, FIN: true };
}

/** Marca la pregunta como recordada. Solo una vez por código. */
export async function marcarRecordatorio(db: Db, movimiento_id: string, codigo: string): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE movimientos SET recordado = true
     WHERE id = $1 AND estado = 'esperando_respuesta' AND pregunta_codigo = $2 AND NOT recordado RETURNING id`,
    [movimiento_id, codigo],
  );
  return rows.length > 0;
}

export async function reasignarPregunta(db: Db, e: Entrada<'reasignar_pregunta'>, ctx: Contexto = {}) {
  const obj = await objetivo(db, e);
  if ('respuesta' in obj) return obj.respuesta;
  const movimiento_id = obj.id;
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM movimientos WHERE id = $1 FOR UPDATE`, [movimiento_id]);
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (m.estado !== 'esperando_respuesta') throw new ErrorDominio(409, `estado ${m.estado}`);
    if (m.preguntado_a === e.persona_destino) throw new ErrorDominio(409, 'ya se le preguntó a esa persona');
    const target = await targetDe(tx, e.persona_destino);
    const codigo = await nuevoCodigo(tx);
    await tx.query(
      `UPDATE movimientos SET pregunta_codigo = $2, preguntado_a = $3, destino = 'privado', recordado = false, actualizado_en = now()
       WHERE id = $1`,
      [movimiento_id, codigo, e.persona_destino],
    );
    await bitacora(tx, {
      movimiento_id, actor: 'agente', accion: 'reasignar_pregunta',
      antes: { preguntado_a: m.preguntado_a, codigo: m.pregunta_codigo }, despues: { preguntado_a: e.persona_destino, codigo }, ctx,
    });
    return { movimiento_id, pregunta_codigo: codigo, target, mensaje: conCodigo(m.pregunta_texto ?? '¿De qué fue esta compra?', codigo) };
  });
}

/**
 * «¿Qué me falta por responder?»: compras que esperan respuesta de quien escribe y las del
 * grupo. Sin remitente, todas. Solo lectura; sin ids visibles (el agente muestra código y valor).
 */
export async function pendientes(db: Db, e: Entrada<'pendientes'>) {
  const quien = e.numero_remitente || e.remitente ? await remitenteDe(db, e.remitente, e.numero_remitente) : null;
  const { rows } = await db.query(
    `${VISTA} WHERE m.estado = 'esperando_respuesta' AND ($1::text IS NULL OR m.preguntado_a IN ($1, 'grupo'))
     ORDER BY m.fecha, m.creado_en LIMIT 30`,
    [quien],
  );
  const lista = rows.map((m: any, i: number) => ({
    n: i + 1,
    codigo: `#${m.pregunta_codigo}`,
    descripcion: `${R.valorCorto(m)} en ${m.comercio ?? 'un comercio'}${m.tarjeta ? ` (${m.tarjeta})` : ''}, ${m.fecha}`,
    preguntado_a: m.preguntado_a,
  }));
  return { persona: quien, cantidad: lista.length, lista };
}

// ───────────────────────────── Flujo 3: respuesta ─────────────────────────────

type Persona = 'miguel' | 'katerine';

/** Quién escribe: el número de WhatsApp (verificado por el canal) manda sobre el nombre. */
async function remitenteDe(db: Db, nombre?: Persona, numero?: string): Promise<Persona> {
  if (numero) {
    const p = await R.personaDeNumero(db, numero);
    if (p) return p;
    if (!nombre) throw new ErrorDominio(403, 'el número no corresponde a Miguel ni a Katerine');
  }
  if (nombre) return nombre;
  throw new ErrorDominio(400, 'falta respondido_por o numero_remitente');
}

/** Movimiento al que se refiere una herramienta: id explícito, o referencia en texto libre. */
async function objetivo(db: Db, e: { movimiento_id?: string; referencia?: string }): Promise<{ id: string; metodo: string } | { respuesta: Record<string, unknown> }> {
  if (e.movimiento_id) return { id: e.movimiento_id, metodo: 'id' };
  const sel = await R.seleccionar(db, e.referencia);
  if (sel.tipo === 'unica') return { id: sel.movimiento.movimiento_id, metodo: sel.metodo };
  return { respuesta: R.noUnica(sel, e.referencia) };
}

async function descripcionDe(db: Db, id: string) {
  const c = await R.candidatoPorId(db, id);
  return c ? R.describir(c) : null;
}

export async function resolverRespuesta(db: Db, e: Entrada<'resolver_respuesta'>) {
  const quien = await remitenteDe(db, e.remitente, e.numero_remitente);
  const abierto = `${VISTA} WHERE m.estado = 'esperando_respuesta'`;
  const salida = async (m: any, metodo: string) => ({
    movimiento: conTexto(m),
    descripcion: R.describir(m),
    metodo,
    // En privado solo se aplica si quien responde es a quien se le preguntó.
    // Las preguntas del grupo se pueden responder desde cualquier privado.
    solo_sugerencia: e.canal === 'privado' && !!m.preguntado_a && m.preguntado_a !== 'grupo' && m.preguntado_a !== quien,
    categorias_sugeridas: await listaSugeridas(db, m.categorias_sugeridas ?? []),
  });
  if (e.reply_to) {
    const { rows } = await db.query(`${abierto} AND m.whatsapp_message_id = $1`, [e.reply_to]);
    if (rows[0]) return salida(rows[0], 'reply_to');
  }
  const cod = (e.movimiento_codigo ?? e.texto.match(/#([A-Z0-9]{2,4})\b/i)?.[0])?.replace('#', '').toUpperCase();
  if (cod) {
    const { rows } = await db.query(`${abierto} AND m.pregunta_codigo = $1`, [cod]);
    if (rows[0]) return salida(rows[0], 'codigo');
  }
  const { rows } = await db.query(
    `${abierto} AND (m.preguntado_a = $1 OR ($2 = 'grupo' AND m.destino = 'grupo'))
     ORDER BY m.preguntado_en DESC NULLS LAST LIMIT 10`,
    [quien, e.canal],
  );
  if (rows.length === 1) return salida(rows[0], 'unico_pendiente');
  if (rows.length > 1) {
    // Sin código: el valor o el comercio que mencione la persona deciden.
    const sel = R.elegir(e.texto, rows as any[]);
    if (sel.tipo === 'unica' && sel.metodo !== 'unico_pendiente') {
      const m = rows.find((r: any) => r.movimiento_id === sel.movimiento.movimiento_id);
      return salida(m, `referencia:${sel.metodo}`);
    }
  }
  return {
    movimiento: null,
    metodo: rows.length ? 'varios' : 'ninguno',
    mensaje: rows.length
      ? 'Varias compras esperan respuesta. Muestra la lista numerada (sin ids ni códigos) y pregunta cuál.'
      : 'No hay compras esperando respuesta de esta persona.',
    lista: R.opciones(rows as any[]),
    opciones: rows.map(conTexto),
  };
}

function mismosValores(r: any, v: { categoria_id: number; persona: string | null; reembolsable: boolean }) {
  return r.categoria_id === v.categoria_id && (r.persona_default ?? null) === v.persona && (r.reembolsable_default ?? false) === v.reembolsable;
}

export async function clasificar(db: Db, e: Entrada<'clasificar'>, ctx: Contexto = {}) {
  const quien = await remitenteDe(db, e.respondido_por, e.numero_remitente);
  if (e.categoria_id == null && !e.categoria) throw new ErrorDominio(400, 'falta categoria_id o categoria');
  const obj = await objetivo(db, e);
  if ('respuesta' in obj) return obj.respuesta;
  return db.tx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT m.*, t.tipo AS tipo_tarjeta, t.persona_default AS persona_tarjeta
       FROM movimientos m LEFT JOIN tarjetas t ON t.id = m.tarjeta_id
       WHERE m.id = $1 FOR UPDATE OF m`,
      [obj.id],
    );
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (m.estado === 'descartado' || m.estado === 'requiere_interpretacion' || m.estado === 'requiere_trm')
      throw new ErrorDominio(409, `estado ${m.estado}${m.estado === 'requiere_trm' ? ': falta la TRM para el valor en COP' : ''}`);
    const cats = await R.nombresCategorias(tx);
    const categoria_id = e.categoria_id ?? R.categoriaDeTexto(e.categoria!, cats, m.categorias_sugeridas ?? []);
    if (categoria_id == null)
      return {
        aplicado: false,
        motivo: 'categoria_no_reconocida',
        mensaje: 'No entendí la categoría. Muestra estas opciones numeradas y, con la respuesta, vuelve a llamar con su categoria_id.',
        movimiento: await descripcionDe(tx, m.id),
        opciones: cats.map((c, i) => ({ n: i + 1, categoria_id: c.id, nombre: c.nombre })),
      };
    const categoria = cats.find((c) => c.id === categoria_id);
    if (!categoria) throw new ErrorDominio(400, 'categoria_id no existe o está inactiva');
    // Persona: en tarjetas individuales, la dueña; si no, la que diga el mensaje o quien responde.
    const persona: Persona = m.tipo_tarjeta === 'individual' && m.persona_tarjeta ? m.persona_tarjeta : e.persona ?? quien;
    const reembolsable = e.reembolsable ?? categoria_id === 12;
    const valores = { categoria_id, persona, reembolsable };

    // Solo es sugerencia si la pregunta era para la OTRA persona; las del grupo se aplican.
    if (e.canal === 'privado' && m.preguntado_a && m.preguntado_a !== 'grupo' && m.preguntado_a !== quien) {
      await bitacora(tx, { movimiento_id: m.id, actor: quien, accion: 'sugerencia', despues: { ...e, ...valores }, ctx, instruido_por: quien });
      return { aplicado: false, sugerencia: true, motivo: `la pregunta era para ${m.preguntado_a}; confirmar en el grupo` };
    }

    const antes = { estado: m.estado, categoria_id: m.categoria_id, persona: m.persona, reembolsable: m.reembolsable, regla_id: m.regla_id };
    await tx.query(
      `UPDATE movimientos SET categoria_id = $2, persona = $3, reembolsable = $4, nota = COALESCE($5, nota), estado = 'confirmado',
         clasificado_por = $6, en_proceso_hasta = NULL, actualizado_en = now() WHERE id = $1`,
      [m.id, categoria_id, persona, reembolsable, e.nota ?? null, quien],
    );
    await bitacora(tx, {
      movimiento_id: m.id, actor: quien, instruido_por: quien, accion: 'clasificar', antes,
      despues: { estado: 'confirmado', ...valores, metodo: obj.metodo }, ctx,
    });

    // Ciclo de vida de reglas: solo respuestas humanas, nunca comercios genéricos.
    let regla: any = null;
    if (m.comercio_id && !e.solo_esta_vez && !(await comercioEsGenerico(tx, m.comercio_id))) {
      const v = { categoria_id, persona: m.tipo_tarjeta === 'compartida' ? persona : null, reembolsable };
      const { rows: rs } = await tx.query('SELECT * FROM reglas_comercio WHERE comercio_id = $1 FOR UPDATE', [m.comercio_id]);
      const r = rs[0];
      const reiniciar = async (accion: string) => {
        const { rows: up } = await tx.query(
          `UPDATE reglas_comercio SET categoria_id = $2, persona_default = $3, reembolsable_default = $4, estado = 'propuesta',
             coincidencias_humanas = 1, ultimo_movimiento_id = $5, confirmada_por = NULL, confirmada_en = NULL, actualizada_en = now()
           WHERE id = $1 RETURNING *`,
          [r.id, v.categoria_id, v.persona, v.reembolsable, m.id],
        );
        await bitacora(tx, { movimiento_id: m.id, actor: quien, accion, antes: r, despues: up[0], ctx });
        return up[0];
      };
      if (!r) {
        const { rows: nueva } = await tx.query(
          `INSERT INTO reglas_comercio (comercio_id, categoria_id, persona_default, reembolsable_default, estado,
             coincidencias_humanas, ultimo_movimiento_id, creada_por)
           VALUES ($1, $2, $3, $4, 'propuesta', 1, $5, $6) RETURNING *`,
          [m.comercio_id, v.categoria_id, v.persona, v.reembolsable, m.id, quien],
        );
        regla = nueva[0];
        await bitacora(tx, { movimiento_id: m.id, actor: quien, accion: 'regla_nace', despues: regla, ctx });
      } else if (r.estado === 'confirmada') {
        regla = mismosValores(r, v) ? r : await reiniciar(m.regla_id === r.id ? 'regla_suspendida' : 'regla_contradicha');
      } else if (mismosValores(r, v)) {
        if (r.ultimo_movimiento_id === m.id) regla = r;
        else {
          const n = r.coincidencias_humanas + 1;
          const confirma = n >= 2;
          const { rows: up } = await tx.query(
            `UPDATE reglas_comercio SET coincidencias_humanas = $2, ultimo_movimiento_id = $3, actualizada_en = now(),
               estado = CASE WHEN $4 THEN 'confirmada' ELSE estado END,
               confirmada_por = CASE WHEN $4 THEN $5 ELSE confirmada_por END,
               confirmada_en = CASE WHEN $4 THEN now() ELSE confirmada_en END
             WHERE id = $1 RETURNING *`,
            [r.id, n, m.id, confirma, quien],
          );
          regla = up[0];
          if (confirma) await bitacora(tx, { movimiento_id: m.id, actor: quien, accion: 'regla_confirmada', despues: regla, ctx });
        }
      } else regla = await reiniciar('regla_reiniciada');
    }
    return {
      aplicado: true,
      movimiento: await descripcionDe(tx, m.id),
      categoria: categoria.nombre,
      persona,
      reembolsable,
      metodo: obj.metodo,
      regla: regla ? { id: regla.id, estado: regla.estado, coincidencias_humanas: regla.coincidencias_humanas } : null,
    };
  });
}

// ───────────────────────────── Flujo 4: pedidos sueltos ─────────────────────────────

export async function cambiarCuotas(db: Db, e: Entrada<'cambiar_cuotas'>, ctx: Contexto = {}) {
  const obj = await objetivo(db, e);
  if ('respuesta' in obj) return obj.respuesta;
  const { rows } = await db.query(
    `UPDATE movimientos SET cuotas = $2, actualizado_en = now() WHERE id = $1 AND estado <> 'descartado'
     RETURNING id, (SELECT cuotas FROM movimientos WHERE id = $1) AS antes`,
    [obj.id, e.cuotas],
  );
  if (!rows[0]) throw new ErrorDominio(404, 'movimiento no existe o está descartado');
  await bitacora(db, { movimiento_id: obj.id, actor: 'agente', accion: 'cambiar_cuotas', antes: { cuotas: rows[0].antes }, despues: { cuotas: e.cuotas, metodo: obj.metodo }, ctx });
  return { aplicado: true, cuotas: e.cuotas, movimiento: await descripcionDe(db, obj.id) };
}

/**
 * Descarte. Sin id se resuelve la referencia. "duplicada" solo si existe otra fila viva
 * con el mismo valor, fecha y tarjeta; si no, no se descarta nada y se muestran las compras.
 */
export async function descartarMovimiento(db: Db, ef: Efectos, e: Entrada<'descartar_movimiento'>, ctx: Contexto = {}) {
  const instruido = e.numero_remitente ? (await R.personaDeNumero(db, e.numero_remitente)) ?? e.instruido_por : e.instruido_por;
  let id = e.movimiento_id;
  let metodo = 'id';
  let conserva: R.Candidato | null = null;
  if (!id) {
    const sel = await R.seleccionar(db, e.referencia);
    if (sel.tipo === 'unica') {
      id = sel.movimiento.movimiento_id;
      metodo = sel.metodo;
    } else if (e.motivo === 'duplicada') {
      // "Están repetidas, borra una": se busca entre las compras señaladas un par de gemelas.
      const grupos: R.Candidato[][] = [];
      for (const c of sel.candidatos) {
        if (grupos.some((g) => g.some((x) => x.movimiento_id === c.movimiento_id))) continue;
        const gs = await R.gemelas(db, c);
        if (gs.length) grupos.push([c, ...gs]);
      }
      if (grupos.length !== 1) return sinDuplicado(grupos.length ? grupos.flat() : sel.candidatos, grupos.length > 1);
      // Se descarta la copia que siga pendiente; se conserva la otra.
      const g = grupos[0];
      const aDescartar = [...g].sort((a, b) => Number(R.PENDIENTES.includes(b.estado)) - Number(R.PENDIENTES.includes(a.estado)))[0];
      id = aDescartar.movimiento_id;
      conserva = g.find((x) => x.movimiento_id !== id) ?? null;
      metodo = `${sel.metodo}+gemelas`;
    } else return R.noUnica(sel, e.referencia);
  }
  if (e.motivo === 'duplicada' && !conserva) {
    const m = await R.candidatoPorId(db, id);
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    const gs = await R.gemelas(db, m);
    if (!gs.length) return sinDuplicado([m, ...(await R.candidatos(db)).filter((c) => c.movimiento_id !== m.movimiento_id && R.PENDIENTES.includes(c.estado))], false);
    conserva = gs[0];
  }
  // A4: descartar una línea del extracto que tiene un correo unido borraría la compra (el correo ya no suma).
  const { rows: unidoAlCorreo } = await db.query(`SELECT 1 FROM movimientos WHERE conciliado_con = $1 LIMIT 1`, [id]);
  if (unidoAlCorreo.length) throw new ErrorDominio(409, 'esa línea del extracto está unida a un correo: descarta el correo, no la línea');
  const descripcion = await descripcionDe(db, id);
  const { rows } = await db.query(
    `UPDATE movimientos SET estado = 'descartado', motivo_descarte = $2, nota = COALESCE($3, nota),
       en_proceso_hasta = NULL, actualizado_en = now()
     WHERE id = $1 AND estado <> 'descartado' RETURNING id`,
    [id, e.motivo, e.detalle ?? null],
  );
  if (!rows[0]) throw new ErrorDominio(409, 'movimiento no existe o ya está descartado');
  await bitacora(db, { movimiento_id: id, actor: 'agente', instruido_por: instruido, accion: 'descartar', despues: { motivo: e.motivo, detalle: e.detalle, metodo, conserva: conserva?.movimiento_id }, ctx });
  if (e.motivo === 'no_reconocida') {
    await ef.avisarHook({ movimiento_id: id, evento: 'alerta_no_reconocida' });
    return {
      aplicado: true,
      estado: 'descartado',
      movimiento: descripcion,
      alerta: true,
      recomendacion: 'Compra no reconocida: avisar a Miguel y Katerine ya y recomendar llamar al banco para bloquear la tarjeta. El agente no puede bloquearla.',
    };
  }
  return { aplicado: true, estado: 'descartado', movimiento: descripcion, ...(conserva ? { se_conserva: R.describir(conserva) } : {}) };
}

function sinDuplicado(compras: R.Candidato[], variosPares: boolean) {
  return {
    aplicado: false,
    motivo: variosPares ? 'ambigua' : 'sin_duplicado',
    mensaje: variosPares
      ? 'Hay más de un par de compras repetidas. Muestra la lista numerada y pregunta cuál descartar.'
      : 'No hay otra compra con el mismo valor, fecha y tarjeta: no se descartó nada. Muestra estas compras (sin ids) y pregunta qué quiere hacer.',
    opciones: R.opciones(compras),
  };
}

export async function proponerRegla(db: Db, e: Entrada<'proponer_regla'>, ctx: Contexto = {}) {
  const { rows: c } = await db.query('SELECT id FROM comercios WHERE id = $1', [e.comercio_id]);
  if (!c[0]) throw new ErrorDominio(404, 'comercio no existe');
  if (await comercioEsGenerico(db, e.comercio_id))
    throw new ErrorDominio(422, 'política: los comercios genéricos (pasarelas) no tienen regla de categoría; siempre se pregunta');
  const { rows: cat } = await db.query(`SELECT id FROM categorias WHERE id = $1 AND estado IN ('activa', 'propuesta')`, [e.categoria_id]);
  if (!cat[0]) throw new ErrorDominio(400, 'categoria_id no existe o está inactiva');
  // Lo propone el modelo: nace en propuesta con 0 coincidencias humanas.
  const { rows } = await db.query(
    `INSERT INTO reglas_comercio (comercio_id, categoria_id, persona_default, reembolsable_default, estado, coincidencias_humanas, creada_por)
     VALUES ($1, $2, $3, $4, 'propuesta', 0, 'agente')
     ON CONFLICT (comercio_id) DO NOTHING RETURNING *`,
    [e.comercio_id, e.categoria_id, e.persona ?? null, e.reembolsable ?? null],
  );
  if (!rows[0]) {
    const { rows: ex } = await db.query('SELECT id, estado FROM reglas_comercio WHERE comercio_id = $1', [e.comercio_id]);
    return { creada: false, regla: ex[0], motivo: 'ya existe una regla para ese comercio' };
  }
  await bitacora(db, { actor: 'agente', accion: 'proponer_regla', despues: rows[0], ctx });
  return { creada: true, regla: { id: rows[0].id, estado: 'propuesta' } };
}

/** Umbral de similitud de nombres (pg_trgm) para avisar de una categoría parecida. */
const UMBRAL_CATEGORIA_PARECIDA = 0.45;

/**
 * Categorías existentes parecidas a un nombre nuevo: por nombre (pg_trgm), por las palabras de
 * las categorías base («tiendas» → Supermercado y mercado) y por sinónimos («alquiler» → Arrendamientos).
 */
export async function categoriasParecidas(db: Db, nombre: string): Promise<Array<{ id: number; nombre: string; similitud: number }>> {
  const norm = normalizarCategoria(nombre);
  const { rows: sim } = await db.query<{ id: number; nombre: string; s: number }>(
    `SELECT id, nombre, GREATEST(similarity(nombre_normalizado, $1), word_similarity($1, nombre_normalizado))::float8 AS s
     FROM categorias WHERE estado <> 'inactiva' ORDER BY s DESC, id LIMIT 5`,
    [norm],
  );
  const salida = new Map<number, { id: number; nombre: string; similitud: number }>();
  for (const r of sim) if (Number(r.s) >= UMBRAL_CATEGORIA_PARECIDA) salida.set(r.id, { id: r.id, nombre: r.nombre, similitud: Number(Number(r.s).toFixed(2)) });
  const cats = await R.nombresCategorias(db);
  for (const id of [...R.categoriasPorPalabras(nombre), ...R.categoriasPorSinonimos(nombre, cats)]) {
    const c = cats.find((x) => x.id === id);
    if (c && !salida.has(id)) salida.set(id, { id, nombre: c.nombre, similitud: 0 });
  }
  return [...salida.values()].slice(0, 3);
}

/**
 * Categoría nueva. No necesita aprobación, pero antes se valida la similitud: si hay una
 * parecida, NO se crea y se devuelven las parecidas para proponerlas. Solo con `confirmar_nueva`
 * (la persona ya vio las parecidas y quiere la nueva igual) se crea aunque se parezca. Un nombre
 * igual a uno existente nunca se crea dos veces.
 */
export async function crearCategoria(
  db: Db,
  e: { nombre: string; confirmar_nueva?: boolean },
  quien: { actor: Actor; instruido_por?: string | null } = { actor: 'agente' },
  ctx: Contexto = {},
) {
  const nombre = e.nombre.trim().replace(/\s+/g, ' ');
  const norm = normalizarCategoria(nombre);
  if (!norm || nombre.length < 3) throw new ErrorDominio(400, 'nombre de 3 a 40 caracteres');
  const { rows: igual } = await db.query(`SELECT id, nombre, estado FROM categorias WHERE nombre_normalizado = $1 OR lower(nombre) = lower($2)`, [norm, nombre]);
  if (igual[0]) {
    if (igual[0].estado === 'inactiva') {
      const { rows } = await db.query(`UPDATE categorias SET estado = 'activa' WHERE id = $1 RETURNING id, nombre, estado`, [igual[0].id]);
      await bitacora(db, { actor: quien.actor, instruido_por: quien.instruido_por, accion: 'reactivar_categoria', despues: rows[0], ctx });
      return { creada: false, reactivada: true, categoria: rows[0], mensaje: `«${rows[0].nombre}» ya existía y quedó activa de nuevo.` };
    }
    return {
      creada: false, ya_existe: true, existente: { id: igual[0].id, nombre: igual[0].nombre },
      categoria: { id: igual[0].id, nombre: igual[0].nombre, estado: igual[0].estado },
      mensaje: `«${igual[0].nombre}» ya existe: usa esa.`,
    };
  }
  if (!e.confirmar_nueva) {
    const parecidas = await categoriasParecidas(db, nombre);
    if (parecidas.length)
      return {
        creada: false,
        existente: { id: parecidas[0].id, nombre: parecidas[0].nombre },
        similitud: parecidas[0].similitud,
        parecidas,
        mensaje: `No la creé: se parece a ${parecidas.map((p) => `«${p.nombre}»`).join(', ')}. Pregunta si usa una de esas o si quiere «${nombre}» igual; si quiere la nueva, vuelve a llamar con confirmar_nueva: true.`,
      };
  }
  const { rows } = await db.query(
    `INSERT INTO categorias (nombre, nombre_normalizado, estado, creada_por, confirmada_por) VALUES ($1, $2, 'activa', $3, $3) RETURNING id, nombre, estado`,
    [nombre, norm, quien.actor],
  );
  await bitacora(db, { actor: quien.actor, instruido_por: quien.instruido_por, accion: 'crear_categoria', despues: { ...rows[0], confirmar_nueva: !!e.confirmar_nueva }, ctx });
  return { creada: true, categoria: rows[0], mensaje: `Categoría «${rows[0].nombre}» creada y lista para usar.` };
}

/** Herramienta del chat `crear_categoria`: la crea a nombre de quien la pide. */
export async function crearCategoriaChat(db: Db, e: Entrada<'crear_categoria'>, ctx: Contexto = {}) {
  const quien = await remitenteDe(db, undefined, e.numero_remitente);
  return crearCategoria(db, { nombre: e.nombre, confirmar_nueva: e.confirmar_nueva }, { actor: quien, instruido_por: quien }, ctx);
}

const PLAN_RECLASIFICACION = `
  SELECT m.id, c.nombre AS comercio, m.valor::int AS valor, m.fecha::text AS fecha,
         m.categoria_id AS categoria_actual, r.categoria_id AS categoria_nueva, r.id AS regla_id,
         COALESCE(CASE WHEN t.tipo = 'individual' THEN t.persona_default END, m.persona, r.persona_default) AS persona
  FROM movimientos m
  JOIN reglas_comercio r ON r.comercio_id = m.comercio_id AND r.estado = 'confirmada' AND r.categoria_id IS NOT NULL
  JOIN comercios c ON c.id = m.comercio_id
  LEFT JOIN tarjetas t ON t.id = m.tarjeta_id
  WHERE m.estado IN ('por_preguntar', 'esperando_respuesta', 'requiere_revision', 'confirmado', 'provisional')
    AND m.categoria_id IS DISTINCT FROM r.categoria_id
    AND (m.clasificado_por IS NULL OR m.clasificado_por IN ('sistema', 'agente'))
  ORDER BY m.fecha, m.id`;

export async function reclasificar(db: Db, e: Entrada<'reclasificar'>, ctx: Contexto = {}) {
  const umbral = Number(await config<number>(db, 'umbral_reclasificacion', UMBRAL_DEFAULT));
  return db.tx(async (tx) => {
    const { rows: plan } = await tx.query(`${PLAN_RECLASIFICACION} FOR UPDATE OF m`);
    const huella = createHash('sha256').update(plan.map((p) => `${p.id}:${p.categoria_nueva}`).join('|')).digest('hex');
    if (e.dry_run) {
      const token = randomBytes(18).toString('base64url');
      await tx.query(
        `INSERT INTO tokens_reclasificacion (token, huella, cantidad, expira_en) VALUES ($1, $2, $3, now() + interval '30 minutes')`,
        [token, huella, plan.length],
      );
      return { dry_run: true, cantidad: plan.length, muestra: plan.slice(0, 10), token_confirmacion: token, requiere_aprobacion: plan.length > umbral, umbral };
    }
    if (plan.length > umbral) {
      if (!e.token_confirmacion || !e.aprobado_por)
        throw new ErrorDominio(403, `son ${plan.length} movimientos (> ${umbral}): hace falta token_confirmacion y el "sí" de Miguel o Katerine`);
      const { rows: tok } = await tx.query(
        `UPDATE tokens_reclasificacion SET usado_en = now()
         WHERE token = $1 AND usado_en IS NULL AND expira_en > now() AND huella = $2 RETURNING token`,
        [e.token_confirmacion, huella],
      );
      if (!tok[0]) throw new ErrorDominio(403, 'token inválido, vencido, usado o el plan cambió: repetir dry_run');
    } else if (e.token_confirmacion) {
      await tx.query(`UPDATE tokens_reclasificacion SET usado_en = now() WHERE token = $1 AND usado_en IS NULL`, [e.token_confirmacion]);
    }
    for (const p of plan) {
      await tx.query(
        `UPDATE movimientos SET categoria_id = $2, regla_id = $3, persona = COALESCE(persona, $4), clasificado_por = 'sistema',
           estado = CASE WHEN COALESCE(persona, $4) IS NOT NULL AND estado <> 'confirmado' THEN 'confirmado' ELSE estado END,
           actualizado_en = now()
         WHERE id = $1`,
        [p.id, p.categoria_nueva, p.regla_id, p.persona],
      );
      await bitacora(tx, {
        movimiento_id: p.id, actor: 'agente', instruido_por: e.aprobado_por ?? null, accion: 'reclasificar',
        antes: { categoria_id: p.categoria_actual }, despues: { categoria_id: p.categoria_nueva, regla_id: p.regla_id }, ctx,
      });
    }
    return { dry_run: false, cantidad: plan.length };
  });
}

export async function modoPreguntas(db: Db, e: Entrada<'modo_preguntas'>, ctx: Contexto = {}) {
  const antes = await config<string>(db, 'modo_preguntas', 'por_comercio');
  await db.query(
    `INSERT INTO config (clave, valor) VALUES ('modo_preguntas', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [JSON.stringify(e.modo)],
  );
  await bitacora(db, { actor: 'agente', accion: 'modo_preguntas', antes: { modo: antes }, despues: { modo: e.modo }, ctx });
  return { modo: e.modo };
}

// ───────────────────────────── Resúmenes y repaso ─────────────────────────────

const PERSONAS: Record<string, string> = { miguel: 'Miguel', katerine: 'Katerine', compartido: 'Compartido', sin_asignar: 'Sin asignar' };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const pesos = (v: number) => `$${fmt(v)}`;

/**
 * Texto del resumen armado por el servidor: el agente lo publica tal cual y ninguna cifra
 * pasa por el modelo. Corto, para WhatsApp.
 */
export function textoResumen(r: {
  mes: string; persona?: string; total: number; cantidad: number; reembolsable: number;
  por_persona: Array<{ persona: string; total: number }>; por_categoria: Array<{ categoria: string; total: number }>;
  variaciones: Array<{ categoria: string; variacion_pct: number | null }>; esperando: number; alertas: number;
  /** Mes en curso: la comparación es contra los mismos días (1..corte) del mes anterior. */
  corte?: number | null;
  /** Ingresos del mes (sin filtros de tarjeta o categoría). Sin ingresos no se muestra saldo. */
  ingresos?: { total: number; propios: number; reembolsos: number; cantidad: number; por_persona: Array<{ persona: string; total: number }> } | null;
  /** Lo que la empresa debe en total (compras reembolsables sin pagar, todos los meses). */
  debe_empresa?: number;
}): string {
  const [a, m] = r.mes.split('-');
  const quien = r.persona ? ` de ${PERSONAS[r.persona] ?? r.persona}` : '';
  const l: string[] = [`Gastos${quien} de ${MESES[Number(m) - 1]} ${a}: ${pesos(r.total)} en ${r.cantidad} ${r.cantidad === 1 ? 'compra' : 'compras'}.`];
  if (!r.persona && r.por_persona.length > 1) l.push(r.por_persona.map((p) => `${PERSONAS[p.persona] ?? p.persona} ${pesos(p.total)}`).join(' · '));
  if (r.por_categoria.length) l.push('', 'Por categoría:', ...r.por_categoria.slice(0, 5).map((c) => `• ${c.categoria}: ${pesos(c.total)}`));
  if (r.reembolsable > 0) l.push(`Reembolsable de la empresa: ${pesos(r.reembolsable)}.`);
  if (r.ingresos && r.ingresos.cantidad > 0) {
    const ing = r.ingresos;
    const quienes = !r.persona && ing.por_persona.length > 1 ? ` (${ing.por_persona.map((p) => `${PERSONAS[p.persona] ?? p.persona} ${pesos(p.total)}`).join(' · ')})` : '';
    const salio = r.total - r.reembolsable;
    const quedo = ing.propios - salio;
    l.push('', `Ingresos: ${pesos(ing.total)}${quienes}.`);
    if (ing.reembolsos > 0) l.push(`De ellos, reembolsos de la empresa: ${pesos(ing.reembolsos)}.`);
    l.push(`Saldo: entró ${pesos(ing.propios)}, salió ${pesos(salio)}, ${quedo >= 0 ? `quedó ${pesos(quedo)}` : `faltó ${pesos(-quedo)}`}.`);
  }
  if (r.debe_empresa && r.debe_empresa > 0) l.push(`La empresa les debe ${pesos(r.debe_empresa)} en total.`);
  const fuertes = r.variaciones.filter((v) => v.variacion_pct !== null);
  const frente = r.corte ? `Frente al 1–${r.corte} del mes anterior` : 'Frente al mes anterior';
  if (fuertes.length) l.push('', `${frente}: ${fuertes.map((v) => `${v.categoria} ${v.variacion_pct! > 0 ? '+' : ''}${v.variacion_pct}%`).join(', ')}.`);
  if (r.esperando) l.push('', `Faltan por responder: ${r.esperando}.`);
  if (r.alertas) l.push(`Hay ${r.alertas} ${r.alertas === 1 ? 'compra' : 'compras'} por revisar en el tablero.`);
  return l.join('\n');
}

export async function resumen(db: Db, e: Entrada<'resumen'>, ef?: Efectos) {
  // Antes de calcular: reintentar las TRM pendientes (todas las cifras van en COP).
  if (ef) await reintentarTrm(db, ef);
  const desde = `${e.mes}-01`;
  // Sin doble conteo: las compras por correo que ya tienen su fila del extracto no suman.
  const noSuman = await idsQueNoSuman(db);
  const filtros: string[] = [`m.fecha >= $1::date`, `m.fecha < ($1::date + interval '1 month')`, `m.estado <> 'descartado'`, `NOT (m.id = ANY($2::uuid[]))`];
  const params: unknown[] = [desde, noSuman];
  const add = (cond: string, v: unknown) => {
    params.push(v);
    filtros.push(cond.replaceAll('?', `$${params.length}`));
  };
  if (e.persona) add('m.persona = ?', e.persona);
  if (e.tarjeta) add('(t.id = ? OR t.nombre ILIKE ?)', e.tarjeta);
  if (e.categoria_id) add('m.categoria_id = ?', e.categoria_id);
  if (e.reembolsable !== undefined) add('m.reembolsable = ?', e.reembolsable);
  const where = filtros.join(' AND ');
  const base = `FROM movimientos m LEFT JOIN tarjetas t ON t.id = m.tarjeta_id LEFT JOIN categorias c ON c.id = m.categoria_id WHERE ${where}`;
  const q = async (sql: string) => (await db.query(sql, params)).rows;

  const [tot] = await q(`SELECT COALESCE(SUM(m.valor), 0)::bigint AS total, COUNT(*)::int AS cantidad,
      COALESCE(SUM(m.valor) FILTER (WHERE m.reembolsable), 0)::bigint AS reembolsable,
      COALESCE(SUM(m.valor) FILTER (WHERE m.estado <> 'confirmado'), 0)::bigint AS sin_confirmar,
      COUNT(*) FILTER (WHERE m.clasificado_por = 'sistema')::int AS resueltas_sin_llm ${base}`);
  const porCategoria = await q(`SELECT m.categoria_id, COALESCE(c.nombre, 'Sin clasificar') AS categoria,
      SUM(m.valor)::bigint AS total, COUNT(*)::int AS cantidad ${base} GROUP BY 1, 2 ORDER BY 3 DESC`);
  const porPersona = await q(`SELECT COALESCE(m.persona, 'sin_asignar') AS persona, SUM(m.valor)::bigint AS total ${base} GROUP BY 1 ORDER BY 2 DESC`);
  const porTarjeta = await q(`SELECT t.nombre AS tarjeta, SUM(m.valor)::bigint AS total ${base} GROUP BY 1 ORDER BY 2 DESC`);
  // Mes en curso: se compara con los mismos días del mes anterior (no con el mes completo).
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const corte = e.mes === hoy.slice(0, 7) ? Number(hoy.slice(8, 10)) : null;
  const anterior = (await db.query(
    `SELECT m.categoria_id, SUM(m.valor)::bigint AS total FROM movimientos m
     WHERE m.fecha >= ($1::date - interval '1 month')
       AND m.fecha < LEAST($1::date, ($1::date - interval '1 month')::date + COALESCE($3::int, 31))
       AND m.estado <> 'descartado' AND NOT (m.id = ANY($2::uuid[])) GROUP BY 1`,
    [desde, noSuman, corte],
  )).rows;
  const variaciones = porCategoria
    .map((c: any) => {
      const prev = anterior.find((a: any) => a.categoria_id === c.categoria_id);
      const p = prev ? Number(prev.total) : 0;
      return { categoria: c.categoria, actual: Number(c.total), anterior: p, variacion_pct: p ? Math.round(((Number(c.total) - p) / p) * 100) : null };
    })
    .filter((v) => v.variacion_pct !== null && Math.abs(v.variacion_pct) >= 30);

  const pendientes = (await db.query(
    `SELECT estado, COUNT(*)::int AS cantidad FROM movimientos
     WHERE estado IN ('requiere_interpretacion', 'requiere_revision', 'requiere_trm', 'por_preguntar', 'en_proceso', 'esperando_respuesta') GROUP BY 1`,
  )).rows;
  const revision = (await db.query(
    // SEC-001: sin asunto ni texto del correo; el modelo recibe ids y la nota del servidor.
    `SELECT m.id AS movimiento_id, m.nota FROM movimientos m
     WHERE m.estado = 'requiere_revision' ORDER BY m.creado_en LIMIT 20`,
  )).rows;
  const atascadosAlerta = (await db.query(
    `${ATASCO_SELECT('movimientos')}
     WHERE (m.estado = 'en_proceso' AND m.en_proceso_hasta < now())
        OR (m.estado = 'por_preguntar' AND (m.intentos_preguntar >= 1 OR m.creado_en < now() - interval '30 minutes'))
     ORDER BY m.creado_en LIMIT 20`,
  )).rows.map(atasco);
  const sinTrm = (await db.query(
    `SELECT m.id AS movimiento_id, m.fecha::text AS fecha, m.valor_original::float8 AS valor_usd, c.nombre AS comercio
     FROM movimientos m LEFT JOIN comercios c ON c.id = m.comercio_id WHERE m.estado = 'requiere_trm' ORDER BY m.creado_en LIMIT 20`,
  )).rows;
  const sinPareja = (await db.query(
    `SELECT correo_id, tipo FROM correos WHERE estado = 'sin_pareja' AND recibido_en > now() - interval '7 days'`,
  )).rows;
  const plantillas = (await db.query(
    `SELECT banco FROM (
       SELECT banco, resultado_parser, ROW_NUMBER() OVER (PARTITION BY banco ORDER BY recibido_en DESC) AS n
       FROM correos WHERE banco IS NOT NULL AND resultado_parser IS NOT NULL) x
     WHERE n <= 3 GROUP BY banco HAVING COUNT(*) = 3 AND bool_and(resultado_parser = 'fallo')`,
  )).rows.map((r: any) => r.banco);
  const n = (v: any) => Number(v);
  const esperando = pendientes.find((p: any) => p.estado === 'esperando_respuesta')?.cantidad ?? 0;
  // Ingresos y saldo: solo en el resumen general (o de una persona), no filtrado por tarjeta o categoría.
  const conIngresos = !e.tarjeta && !e.categoria_id && e.reembolsable === undefined;
  const ingresos = conIngresos ? await cifrasIngresos(db, e.mes, e.persona) : null;
  const debeEmpresa = conIngresos && !e.persona ? (await reembolsablesPendientes(db)).reduce((s, c) => s + c.valor, 0) : 0;
  const gastosPropios = n(tot.total) - n(tot.reembolsable);
  const texto = textoResumen({
    mes: e.mes, persona: e.persona, total: n(tot.total), cantidad: tot.cantidad, reembolsable: n(tot.reembolsable),
    por_persona: porPersona.map((c: any) => ({ persona: c.persona, total: n(c.total) })),
    por_categoria: porCategoria.map((c: any) => ({ categoria: c.categoria, total: n(c.total) })),
    variaciones, esperando, alertas: atascadosAlerta.length + revision.length + sinTrm.length, corte,
    ingresos, debe_empresa: debeEmpresa,
  });
  return {
    mes: e.mes,
    texto,
    filtros: { persona: e.persona, tarjeta: e.tarjeta, categoria_id: e.categoria_id, reembolsable: e.reembolsable },
    total: n(tot.total),
    cantidad: tot.cantidad,
    reembolsable: n(tot.reembolsable),
    sin_confirmar: n(tot.sin_confirmar),
    ingresos,
    saldo: ingresos && ingresos.cantidad > 0 ? { entro: ingresos.propios, salio: gastosPropios, quedo: ingresos.propios - gastosPropios } : null,
    debe_empresa: debeEmpresa,
    por_categoria: porCategoria.map((c: any) => ({ ...c, total: n(c.total) })),
    por_persona: porPersona.map((c: any) => ({ ...c, total: n(c.total) })),
    por_tarjeta: porTarjeta.map((c: any) => ({ ...c, total: n(c.total) })),
    variaciones_fuertes: variaciones,
    pendientes,
    alertas: { pendientes_atascados: atascadosAlerta, requiere_revision: revision, requiere_trm: sinTrm, reversos_sin_pareja: sinPareja, plantillas_cambiadas: plantillas },
    metricas: { pct_sin_llm: tot.cantidad ? Math.round((tot.resueltas_sin_llm / tot.cantidad) * 100) : null },
  };
}

export async function repaso(db: Db) {
  const categorias = (await db.query(`SELECT id, nombre FROM categorias WHERE estado = 'propuesta' ORDER BY id`)).rows;
  const reglas = (await db.query(
    `SELECT r.id, co.nombre AS comercio, c.nombre AS categoria, r.persona_default, r.reembolsable_default, r.coincidencias_humanas
     FROM reglas_comercio r JOIN comercios co ON co.id = r.comercio_id LEFT JOIN categorias c ON c.id = r.categoria_id
     WHERE r.estado = 'propuesta' ORDER BY r.id`,
  )).rows;
  // SEC-001: la vista del modelo no incluye descripcion_original (texto de terceros).
  const revision = (await db.query(`${VISTA} WHERE m.estado = 'requiere_revision' ORDER BY m.creado_en`))
    .rows.map(conTexto).map(({ descripcion_original: _omitido, ...sinTexto }: any) => sinTexto);
  const metricas = await metricasSemana(db);
  // Numeración única para «sí a todo» / «sí menos la 2»: n → (tipo, id). El agente pasa los ids a confirmar_repaso.
  const numeracion = [
    ...categorias.map((c: any) => ({ tipo: 'categoria' as const, id: c.id as number, texto: `Categoría nueva: ${c.nombre}` })),
    ...reglas.map((r: any) => ({
      tipo: 'regla' as const, id: r.id as number,
      texto: `${r.comercio} → ${r.categoria ?? 'sin categoría'}${r.persona_default ? ` (${PERSONAS[r.persona_default] ?? r.persona_default})` : ''}`,
    })),
  ].map((x, i) => ({ n: i + 1, ...x }));
  return {
    categorias_propuestas: categorias, reglas_propuestas: reglas, requiere_revision: revision, numeracion, metricas,
    texto: textoRepaso(numeracion, revision.length, metricas),
  };
}

/** Métricas de los últimos 7 días: tiempo de respuesta y aciertos de la categoría sugerida. */
export async function metricasSemana(db: Db) {
  const [r] = (await db.query(
    `WITH resp AS (
       SELECT m.id, m.categoria_id, m.categorias_sugeridas, m.preguntado_en,
              (SELECT min(b.creado_en) FROM bitacora b WHERE b.movimiento_id = m.id AND b.accion = 'clasificar') AS respondido_en
       FROM movimientos m
       WHERE m.estado = 'confirmado' AND m.preguntado_en IS NOT NULL AND m.preguntado_en > now() - interval '7 days')
     SELECT count(*)::int AS respondidas,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (respondido_en - preguntado_en)) / 60))::int AS mediana_min,
            count(*) FILTER (WHERE categorias_sugeridas[1] = categoria_id)::int AS acierto_primera,
            count(*) FILTER (WHERE categoria_id = ANY(categorias_sugeridas))::int AS en_lista
     FROM resp WHERE respondido_en IS NOT NULL`,
  )).rows;
  const pct = (x: number) => (r.respondidas ? Math.round((x / r.respondidas) * 100) : null);
  return {
    respondidas: r.respondidas as number,
    mediana_respuesta_min: (r.mediana_min ?? null) as number | null,
    pct_acierto_primera: pct(r.acierto_primera),
    pct_en_lista: pct(r.en_lista),
  };
}

/** Texto del repaso armado por el servidor (numerado para «sí a todo» / «sí menos la 2»). */
export function textoRepaso(
  numeracion: Array<{ n: number; texto: string }>, enRevision: number,
  m: { respondidas: number; mediana_respuesta_min: number | null; pct_acierto_primera: number | null },
): string {
  const l: string[] = ['Repaso de la semana.'];
  if (numeracion.length)
    l.push('', 'Para aprobar:', ...numeracion.map((x) => `${x.n}. ${x.texto}`), '', 'Respondan «sí a todo» o, por ejemplo, «sí menos la 2».');
  else l.push('No hay reglas ni categorías nuevas para aprobar.');
  if (enRevision) l.push('', `${enRevision} ${enRevision === 1 ? 'compra necesita' : 'compras necesitan'} revisión en el tablero.`);
  if (m.respondidas)
    l.push('', `Esta semana respondieron ${m.respondidas} ${m.respondidas === 1 ? 'pregunta' : 'preguntas'}` +
      `${m.mediana_respuesta_min != null ? ` (mediana ${m.mediana_respuesta_min} min)` : ''}` +
      `${m.pct_acierto_primera != null ? `; la primera opción acertó ${m.pct_acierto_primera}%` : ''}.`);
  return l.join('\n');
}

export async function confirmarRepaso(db: Db, e: Entrada<'confirmar_repaso'>, ctx: Contexto = {}) {
  return db.tx(async (tx) => {
    const cats = e.categorias_ids?.length
      ? (await tx.query(
          `UPDATE categorias SET estado = 'activa', confirmada_por = $2 WHERE id = ANY($1::int[]) AND estado = 'propuesta' RETURNING id`,
          [e.categorias_ids, e.confirmado_por],
        )).rows
      : [];
    const reglas = e.reglas_ids?.length
      ? (await tx.query(
          `UPDATE reglas_comercio SET estado = 'confirmada', confirmada_por = $2, confirmada_en = now(), actualizada_en = now()
           WHERE id = ANY($1::int[]) AND estado = 'propuesta' AND categoria_id IS NOT NULL RETURNING id`,
          [e.reglas_ids, e.confirmado_por],
        )).rows
      : [];
    await bitacora(tx, { actor: e.confirmado_por, instruido_por: e.confirmado_por, accion: 'confirmar_repaso', despues: { categorias: cats, reglas }, ctx });
    return { categorias_confirmadas: cats.map((c) => c.id), reglas_confirmadas: reglas.map((r) => r.id) };
  });
}

// ───────────────────────────── Detalle y mensaje original ─────────────────────────────

/**
 * Texto legible del correo original: sin HTML, sin espacios repetidos y con cualquier número
 * largo (13+ dígitos, posible tarjeta completa) enmascarado. Para personas, nunca para el modelo.
 */
export function textoLegible(crudo: string): string {
  const sinHtml = crudo
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h\d|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return sinHtml
    .replace(/\d(?:[ -]?\d){12,}/g, (m) => `•••• ${m.replace(/\D/g, '').slice(-4)}`)
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n').trim();
}

/** Datos de una compra con su mensaje original (correo o línea del extracto). */
export async function detalleMovimiento(db: Db, movimiento_id: string) {
  const { rows } = await db.query(
    `${VISTA.replace('m.categorias_sugeridas', `m.categorias_sugeridas, m.fuente, m.nota, m.correo_id, m.motivo_descarte,
       cat.nombre AS categoria, co.asunto, co.remitente, co.fecha_correo::text AS fecha_correo, co.texto AS correo_texto`)}
     LEFT JOIN categorias cat ON cat.id = m.categoria_id
     LEFT JOIN correos co ON co.correo_id = m.correo_id
     WHERE m.id = $1`,
    [movimiento_id],
  );
  const m = rows[0];
  if (!m) throw new ErrorDominio(404, 'movimiento no existe');
  return {
    movimiento_id: m.movimiento_id as string,
    fuente: m.fuente as string,
    estado: m.estado as string,
    fecha: m.fecha as string | null,
    valor_texto: valorTexto(m),
    valor: Number(m.valor),
    tarjeta_id: (m.tarjeta_id ?? null) as string | null,
    categoria_id: (m.categoria_id ?? null) as number | null,
    comercio: (m.comercio ?? null) as string | null,
    descripcion_original: (m.descripcion_original ?? null) as string | null,
    tarjeta: (m.tarjeta ?? null) as string | null,
    categoria: (m.categoria ?? null) as string | null,
    persona: (m.persona ?? null) as string | null,
    nota: (m.nota ?? null) as string | null,
    correo: m.correo_id
      ? { asunto: m.asunto as string, remitente: m.remitente as string, fecha: m.fecha_correo as string, texto: textoLegible(m.correo_texto ?? '') }
      : null,
  };
}

/** Mensaje de WhatsApp con el detalle (lo envía el MCP; el modelo no lo ve). */
export function textoDetalle(d: Awaited<ReturnType<typeof detalleMovimiento>>): string {
  const cab = [
    `Detalle: ${d.comercio ?? d.descripcion_original ?? 'compra'} · ${d.valor_texto}`,
    [d.fecha, d.tarjeta, d.categoria, d.persona].filter(Boolean).join(' · '),
  ];
  if (!d.correo) {
    const origen = d.fuente === 'extracto' ? `Línea del extracto: ${d.descripcion_original ?? ''}`
      : d.fuente === 'captura' ? `Cargada desde una captura o reporte de la app del banco: ${d.descripcion_original ?? ''}`
      : 'No hay correo original guardado.';
    return [...cab, '', origen].join('\n');
  }
  const cuerpo = d.correo.texto.length > 3000 ? `${d.correo.texto.slice(0, 3000)}\n[…recortado; completo en el tablero]` : d.correo.texto;
  return [...cab, '', `Correo de ${d.correo.remitente || 'remitente desconocido'} — ${d.correo.asunto || '(sin asunto)'}`, '', cuerpo].join('\n');
}

/**
 * «Pásame el detalle / el mensaje original»: el servidor arma el texto y decide el chat
 * (el privado de quien pidió o el grupo); el MCP lo envía. El modelo solo recibe «enviado».
 */
export async function enviarDetalle(db: Db, e: Entrada<'enviar_detalle'>) {
  const quien = await remitenteDe(db, undefined, e.numero_remitente);
  const obj = await objetivo(db, e);
  if ('respuesta' in obj) return obj.respuesta;
  const d = await detalleMovimiento(db, obj.id);
  const target = await targetDe(db, e.canal === 'privado' ? quien : 'grupo');
  return { aplicado: true, target, mensaje: textoDetalle(d), movimiento: `${d.comercio ?? 'compra'} · ${d.valor_texto}`, FIN: true };
}

type QuienRevision = { correo: string; persona: Persona };

/**
 * Atender desde el tablero una compra en «requiere revisión» (p. ej. sin valor o con tarjeta
 * desconocida): una persona completa los datos leyendo el correo original.
 * Con categoría queda confirmada; sin categoría pasa a por_preguntar y el respaldo la pregunta.
 */
/**
 * Confirmar desde el tablero una compra pendiente (esperando respuesta, por preguntar o en revisión
 * con categoría): usa la misma operación que la respuesta por WhatsApp. Canal «grupo» porque el
 * tablero ya autenticó a la persona; así no se aplica el filtro de sugerencia del privado.
 */
export async function confirmarTablero(db: Db, e: { movimiento_id: string; categoria_id: number }, quien: QuienRevision) {
  return clasificar(db, { movimiento_id: e.movimiento_id, categoria_id: e.categoria_id, respondido_por: quien.persona, canal: 'grupo' } as any, { sesion_openclaw: 'tablero' });
}

/**
 * Cambiar la fecha de una compra desde el tablero (p. ej. el banco la registró otro día).
 * No toca compras descartadas. Queda en la bitácora con la fecha anterior. La fecha no puede ser
 * futura (+1 día de margen por la zona horaria) ni anterior a 2020.
 */
export async function cambiarFechaTablero(db: Db, e: unknown, quien: QuienRevision, ahora = Date.now()) {
  const E = z.object({ movimiento_id: z.string().uuid(), fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'entrada inválida');
  const { movimiento_id, fecha } = E.data;
  const t = Date.parse(`${fecha}T12:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== fecha) throw new ErrorDominio(400, 'fecha inválida');
  if (fecha < '2020-01-01' || t > ahora + 36 * 3600_000) throw new ErrorDominio(400, 'la fecha no puede ser futura ni anterior a 2020');
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT id, estado, fecha::text AS fecha FROM movimientos WHERE id = $1 FOR UPDATE`, [movimiento_id]);
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (m.estado === 'descartado') throw new ErrorDominio(409, 'la compra está descartada');
    if (m.fecha === fecha) return { aplicado: true, sin_cambios: true, fecha };
    await tx.query(`UPDATE movimientos SET fecha = $2, actualizado_en = now() WHERE id = $1`, [movimiento_id, fecha]);
    await bitacora(tx, { movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion: 'cambiar_fecha', antes: { fecha: m.fecha }, despues: { fecha } });
    return { aplicado: true, fecha, antes: m.fecha as string | null };
  });
}

/**
 * Editar desde el tablero los datos de una compra: valor, fecha, comercio, tarjeta, categoría,
 * persona y nota. No cambia el estado (eso lo hacen las otras acciones). Las descartadas no se
 * editan. Cada campo cambiado queda en la bitácora con su valor anterior. Si la tarjeta es
 * individual, la persona es la de la tarjeta.
 */
export async function editarMovimientoTablero(db: Db, e: unknown, quien: QuienRevision, ahora = Date.now(), accion = 'editar_tablero') {
  const E = z.object({
    movimiento_id: z.string().uuid(),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    valor: z.number().int().positive().max(1_000_000_000).optional(),
    comercio: z.string().trim().min(2).max(60).optional(),
    tarjeta_id: z.string().min(2).max(40).optional(),
    categoria_id: z.number().int().positive().optional(),
    persona: z.enum(['miguel', 'katerine']).optional(),
    nota: z.string().trim().max(200).optional(),
    medio_pago: z.enum(['efectivo', 'pse', 'bre_b', 'transferencia', 'tarjeta_debito', 'otro']).optional(),
  }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'entrada inválida');
  const { movimiento_id, medio_pago: medioPagoDicho, ...cambios } = E.data;
  if (cambios.fecha !== undefined) {
    const t = Date.parse(`${cambios.fecha}T12:00:00Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== cambios.fecha) throw new ErrorDominio(400, 'fecha inválida');
    if (cambios.fecha < '2020-01-01' || t > ahora + 36 * 3600_000) throw new ErrorDominio(400, 'la fecha no puede ser futura ni anterior a 2020');
  }
  if (Object.keys(cambios).length === 0) throw new ErrorDominio(400, 'no hay nada que cambiar');
  return db.tx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, estado, fecha::text AS fecha, valor::int AS valor, comercio_id, tarjeta_id, categoria_id, persona, nota, fuente, medio_pago
       FROM movimientos WHERE id = $1 FOR UPDATE`,
      [movimiento_id],
    );
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (m.estado === 'descartado') throw new ErrorDominio(409, 'la compra está descartada');
    // M1: correo y línea del extracto ya conciliados son UNA compra. Valor, fecha y tarjeta salen del
    // extracto (si cambian, los totales no se moverían); categoría y persona se copian a la pareja.
    const { rows: pares } = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM movimientos WHERE id <> $1
         AND (id = (SELECT conciliado_con FROM movimientos WHERE id = $1) OR conciliado_con = $1)`,
      [movimiento_id],
    );
    const conciliada = pares.length > 0;
    if (conciliada && ((cambios.valor !== undefined && cambios.valor !== m.valor) || (cambios.fecha !== undefined && cambios.fecha !== m.fecha)
      || (cambios.tarjeta_id !== undefined && cambios.tarjeta_id !== m.tarjeta_id)))
      throw new ErrorDominio(409, 'compra conciliada con el extracto: el valor, la fecha y la tarjeta salen del extracto');

    let tarjeta: { id: string; tipo: string; persona_default: string | null; canal: string; clase: string } | undefined;
    if (cambios.tarjeta_id !== undefined) {
      const { rows: t } = await tx.query(`SELECT id, tipo, persona_default, canal, clase FROM tarjetas WHERE id = $1`, [cambios.tarjeta_id]);
      if (!t[0]) throw new ErrorDominio(400, 'tarjeta no existe');
      tarjeta = t[0] as typeof tarjeta;
    }
    const tarjetaFinal = tarjeta ? tarjeta.id : m.tarjeta_id;
    if (tarjetaFinal && (cambios.tarjeta_id !== undefined || cambios.persona !== undefined)) {
      const t: Array<{ id: string; tipo: string; persona_default: string | null }> = tarjeta
        ? [tarjeta]
        : ((await tx.query(`SELECT id, tipo, persona_default FROM tarjetas WHERE id = $1`, [tarjetaFinal])).rows as typeof t);
      if (t[0]?.tipo === 'individual') {
        if (cambios.persona !== undefined && cambios.persona !== t[0].persona_default) throw new ErrorDominio(400, `esa tarjeta es de ${t[0].persona_default}`);
        cambios.persona = t[0].persona_default as 'miguel' | 'katerine';
      }
    }
    if (cambios.categoria_id !== undefined) {
      const { rows: c } = await tx.query(`SELECT id FROM categorias WHERE id = $1 AND estado IN ('activa', 'propuesta')`, [cambios.categoria_id]);
      if (!c[0]) throw new ErrorDominio(400, 'categoría inexistente o inactiva');
    }
    const comercio = cambios.comercio !== undefined ? await resolverComercio(tx, cambios.comercio) : null;

    const sets: string[] = [];
    const params: unknown[] = [movimiento_id];
    const antes: Record<string, unknown> = {};
    const despues: Record<string, unknown> = {};
    const poner = (columna: string, valor: unknown, clave: string, previo: unknown) => {
      params.push(valor);
      sets.push(`${columna} = $${params.length}`);
      antes[clave] = previo;
      despues[clave] = valor;
    };
    if (cambios.fecha !== undefined && cambios.fecha !== m.fecha) poner('fecha', cambios.fecha, 'fecha', m.fecha);
    if (cambios.valor !== undefined && cambios.valor !== m.valor) poner('valor', cambios.valor, 'valor', m.valor);
    if (comercio && comercio.id !== m.comercio_id) {
      // B5: la bitácora guarda el comercio ANTERIOR (no el nuevo) en «antes».
      const { rows: previo } = m.comercio_id
        ? await tx.query<{ nombre: string }>(`SELECT nombre FROM comercios WHERE id = $1`, [m.comercio_id])
        : { rows: [] as Array<{ nombre: string }> };
      poner('comercio_id', comercio.id, 'comercio', previo[0]?.nombre ?? null);
    }
    if (cambios.tarjeta_id !== undefined && cambios.tarjeta_id !== m.tarjeta_id) {
      poner('tarjeta_id', cambios.tarjeta_id, 'tarjeta_id', m.tarjeta_id);
      // Gasto manual: la forma de pago sigue al medio (efectivo, PSE, débito); una transferencia o
      // Bre-B desde otra cuenta conserva su forma.
      if (m.fuente === 'manual' && tarjeta) {
        const nueva = medioPagoDicho
          ?? (tarjeta.canal !== 'tarjeta' ? tarjeta.canal
            : tarjeta.clase === 'efectivo' ? 'efectivo'
            : ['transferencia', 'bre_b'].includes(m.medio_pago) ? m.medio_pago : 'tarjeta_debito');
        if (nueva !== m.medio_pago) poner('medio_pago', nueva, 'medio_pago', m.medio_pago);
      }
    } else if (medioPagoDicho && m.fuente === 'manual' && medioPagoDicho !== m.medio_pago) poner('medio_pago', medioPagoDicho, 'medio_pago', m.medio_pago);
    if (cambios.categoria_id !== undefined && cambios.categoria_id !== m.categoria_id) {
      poner('categoria_id', cambios.categoria_id, 'categoria_id', m.categoria_id);
      poner('reembolsable', cambios.categoria_id === 12, 'reembolsable', undefined);
      poner('clasificado_por', quien.persona, 'clasificado_por', undefined);
    }
    if (cambios.persona !== undefined && cambios.persona !== m.persona) poner('persona', cambios.persona, 'persona', m.persona);
    if (cambios.nota !== undefined && (cambios.nota || null) !== (m.nota || null)) poner('nota', cambios.nota || null, 'nota', m.nota);
    if (sets.length === 0) return { aplicado: true, sin_cambios: true };

    await tx.query(`UPDATE movimientos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $1`, params);
    // M1: la pareja (correo ↔ extracto) toma la categoría, la persona y el reembolsable de esta fila.
    if (conciliada && (cambios.categoria_id !== undefined || cambios.persona !== undefined)) {
      await tx.query(
        `UPDATE movimientos SET categoria_id = src.categoria_id, persona = src.persona, reembolsable = src.reembolsable, actualizado_en = now()
         FROM (SELECT categoria_id, persona, reembolsable FROM movimientos WHERE id = $1) src
         WHERE movimientos.id = ANY($2::uuid[])`,
        [movimiento_id, pares.map((p) => p.id)],
      );
    }
    await bitacora(tx, { movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion, antes, despues });
    return { aplicado: true, cambios: Object.keys(despues) };
  });
}

/**
 * Borrar una compra desde el tablero. IRREVERSIBLE: la fila desaparece. Antes se guarda en la
 * bitácora una copia de cómo quedó (valor, fecha, comercio, tarjeta, categoría, persona, nota).
 * No se borra una compra conciliada con el extracto ni una que tenga su pareja: en ese caso
 * se descarta (así no se rompen los totales ni la conciliación).
 */
export async function borrarMovimientoTablero(db: Db, e: unknown, quien: QuienRevision) {
  const E = z.object({ movimiento_id: z.string().uuid(), confirmar: z.literal(true) }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'falta confirmar el borrado');
  const { movimiento_id } = E.data;
  return db.tx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT m.*, c.nombre AS comercio, t.nombre AS tarjeta_nombre FROM movimientos m
       LEFT JOIN comercios c ON c.id = m.comercio_id LEFT JOIN tarjetas t ON t.id = m.tarjeta_id
       WHERE m.id = $1 FOR UPDATE OF m`,
      [movimiento_id],
    );
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'la compra no existe');
    const { rows: pareja } = await tx.query(
      `SELECT 1 FROM movimientos WHERE conciliado_con = $1 OR id = (SELECT conciliado_con FROM movimientos WHERE id = $1) LIMIT 1`,
      [movimiento_id],
    );
    const { rows: concil } = await tx.query(
      `SELECT 1 FROM conciliaciones WHERE movimiento_id = $1 OR movimiento_correo_id = $1 LIMIT 1`,
      [movimiento_id],
    );
    if (m.conciliado_con || pareja.length || concil.length)
      throw new ErrorDominio(409, 'la compra está conciliada con el extracto: descártala en vez de borrarla');
    const antes = {
      fecha: m.fecha, valor: m.valor, comercio: m.comercio ?? m.descripcion_original, tarjeta: m.tarjeta_nombre ?? null,
      categoria_id: m.categoria_id, persona: m.persona, estado: m.estado, fuente: m.fuente, medio_pago: m.medio_pago, nota: m.nota,
    };
    await bitacora(tx, { movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion: 'borrar_tablero', antes });
    await tx.query(`DELETE FROM recordatorios_pendientes WHERE movimiento_id = $1`, [movimiento_id]);
    await tx.query(`DELETE FROM movimientos WHERE id = $1`, [movimiento_id]);
    return { aplicado: true, borrado: true };
  });
}

export async function atenderRevision(db: Db, e: unknown, quien: QuienRevision) {
  const E = z.object({
    movimiento_id: z.string().uuid(),
    valor: z.number().positive().max(1_000_000_000),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tarjeta_id: z.string().min(2).max(40),
    comercio: z.string().trim().min(2).max(60),
    categoria_id: z.number().int().positive().optional(),
  }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'datos incompletos: valor, fecha, tarjeta y comercio');
  const v = E.data;
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM movimientos WHERE id = $1 FOR UPDATE`, [v.movimiento_id]);
    const m = rows[0];
    if (!m) throw new ErrorDominio(404, 'movimiento no existe');
    if (!['requiere_revision', 'requiere_interpretacion'].includes(m.estado)) throw new ErrorDominio(409, `estado ${m.estado}: ya no está en revisión`);
    const { rows: t } = await tx.query(`SELECT id, tipo, persona_default FROM tarjetas WHERE id = $1`, [v.tarjeta_id]);
    if (!t[0]) throw new ErrorDominio(400, 'tarjeta no existe');
    if (v.categoria_id) {
      const { rows: c } = await tx.query(`SELECT id FROM categorias WHERE id = $1 AND estado IN ('activa', 'propuesta')`, [v.categoria_id]);
      if (!c[0]) throw new ErrorDominio(400, 'categoría inexistente o inactiva');
    }
    const comercio = await resolverComercio(tx, v.comercio);
    const persona = t[0].tipo === 'individual' ? t[0].persona_default : quien.persona;
    const estado = v.categoria_id ? 'confirmado' : 'por_preguntar';
    await tx.query(
      `UPDATE movimientos SET valor = $2, fecha = $3, tarjeta_id = $4, comercio_id = $5, categoria_id = $6, persona = $7,
         reembolsable = $8, estado = $9, clasificado_por = CASE WHEN $6::int IS NULL THEN clasificado_por ELSE $10 END,
         actualizado_en = now() - interval '5 minutes' WHERE id = $1`,
      [v.movimiento_id, Math.round(v.valor), v.fecha, v.tarjeta_id, comercio.id, v.categoria_id ?? null,
        v.categoria_id ? persona : m.persona, v.categoria_id === 12, estado, quien.persona],
    );
    await bitacora(tx, {
      movimiento_id: v.movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion: 'atender_revision',
      antes: { estado: m.estado, valor: m.valor, fecha: m.fecha, tarjeta_id: m.tarjeta_id, nota: m.nota },
      despues: { estado, valor: Math.round(v.valor), fecha: v.fecha, tarjeta_id: v.tarjeta_id, comercio: comercio.nombre, categoria_id: v.categoria_id ?? null },
    });
    return { aplicado: true, estado, comercio: comercio.nombre };
  });
}

/** Descartar desde el tablero una compra que no es un gasto real (p. ej. correo informativo). */
export async function descartarTablero(db: Db, e: unknown, quien: QuienRevision) {
  const E = z.object({
    movimiento_id: z.string().uuid(),
    motivo: z.enum(['rechazada', 'reversada', 'duplicada', 'no_reconocida', 'otro']),
  }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'entrada inválida');
  const { rows } = await db.query(
    `UPDATE movimientos SET estado = 'descartado', motivo_descarte = $2, en_proceso_hasta = NULL, actualizado_en = now()
     WHERE id = $1 AND estado IN ('requiere_revision', 'requiere_interpretacion', 'requiere_trm', 'por_preguntar', 'esperando_respuesta')
     RETURNING id`,
    [E.data.movimiento_id, E.data.motivo],
  );
  if (!rows[0]) throw new ErrorDominio(409, 'esa compra no se puede descartar desde aquí');
  await bitacora(db, { movimiento_id: E.data.movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion: 'descartar_tablero', despues: { motivo: E.data.motivo } });
  return { aplicado: true };
}

// ───────────────────────────── Tablero: acciones de las personas ─────────────────────────────

type QuienTablero = { correo: string; persona: Persona };

/** Compras con la pregunta preparada y el envío sin confirmar: van en «Por atender». */
export async function enviosSinConfirmar(db: Db) {
  const { rows } = await db.query(
    `${VISTA} WHERE m.estado IN ('por_preguntar', 'en_proceso') AND m.pregunta_codigo IS NOT NULL AND m.whatsapp_message_id IS NULL
     ORDER BY m.creado_en LIMIT 50`,
  );
  return rows.map((m: any) => ({
    movimiento_id: m.movimiento_id, fecha: m.fecha, comercio: m.comercio, tarjeta: m.tarjeta,
    valor_texto: valorTexto(m), codigo: `#${m.pregunta_codigo}`, preguntado_a: m.preguntado_a,
  }));
}

/**
 * Una persona decide qué pasó con un envío sin confirmar:
 * - `si_llego`: la pregunta sí llegó → queda esperando respuesta con el mismo código y su recordatorio.
 * - `volver_a_preguntar`: no llegó → se borra el código y el respaldo vuelve a avisar (código nuevo).
 */
export async function resolverEnvioSinConfirmar(db: Db, movimiento_id: string, accion: 'si_llego' | 'volver_a_preguntar', quien: QuienTablero) {
  return db.tx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, estado, pregunta_codigo FROM movimientos
       WHERE id = $1 AND estado IN ('por_preguntar', 'en_proceso') AND pregunta_codigo IS NOT NULL AND whatsapp_message_id IS NULL FOR UPDATE`,
      [movimiento_id],
    );
    const m = rows[0];
    if (!m) throw new ErrorDominio(409, 'esa compra ya no tiene un envío sin confirmar');
    if (accion === 'si_llego') {
      await tx.query(
        `UPDATE movimientos SET estado = 'esperando_respuesta', whatsapp_message_id = 'confirmado-en-tablero', preguntado_en = now(),
           recordado = false, en_proceso_hasta = NULL, ultimo_error = NULL, actualizado_en = now() WHERE id = $1`,
        [movimiento_id],
      );
      await encolarRecordatorio(tx, movimiento_id, m.pregunta_codigo);
    } else {
      await tx.query(
        `UPDATE movimientos SET estado = 'por_preguntar', pregunta_codigo = NULL, intentos_preguntar = 0, en_proceso_hasta = NULL,
           ultimo_error = NULL, actualizado_en = now() - interval '5 minutes' WHERE id = $1`,
        [movimiento_id],
      );
    }
    await bitacora(tx, {
      movimiento_id, actor: quien.persona, instruido_por: quien.correo, accion: 'resolver_envio_sin_confirmar',
      antes: { estado: m.estado, codigo: m.pregunta_codigo }, despues: { accion },
    });
    return { aplicado: true, accion };
  });
}

/**
 * Categoría nueva creada por una persona en el tablero: la misma validación de similitud que
 * el chat (`crear_categoria`).
 */
export async function crearCategoriaTablero(db: Db, nombre: unknown, quien: QuienTablero, confirmar_nueva = false) {
  if (typeof nombre !== 'string' || nombre.trim().length < 3 || nombre.trim().length > 40) throw new ErrorDominio(400, 'nombre de 3 a 40 caracteres');
  return crearCategoria(db, { nombre: nombre.trim(), confirmar_nueva }, { actor: quien.persona, instruido_por: quien.correo });
}

/** Las categorías base (ids menores a 100) las usa el código (defaults, reembolsable): no se borran. */
const ID_MAX_CATEGORIA_BASE = 99;

/**
 * Cambiar el nombre de una categoría desde el tablero. Mismo criterio que al crear: no puede
 * repetir otro nombre y, si se parece a otra categoría, no se cambia hasta confirmar. Solo cambia
 * el nombre (los registros siguen apuntando al mismo id).
 */
export async function renombrarCategoriaTablero(db: Db, e: unknown, quien: QuienRevision) {
  const E = z.object({
    id: z.number().int().positive(),
    nombre: z.string().trim().min(3).max(40),
    confirmar_parecida: z.boolean().optional(),
  }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'nombre de 3 a 40 caracteres');
  const nombre = E.data.nombre.replace(/\s+/g, ' ');
  const norm = normalizarCategoria(nombre);
  if (!norm) throw new ErrorDominio(400, 'nombre inválido');
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT id, nombre, estado FROM categorias WHERE id = $1 FOR UPDATE`, [E.data.id]);
    const c = rows[0];
    if (!c || c.estado === 'inactiva') throw new ErrorDominio(404, 'la categoría no existe');
    if (c.nombre === nombre) return { aplicado: true, sin_cambios: true, categoria: { id: c.id, nombre: c.nombre } };
    const { rows: igual } = await tx.query(
      `SELECT nombre FROM categorias WHERE id <> $1 AND estado <> 'inactiva' AND (nombre_normalizado = $2 OR lower(nombre) = lower($3)) LIMIT 1`,
      [c.id, norm, nombre],
    );
    if (igual[0]) throw new ErrorDominio(409, `ya existe una categoría «${igual[0].nombre}»`);
    // Una categoría inactiva con ese nombre ocuparía el nombre único: se avisa en vez de romper.
    const { rows: viejo } = await tx.query(`SELECT 1 FROM categorias WHERE id <> $1 AND (nombre = $2 OR nombre_normalizado = $3) LIMIT 1`, [c.id, nombre, norm]);
    if (viejo[0]) throw new ErrorDominio(409, 'ese nombre ya lo tuvo otra categoría y no se puede reutilizar');
    if (!E.data.confirmar_parecida) {
      const parecidas = (await categoriasParecidas(tx, nombre)).filter((p) => p.id !== c.id);
      if (parecidas.length)
        return {
          aplicado: false, motivo: 'parecida', parecidas,
          mensaje: `«${nombre}» se parece a ${parecidas.map((p) => `«${p.nombre}»`).join(', ')}. Confirma si quieres ese nombre igual.`,
        };
    }
    await tx.query(`UPDATE categorias SET nombre = $2, nombre_normalizado = $3 WHERE id = $1`, [c.id, nombre, norm]);
    await bitacora(tx, { actor: quien.persona, instruido_por: quien.correo, accion: 'renombrar_categoria', antes: { id: c.id, nombre: c.nombre }, despues: { id: c.id, nombre } });
    return { aplicado: true, categoria: { id: c.id, nombre }, antes: c.nombre };
  });
}

/** Registros que apuntan a una categoría (cuenta también las compras descartadas: la llave las exige). */
export async function usosCategoria(db: Db, id: number) {
  const { rows: [u] } = await db.query(
    `SELECT (SELECT count(*)::int FROM movimientos WHERE categoria_id = $1) AS compras,
            (SELECT count(*)::int FROM reglas_comercio WHERE categoria_id = $1) AS reglas,
            (SELECT count(*)::int FROM comercios WHERE categoria_semilla_id = $1) AS comercios,
            (SELECT count(*)::int FROM revisiones_captura_lineas WHERE categoria_id = $1) AS capturas`,
    [id],
  );
  return u as { compras: number; reglas: number; comercios: number; capturas: number };
}

/**
 * Borrar una categoría desde el tablero. IRREVERSIBLE y solo si nada apunta a ella (compras,
 * reglas de comercio, semillas de comercios ni capturas). Las categorías base no se borran.
 */
export async function borrarCategoriaTablero(db: Db, e: unknown, quien: QuienRevision) {
  const E = z.object({ id: z.number().int().positive(), confirmar: z.literal(true) }).strict().safeParse(e);
  if (!E.success) throw new ErrorDominio(400, 'falta confirmar el borrado');
  const { id } = E.data;
  return db.tx(async (tx) => {
    const { rows } = await tx.query(`SELECT id, nombre, estado FROM categorias WHERE id = $1 FOR UPDATE`, [id]);
    const c = rows[0];
    if (!c || c.estado === 'inactiva') throw new ErrorDominio(404, 'la categoría no existe');
    if (id <= ID_MAX_CATEGORIA_BASE) throw new ErrorDominio(409, 'es una categoría base: se puede renombrar, no borrar');
    const u = await usosCategoria(tx, id);
    const partes = [
      u.compras ? `${u.compras} ${u.compras === 1 ? 'compra' : 'compras'}` : '',
      u.reglas ? `${u.reglas} ${u.reglas === 1 ? 'regla de comercio' : 'reglas de comercio'}` : '',
      u.comercios ? `${u.comercios} ${u.comercios === 1 ? 'comercio' : 'comercios'} con ella de semilla` : '',
      u.capturas ? `${u.capturas} ${u.capturas === 1 ? 'línea de captura' : 'líneas de captura'}` : '',
    ].filter(Boolean);
    if (partes.length) throw new ErrorDominio(409, `tiene registros asociados (${partes.join(', ')}): reclasifícalos antes de borrarla`);
    await bitacora(tx, { actor: quien.persona, instruido_por: quien.correo, accion: 'borrar_categoria', antes: { id: c.id, nombre: c.nombre, estado: c.estado } });
    await tx.query(`DELETE FROM categorias WHERE id = $1`, [id]);
    return { aplicado: true, borrada: true, nombre: c.nombre };
  });
}

/**
 * Reclasificar por comercio desde el tablero propone la regla del comercio (ciclo normal):
 * sin regla nace `propuesta` con una coincidencia humana; con otra categoría se reinicia en
 * `propuesta`; con la misma no cambia nada. Nunca para comercios genéricos.
 */
export async function aprenderReglaTablero(tx: Db, comercio: string, categoria_id: number, quien: QuienTablero) {
  const { rows: cs } = await tx.query(`SELECT id FROM comercios WHERE nombre = $1`, [comercio]);
  const comercio_id: number | undefined = cs[0]?.id;
  if (!comercio_id) return { regla: null, motivo: 'comercio sin registro' };
  if (await comercioEsGenerico(tx, comercio_id)) return { regla: null, motivo: 'comercio genérico: siempre se pregunta' };
  const { rows: rs } = await tx.query(`SELECT * FROM reglas_comercio WHERE comercio_id = $1 FOR UPDATE`, [comercio_id]);
  const r = rs[0];
  if (r && r.categoria_id === categoria_id) return { regla: { id: r.id, estado: r.estado }, motivo: 'la regla ya tiene esa categoría' };
  let regla: any;
  if (!r) {
    regla = (await tx.query(
      `INSERT INTO reglas_comercio (comercio_id, categoria_id, estado, coincidencias_humanas, creada_por)
       VALUES ($1, $2, 'propuesta', 1, $3) RETURNING *`,
      [comercio_id, categoria_id, quien.persona],
    )).rows[0];
  } else {
    regla = (await tx.query(
      `UPDATE reglas_comercio SET categoria_id = $2, estado = 'propuesta', coincidencias_humanas = 1, ultimo_movimiento_id = NULL,
         confirmada_por = NULL, confirmada_en = NULL, actualizada_en = now() WHERE id = $1 RETURNING *`,
      [r.id, categoria_id],
    )).rows[0];
  }
  await bitacora(tx, { actor: quien.persona, instruido_por: quien.correo, accion: r ? 'regla_reiniciada_tablero' : 'regla_nace_tablero', antes: r ?? undefined, despues: regla });
  return { regla: { id: regla.id, estado: regla.estado }, motivo: r ? 'regla reiniciada en propuesta' : 'regla propuesta' };
}

// ───────────────────────────── Corte mensual ─────────────────────────────

/** Fecha y hora de Bogotá (UTC−5, sin horario de verano). */
function bogota(ahora: number) {
  const d = new Date(ahora - 5 * 3600_000);
  return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), hora: d.getUTCHours() };
}
export const MAX_INTENTOS_CORTE = 3;
export const URL_TABLERO = 'https://<tu-proyecto>.vercel.app';

/**
 * Pide el extracto el día de corte de cada tarjeta, una vez por mes, desde las 8 a. m. de Bogotá.
 * Si el corte cae en un día que el mes no tiene (31 en noviembre), avisa el último día del mes.
 * Reintenta en el siguiente respaldo si el hook no respondió (hasta MAX_INTENTOS_CORTE).
 */
export async function avisosCorte(db: Db, ef: Efectos, ahora = Date.now()): Promise<number> {
  if (!ef.avisarCorte) return 0;
  const b = bogota(ahora);
  if (b.hora < 8) return 0;
  const mes = `${b.anio}-${String(b.mes).padStart(2, '0')}`;
  const ultimoDia = new Date(Date.UTC(b.anio, b.mes, 0)).getUTCDate();
  await db.query(
    `INSERT INTO avisos_corte (tarjeta_id, mes)
     SELECT id, $1 FROM tarjetas WHERE activa AND clase = 'credito' AND dia_corte IS NOT NULL AND LEAST(dia_corte, $3) = $2
     ON CONFLICT DO NOTHING`,
    [mes, b.dia, ultimoDia],
  );
  const { rows } = await db.query(
    `UPDATE avisos_corte SET intentos = intentos + 1 WHERE mes = $1 AND estado = 'pendiente' AND intentos < $2 RETURNING tarjeta_id, intentos`,
    [mes, MAX_INTENTOS_CORTE],
  );
  let avisos = 0;
  for (const r of rows) {
    try {
      await ef.avisarCorte(r.tarjeta_id, r.intentos);
      avisos++;
    } catch {
      if (r.intentos >= MAX_INTENTOS_CORTE)
        await db.query(`UPDATE avisos_corte SET estado = 'fallido' WHERE tarjeta_id = $1 AND mes = $2`, [r.tarjeta_id, mes]);
    }
  }
  return avisos;
}

/** Texto y destino del aviso de corte (lo envía el MCP). Lo marca enviado al prepararlo. */
export async function avisoCorte(db: Db, { tarjeta_id }: Entrada<'aviso_corte'>) {
  const { rows } = await db.query(`SELECT id, nombre, ultimos_4, tipo, persona_default FROM tarjetas WHERE id = $1`, [tarjeta_id]);
  const t = rows[0];
  if (!t) throw new ErrorDominio(404, 'tarjeta no existe');
  const target = await targetDe(db, t.tipo === 'individual' && t.persona_default ? t.persona_default : 'grupo');
  await db.query(
    `UPDATE avisos_corte SET estado = 'enviado', enviado_en = now() WHERE tarjeta_id = $1 AND estado = 'pendiente'`,
    [tarjeta_id],
  );
  await bitacora(db, { actor: 'sistema', accion: 'aviso_corte', despues: { tarjeta_id } });
  const mensaje =
    `Hoy es el corte de la ${t.nombre}${t.ultimos_4 ? ` *${t.ultimos_4}` : ''}. ` +
    `Cuando llegue el extracto en PDF, cárguenlo en el tablero (${URL_TABLERO}, botón «Cargar extracto») para conciliar el mes.`;
  return { target, mensaje, FIN: true };
}

// ───────────────────────────── Respaldo ─────────────────────────────

/**
 * Pregunta preparada (con código) cuyo envío nunca se confirmó: el mensaje pudo haber salido.
 * El respaldo NO la vuelve a avisar (la persona recibiría dos preguntas con códigos distintos):
 * queda en «Por atender» del tablero, donde una persona decide si se vuelve a preguntar.
 */
export const ENVIO_SIN_CONFIRMAR = `(pregunta_codigo IS NOT NULL AND whatsapp_message_id IS NULL)`;

/** Tras este número de tomas sin pregunta enviada, el respaldo deja de re-avisar (queda en la alerta). */
export const MAX_INTENTOS_PREGUNTA = 3;

/** Columnas de un movimiento atascado (sin texto del correo: solo comercio validado y cifras). */
const ATASCO_SELECT = (t: string) => `
  SELECT m.id AS movimiento_id, c.nombre AS comercio, m.valor, m.moneda, m.valor_original::float8 AS valor_original,
         m.trm::float8 AS trm, m.trm_fecha::text AS trm_fecha, m.ultimo_error, m.pregunta_codigo, m.intentos_preguntar,
         FLOOR(EXTRACT(EPOCH FROM (now() - m.creado_en)) / 60)::int AS minutos
  FROM ${t} m LEFT JOIN comercios c ON c.id = m.comercio_id`;

function motivoAtasco(m: { ultimo_error?: string | null; pregunta_codigo?: string | null; intentos_preguntar?: number }): string {
  if (m.ultimo_error) return `falló preguntar: ${m.ultimo_error}`;
  if (m.pregunta_codigo) return `pregunta preparada (#${m.pregunta_codigo}) pero el envío no se confirmó`;
  if ((m.intentos_preguntar ?? 0) > 0) return 'el agente lo tomó y no preguntó';
  return 'nadie lo ha tomado (¿hook caído?)';
}

function atasco(m: any) {
  const valor = m.valor == null ? null : Number(m.valor);
  return {
    movimiento_id: m.movimiento_id as string,
    comercio: m.comercio as string | null,
    valor,
    valor_texto: valorTexto({ ...m, valor }),
    minutos: Number(m.minutos),
    intentos: Number(m.intentos_preguntar ?? 0),
    motivo: motivoAtasco(m),
  };
}

export async function respaldo(db: Db, ef: Efectos, ahora = Date.now()) {
  const { rows: liberadosFilas } = await db.query(
    `WITH v AS (
       UPDATE movimientos SET estado = 'por_preguntar', en_proceso_hasta = NULL, actualizado_en = now()
       WHERE estado = 'en_proceso' AND en_proceso_hasta < now()
       RETURNING id, ultimo_error, pregunta_codigo, intentos_preguntar, creado_en, comercio_id, valor, moneda,
                 valor_original, trm, trm_fecha)
     ${ATASCO_SELECT('v')}`,
  );
  const atascados = liberadosFilas.map(atasco);
  for (const a of atascados)
    await bitacora(db, { movimiento_id: a.movimiento_id, actor: 'sistema', accion: 'liberar_atascado', despues: { motivo: a.motivo, intentos: a.intentos } });
  const liberados = atascados.length;
  const trm_resueltas = await reintentarTrm(db, ef);
  const interpretar = (await db.query(
    `SELECT correo_id FROM movimientos WHERE estado = 'requiere_interpretacion' AND creado_en < now() - interval '2 minutes' LIMIT 20`,
  )).rows;
  let reintentos = 0;
  for (const r of interpretar) {
    await intentarExtractor(db, ef, r.correo_id);
    reintentos++;
  }
  const porPreguntar = (await db.query(
    `SELECT id FROM movimientos WHERE estado = 'por_preguntar' AND actualizado_en < now() - interval '2 minutes'
       AND intentos_preguntar < ${MAX_INTENTOS_PREGUNTA}
       AND NOT ${ENVIO_SIN_CONFIRMAR}
     ORDER BY creado_en LIMIT 20`,
  )).rows;
  // Clave por ventana de 30 min: un reaviso no queda deduplicado con el aviso original.
  const ventana = String(Math.floor(ahora / 1800_000));
  for (const r of porPreguntar) await ef.avisarHook({ movimiento_id: r.id, evento: 'nuevo', intento: `respaldo-${ventana}` });
  // Idempotencia del MCP: las operaciones viejas ya no se van a reintentar.
  await db.query(`DELETE FROM operaciones WHERE creado_en < now() - interval '7 days'`);
  const avisos_corte = await avisosCorte(db, ef, ahora);
  return { liberados, atascados, reintentos_extractor: reintentos, trm_resueltas, avisos: porPreguntar.length, avisos_corte };
}
