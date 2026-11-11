// Ingresos que la persona cuenta por chat: salario, reembolsos de la empresa y otros.
// Reglas (aplicadas aquí, no en el modelo):
//  - No son ingreso: traslados entre cuentas propias, retiros, préstamos o avances, ni lo que
//    pasa entre Miguel y Katerine. Se rechazan con `no_es_ingreso`.
//  - Tipo: se deduce de la descripción (nómina → salario, reembolso/viáticos → reembolso); si no
//    se puede, se pregunta con opciones. Nunca se adivina.
//  - Un reembolso se asocia a las compras reembolsables pendientes: solo si el valor cuadra
//    exacto (las más viejas primero, o una sola compra). Si no cuadra, se registra y se pregunta
//    cuáles cubre (asociar_reembolso).
//  - Se deshace con descartar_ingreso: el ingreso queda descartado y sus compras vuelven a pendientes.
import type { Db } from './db';
import { ErrorDominio, type Efectos, bitacora } from './dominio';
import type { Contexto, Entrada } from './esquemas';
import { type CompraReembolsable, NOMBRE_TIPO, type TipoIngreso, reembolsablesPendientes } from './ingresos-cifras';
import * as R from './referencias';
import { plano } from './referencias';

const DIAS_ATRAS = 60;
const PERSONA: Record<string, string> = { miguel: 'Miguel', katerine: 'Katerine' };
const NO_ES_INGRESO = new RegExp(
  ['traslado', 'entre (mis |nuestras )?cuentas', 'transferencia (propia|de mi|desde mi)', 'retiro', 'cajero', 'pr[eé]stamo', 'avance', 'devoluci[oó]n de (una )?compra']
    .map((p) => `\\b${p}\\b`)
    .join('|'),
  'i',
);
/** «De Kati», «me pasó Miguel»: plata que va de una persona a la otra, no entra al hogar. */
const DE_LA_OTRA_PERSONA = /\b(de|desde)\s+(kati|kate|katerine|miguel|migue)\b|\b(kati|kate|katerine|miguel|migue)\s+me\s+(pas[oó]|transfiri[oó]|envi[oó])(?![a-záéíóúñ])/i;
const SALARIO = /\b(n[oó]mina|salario|sueldo|quincena|prima|honorarios|pago de (la )?n[oó]mina)\b/i;
const REEMBOLSO = /\b(reembolso|reintegro|vi[aá]ticos|legalizaci[oó]n)\b/i;

const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const dias = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const pesos = (v: number) => `$${v.toLocaleString('es-CO')}`;

export function esIngreso(descripcion: string): { ok: true } | { ok: false; motivo: 'no_es_ingreso' } {
  if (NO_ES_INGRESO.test(descripcion) || DE_LA_OTRA_PERSONA.test(descripcion)) return { ok: false, motivo: 'no_es_ingreso' };
  return { ok: true };
}

export function tipoDeTexto(descripcion: string): TipoIngreso | null {
  if (REEMBOLSO.test(descripcion)) return 'reembolso';
  if (SALARIO.test(descripcion)) return 'salario';
  return null;
}

const OPCIONES_TIPO = (['salario', 'reembolso', 'otro'] as const).map((tipo, i) => ({ n: i + 1, tipo, nombre: NOMBRE_TIPO[tipo] }));

async function quienEscribe(db: Db, numero: string): Promise<'miguel' | 'katerine'> {
  const quien = await R.personaDeNumero(db, numero);
  if (!quien) throw new ErrorDominio(403, 'solo Miguel o Katerine pueden registrar ingresos');
  return quien;
}

/** Marca como pagadas por un reembolso estas compras y sus parejas conciliadas (correo ↔ extracto). */
async function asociar(db: Db, ingresoId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(
    `UPDATE movimientos SET reembolso_id = $1, actualizado_en = now()
     WHERE reembolso_id IS NULL AND (
       id = ANY($2::uuid[]) OR conciliado_con = ANY($2::uuid[])
       OR id IN (SELECT conciliado_con FROM movimientos WHERE id = ANY($2::uuid[]) AND conciliado_con IS NOT NULL))`,
    [ingresoId, ids],
  );
}

