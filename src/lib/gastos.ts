// Gastos que la persona cuenta por chat (efectivo, PSE, Bre-B, transferencia, tarjeta débito).
// Nacen con fuente `manual`, así que NO entran en la conciliación con extractos y cuentan una vez.
// Reglas (aplicadas aquí, no en el modelo):
//  - No son gasto: pagos de tarjeta de crédito, retiros en cajero, ahorro o inversión (CDT),
//    recargas de billetera ni transferencias entre cuentas propias o entre Miguel y Katerine.
//    Se rechazan con `no_es_gasto`. Las cuotas de créditos (libre inversión, carro…) SÍ son gasto.
//  - Medio de pago: se resuelve con `medioDeTexto` (nunca se adivina). Un medio cuyo origen no se
//    registra por chat (crédito) se rechaza: esas compras llegan por correo o extracto.
//  - Sin categoría clara NO se registra: se devuelven las opciones para preguntar en la misma
//    conversación (así no sale una segunda pregunta automática).
//  - Se deshace con descartar_movimiento (motivo "otro") y se corrige con editar_movimiento.
import type { Db } from './db';
import { ErrorDominio, type Efectos, bitacora, clasificar, editarMovimientoTablero, resolverComercio } from './dominio';
import type { Contexto, Entrada } from './esquemas';
import { type Canal, type Medio, canalDeTexto, cargarMedios, medioDeTexto, medioPagoDe, nombreMedio, opcionesMedio, palabrasPropias } from './medios';
import * as R from './referencias';
import { plano } from './referencias';

const NO_ES_GASTO = new RegExp(
  [
    'pago (de )?(la )?(tarjeta|t\\.?\\s?c\\.?)',
    'retiro',
    'cajero',
    'ahorros?',
    '(?<!libre[\\s-]*)inversi[oó]n',
    'cdt',
    'recarga (a |de )?(la )?(nequi|daviplata|billetera|cuenta)',
    'entre (mis |nuestras )?cuentas',
    'transferencia (propia|a mi)',
    'traslado',
  ].map((p) => `\\b${p}\\b`).join('|'),
  'i',
);
/** Transferencia o Bre-B A la otra persona ("a Kati", "para Miguel"): movimiento entre ustedes. */
const A_LA_OTRA_PERSONA = /\b(a|para)\s+(kati|kate|katerine|miguel|migue)\b|^\s*(kati|kate|katerine|miguel|migue)\s*$/i;
const DIAS_ATRAS = 60;
const PERSONA: Record<string, string> = { miguel: 'Miguel', katerine: 'Katerine' };

const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const dias = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const pesos = (v: number) => `$${v.toLocaleString('es-CO')}`;

export function esGasto(descripcion: string, medio: string): { ok: true } | { ok: false; motivo: string } {
  if (NO_ES_GASTO.test(descripcion)) return { ok: false, motivo: 'no_es_gasto' };
  if ((medio === 'transferencia' || medio === 'bre_b') && A_LA_OTRA_PERSONA.test(descripcion)) return { ok: false, motivo: 'no_es_gasto' };
  return { ok: true };
}

type Gasto = Omit<Entrada<'registrar_gasto'>, 'numero_remitente' | 'canal'>;

