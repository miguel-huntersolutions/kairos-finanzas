// Datos del tablero (solo lectura). Se calculan en el servidor, en SQL: el
// navegador nunca ve FINANZAS_API_TOKEN ni habla con la base. Todo en COP
// (`valor`); en compras en USD se incluye además el valor original y la TRM.
import type { Db } from './db';
import { resumen, valorTexto } from './dominio';
import { idsQueNoSuman } from './efectivos';

export const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Mes actual en Bogotá (aaaa-mm). */
export function mesBogota(ahora = new Date()): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' }).format(ahora);
  return f.slice(0, 7);
}

/** Correos con acceso (TABLERO_CORREOS="a@x.com,b@y.com"). Sin lista, nadie entra. */
export function correoPermitido(email: string | undefined, lista: string | undefined): boolean {
  if (!email || !lista) return false;
  const permitidos = lista.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return permitidos.includes(email.trim().toLowerCase());
}

export async function datosTablero(db: Db, mes: string, meses = 12) {
  const r = await resumen(db, { mes });
  const desde = `${mes}-01`;
  const noSuman = await idsQueNoSuman(db);
  const tendencia = (await db.query(
    `SELECT to_char(date_trunc('month', fecha), 'YYYY-MM') AS mes, SUM(valor)::bigint AS total, COUNT(*)::int AS cantidad,
            COALESCE(SUM(valor) FILTER (WHERE reembolsable), 0)::bigint AS reembolsable,
            COUNT(*) FILTER (WHERE moneda = 'USD')::int AS compras_usd
     FROM movimientos
     WHERE estado <> 'descartado' AND valor IS NOT NULL AND NOT (id = ANY($3::uuid[]))
       AND fecha >= ($1::date - make_interval(months => $2 - 1)) AND fecha < ($1::date + interval '1 month')
     GROUP BY 1 ORDER BY 1`,
    [desde, meses, noSuman],
  )).rows.map((t: any) => ({ ...t, total: Number(t.total), reembolsable: Number(t.reembolsable) }));
  const categoriasPorMes = (await db.query(
    `SELECT to_char(date_trunc('month', m.fecha), 'YYYY-MM') AS mes, COALESCE(c.nombre, 'Sin clasificar') AS categoria,
            SUM(m.valor)::bigint AS total
     FROM movimientos m LEFT JOIN categorias c ON c.id = m.categoria_id
     WHERE m.estado <> 'descartado' AND m.valor IS NOT NULL AND NOT (m.id = ANY($3::uuid[]))
       AND m.fecha >= ($1::date - make_interval(months => $2 - 1)) AND m.fecha < ($1::date + interval '1 month')
     GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
    [desde, meses, noSuman],
  )).rows.map((t: any) => ({ ...t, total: Number(t.total) }));
  const movimientos = (await db.query(
    `SELECT m.id, m.fecha::text AS fecha, co.nombre AS comercio, m.valor, m.moneda, m.valor_original::float8 AS valor_original,
            m.trm::float8 AS trm, m.trm_fecha::text AS trm_fecha, m.cuotas, m.estado, m.persona, m.reembolsable,
            c.nombre AS categoria, t.nombre AS tarjeta
     FROM movimientos m
     LEFT JOIN comercios co ON co.id = m.comercio_id
     LEFT JOIN categorias c ON c.id = m.categoria_id
     LEFT JOIN tarjetas t ON t.id = m.tarjeta_id
     WHERE m.estado <> 'descartado' AND m.fecha >= $1::date AND m.fecha < ($1::date + interval '1 month')
     ORDER BY m.fecha DESC, m.creado_en DESC LIMIT 1000`,
    [desde],
  )).rows.map((m: any) => {
    const valor = m.valor == null ? null : Number(m.valor);
    // `suma: false` = compra por correo que ya tiene su fila del extracto (no cuenta).
    return { ...m, valor, valor_texto: valorTexto({ ...m, valor }), suma: !noSuman.includes(m.id) };
  });
  // Sin texto del correo: las alertas de revisión van sin asunto.
  const alertas = {
    ...r.alertas,
    requiere_revision: r.alertas.requiere_revision.map((a: any) => ({ movimiento_id: a.movimiento_id, nota: a.nota })),
  };
  return {
    mes,
    generado_en: new Date().toISOString(),
    resumen: { ...r, alertas },
    tendencia,
    categorias_por_mes: categoriasPorMes,
    movimientos,
    reembolsables: movimientos.filter((m) => m.reembolsable && m.suma),
  };
}