/** Compras que cubre un reembolso de `valor`: las más viejas primero, o una sola; si no cuadra exacto, ninguna. */
export function comprasQueCuadran(pendientes: CompraReembolsable[], valor: number): CompraReembolsable[] | null {
  let suma = 0;
  for (let i = 0; i < pendientes.length; i++) {
    suma += pendientes[i].valor;
    if (suma === valor) return pendientes.slice(0, i + 1);
    if (suma > valor) break;
  }
  const una = pendientes.filter((p) => p.valor === valor);
  return una.length === 1 ? una : null;
}

const lineaCompra = (c: CompraReembolsable) => `${c.n}. ${ddmm(c.fecha)} · ${c.comercio} · ${pesos(c.valor)}`;
const suma = (cs: CompraReembolsable[]) => cs.reduce((s, c) => s + c.valor, 0);

/** Registra un ingreso. Devuelve `aplicado: false` (sin escribir nada) si falta un dato o no es ingreso. */
export async function registrarIngreso(db: Db, _ef: Efectos, e: Entrada<'registrar_ingreso'>, ctx: Contexto = {}) {
  const quien = await quienEscribe(db, e.numero_remitente);
  const descripcion = e.descripcion.trim();
  const fecha = e.fecha ?? hoyBogota();
  const diferencia = dias(fecha, hoyBogota());
  if (diferencia > 0 || diferencia < -DIAS_ATRAS)
    return { aplicado: false, motivo: 'fecha_fuera_de_rango', mensaje: `La fecha debe ser hoy o hasta ${DIAS_ATRAS} días atrás. No registré nada.` };
  if (!esIngreso(descripcion).ok)
    return {
      aplicado: false, motivo: 'no_es_ingreso',
      mensaje: 'Eso no es un ingreso del hogar (traslado entre cuentas, retiro, préstamo o plata entre ustedes). No lo registré. Dilo así a la persona.',
    };
  const tipo: TipoIngreso | null = e.tipo ?? tipoDeTexto(descripcion);
  if (!tipo)
    return {
      aplicado: false, motivo: 'falta_tipo',
      mensaje: '¿Qué tipo de ingreso es? Pregunta mostrando las opciones numeradas y vuelve a llamar con `tipo`. No registré nada.',
      opciones: OPCIONES_TIPO,
    };
  const persona = e.persona ?? quien;

  const { rows: parecidos } = await db.query(
    `SELECT 1 FROM ingresos WHERE estado = 'confirmado' AND valor = $1 AND fecha BETWEEN ($2::date - 1) AND ($2::date + 1) LIMIT 1`,
    [e.valor, fecha],
  );

  return db.tx(async (tx) => {
    const { rows: [ing] } = await tx.query(
      `INSERT INTO ingresos (fecha, valor, descripcion, tipo, persona, registrado_por, nota)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [fecha, e.valor, descripcion, tipo, persona, quien, e.nota ?? null],
    );
    let cubiertas: CompraReembolsable[] = [];
    let pendientes: CompraReembolsable[] = [];
    if (tipo === 'reembolso') {
      pendientes = await reembolsablesPendientes(tx);
      cubiertas = comprasQueCuadran(pendientes, e.valor) ?? [];
      await asociar(tx, ing.id, cubiertas.map((c) => c.movimiento_id));
    }
    await bitacora(tx, {
      actor: quien, instruido_por: quien, accion: 'registrar_ingreso', ctx,
      despues: { ingreso_id: ing.id, tipo, persona, valor: e.valor, fecha, compras_cubiertas: cubiertas.map((c) => c.movimiento_id) },
    });
    const base = `Registré ingreso: ${descripcion} · ${pesos(e.valor)} · ${ddmm(fecha)} · ${NOMBRE_TIPO[tipo]} · de ${PERSONA[persona]}.`;
    const duplicado = parecidos.length ? 'Ojo: ya hay otro ingreso de ese valor ese día. Si es el mismo, dile a la persona que descarte uno.' : '';
    const respuesta: Record<string, unknown> = { aplicado: true, motivo: 'confirmado', tipo, persona, fecha, posible_duplicado: parecidos.length > 0 };
    if (tipo !== 'reembolso') return { ...respuesta, mensaje: [base, duplicado].filter(Boolean).join(' ') };

    const quedan = pendientes.filter((p) => !cubiertas.includes(p));
    if (!pendientes.length)
      return { ...respuesta, mensaje: [base, 'No había compras reembolsables pendientes.', duplicado].filter(Boolean).join(' '), compras_cubiertas: 0 };
    if (cubiertas.length)
      return {
        ...respuesta,
        compras_cubiertas: cubiertas.length,
        mensaje: [
          base,
          `Cubre ${cubiertas.length} ${cubiertas.length === 1 ? 'compra reembolsable' : 'compras reembolsables'}.`,
          quedan.length ? `La empresa todavía debe ${pesos(suma(quedan))} (${quedan.length} ${quedan.length === 1 ? 'compra' : 'compras'}).` : 'La empresa ya no debe nada.',
          duplicado,
        ].filter(Boolean).join(' '),
      };
    return {
      ...respuesta,
      compras_cubiertas: 0,
      por_asociar: true,
      mensaje: `${base} El valor no cuadra con las compras reembolsables pendientes. Publica \`texto\` tal cual y, con la respuesta, llama asociar_reembolso con los números que diga.`,
      texto: [`${base}`, '', `¿Qué compras cubre? Pendientes (${pesos(suma(pendientes))}):`, ...pendientes.slice(0, 30).map(lineaCompra), '', 'Responde con los números (ej: 1, 3).'].join('\n'),
    };
  });
}