/** Medio del gasto: el que nombró la persona o, si solo dijo el canal (efectivo, PSE), el de ese canal. */
function resolverMedio(g: Gasto, medios: Medio[]):
  | { ok: true; medio: Medio; canal: Canal | null }
  | { ok: false; respuesta: Record<string, unknown> } {
  let texto = (g.medio ?? g.tarjeta ?? '').trim();
  let canalDicho: Canal | null =
    g.medio_pago === 'tarjeta_debito' ? 'tarjeta' : (g.medio_pago as Canal | undefined) ?? null;
  // «por transferencia», «con Bre-B»: solo dice CÓMO, no con qué cuenta.
  if (texto && !palabrasPropias(plano(texto)).length && canalDeTexto(texto)) {
    canalDicho = canalDicho && canalDicho !== 'tarjeta' ? canalDicho : canalDeTexto(texto);
    if (canalDicho === 'transferencia' || canalDicho === 'bre_b') texto = '';
  }
  const pedir = (motivo: string, mensaje: string, candidatos: Medio[] = []) => ({
    ok: false as const,
    respuesta: {
      aplicado: false, motivo, mensaje,
      opciones: candidatos.length ? opcionesMedio(candidatos) : opcionesMedio(medios),
    },
  });
  if (texto) {
    const r = medioDeTexto(texto, medios);
    if (r.tipo === 'unico') return { ok: true, medio: r.medio, canal: canalDicho && canalDicho !== 'tarjeta' ? canalDicho : r.canal };
    if (r.tipo === 'ambiguo')
      return pedir('medio_ambiguo', `«${texto}» puede ser varios medios. Pregunta cuál (muestra las opciones numeradas) y vuelve a llamar con el que diga. No registré nada.`, r.candidatos);
    return pedir('medio_no_reconocido', `No tengo un medio de pago «${texto}». Muestra las opciones; si es uno nuevo, se crea en el tablero (Medios de pago). No registré nada.`);
  }
  if (canalDicho === 'efectivo' || canalDicho === 'pse') {
    const r = medioDeTexto(canalDicho, medios);
    if (r.tipo === 'unico') return { ok: true, medio: r.medio, canal: canalDicho };
  }
  if (canalDicho === 'transferencia' || canalDicho === 'bre_b')
    return pedir('falta_cuenta', '¿Desde qué cuenta salió? Pregunta y vuelve a llamar con `medio`. No registré nada.');
  return pedir('falta_medio', '¿Con qué pagó (efectivo, PSE, cuál débito)? Pregunta y vuelve a llamar con `medio`. No registré nada.');
}

/** Registra un gasto. Devuelve `aplicado: false` (sin escribir nada) si falta un dato. */
export async function registrarGasto(db: Db, _ef: Efectos, e: Entrada<'registrar_gasto'>, ctx: Contexto = {}) {
  const quien = await R.personaDeNumero(db, e.numero_remitente);
  if (!quien) throw new ErrorDominio(403, 'solo Miguel o Katerine pueden registrar gastos');
  return registrarUno(db, quien, e, ctx);
}

