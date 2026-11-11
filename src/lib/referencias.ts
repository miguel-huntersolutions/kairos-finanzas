// Resolución determinista de lo que dice la gente por WhatsApp:
//  - "la de 147.750", "Farmatodo", "la última", "#T3" → qué movimiento es;
//  - "1", "mercado", "fue en la droguería" → qué categoría es;
//  - el número de WhatsApp de quien escribe → miguel | katerine.
// El agente nunca necesita (ni pide) un id: pasa el texto y el servidor decide.
import type { Db } from './db';
import { sinTildes } from './texto';

/** Estados en los que una compra todavía espera algo de la familia. */
export const PENDIENTES = ['por_preguntar', 'en_proceso', 'esperando_respuesta', 'requiere_revision', 'requiere_trm'];
/** Ventana de búsqueda para compras ya cerradas (además de todas las pendientes). */
export const DIAS_REFERENCIA = 30;
/** Si no hay coincidencia en 30 días y la persona dio valor, fecha o comercio: buscar en el último año. */
export const DIAS_REFERENCIA_AMPLIA = 400;
const MAX_OPCIONES = 5;

export interface Candidato {
  movimiento_id: string;
  estado: string;
  fecha: string | null; // aaaa-mm-dd
  valor: number | null;
  moneda: string | null;
  valor_original: number | null;
  trm: number | null;
  trm_fecha: string | null;
  tarjeta_id: string | null;
  tarjeta: string | null;
  comercio: string | null;
  descripcion_original: string | null;
  pregunta_codigo: string | null;
  categorias_sugeridas?: number[] | null;
}

// ───────────────────────────── texto ─────────────────────────────

/** Minúsculas, sin tildes, solo letras, números y espacios. */
export function plano(s: string): string {
  return sinTildes(s).toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Raíz muy simple para comparar singular/plural ("droguerías" = "droguería"). */
export function raiz(p: string): string {
  let r = p;
  if (r.length > 3 && r.endsWith('s')) r = r.slice(0, -1);
  if (r.length > 4 && r.endsWith('e')) r = r.slice(0, -1);
  return r;
}

// Palabras que no identifican una compra ni un comercio.
const VACIAS = new Set(
  'esta este esto estas estos aquella aquel compra compras pago pagos para fue era sera la el los las una uno que con por del de en mi mio mia yo hice hizo hicimos borra borrar borrala elimina eliminar quita quitar descarta descartar repetida repetidas repetido duplicada duplicadas duplicado favor porfa gracias ultima ultimo reciente esa ese esas esos otra otro cosa cual cuales tienda sas ltda colombia store mercado bogota medellin cali'
    .split(' ')
    .map(raiz),
);

const tokens = (s: string | null | undefined) =>
  plano(s ?? '')
    .split(' ')
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t))
    .map(raiz)
    .filter((t) => !VACIAS.has(t));

const FECHA = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

/** Valores en pesos mencionados: "147.750", "$20.980", "147750", "147 mil". Ignora < 1.000. */
export function valoresEnTexto(texto: string): number[] {
  const t = texto.replace(new RegExp(FECHA.source, 'g'), ' ');
  const out = new Set<number>();
  for (const m of t.matchAll(/(\d{1,3}(?:[.,]\d{3})*|\d+)\s*(?:mil\b|k\b)/gi)) out.add(Number(m[1].replace(/[.,]/g, '')) * 1000);
  for (const m of t.matchAll(/(?<![\d.,])\$?\s?(\d{1,3}(?:[.,\s]\d{3})+|\d{4,})(?![\d])/g)) out.add(Number(m[1].replace(/[.,\s]/g, '')));
  return [...out].filter((v) => Number.isFinite(v) && v >= 1000);
}

function fechaEnTexto(texto: string): { dia: number; mes: number } | null {
  const m = texto.match(FECHA);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  return dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 ? { dia, mes } : null;
}

