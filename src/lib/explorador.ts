// Tablero unificado (antes "Explorador VISA"). Una sola fuente: la tabla
// `movimientos`, todas las tarjetas y fuentes; los descartados no se muestran ni suman.
// Cada compra lleva su estado visible (Conciliado / flujo del correo + Por conciliar /
// Manual) y, mientras no haya conciliación, la marca de posible duplicado de extracto
// (ver ./conciliacion y docs/conciliacion.md). Reclasificar por comercio: `reglas_comercio`
// exige comercio_id y las filas del extracto no lo tienen, así que se actualizan las
// compras de ese comercio.
import { z } from 'zod';
import { cuenta, estadoVista, posiblesDuplicados } from './conciliacion';
import type { Db } from './db';
import { ErrorDominio, aprenderReglaTablero, enviosSinConfirmar } from './dominio';
import { normalizar } from './texto';

export const ACCION = 'reclasificar_explorador';
/** Estados que se pueden reclasificar desde el tablero (los pendientes se responden por WhatsApp). */
export const ESTADOS_RECLASIFICABLES = ['confirmado', 'provisional'];
/** Pendientes que se muestran en la banda "Por atender". */
export const ESTADOS_POR_ATENDER = ['esperando_respuesta', 'requiere_revision'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-03" → "mar 26". */
export const etiquetaMes = (mes: string) => `${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(2, 4)}`;

/** Limpia una descripción del extracto para agrupar por comercio. */
export function limpiarDescripcion(desc: string): string {
  const t = desc
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+\d[\d\s./-]*$/, '') // referencias y números al final
    .trim();
  return (t || desc.trim()).slice(0, 60);
}

/**
 * Comercio de un movimiento: el comercio enlazado (compras por correo); si no, la nota
 * "Comercio: X" (filas de datos.json); si no, el comercio conocido cuyo patrón aparece en
 * la descripción; si no, la descripción limpia.
 */
export function comercioDe(
  nota: string | null,
  descripcion: string,
  comercios: Array<{ id: number; nombre: string; patrones: string[] }>,
  enlazado?: string | null,
): string {
  if (enlazado) return enlazado.slice(0, 60);
  const m = (nota ?? '').match(/(?:^|\n)\s*Comercio:\s*(.+?)\s*(?:\n|$)/i);
  if (m?.[1]) return m[1].slice(0, 60);
  return normalizar(descripcion, comercios)?.nombre ?? limpiarDescripcion(descripcion);
}

async function cargar(db: Db) {
  const { rows: comercios } = await db.query<{ id: number; nombre: string; patrones: string[] }>('SELECT id, nombre, patrones FROM comercios');
  const { rows } = await db.query(
    `SELECT m.id, m.fecha::text AS fecha, m.descripcion_original, m.nota, m.valor, m.cuotas, m.categoria_id,
            m.tarjeta_id, m.fuente, m.estado, m.persona, m.reembolsable, m.moneda, m.conciliado_con,
            m.extracto_id, m.no_aparece_en_extracto,
            co.nombre AS comercio_enlazado, c.nombre AS categoria, ini.categoria_inicial_id
     FROM movimientos m
     LEFT JOIN comercios co ON co.id = m.comercio_id
     LEFT JOIN categorias c ON c.id = m.categoria_id
     LEFT JOIN LATERAL (
       SELECT (b.antes->>'categoria_id')::int AS categoria_inicial_id FROM bitacora b
       WHERE b.movimiento_id = m.id AND b.accion = $1 ORDER BY b.id LIMIT 1
     ) ini ON true
     WHERE m.estado <> 'descartado' AND m.valor IS NOT NULL AND m.fecha IS NOT NULL
     ORDER BY m.fecha, m.id`,
    [ACCION],
  );
  return rows.map((r: any) => ({
    ...r,
    valor: Number(r.valor),
    comercio: comercioDe(r.nota, r.descripcion_original ?? '', comercios, r.comercio_enlazado),
  }));
}