async function registrarUno(db: Db, quien: 'miguel' | 'katerine', e: Gasto, ctx: Contexto) {
  const descripcion = e.descripcion.trim();
  const fecha = e.fecha ?? hoyBogota();
  const diferencia = dias(fecha, hoyBogota());
  if (diferencia > 0 || diferencia < -DIAS_ATRAS)
    return { aplicado: false, motivo: 'fecha_fuera_de_rango', mensaje: `La fecha debe ser hoy o hasta ${DIAS_ATRAS} días atrás. No registré nada.` };

  const medios = await cargarMedios(db);
  const m = resolverMedio(e, medios);
  if (!m.ok) return m.respuesta;
  const { medio } = m;
  if (medio.registro_chat === false)
    return {
      aplicado: false, motivo: 'origen_no_se_registra',
      mensaje: `${nombreMedio(medio)} es de origen ${medio.origen_nombre ?? medio.clase}: esas compras llegan por correo o por el extracto, no las registro a mano. No registré nada.`,
    };
  const medioPago = medioPagoDe(medio, m.canal);
  const regla = esGasto(descripcion, medioPago);
  if (!regla.ok)
    return {
      aplicado: false,
      motivo: regla.motivo,
      mensaje: 'Eso no es un gasto (pago de tarjeta, retiro, ahorro o un movimiento entre cuentas o entre ustedes). No lo registré. Dilo así a la persona.',
    };

  const cats = await R.nombresCategorias(db);
  const sugeridas = [...new Set([...R.categoriasPorPalabras(descripcion), ...R.categoriasPorSinonimos(descripcion, cats)])]
    .filter((id) => cats.some((c) => c.id === id))
    .slice(0, 3);
  let categoriaId: number | null = e.categoria_id ?? (e.categoria ? R.categoriaDeTexto(e.categoria, cats, sugeridas) : null);
  if (categoriaId != null && !cats.some((c) => c.id === categoriaId)) categoriaId = null;
  if (categoriaId == null) {
    const orden = [...sugeridas, ...cats.map((c) => c.id).filter((id) => !sugeridas.includes(id))];
    return {
      aplicado: false,
      motivo: e.categoria ? 'categoria_no_reconocida' : 'falta_categoria',
      mensaje: e.categoria
        ? `No tengo la categoría «${e.categoria}». Muestra las opciones numeradas; si quiere una nueva, usa crear_categoria y vuelve a llamar con su categoria_id. No registré nada.`
        : 'Falta la categoría. Pregúntala mostrando las opciones numeradas y vuelve a llamar con su categoria_id. No registré nada.',
      sugeridas: sugeridas.map((id, i) => ({ n: i + 1, categoria_id: id, nombre: cats.find((c) => c.id === id)!.nombre })),
      opciones: orden.map((id, i) => ({ n: i + 1, categoria_id: id, nombre: cats.find((c) => c.id === id)!.nombre })),
    };
  }
  const categoria = cats.find((c) => c.id === categoriaId)!;

  // Aviso, no bloqueo: una compra de correo, captura o extracto del mismo valor y día puede ser la misma.
  const { rows: parecidos } = await db.query(
    `SELECT 1 FROM movimientos
     WHERE estado <> 'descartado' AND valor = $1 AND fecha BETWEEN ($2::date - 1) AND ($2::date + 1) LIMIT 1`,
    [e.valor, fecha],
  );
  const posibleDuplicado = parecidos.length > 0;

  return db.tx(async (tx) => {
    const comercio = await resolverComercio(tx, descripcion);
    const persona = medio.tipo === 'individual' && medio.persona_default ? medio.persona_default : e.persona ?? quien;
    const reembolsable = e.reembolsable ?? categoriaId === 12;
    const { rows: [mov] } = await tx.query(
      `INSERT INTO movimientos (fecha, comercio_id, descripcion_original, valor, cuotas, tarjeta_id, persona, categoria_id, reembolsable,
         estado, fuente, clasificado_por, moneda, medio_pago, nota)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'confirmado', 'manual', $9, 'COP', $10, $11) RETURNING id::text AS id`,
      [fecha, comercio.id, descripcion, e.valor, medio.id, persona, categoriaId, reembolsable, quien, medioPago, e.nota ?? null],
    );
    await bitacora(tx, {
      movimiento_id: mov.id, actor: quien, instruido_por: quien, accion: 'registrar_gasto', ctx,
      despues: { estado: 'confirmado', categoria_id: categoriaId, persona, medio_pago: medioPago, tarjeta_id: medio.id, valor: e.valor, fecha },
    });
    const forma = m.canal && m.canal !== medio.canal && m.canal !== 'tarjeta'
      ? `${etiquetaCanal(m.canal)} desde ${nombreMedio(medio)}`
      : nombreMedio(medio);
    const partes = [
      `Registré ${descripcion} · ${pesos(e.valor)} · ${ddmm(fecha)} · ${forma} · ${categoria.nombre} · a nombre de ${PERSONA[persona]}.`,
      persona !== quien && medio.tipo === 'individual' ? `(${nombreMedio(medio)} es de ${PERSONA[persona]}.)` : '',
      posibleDuplicado ? 'Ojo: ya hay otra compra de ese valor ese día. Si es la misma, dile a la persona que descarte una.' : '',
    ].filter(Boolean);
    return {
      aplicado: true,
      motivo: 'confirmado',
      mensaje: partes.join(' '),
      persona,
      medio: nombreMedio(medio),
      categoria: categoria.nombre,
      fecha,
      posible_duplicado: posibleDuplicado,
      movimiento: await R.candidatoPorId(tx, mov.id).then((c) => (c ? R.describir(c) : null)),
    };
  });
}