function codigosEnTexto(texto: string): string[] {
  const out = new Set<string>();
  for (const m of texto.matchAll(/#([A-Za-z][2-9][A-Za-z]?)\b/g)) out.add(m[1].toUpperCase());
  for (const m of texto.matchAll(/\b([A-Z][2-9][A-Z]?)\b/g)) out.add(m[1]);
  return [...out];
}

const pideUltima = (texto: string) => /\b(ultim[oa]s?|mas reciente|recien)\b/.test(plano(texto));

// ───────────────────────────── referencia → movimiento ─────────────────────────────

export type Seleccion =
  | { tipo: 'unica'; movimiento: Candidato; metodo: string }
  | { tipo: 'varias'; candidatos: Candidato[]; metodo: string }
  | { tipo: 'ninguna'; candidatos: Candidato[]; metodo: string };

/**
 * Elige entre candidatos según el texto (pura, para probarla sin base). Orden de criterios:
 * código #XX → valor → fecha dd/mm → comercio → "la última". Sin ningún criterio: las
 * compras que esperan respuesta. Si quedan varias y solo una sigue pendiente, esa.
 */
export function elegir(texto: string | undefined, candidatos: Candidato[]): Seleccion {
  const t = texto ?? '';
  const esperando = candidatos.filter((c) => c.estado === 'esperando_respuesta');
  let lista = candidatos;
  const criterios: string[] = [];

  const cods = codigosEnTexto(t);
  const porCodigo = esperando.filter((c) => c.pregunta_codigo && cods.includes(c.pregunta_codigo));
  if (porCodigo.length === 1) return { tipo: 'unica', movimiento: porCodigo[0], metodo: 'codigo' };
  // A5: un código que no coincide con ninguna compra esperando NO significa «la única pendiente».
  if (cods.length && !porCodigo.length)
    return { tipo: 'ninguna', candidatos: ordenar(candidatos.filter((c) => PENDIENTES.includes(c.estado))), metodo: 'codigo_no_coincide' };

  const valores = valoresEnTexto(t);
  if (valores.length) {
    criterios.push('valor');
    lista = lista.filter(
      (c) => (c.valor != null && valores.includes(Number(c.valor))) || (c.valor_original != null && valores.includes(Math.round(Number(c.valor_original)))),
    );
  }
  const f = fechaEnTexto(t);
  if (f) {
    criterios.push('fecha');
    lista = lista.filter((c) => {
      if (!c.fecha) return false;
      const [, mes, dia] = c.fecha.split('-').map(Number);
      return dia === f.dia && mes === f.mes;
    });
  }
  // Comercio: solo cuenta si alguna palabra del texto coincide con algún candidato
  // (así "mercado" o "la hice yo" no descartan nada).
  const palabras = new Set(tokens(t));
  if (palabras.size && lista.length) {
    const conComercio = lista.filter((c) => tokens(`${c.comercio ?? ''} ${c.descripcion_original ?? ''}`).some((p) => palabras.has(p)));
    if (conComercio.length) {
      criterios.push('comercio');
      lista = conComercio;
    } else if (!criterios.length) {
      // A5: la persona nombró algo y no coincide con ninguna compra: no se clasifica «la única pendiente».
      return { tipo: 'ninguna', candidatos: ordenar(candidatos.filter((c) => PENDIENTES.includes(c.estado))), metodo: 'sin_coincidencia' };
    }
  }
  if (pideUltima(t) && lista.length) {
    criterios.push('ultima');
    lista = [ordenar(lista)[0]];
  }

  if (!criterios.length) {
    if (esperando.length === 1) return { tipo: 'unica', movimiento: esperando[0], metodo: 'unico_pendiente' };
    return esperando.length
      ? { tipo: 'varias', candidatos: ordenar(esperando), metodo: 'varios_pendientes' }
      : { tipo: 'ninguna', candidatos: ordenar(candidatos.filter((c) => PENDIENTES.includes(c.estado))), metodo: 'sin_pendientes' };
  }
  const metodo = criterios.join('+');
  if (lista.length === 1) return { tipo: 'unica', movimiento: lista[0], metodo };
  if (lista.length > 1) {
    const pendientes = lista.filter((c) => PENDIENTES.includes(c.estado));
    if (pendientes.length === 1) return { tipo: 'unica', movimiento: pendientes[0], metodo: `${metodo}+pendiente` };
    return { tipo: 'varias', candidatos: ordenar(lista), metodo };
  }
  return { tipo: 'ninguna', candidatos: ordenar(candidatos.filter((c) => PENDIENTES.includes(c.estado))), metodo };
}

const ordenar = (l: Candidato[]) =>
  [...l].sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || 0);

const SELECT_CANDIDATOS = `
  SELECT m.id AS movimiento_id, m.estado, m.fecha::text AS fecha, m.valor::int AS valor, m.moneda,
         m.valor_original::float8 AS valor_original, m.trm::float8 AS trm, m.trm_fecha::text AS trm_fecha,
         m.tarjeta_id, t.nombre AS tarjeta, c.nombre AS comercio, m.descripcion_original, m.pregunta_codigo,
         m.categorias_sugeridas
  FROM movimientos m
  LEFT JOIN comercios c ON c.id = m.comercio_id
  LEFT JOIN tarjetas t ON t.id = m.tarjeta_id`;

/** Compras pendientes (todas) y de los últimos `dias` días, sin las descartadas. */
export async function candidatos(db: Db, dias = DIAS_REFERENCIA): Promise<Candidato[]> {
  const { rows } = await db.query<Candidato>(
    `${SELECT_CANDIDATOS}
     WHERE m.estado <> 'descartado' AND (m.estado = ANY($1) OR m.fecha >= current_date - $2::int)
     ORDER BY m.fecha DESC NULLS LAST, m.creado_en DESC LIMIT ${dias > DIAS_REFERENCIA ? 3000 : 300}`,
    [PENDIENTES, dias],
  );
  return rows;
}

export async function candidatoPorId(db: Db, id: string): Promise<Candidato | null> {
  const { rows } = await db.query<Candidato>(`${SELECT_CANDIDATOS} WHERE m.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function seleccionar(db: Db, referencia: string | undefined): Promise<Seleccion> {
  const sel = elegir(referencia, await candidatos(db));
  if (!referencia?.trim()) return sel;
  // Compras viejas (p. ej. cargadas con el extracto del mes anterior), en dos casos:
  // 1) dio valor o fecha y no hubo coincidencia en 30 días;
  // 2) nombró un comercio que no está en los 30 días: sin esto, el texto no cuenta como criterio
  //    y se usaría «la única pendiente», que puede ser OTRA compra.
  const sinCriterio = ['sin_pendientes', 'unico_pendiente', 'varios_pendientes'].includes(sel.metodo);
  if (sel.tipo === 'ninguna' || sinCriterio) {
    const amplia = elegir(referencia, await candidatos(db, DIAS_REFERENCIA_AMPLIA));
    const conCriterio = !['sin_pendientes', 'unico_pendiente', 'varios_pendientes'].includes(amplia.metodo);
    if (amplia.tipo !== 'ninguna' && conCriterio) return amplia;
  }
  return sel;
}

/** Gemelas de una compra: otra fila viva con el mismo valor, fecha y tarjeta. */
export async function gemelas(db: Db, m: Candidato): Promise<Candidato[]> {
  if (m.valor == null || !m.fecha || !m.tarjeta_id) return [];
  // A4: un par ya conciliado (correo ↔ línea del extracto) es UNA compra, no un duplicado.
  const { rows: unido } = await db.query<{ unido: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM movimientos x WHERE x.id = $1 AND x.conciliado_con IS NOT NULL)
          OR EXISTS (SELECT 1 FROM movimientos c WHERE c.conciliado_con = $1)) AS unido`,
    [m.movimiento_id],
  );
  if (unido[0]?.unido) return [];
  const { rows } = await db.query<Candidato>(
    `${SELECT_CANDIDATOS}
     WHERE m.id <> $1 AND m.estado <> 'descartado' AND m.valor = $2 AND m.fecha = $3::date AND m.tarjeta_id = $4
       AND m.conciliado_con IS NULL AND NOT EXISTS (SELECT 1 FROM movimientos c WHERE c.conciliado_con = m.id)`,
    [m.movimiento_id, m.valor, m.fecha, m.tarjeta_id],
  );
  return rows;
}

// ───────────────────────────── presentación ─────────────────────────────

const fmt = (n: number, dec = 0) => new Intl.NumberFormat('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);

export function valorCorto(c: Pick<Candidato, 'moneda' | 'valor' | 'valor_original'>): string {
  if (c.moneda === 'USD' && c.valor_original != null) return `USD ${fmt(Number(c.valor_original), 2)}`;
  return c.valor != null ? `$${fmt(Number(c.valor))}` : 'valor pendiente';
}

const ESTADO_LEGIBLE: Record<string, string> = {
  esperando_respuesta: 'esperando respuesta',
  por_preguntar: 'por preguntar',
  en_proceso: 'por preguntar',
  requiere_revision: 'en revisión',
  requiere_trm: 'falta la TRM',
  confirmado: 'ya clasificada',
  provisional: 'provisional',
};

/** "Farmatodo · $147.750 · 06/11 · VISA (esperando respuesta)". Sin ids. */
export function describir(c: Candidato): string {
  const fecha = c.fecha ? `${c.fecha.slice(8, 10)}/${c.fecha.slice(5, 7)}` : 'sin fecha';
  const partes = [c.comercio ?? c.descripcion_original ?? 'Compra', valorCorto(c), fecha, c.tarjeta ?? 'tarjeta sin registrar'];
  return `${partes.join(' · ')} (${ESTADO_LEGIBLE[c.estado] ?? c.estado})`;
}

/** Lista numerada para el agente: muestra n y descripcion; usa movimiento_id al elegir (nunca lo muestra). */
export function opciones(l: Candidato[]) {
  return l.slice(0, MAX_OPCIONES).map((c, i) => ({ n: i + 1, descripcion: describir(c), movimiento_id: c.movimiento_id }));
}

/** Respuesta común cuando la referencia no apunta a una sola compra. */
export function noUnica(s: Exclude<Seleccion, { tipo: 'unica' }>, referencia?: string) {
  const lista = opciones(s.candidatos);
  if (s.tipo === 'varias')
    return {
      aplicado: false,
      motivo: 'ambigua',
      mensaje: 'Varias compras coinciden. Muestra esta lista numerada (sin ids) y pregunta cuál; con la respuesta, vuelve a llamar con el movimiento_id de esa opción.',
      opciones: lista,
    };
  return {
    aplicado: false,
    motivo: 'ninguna',
    mensaje: `No encontré una compra que coincida${referencia ? ` con «${referencia.slice(0, 80)}»` : ''}. Dilo así; si hay compras pendientes, muéstralas numeradas.`,
    opciones: lista,
  };
}

// ───────────────────────────── categorías ─────────────────────────────

/** Palabras clave → categoría de la semilla (ids fijos de db/semilla.sql). */
const PALABRAS_CATEGORIA: Record<number, string[]> = {
  1: ['mercado', 'supermercado', 'super', 'mercar', 'tienda', 'minimercado', 'surtido', 'd1', 'ara', 'exito', 'carulla', 'olimpica', 'jumbo', 'fruver', 'verduras', 'frutas', 'carne', 'carniceria', 'panaderia', 'viveres', 'abarrotes', 'despensa'],
  2: ['restaurante', 'domicilio', 'rappi', 'comida', 'almuerzo', 'cena', 'desayuno', 'onces', 'cafe', 'pizza', 'hamburguesa', 'helado', 'pola', 'cerveza'],
  3: ['transporte', 'uber', 'didi', 'cabify', 'taxi', 'bus', 'peaje', 'viaje', 'vuelo', 'tiquete', 'avianca', 'latam', 'hotel', 'airbnb', 'flypass'],
  4: ['servicio', 'luz', 'agua', 'gas', 'internet', 'celular', 'telefono', 'telefonia', 'plan', 'claro', 'movistar', 'tigo', 'wom', 'epm', 'energia', 'administracion'],
  5: ['salud', 'drogueria', 'farmacia', 'farmatodo', 'medicina', 'medicamento', 'remedio', 'pastilla', 'medico', 'cita', 'odontologo', 'dentista', 'eps', 'laboratorio', 'examen', 'gimnasio', 'gym', 'bienestar', 'pañal', 'formula', 'pediatra', 'vacuna'],
  6: ['suscripcion', 'netflix', 'spotify', 'disney', 'youtube', 'icloud', 'hbo', 'prime', 'chatgpt', 'claude', 'app', 'digital'],
  7: ['entretenimiento', 'cine', 'concierto', 'boleta', 'juego', 'fiesta', 'bar', 'rumba', 'paseo', 'parque', 'teatro'],
  8: ['hogar', 'casa', 'tecnologia', 'electrodomestico', 'mueble', 'ferreteria', 'homecenter', 'aseo', 'limpieza', 'computador', 'cocina', 'decoracion'],
  9: ['ropa', 'zapato', 'tenis', 'personal', 'regalo', 'belleza', 'peluqueria', 'cosmetico', 'maquillaje', 'perfume', 'accesorio'],
  10: ['vehiculo', 'carro', 'moto', 'gasolina', 'tanqueo', 'parqueadero', 'parqueo', 'taller', 'soat', 'lavado', 'llanta', 'tecnomecanica'],
  11: ['otro', 'otra', 'transferencia', 'varios'],
  12: ['reembolsable', 'empresa', 'trabajo', 'oficina', 'viatico', 'cliente'],
};
const INDICE_PALABRAS = new Map<string, number[]>();
for (const [id, ps] of Object.entries(PALABRAS_CATEGORIA))
  for (const p of ps) INDICE_PALABRAS.set(raiz(p), [...(INDICE_PALABRAS.get(raiz(p)) ?? []), Number(id)]);

/** Categorías por palabras clave en un texto (orden: más coincidencias primero). */
export function categoriasPorPalabras(texto: string): number[] {
  const puntos = new Map<number, number>();
  for (const t of plano(texto).split(' ').map(raiz))
    for (const id of INDICE_PALABRAS.get(t) ?? []) puntos.set(id, (puntos.get(id) ?? 0) + 1);
  return [...puntos.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Sinónimos para categorías creadas después (no tienen palabras propias): si el nombre de una
 * categoría contiene la raíz, estas palabras la señalan ("arriendo" → «Arrendamientos»).
 */
const SINONIMOS: Array<[string, string[]]> = [
  ['arrend', ['arriendo', 'arrendamiento', 'alquiler', 'canon']],
  ['credit', ['credito', 'prestamo', 'cuota', 'libranza', 'hipoteca', 'leasing']],
  ['educa', ['educacion', 'colegio', 'mensualidad', 'pension', 'matricula', 'universidad', 'curso', 'jardin', 'escolar', 'utile']],
  ['colegi', ['colegio', 'mensualidad', 'pension', 'matricula', 'escolar']],
  ['segur', ['seguro', 'poliza']],
  ['impuest', ['impuesto', 'predial', 'dian', 'renta']],
  ['mascot', ['mascota', 'veterinario', 'perro', 'gato', 'concentrado']],
  ['ahorr', ['ahorro']],
];

/** Categorías (de la lista dada) que señalan los sinónimos del texto. */
export function categoriasPorSinonimos(texto: string, categorias: Array<{ id: number; nombre: string }>): number[] {
  const palabras = new Set(plano(texto).split(' ').map(raiz));
  const ids: number[] = [];
  for (const [r, lista] of SINONIMOS) {
    if (!lista.some((p) => palabras.has(raiz(p)))) continue;
    for (const c of categorias)
      if (plano(c.nombre).split(' ').some((w) => w.startsWith(r)) && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}

const ORDINALES: Record<string, number> = { uno: 1, una: 1, primera: 1, primero: 1, dos: 2, segunda: 2, segundo: 2, tres: 3, tercera: 3, tercero: 3 };

/**
 * Texto de la persona → categoría. Acepta el número de la lista sugerida ("1", "la 2"),
 * el nombre de una categoría o texto libre ("fue mercado", "en la droguería").
 * null si no hay una sola categoría clara (el agente muestra las opciones).
 */
export function categoriaDeTexto(texto: string, categorias: Array<{ id: number; nombre: string }>, sugeridas: number[] = []): number | null {
  const t = plano(texto);
  const ids = new Set(categorias.map((c) => c.id));
  const hayPalabras = categoriasPorPalabras(texto).some((id) => ids.has(id));
  const eleccion = t.match(/^(?:(?:es|fue|la|el|opcion|numero|nro)\s+)*(\d{1,2}|uno|dos|tres|primer[oa]|segund[oa]|tercer[oa])\b/);
  // Un dígito es una elección explícita; una palabra ("dos") solo si el mensaje es corto y sin categoría.
  const esDigito = eleccion && /^\d+$/.test(eleccion[1]);
  if (eleccion && !valoresEnTexto(texto).length && (esDigito || (!hayPalabras && t.split(' ').length <= 3))) {
    const n = esDigito ? Number(eleccion[1]) : ORDINALES[eleccion[1]];
    if (n >= 1 && n <= sugeridas.length) return sugeridas[n - 1];
    if (!sugeridas.length && ids.has(n)) return n;
    if (esDigito) return null; // número fuera de la lista: que el agente muestre las opciones
  }
  const exacta = categorias.find((c) => t.includes(plano(c.nombre)));
  if (exacta) return exacta.id;
  const porPalabra = categoriasPorPalabras(texto).filter((id) => ids.has(id));
  if (porPalabra.length) {
    const puntos = (id: number) => plano(texto).split(' ').map(raiz).filter((x) => INDICE_PALABRAS.get(x)?.includes(id)).length;
    const top = puntos(porPalabra[0]);
    const empatadas = porPalabra.filter((id) => puntos(id) === top);
    if (empatadas.length === 1) return empatadas[0];
    // Empate: si una de ellas estaba entre las sugeridas, gana la primera sugerida.
    const sug = sugeridas.find((s) => empatadas.includes(s));
    if (sug) return sug;
  }
  // Categorías creadas después (nombres nuevos): por nombre normalizado, luego por sinónimos.
  const porNombre = categorias.filter((c) => !Object.keys(PALABRAS_CATEGORIA).includes(String(c.id)) && t.includes(raiz(plano(c.nombre))));
  if (porNombre.length === 1) return porNombre[0].id;
  // Todas las palabras de un nombre nuevo, en cualquier orden ("ninos colegio" → «Colegio Niños»).
  const porPalabrasNombre = categorias.filter((c) => {
    const ws = plano(c.nombre).split(' ').filter((w) => w.length >= 3 && w !== 'y');
    return ws.length > 0 && ws.every((w) => t.split(' ').some((p) => raiz(p) === raiz(w)));
  });
  if (porPalabrasNombre.length === 1) return porPalabrasNombre[0].id;
  const porSinonimo = categoriasPorSinonimos(texto, categorias);
  return porSinonimo.length === 1 ? porSinonimo[0] : null;
}

/** Categorías sugeridas para la pregunta (2–3): regla, semilla, historial, palabras, frecuentes. */
export async function sugerirCategorias(
  db: Db,
  m: { comercio_id: number | null; comercio?: string | null; descripcion_original?: string | null },
  generico: boolean,
): Promise<number[]> {
  const ids: number[] = [];
  const agregar = (id: number | null | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (m.comercio_id) {
    const { rows: r } = await db.query('SELECT categoria_id FROM reglas_comercio WHERE comercio_id = $1', [m.comercio_id]);
    if (!generico) agregar(r[0]?.categoria_id);
    const { rows: c } = await db.query('SELECT categoria_semilla_id FROM comercios WHERE id = $1', [m.comercio_id]);
    if (!generico) agregar(c[0]?.categoria_semilla_id);
    const { rows: h } = await db.query(
      `SELECT categoria_id FROM movimientos WHERE comercio_id = $1 AND estado = 'confirmado' AND categoria_id IS NOT NULL
       GROUP BY categoria_id ORDER BY count(*) DESC LIMIT 2`,
      [m.comercio_id],
    );
    h.forEach((x) => agregar(x.categoria_id));
  }
  if (!generico) categoriasPorPalabras(`${m.comercio ?? ''} ${m.descripcion_original ?? ''}`).forEach(agregar);
  if (ids.length < 3) {
    const { rows: f } = await db.query(
      `SELECT categoria_id FROM movimientos WHERE estado = 'confirmado' AND categoria_id IS NOT NULL AND categoria_id <> 12
         AND fecha >= current_date - 90
       GROUP BY categoria_id ORDER BY count(*) DESC LIMIT 3`,
    );
    f.forEach((x) => agregar(x.categoria_id));
  }
  for (const d of [1, 2, 11]) agregar(d);
  const { rows: activas } = await db.query<{ id: number }>(`SELECT id FROM categorias WHERE estado IN ('activa', 'propuesta')`);
  const vivas = new Set(activas.map((a) => a.id));
  return ids.filter((id) => vivas.has(id)).slice(0, 3);
}

export async function nombresCategorias(db: Db): Promise<Array<{ id: number; nombre: string }>> {
  const { rows } = await db.query<{ id: number; nombre: string }>(
    `SELECT id, nombre FROM categorias WHERE estado IN ('activa', 'propuesta') ORDER BY id`,
  );
  return rows;
}

// ───────────────────────────── personas ─────────────────────────────

const digitos = (s: string) => s.replace(/\D/g, '').slice(-10);

/**
 * Número de WhatsApp → persona, comparando con los destinos privados de la config
 * (destino_miguel, destino_katerine: los mismos números a los que se pregunta en privado).
 */
export async function personaDeNumero(db: Db, numero: string): Promise<'miguel' | 'katerine' | null> {
  const n = digitos(numero);
  if (n.length < 7) return null;
  const { rows } = await db.query<{ clave: string; valor: unknown }>(
    `SELECT clave, valor FROM config WHERE clave IN ('destino_miguel', 'destino_katerine')`,
  );
  for (const r of rows) if (typeof r.valor === 'string' && digitos(r.valor) === n) return r.clave === 'destino_miguel' ? 'miguel' : 'katerine';
  return null;
}