const textoValor = (v: number | null) => (v == null ? 'sin valor' : '$' + Math.round(v).toLocaleString('es-CO'));

/**
 * Datos del tablero: todas las tarjetas y fuentes, solo los campos necesarios (sin notas
 * ni texto de correos). `cuenta` dice si la compra suma en KPIs y gráficos.
 */
export async function datosExplorador(db: Db) {
  const filas = await cargar(db);
  const { rows: cats } = await db.query<{ id: number; nombre: string }>(
    `SELECT id, nombre FROM categorias WHERE estado IN ('activa', 'propuesta') ORDER BY id`,
  );
  // Para gestionar categorías (renombrar o borrar): cuántos registros apuntan a cada una.
  const { rows: gestion } = await db.query(
    `SELECT c.id, c.nombre, c.estado,
            (SELECT count(*)::int FROM movimientos m WHERE m.categoria_id = c.id) AS compras,
            (SELECT count(*)::int FROM reglas_comercio r WHERE r.categoria_id = c.id) AS reglas,
            (SELECT count(*)::int FROM comercios k WHERE k.categoria_semilla_id = c.id) AS comercios,
            (SELECT count(*)::int FROM revisiones_captura_lineas l WHERE l.categoria_id = c.id) AS capturas
     FROM categorias c WHERE c.estado <> 'inactiva' ORDER BY c.id`,
  );
  const categorias_gestion = gestion.map((g: any) => ({ ...g, base: g.id < 100 }));
  const { rows: tarjetas } = await db.query<{ id: string; nombre: string }>('SELECT id, nombre FROM tarjetas ORDER BY nombre');
  const nombreTarjeta = new Map(tarjetas.map((t) => [t.id, t.nombre]));
  const nombre = new Map(cats.map((c) => [c.id, c.nombre]));
  const duplicados = posiblesDuplicados(filas);
  const movimientos = filas.map((r: any) => {
    const ev = estadoVista(r.fuente, r.estado, r.conciliado_con);
    return {
      id: r.id as string,
      fecha: r.fecha as string,
      mes: (r.fecha as string).slice(0, 7),
      desc: (r.fuente === 'extracto' && r.descripcion_original) || r.comercio,
      comercio: r.comercio as string,
      valor: r.valor as number,
      cuotas: Number(r.cuotas ?? 1),
      categoria_id: r.categoria_id as number | null,
      categoria: (r.categoria as string | null) ?? 'Sin clasificar',
      categoria_inicial: r.categoria_inicial_id != null ? nombre.get(r.categoria_inicial_id) ?? 'Sin clasificar' : (r.categoria as string | null) ?? 'Sin clasificar',
      tarjeta_id: (r.tarjeta_id as string | null) ?? null,
      tarjeta: r.tarjeta_id ? nombreTarjeta.get(r.tarjeta_id) ?? r.tarjeta_id : 'Sin tarjeta',
      fuente: r.fuente as string,
      estado: r.estado as string,
      estado_vista: ev.etiqueta,
      grupo: ev.grupo,
      por_conciliar: ev.por_conciliar,
      duplicado_de: duplicados.get(r.id) ?? null,
      no_aparece: Boolean(r.no_aparece_en_extracto),
      cuenta: cuenta(r, duplicados),
      reclasificable: ESTADOS_RECLASIFICABLES.includes(r.estado),
      persona: (r.persona as string | null) ?? null,
    };
  });
  const meses = [...new Set(movimientos.map((m) => m.mes))].sort().map((mes) => ({ mes, etiqueta: etiquetaMes(mes) }));
  const usadas = new Set(movimientos.map((m) => m.tarjeta_id));
  // "Por atender": esperando respuesta y requiere revisión (p. ej. tarjeta desconocida),
  // aunque no tengan valor o fecha todavía.
  const { rows: pend } = await db.query(
    `SELECT m.id, m.fecha::text AS fecha, m.valor, m.estado, m.tarjeta_id, m.nota, m.descripcion_original, m.creado_en::text AS creado_en,
            co.nombre AS comercio
     FROM movimientos m LEFT JOIN comercios co ON co.id = m.comercio_id
     WHERE m.estado = ANY($1::text[]) ORDER BY m.creado_en LIMIT 100`,
    [ESTADOS_POR_ATENDER],
  );
  const por_atender = pend.map((p: any) => ({
    id: p.id as string,
    fecha: (p.fecha as string | null) ?? (p.creado_en as string).slice(0, 10),
    comercio: (p.comercio as string | null) ?? (p.descripcion_original ? limpiarDescripcion(p.descripcion_original) : 'Compra sin interpretar'),
    valor_texto: textoValor(p.valor == null ? null : Number(p.valor)),
    tarjeta: p.tarjeta_id ? nombreTarjeta.get(p.tarjeta_id) ?? p.tarjeta_id : 'Sin tarjeta',
    estado: estadoVista('correo', p.estado).etiqueta,
    motivo: p.estado === 'requiere_revision' ? String(p.nota ?? 'revisar').slice(0, 120) : 'falta que respondan de qué fue',
    // En revisión se atiende desde el tablero (completar datos o descartar), viendo el correo original.
    accion: p.estado === 'requiere_revision' ? 'revision' : p.estado === 'esperando_respuesta' ? 'confirmar' : 'detalle',
  } as any));
  // Pregunta preparada cuyo envío no se confirmó: una persona decide si llegó o se vuelve a preguntar.
  for (const e of await enviosSinConfirmar(db)) por_atender.push({
    id: e.movimiento_id, fecha: e.fecha, comercio: e.comercio ?? 'Compra', valor_texto: e.valor_texto,
    tarjeta: e.tarjeta ?? 'Sin tarjeta', estado: 'Envío sin confirmar',
    motivo: `la pregunta ${e.codigo} pudo no haber llegado: ¿llegó por WhatsApp?`, accion: 'envio',
  } as any);
  // Conciliación: compras por correo que no aparecen en su extracto, extractos en revisión y
  // líneas que no se resuelven solas (cuotas, abonos o reversos, USD), de los últimos 90 días.
  const { rows: noAparecen } = await db.query(
    `SELECT m.id, m.fecha::text AS fecha, m.valor, m.estado, m.tarjeta_id, m.descripcion_original, e.fecha_corte::text AS fecha_corte,
            co.nombre AS comercio
     FROM movimientos m JOIN extractos e ON e.id = m.no_aparece_en_extracto
     LEFT JOIN comercios co ON co.id = m.comercio_id
     WHERE m.estado <> 'descartado' AND m.conciliado_con IS NULL ORDER BY m.fecha LIMIT 100`,
  );
  for (const p of noAparecen) por_atender.push({
    id: p.id as string,
    fecha: p.fecha as string,
    comercio: (p.comercio as string | null) ?? (limpiarDescripcion(p.descripcion_original ?? '') || 'Compra'),
    valor_texto: textoValor(p.valor == null ? null : Number(p.valor)),
    tarjeta: p.tarjeta_id ? nombreTarjeta.get(p.tarjeta_id) ?? p.tarjeta_id : 'Sin tarjeta',
    estado: 'No aparece en el extracto',
    motivo: `no está en el extracto con corte ${p.fecha_corte}: revisar si es un duplicado del correo o si se cobra en el próximo corte`,
  });
  const { rows: revisar } = await db.query(
    `SELECT e.id::text AS extracto_id, e.tarjeta_id, e.fecha_corte::text AS fecha_corte, e.estado, e.motivo, e.creado_en::text AS creado_en,
            c.linea, c.fecha::text AS fecha, c.descripcion, c.valor, c.criterio
     FROM extractos e LEFT JOIN conciliaciones c ON c.extracto_id = e.id::text AND c.resultado = 'revision' AND e.estado = 'procesado'
     WHERE e.creado_en > now() - interval '90 days' AND (e.estado = 'en_revision' OR c.linea IS NOT NULL)
     ORDER BY e.creado_en, c.linea LIMIT 100`,
  );
  for (const r of revisar) {
    const tarjeta = r.tarjeta_id ? nombreTarjeta.get(r.tarjeta_id) ?? r.tarjeta_id : 'Tarjeta desconocida';
    if (r.estado === 'en_revision') por_atender.push({
      id: `extracto:${r.extracto_id}`, fecha: (r.fecha_corte as string | null) ?? (r.creado_en as string).slice(0, 10), comercio: 'Extracto sin conciliar',
      valor_texto: '—', tarjeta, estado: 'Extracto en revisión', motivo: String(r.motivo ?? 'revisar').slice(0, 120),
    });
    else por_atender.push({
      id: `extracto:${r.extracto_id}:${r.linea}`, fecha: r.fecha as string, comercio: String(r.descripcion ?? '').slice(0, 60),
      valor_texto: textoValor(r.valor == null ? null : Number(r.valor)), tarjeta, estado: 'Línea del extracto a revisar', motivo: String(r.criterio ?? '').slice(0, 120),
    });
  }
  // Intereses y deuda del último corte de cada tarjeta y mes (para «Detalle del mes»).
  const { rows: cortes } = await db.query(
    `SELECT DISTINCT ON (e.tarjeta_id, to_char(e.fecha_corte, 'YYYY-MM')) e.tarjeta_id, e.fecha_corte::text AS fecha_corte,
            e.intereses, e.saldo_total, e.total_compras
     FROM extractos e
     WHERE e.estado = 'procesado' AND e.tarjeta_id IS NOT NULL AND (e.intereses IS NOT NULL OR e.saldo_total IS NOT NULL)
     ORDER BY e.tarjeta_id, to_char(e.fecha_corte, 'YYYY-MM'), e.fecha_corte DESC, e.creado_en DESC`,
  );
  const extractos = cortes.map((c: any) => ({
    tarjeta_id: c.tarjeta_id as string,
    tarjeta: nombreTarjeta.get(c.tarjeta_id) ?? c.tarjeta_id,
    fecha_corte: c.fecha_corte as string,
    mes: (c.fecha_corte as string).slice(0, 7),
    intereses: c.intereses == null ? null : Number(c.intereses),
    saldo_total: c.saldo_total == null ? null : Number(c.saldo_total),
  }));
  return {
    titulo: 'Gastos del hogar',
    categorias: cats,
    categorias_gestion,
    tarjetas: tarjetas.filter((t) => usadas.has(t.id)),
    // Todas las tarjetas (para completar una compra en revisión con tarjeta desconocida).
    tarjetas_todas: tarjetas,
    meses,
    movimientos,
    por_atender,
    extractos,
  };
}