/** «Cubre la 1 y la 3»: asocia esas compras pendientes al último reembolso registrado. */
export async function asociarReembolso(db: Db, _ef: Efectos, e: Entrada<'asociar_reembolso'>, ctx: Contexto = {}) {
  const quien = await quienEscribe(db, e.numero_remitente);
  const { rows: [ing] } = await db.query(
    `SELECT id::text AS id, valor::bigint AS valor, descripcion FROM ingresos
     WHERE tipo = 'reembolso' AND estado = 'confirmado' ORDER BY creado_en DESC LIMIT 1`,
  );
  if (!ing) return { aplicado: false, motivo: 'sin_reembolso', mensaje: 'No hay un reembolso registrado. Primero regístralo con registrar_ingreso. No cambié nada.' };
  const pendientes = await reembolsablesPendientes(db);
  const elegidas = [...new Set(e.numeros)].map((n) => pendientes.find((p) => p.n === n));
  if (elegidas.some((c) => !c))
    return {
      aplicado: false, motivo: 'numero_invalido',
      mensaje: 'Algún número no está en la lista de pendientes. Publica `texto` y vuelve a preguntar. No cambié nada.',
      texto: ['Compras reembolsables pendientes:', ...pendientes.slice(0, 30).map(lineaCompra)].join('\n'),
    };
  const compras = elegidas as CompraReembolsable[];
  return db.tx(async (tx) => {
    await asociar(tx, ing.id, compras.map((c) => c.movimiento_id));
    await bitacora(tx, {
      actor: quien, instruido_por: quien, accion: 'asociar_reembolso', ctx,
      despues: { ingreso_id: ing.id, compras: compras.map((c) => c.movimiento_id) },
    });
    const cubierto = suma(compras);
    const valor = Number(ing.valor);
    const quedan = pendientes.filter((p) => !compras.includes(p));
    return {
      aplicado: true,
      compras_cubiertas: compras.length,
      mensaje: [
        `Listo: el reembolso de ${pesos(valor)} cubre ${compras.length} ${compras.length === 1 ? 'compra' : 'compras'} (${pesos(cubierto)}).`,
        cubierto !== valor ? `Diferencia: ${pesos(Math.abs(valor - cubierto))} ${valor > cubierto ? 'de más' : 'de menos'}.` : '',
        quedan.length ? `La empresa todavía debe ${pesos(suma(quedan))}.` : 'La empresa ya no debe nada.',
      ].filter(Boolean).join(' '),
    };
  });
}

