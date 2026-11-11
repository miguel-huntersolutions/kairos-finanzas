// Utilidades de texto deterministas.

export interface Comercio {
  id: number;
  nombre: string;
  patrones: string[];
}

/**
 * Copiado de lib/categorize.ts (app-financial-services-home), RF-016 / CA-016.1:
 * el patrón más largo gana, para que "APPLE STORE" no caiga en
 * "APPLE.COM/BILL" ni al revés.
 */
export function normalizar<M extends Comercio>(descripcion: string, comercios: M[]): M | null {
  const u = descripcion.toUpperCase();
  let mejor: M | null = null;
  let largo = 0;
  for (const m of comercios) {
    for (const p of m.patrones) {
      if (u.includes(p.toUpperCase()) && p.length > largo) {
        mejor = m;
        largo = p.length;
      }
    }
  }
  return mejor;
}

export function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Un comercio es genérico si su nombre contiene un patrón de comercios_genericos. */
export function esGenerico(nombre: string, patrones: string[]): boolean {
  const u = sinTildes(nombre).toUpperCase();
  const compacto = u.replace(/[^A-Z0-9]/g, '');
  return patrones.some((p) => {
    const pu = sinTildes(p).toUpperCase();
    const re = new RegExp(`(^|[^A-Z0-9])${pu.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`);
    const pc = pu.replace(/[^A-Z0-9]/g, '');
    return re.test(u) || (pc.length >= 6 && compacto.startsWith(pc));
  });
}

/** Nombre para un comercio que no está en la semilla (queda sin verificar). */
export function nombreComercioNuevo(descripcion: string): string {
  const limpio = descripcion.replace(/\s{2,}/g, ' ').trim().slice(0, 60);
  return limpio.length > 3 ? limpio.charAt(0).toUpperCase() + limpio.slice(1).toLowerCase() : limpio;
}

/** Singular simple en español, palabra por palabra. */
function singular(p: string): string {
  if (p.length <= 3) return p;
  if (/ces$/.test(p)) return p.slice(0, -3) + 'z';
  if (/(ones|ores|ales|eles|ares|ines|udes|ades)$/.test(p)) return p.slice(0, -2);
  if (/s$/.test(p) && !/ss$/.test(p)) return p.slice(0, -1);
  return p;
}

/** Compuerta de categorías: minúsculas, sin tildes, singular. */
export function normalizarCategoria(nombre: string): string {
  return sinTildes(nombre)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

/** HTML a texto plano, sin scripts ni estilos. */
export function htmlATexto(html: string): string {
  // SEC-008: se recorta antes de procesar; los regex de etiquetas son costosos en entradas grandes.
  return html.slice(0, 20_000)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Texto limpio y acotado que puede leer el extractor en cuarentena. */
export function textoParaExtractor(texto: string | null, html: string | null): string {
  const base = texto && texto.trim() ? texto : html ? htmlATexto(html) : '';
  return base.replace(/\s+/g, ' ').trim().slice(0, 4000);
}

/**
 * "$45.900,00" → 45900; "$45,900.00" → 45900; "$120.000" → 120000; "$93.663,75" → 93664.
 * Si el último separador va seguido de exactamente 2 dígitos son centavos: se redondean a pesos
 * enteros (desde 50 centavos hacia arriba), igual que el extracto y la captura (A2).
 */
export function valorCOP(s: string): number | null {
  const limpio = s.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(limpio)) return null;
  const m = limpio.match(/^(.*)[.,](\d{2})$/);
  const entero = (m ? m[1] : limpio).replace(/[.,]/g, '');
  const n = Number(entero) + (m && Number(m[2]) >= 50 ? 1 : 0);
  // SEC-007: tope de 1e9 (la columna valor es int4; un valor mayor tumbaría las herramientas por referencia).
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000 ? n : null;
}

/**
 * Dólares con hasta 2 decimales: "12.50" / "12,50" → 12.5; "1,234.56" / "1.234,56" → 1234.56.
 * Si el último separador va seguido de 1 o 2 dígitos es el decimal.
 */
export function valorUSD(s: string): number | null {
  const limpio = s.replace(/[^0-9.,]/g, '').replace(/[.,]+$/, '');
  if (!/\d/.test(limpio)) return null;
  const m = limpio.match(/^(.*?)[.,](\d{1,2})$/);
  const entero = (m ? m[1] : limpio).replace(/[.,]/g, '') || '0';
  const n = Number(`${entero}.${m ? m[2].padEnd(2, '0') : '00'}`);
  // SEC-007: mismo tope que el extractor (USD 50.000); evita valores desproporcionados.
  return Number.isFinite(n) && n > 0 && n <= 50_000 ? Math.round(n * 100) / 100 : null;
}

/** dd/mm/aaaa, aaaa/mm/dd o aaaa-mm-dd → aaaa-mm-dd. */
export function fechaISO(s: string): string | null {
  let m = s.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  let a: number, mes: number, d: number;
  if (m) [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (!m) return null;
    [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Comercio seguro para mostrar al agente: corto y sin caracteres de control. */
export const COMERCIO_SEGURO = /^[\p{L}\p{N} .,&*'/#()_-]{1,60}$/u;