export const ENTRADA_RECLASIFICAR = z.union([
  z.object({ movimiento_id: z.string().uuid(), categoria_id: z.number().int().positive() }).strict(),
  z.object({ comercio: z.string().min(1).max(60), categoria_id: z.number().int().positive(), tarjeta_id: z.string().min(1).max(60).optional() }).strict(),
  z.object({
    cambios: z.array(z.object({ movimiento_id: z.string().uuid(), categoria_id: z.number().int().positive() }).strict()).min(1).max(1000),
  }).strict(),
]);

export interface Quien { correo: string; persona: 'miguel' | 'katerine' }

/**
 * Persona de la sesión: TABLERO_PERSONAS="correo=miguel,correo=katerine".
 * SEC-012: un correo sin mapeo NO recibe una persona por defecto; la sesión se rechaza (tienePersona).
 */
export function personaDe(correo: string, mapa: string | undefined): 'miguel' | 'katerine' {
  for (const par of (mapa ?? '').split(',')) {
    const [c, p] = par.split('=').map((x) => x?.trim().toLowerCase());
    if (c === correo && (p === 'miguel' || p === 'katerine')) return p;
  }
  throw new Error('correo sin persona asignada en TABLERO_PERSONAS');
}

/** ¿El correo tiene persona asignada en TABLERO_PERSONAS? */
export function tienePersona(correo: string, mapa: string | undefined): boolean {
  return (mapa ?? '').split(',').some((par) => {
    const [c, p] = par.split('=').map((x) => x?.trim().toLowerCase());
    return c === correo && (p === 'miguel' || p === 'katerine');
  });
}