/** «¿Cuánto nos debe la empresa?»: compras reembolsables pendientes, armado por el servidor. */
export async function reembolsos(db: Db) {
  const pendientes = await reembolsablesPendientes(db);
  const total = suma(pendientes);
  const texto = pendientes.length
    ? [
        `La empresa les debe ${pesos(total)} en ${pendientes.length} ${pendientes.length === 1 ? 'compra' : 'compras'}:`,
        ...pendientes.slice(0, 30).map(lineaCompra),
        pendientes.length > 30 ? `… y ${pendientes.length - 30} más (ver el tablero).` : '',
      ].filter(Boolean).join('\n')
    : 'La empresa no les debe nada: no hay compras reembolsables pendientes.';
  return { total, cantidad: pendientes.length, texto, mensaje: 'Publica `texto` tal cual.' };
}

/** Deshace un ingreso mal registrado: queda descartado y sus compras vuelven a pendientes. */
export async function descartarIngreso(db: Db, _ef: Efectos, e: Entrada<'descartar_ingreso'>, ctx: Contexto = {}) {
  const quien = await quienEscribe(db, e.numero_remitente);
  const { rows } = await db.query(
    `SELECT id::text AS id, fecha::text AS fecha, valor::bigint AS valor, descripcion, tipo FROM ingresos
     WHERE estado = 'confirmado' AND fecha >= (CURRENT_DATE - 90) ORDER BY fecha DESC, creado_en DESC`,
  );
  const ref = plano(e.referencia);
  const numero = Number(e.referencia.replace(/[^0-9]/g, ''));
  let candidatos = rows;
  if (/\b(ultim[oa]|ese|eso)\b/.test(ref)) candidatos = rows.slice(0, 1);
  else if (numero >= 1000) candidatos = rows.filter((r: any) => Number(r.valor) === numero);
  else {
    const palabras = ref.split(/\s+/).filter((p) => p.length >= 3 && !['ingreso', 'el', 'la', 'del', 'de'].includes(p));
    candidatos = rows.filter((r: any) => palabras.length > 0 && palabras.every((p) => plano(r.descripcion).includes(p)));
  }
  const describir = (r: any) => `${r.descripcion} · ${pesos(Number(r.valor))} · ${ddmm(r.fecha)}`;
  if (candidatos.length !== 1)
    return {
      aplicado: false, motivo: candidatos.length ? 'ambigua' : 'ninguna',
      mensaje: candidatos.length
        ? 'Hay varios ingresos que coinciden. Muestra las opciones numeradas y vuelve a llamar con la descripción o el valor exacto. No cambié nada.'
        : 'No encontré ese ingreso (últimos 90 días). Pregunta cuál es (descripción o valor). No cambié nada.',
      opciones: (candidatos.length ? candidatos : rows.slice(0, 10)).slice(0, 10).map((r: any, i: number) => ({ n: i + 1, ingreso: describir(r) })),
    };
  const ing = candidatos[0];
  return db.tx(async (tx) => {
    await tx.query(`UPDATE ingresos SET estado = 'descartado', actualizado_en = now() WHERE id = $1`, [ing.id]);
    const { rows: liberadas } = await tx.query(
      `UPDATE movimientos SET reembolso_id = NULL, actualizado_en = now() WHERE reembolso_id = $1 RETURNING id`,
      [ing.id],
    );
    await bitacora(tx, {
      actor: quien, instruido_por: quien, accion: 'descartar_ingreso', ctx,
      antes: { ingreso_id: ing.id, estado: 'confirmado' }, despues: { estado: 'descartado', compras_liberadas: liberadas.length },
    });
    return {
      aplicado: true,
      mensaje: `Descarté el ingreso ${describir(ing)}.${liberadas.length ? ' Sus compras reembolsables volvieron a pendientes.' : ''}`,
    };
  });
}
