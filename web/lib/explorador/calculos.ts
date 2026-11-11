// Cálculos del explorador, idénticos a los del HTML original (explorador-visa),
// separados de la vista para poder probarlos. La categoría vigente viene de la base.
export const OTROS = 'Otros / pagos a comercios';
export const HORMIGA = 20_000;

export interface Mov {
  id: string;
  mes: string;
  fecha: string;
  desc: string;
  comercio: string;
  valor: number;
  cuotas: number;
  categoria_id: number | null;
  categoria: string;
  categoria_inicial: string;
  // Tablero unificado (opcionales para filas antiguas o sintéticas)
  tarjeta_id?: string | null;
  tarjeta?: string;
  fuente?: string;
  estado?: string;
  estado_vista?: string;
  grupo?: 'conciliado' | 'por_conciliar' | 'pendiente' | 'manual';
  por_conciliar?: boolean;
  duplicado_de?: string | null;
  /** false = posible duplicado de extracto (o ya conciliada): no suma. */
  cuenta?: boolean;
  reclasificable?: boolean;
}
/** Filtro de estado: conciliado, por_conciliar, pendiente, manual o duplicado. */
export type FiltroEstado = '' | 'conciliado' | 'por_conciliar' | 'pendiente' | 'manual' | 'duplicado';
export interface Filtros { mes: string; cat: string; monto: '' | 'h' | 'p' | 'g'; q: string; tarjeta?: string; estado?: FiltroEstado }

/** ¿Suma en KPIs y gráficos? Los posibles duplicados de extracto no. */
export const cuentaEnTotales = (m: Mov) => m.cuenta !== false;

/** Total sin doble conteo: los posibles duplicados de extracto no suman. */
export const suma = (a: Mov[]) => a.reduce((s, m) => s + (cuentaEnTotales(m) ? m.valor : 0), 0);

/** Coincide con el filtro de estado del tablero. */
export function enEstado(m: Mov, e: FiltroEstado | undefined): boolean {
  if (!e) return true;
  if (e === 'duplicado') return !!m.duplicado_de;
  if (e === 'por_conciliar') return !!m.por_conciliar;
  return m.grupo === e;
}

/**
 * Mismo filtro que `rows()` del HTML, más tarjeta y estado. Por defecto deja fuera los
 * posibles duplicados (no suman); `conDuplicados` los incluye (tabla de Movimientos).
 */
export function filtrar(movs: Mov[], f: Filtros, { ignoreMes = false, ignoreCat = false, conDuplicados = false } = {}): Mov[] {
  const qq = f.q.trim().toLowerCase();
  const incluirDup = conDuplicados || f.estado === 'duplicado';
  return movs.filter((m) => {
    if (!incluirDup && !cuentaEnTotales(m)) return false;
    if (f.tarjeta && (m.tarjeta_id ?? '') !== f.tarjeta) return false;
    if (!enEstado(m, f.estado)) return false;
    if (!ignoreMes && f.mes && m.mes !== f.mes) return false;
    if (!ignoreCat && f.cat && m.categoria !== f.cat) return false;
    if (f.monto === 'h' && m.valor > 20000) return false;
    if (f.monto === 'p' && m.valor > 100000) return false;
    if (f.monto === 'g' && m.valor <= 100000) return false;
    if (qq && !(m.desc.toLowerCase().includes(qq) || m.comercio.toLowerCase().includes(qq))) return false;
    return true;
  });
}

/** KPIs de "Resumen" (viewResumen del HTML). */
export function kpisResumen(data: Mov[]) {
  const total = suma(data);
  const meses = new Set(data.map((m) => m.mes)).size || 1;
  const horm = data.filter((m) => m.valor <= HORMIGA);
  const otros = data.filter((m) => m.categoria === OTROS);
  return {
    total,
    compras: data.length,
    promedio: data.length ? total / data.length : 0,
    meses,
    porMes: total / meses,
    hormiga: { total: suma(horm), compras: horm.length, pct: suma(horm) / (total || 1) },
    otros: { total: suma(otros), pct: suma(otros) / (total || 1) },
  };
}

/** KPIs de "Detalle del mes" frente al mes anterior (viewMes del HTML, sin intereses ni deuda). */
export function kpisMes(cur: Mov[], ant: Mov[]) {
  const hc = cur.filter((m) => m.valor <= HORMIGA);
  const ha = ant.filter((m) => m.valor <= HORMIGA);
  return {
    consumo: { actual: suma(cur), anterior: suma(ant) },
    compras: { actual: cur.length, anterior: ant.length },
    hormiga: { actual: suma(hc), anterior: suma(ha), compras: hc.length },
  };
}

/** KPIs de "Reclasificar": «Otros» al empezar (antes de reclasificar en el explorador) y ahora. */
export function kpisReclasificar(all: Mov[]) {
  const total = suma(all) || 1;
  const otrosOrig = suma(all.filter((m) => m.categoria_inicial === OTROS));
  const otrosNow = suma(all.filter((m) => m.categoria === OTROS));
  const ajustadas = all.filter((m) => m.categoria !== m.categoria_inicial);
  return {
    otrosOrig,
    otrosNow,
    pctOrig: otrosOrig / total,
    pctNow: otrosNow / total,
    comprasAjustadas: ajustadas.length,
    comerciosAjustados: new Set(ajustadas.map((m) => m.comercio)).size,
  };
}

/** "Comercios con más gasto" (top 12 por total; categoría = la de su primera compra, como el HTML). */
export function topComercios(data: Mov[], n = 12) {
  const g = new Map<string, Mov[]>();
  for (const m of data) g.set(m.comercio, [...(g.get(m.comercio) ?? []), m]);
  return [...g]
    .map(([k, a]) => ({ k, t: suma(a), n: a.length, c: a[0].categoria }))
    .sort((a, b) => b.t - a.t)
    .slice(0, n);
}