/**
 * Reclasifica (por movimiento, por comercio o en lote para deshacer), en cualquier tarjeta
 * y fuente. Valida categoría activa/propuesta y estado (confirmado o provisional); deja en la bitácora quién, cuándo, antes y después.
 */
export async function reclasificarExplorador(db: Db, entradaCruda: unknown, quien: Quien) {
  const e = ENTRADA_RECLASIFICAR.safeParse(entradaCruda);
  if (!e.success) throw new ErrorDominio(400, 'entrada inválida');
  const pedido = e.data;
  return db.tx(async (tx) => {
    let objetivo: Array<{ movimiento_id: string; categoria_id: number }>;
    let via: 'movimiento' | 'comercio' | 'lote';
    if ('cambios' in pedido) {
      via = 'lote';
      objetivo = pedido.cambios;
    } else if ('movimiento_id' in pedido) {
      via = 'movimiento';
      objetivo = [pedido];
    } else {
      via = 'comercio';
      const filas = await cargar(tx);
      objetivo = filas
        .filter((f: any) => f.comercio === pedido.comercio && ESTADOS_RECLASIFICABLES.includes(f.estado))
        .filter((f: any) => !pedido.tarjeta_id || f.tarjeta_id === pedido.tarjeta_id)
        .map((f: any) => ({ movimiento_id: f.id, categoria_id: pedido.categoria_id }));
      if (!objetivo.length) throw new ErrorDominio(404, 'no hay compras de ese comercio');
    }
    const ids = [...new Set(objetivo.map((o) => o.categoria_id))];
    const { rows: validas } = await tx.query(`SELECT id FROM categorias WHERE id = ANY($1::int[]) AND estado IN ('activa', 'propuesta')`, [ids]);
    if (validas.length !== ids.length) throw new ErrorDominio(400, 'categoría inexistente o inactiva');
    const { rows: actuales } = await tx.query(
      `SELECT id, categoria_id FROM movimientos
       WHERE id = ANY($1::uuid[]) AND estado = ANY($2::text[]) FOR UPDATE`,
      [objetivo.map((o) => o.movimiento_id), ESTADOS_RECLASIFICABLES],
    );
    if (actuales.length !== new Set(objetivo.map((o) => o.movimiento_id)).size)
      throw new ErrorDominio(404, 'movimiento inexistente, descartado o pendiente (respóndelo por WhatsApp)');
    const antes = new Map(actuales.map((a: any) => [a.id as string, a.categoria_id as number | null]));
    const cambios: Array<{ movimiento_id: string; antes: number | null; despues: number }> = [];
    for (const o of objetivo) {
      const previo = antes.get(o.movimiento_id) ?? null;
      if (previo === o.categoria_id) continue;
      await tx.query(
        `UPDATE movimientos SET categoria_id = $2, clasificado_por = $3, regla_id = NULL, actualizado_en = now() WHERE id = $1`,
        [o.movimiento_id, o.categoria_id, quien.persona],
      );
      await tx.query(
        `INSERT INTO bitacora (movimiento_id, actor, instruido_por, accion, antes, despues)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [o.movimiento_id, quien.persona, quien.correo, ACCION, JSON.stringify({ categoria_id: previo }), JSON.stringify({ categoria_id: o.categoria_id, via })],
      );
      cambios.push({ movimiento_id: o.movimiento_id, antes: previo, despues: o.categoria_id });
    }
    // Por comercio: además propone la regla del comercio (nace en propuesta y sigue el ciclo normal).
    const aprendizaje = via === 'comercio' && 'comercio' in pedido
      ? await aprenderReglaTablero(tx, pedido.comercio, pedido.categoria_id, quien)
      : undefined;
    return { actualizados: cambios.length, cambios, ...(aprendizaje ? { regla: aprendizaje } : {}) };
  });
}