function etiquetaCanal(c: Canal): string {
  return ({ efectivo: 'efectivo', pse: 'PSE', bre_b: 'Bre-B', transferencia: 'transferencia', otro: 'otro medio', tarjeta: 'tarjeta' } as const)[c];
}

/** Varios gastos de un mismo mensaje: cada uno se registra (o se explica qué falta) por separado. */
export async function registrarGastos(db: Db, _ef: Efectos, e: Entrada<'registrar_gastos'>, ctx: Contexto = {}) {
  const quien = await R.personaDeNumero(db, e.numero_remitente);
  if (!quien) throw new ErrorDominio(403, 'solo Miguel o Katerine pueden registrar gastos');
  const resultados: Array<Record<string, any>> = [];
  for (const g of e.gastos) resultados.push({ descripcion: g.descripcion, valor: g.valor, ...(await registrarUno(db, quien, g, ctx)) });
  const hechos = resultados.filter((r) => r.aplicado);
  const faltan = resultados.filter((r) => !r.aplicado);
  const lineas = resultados.map((r, i) =>
    r.aplicado ? `${i + 1}. ✓ ${String(r.mensaje).replace(/^Registré /, '')}` : `${i + 1}. ✗ ${r.descripcion} · ${pesos(r.valor)}: ${motivoCorto(r.motivo)}`,
  );
  return {
    aplicados: hechos.length,
    pendientes: faltan.length,
    texto: [`Registré ${hechos.length} de ${resultados.length}:`, ...lineas].join('\n'),
    mensaje: faltan.length
      ? 'Publica `texto` tal cual y pregunta lo que falta de los ✗ (usa las `opciones` de cada uno). Con la respuesta, registra solo esos con registrar_gasto.'
      : 'Publica `texto` tal cual.',
    resultados,
  };
}

function motivoCorto(motivo: string): string {
  return ({
    falta_categoria: 'falta la categoría',
    categoria_no_reconocida: 'no tengo esa categoría',
    falta_medio: 'falta con qué se pagó',
    falta_cuenta: 'falta desde qué cuenta',
    medio_ambiguo: 'el medio puede ser varios',
    medio_no_reconocido: 'no tengo ese medio de pago',
    origen_no_se_registra: 'las compras con crédito llegan por correo',
    no_es_gasto: 'no es un gasto',
    fecha_fuera_de_rango: 'fecha fuera de rango',
  } as Record<string, string>)[motivo] ?? motivo;
}

const PENDIENTES = ['por_preguntar', 'esperando_respuesta', 'en_proceso', 'provisional'];

/**
 * Corregir desde el chat una compra ya registrada. Usa la misma edición del tablero (mismas
 * guardas: compras conciliadas, tarjetas individuales). Si la compra espera su categoría, la
 * categoría pasa por `clasificar` (con su ciclo de reglas).
 */
