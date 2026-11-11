// Estado visible de cada compra en el tablero unificado, la regla de emparejamiento
// correo ↔ extracto (una sola implementación, `emparejar`) y la regla provisional de
// "posible duplicado" para lo que aún no pasó por la conciliación (docs/conciliacion.md).
// Todo es derivado de `fuente` + `estado` (+ `conciliado_con`): no cambia datos.

export type Fuente = 'correo' | 'extracto' | 'manual' | 'captura';

/**
 * Fuentes de compras que el banco confirma después con el extracto: las que llegaron por
 * correo y las que se cargaron desde una captura o reporte de la app (`captura`). En la
 * conciliación, el tablero y las cifras se tratan igual.
 */
export const FUENTES_A_CONCILIAR = ['correo', 'captura'];
export const porConciliarFuente = (fuente: string) => FUENTES_A_CONCILIAR.includes(fuente);

/** Días de diferencia tolerados entre la fecha del correo y la del extracto. */
export const VENTANA_DIAS = 3;

const ETIQUETA_ESTADO: Record<string, string> = {
  requiere_interpretacion: 'Requiere interpretación',
  provisional: 'Provisional',
  requiere_revision: 'Requiere revisión',
  requiere_trm: 'Falta TRM',
  por_preguntar: 'Por preguntar',
  en_proceso: 'Preguntando',
  esperando_respuesta: 'Esperando respuesta',
  confirmado: 'Confirmado',
  descartado: 'Descartado',
};

/** Grupo para el filtro "Estado" del tablero. */
export type GrupoEstado = 'conciliado' | 'por_conciliar' | 'pendiente' | 'manual';

export interface EstadoVista {
  /** Texto de la columna "Estado". */
  etiqueta: string;
  /** Compra que llegó por correo y aún no tiene su fila del extracto. */
  por_conciliar: boolean;
  grupo: GrupoEstado;
}

const PENDIENTES = new Set(['requiere_interpretacion', 'requiere_revision', 'requiere_trm', 'por_preguntar', 'en_proceso', 'esperando_respuesta']);

/**
 * - extracto → "Conciliado" (vino del extracto del banco).
 * - correo → el estado del flujo ("Esperando respuesta", "Confirmado"…) + "Por conciliar"
 *   mientras no tenga `conciliado_con`; con `conciliado_con`, "Conciliado".
 * - manual → "Manual".
 * - captura → como correo, con el prefijo "Captura · " (se cargó desde la app del banco).
 */
export function estadoVista(fuente: string, estado: string, conciliadoCon: string | null = null): EstadoVista {
  if (fuente === 'extracto') return { etiqueta: 'Conciliado', por_conciliar: false, grupo: 'conciliado' };
  if (fuente === 'manual') return { etiqueta: 'Manual', por_conciliar: false, grupo: 'manual' };
  const flujo = (fuente === 'captura' ? 'Captura · ' : '') + (ETIQUETA_ESTADO[estado] ?? estado);
  if (conciliadoCon) return { etiqueta: `${flujo} · Conciliado`, por_conciliar: false, grupo: 'conciliado' };
  return { etiqueta: flujo, por_conciliar: true, grupo: PENDIENTES.has(estado) ? 'pendiente' : 'por_conciliar' };
}

export interface FilaConciliable {
  id: string;
  fuente: string;
  tarjeta_id: string | null;
  valor: number;
  fecha: string; // aaaa-mm-dd
  conciliado_con?: string | null;
  /** Fila del extracto que ya pasó por la conciliación real (`movimientos.extracto_id`). */
  extracto_id?: string | null;
  /** Compra por correo que la conciliación marcó «no aparece en el extracto». */
  no_aparece_en_extracto?: string | null;
}

const dia = (f: string) => Date.UTC(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10))) / 86_400_000;

/** Días entre dos fechas aaaa-mm-dd (valor absoluto). */
export const diasEntre = (a: string, b: string) => Math.abs(dia(a) - dia(b));

/**
 * LA regla de emparejamiento (única implementación; la usan el tablero, `idsQueNoSuman`
 * y `conciliarExtracto`): misma tarjeta (no NULL), mismo valor en COP y fecha a
 * ±VENTANA_DIAS. Uno a uno: cada fila del extracto absorbe a lo sumo una de correo; gana
 * la fecha más cercana y, si empatan, la fecha de correo más antigua.
 * Devuelve id de correo → id del extracto.
 *
 * `ignorarTarjeta` (solo la revisión de capturas cuando el reporte no trae la tarjeta y el
 * mensaje no la dice): empareja por valor y fecha, sin mirar la tarjeta.
 */
export function emparejar(correos: FilaConciliable[], extracto: FilaConciliable[], opciones: { ignorarTarjeta?: boolean } = {}): Map<string, string> {
  const ignorar = Boolean(opciones.ignorarTarjeta);
  const usados = new Set<string>();
  const pares: Array<{ correo: string; ext: string; dist: number; fecha: string }> = [];
  for (const c of correos) {
    if (!ignorar && !c.tarjeta_id) continue;
    for (const e of extracto) {
      if (e.valor !== c.valor) continue;
      if (!ignorar && (!e.tarjeta_id || e.tarjeta_id !== c.tarjeta_id)) continue;
      const dist = diasEntre(e.fecha, c.fecha);
      if (dist <= VENTANA_DIAS) pares.push({ correo: c.id, ext: e.id, dist, fecha: c.fecha });
    }
  }
  pares.sort((a, b) => a.dist - b.dist || a.fecha.localeCompare(b.fecha) || a.correo.localeCompare(b.correo));
  const resultado = new Map<string, string>();
  for (const p of pares) {
    if (resultado.has(p.correo) || usados.has(p.ext)) continue;
    resultado.set(p.correo, p.ext);
    usados.add(p.ext);
  }
  return resultado;
}

/**
 * Regla provisional sin doble conteo, solo donde la conciliación real todavía no decidió:
 * una compra por CORREO (o cargada desde una CAPTURA) que coincide (regla `emparejar`) con una fila del EXTRACTO es
 * "posible duplicado de extracto" y cuenta solo la del extracto. Quedan fuera:
 * - correos con `conciliado_con` (ya conciliados: no suman, ver `cuenta`) o marcados
 *   «no aparece en el extracto» (la conciliación ya los revisó y siguen sumando);
 * - filas del extracto cargadas por un extracto conciliado (`extracto_id`) o que ya tienen
 *   un correo conciliado con ellas: la conciliación real ya las emparejó.
 * Así se aplica solo al historial cargado sin conciliación (p. ej. VISA).
 */
export function posiblesDuplicados(filas: FilaConciliable[]): Map<string, string> {
  const conCorreo = new Set(filas.filter((f) => porConciliarFuente(f.fuente) && f.conciliado_con).map((f) => f.conciliado_con!));
  const extracto = filas.filter((f) => f.fuente === 'extracto' && !f.extracto_id && !conCorreo.has(f.id));
  const correos = filas.filter((f) => porConciliarFuente(f.fuente) && !f.conciliado_con && !f.no_aparece_en_extracto);
  return emparejar(correos, extracto);
}

/** ¿La fila suma en KPIs y gráficos? No si es posible duplicado o ya está conciliada con otra. */
export function cuenta(f: FilaConciliable, duplicados: Map<string, string>): boolean {
  if (porConciliarFuente(f.fuente) && f.conciliado_con) return false;
  return !duplicados.has(f.id);
}