export async function editarMovimientoChat(db: Db, _ef: Efectos, e: Entrada<'editar_movimiento'>, ctx: Contexto = {}) {
  const quien = await R.personaDeNumero(db, e.numero_remitente);
  if (!quien) throw new ErrorDominio(403, 'solo Miguel o Katerine pueden editar compras');
  let id = e.movimiento_id;
  if (!id) {
    const sel = await R.seleccionar(db, e.referencia);
    if (sel.tipo !== 'unica') return { ...R.noUnica(sel, e.referencia), aplicado: false };
    id = sel.movimiento.movimiento_id;
  }
  const { rows } = await db.query(`SELECT estado, fuente FROM movimientos WHERE id = $1`, [id]);
  if (!rows[0]) return { aplicado: false, motivo: 'ninguna', mensaje: 'No encontré esa compra.' };

  const cambios: Record<string, unknown> = {};
  if (e.fecha) cambios.fecha = e.fecha;
  if (e.valor) cambios.valor = e.valor;
  if (e.descripcion) cambios.comercio = e.descripcion;
  if (e.persona) cambios.persona = e.persona;
  if (e.nota !== undefined) cambios.nota = e.nota;
  if (e.medio) {
    const medios = await cargarMedios(db);
    const r = medioDeTexto(e.medio, medios);
    if (r.tipo !== 'unico')
      return {
        aplicado: false, motivo: r.tipo === 'ambiguo' ? 'medio_ambiguo' : 'medio_no_reconocido',
        mensaje: `No sé cuál medio de pago es «${e.medio}». Muestra las opciones y vuelve a llamar. No cambié nada.`,
        opciones: opcionesMedio(r.candidatos.length ? r.candidatos : medios),
      };
    cambios.tarjeta_id = r.medio.id;
    if (r.canal && r.canal !== 'tarjeta') cambios.medio_pago = r.canal;
  }
  let categoriaId: number | undefined = e.categoria_id;
  if (e.categoria && categoriaId == null) {
    const cats = await R.nombresCategorias(db);
    const c = R.categoriaDeTexto(e.categoria, cats, []);
    if (c == null)
      return {
        aplicado: false, motivo: 'categoria_no_reconocida',
        mensaje: `No tengo la categoría «${e.categoria}». Muestra las opciones; si quiere una nueva, usa crear_categoria. No cambié nada.`,
        opciones: cats.map((x, i) => ({ n: i + 1, categoria_id: x.id, nombre: x.nombre })),
      };
    categoriaId = c;
  }
  const pendiente = PENDIENTES.includes(rows[0].estado);
  if (categoriaId != null && !pendiente) cambios.categoria_id = categoriaId;
  if (!Object.keys(cambios).length && !(categoriaId != null && pendiente))
    return { aplicado: false, motivo: 'sin_cambios', mensaje: 'No dijo qué cambiar.' };

  try {
    if (Object.keys(cambios).length)
      await editarMovimientoTablero(db, { movimiento_id: id, ...cambios }, { correo: 'whatsapp', persona: quien }, Date.now(), 'editar_chat');
    if (categoriaId != null && pendiente) {
      const r: any = await clasificar(db, { movimiento_id: id, categoria_id: categoriaId, numero_remitente: e.numero_remitente, canal: e.canal }, ctx);
      if (!r.aplicado) return r;
    }
  } catch (err) {
    if (err instanceof ErrorDominio && err.status < 500) return { aplicado: false, motivo: 'no_permitido', mensaje: `No se pudo: ${err.message}. No cambié nada.` };
    throw err;
  }
  const { rows: [f] } = await db.query(
    `SELECT c.nombre AS comercio, m.descripcion_original, m.valor::int AS valor, m.fecha::text AS fecha, m.persona,
            t.nombre AS medio, t.canal, t.clase, o.nombre AS origen_nombre, k.nombre AS categoria
     FROM movimientos m LEFT JOIN comercios c ON c.id = m.comercio_id LEFT JOIN tarjetas t ON t.id = m.tarjeta_id
     LEFT JOIN origenes_pago o ON o.id = t.clase LEFT JOIN categorias k ON k.id = m.categoria_id WHERE m.id = $1`,
    [id],
  );
  const medio = f.medio ? nombreMedio({ nombre: f.medio, canal: f.canal, clase: f.clase, origen_nombre: f.origen_nombre }) : 'sin medio de pago';
  return {
    aplicado: true,
    mensaje: `Listo: ${f.comercio ?? f.descripcion_original} · ${pesos(f.valor)} · ${f.fecha ? ddmm(f.fecha) : 'sin fecha'} · ${medio} · ${f.categoria ?? 'sin categoría'} · a nombre de ${PERSONA[f.persona] ?? 'sin asignar'}.`,
    persona: f.persona,
    medio,
    categoria: f.categoria,
    fecha: f.fecha,
  };
}
