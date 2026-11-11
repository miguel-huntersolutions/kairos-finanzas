// Parser por banco (regex por remitente). Determinista. Si no reconoce el
// correo devuelve ok=false y el flujo pasa al extractor en cuarentena.
// Las plantillas se escribieron sobre correos SINTÉTICOS con el formato
// habitual de cada banco: ajustarlas con los correos reales (ver README).
import { COMERCIO_SEGURO, fechaISO, valorCOP, valorUSD } from './texto';

export type TipoCorreo = 'compra' | 'reverso' | 'rechazo' | 'otro';

export type Moneda = 'COP' | 'USD';

export interface Interpretacion {
  tipo: TipoCorreo;
  comercio: string;
  /** Valor en la moneda original: pesos enteros (COP) o dólares con hasta 2 decimales (USD). */
  valor: number;
  moneda: Moneda;
  fecha: string; // aaaa-mm-dd
  ultimos_4_tarjeta: string;
}

export type ResultadoParser =
  | { ok: true; banco: string; datos: Interpretacion }
  | { ok: true; banco: string; datos: null; tipo: 'otro' }
  | { ok: false; banco: string | null; motivo: string };

interface PlantillaBanco {
  banco: string;
  /** Dominios reales desde los que el banco envía alertas. Un remitente con el nombre del banco pero
   *  otro dominio NO se acepta (SEC-002). VALIDAR con un correo real antes de cambiarlos. */
  dominios: string[];
  remitente: RegExp;
  valor: RegExp;
  comercio: RegExp;
  tarjeta: RegExp;
  /** Bancolombia (Mastercard y e-Card) también envía compras en dólares. */
  admiteUSD?: boolean;
}

/**
 * PATRONES DE COMPRAS EN USD — único lugar para ajustarlos.
 * PENDIENTE DE VALIDAR con un correo real en dólares (ver README): hoy cubren
 * "USD 12.50", "US$12,50", "por USD12.50", "12.50 USD" y "12,50 dólares".
 * El grupo 1 de cada patrón es el valor.
 */
export const PATRONES_USD: RegExp[] = [
  /(?:USD|US\$|U\$S)\s?([\d][\d.,]*)/i,
  /\$?\s?([\d][\d.,]*)\s?(?:USD|US\$|d[oó]lares)\b/i,
];

const PLANTILLAS: PlantillaBanco[] = [
  {
    banco: 'bancolombia',
    dominios: ['notificacionesbancolombia.com'],
    remitente: /bancolombia/i,
    valor: /por\s+(?:COP\s*)?\$\s?([\d.,]+)/i,
    comercio: /\ben\s+(.+?)(?=\s+\d{1,2}:\d{2}|\s+el\s+\d|\.\s|\s+con\s|\s+T\.\s?(?:Cred|Deb)|$)/i,
    tarjeta: /(?:T\.\s?(?:Cred|Deb)|tarjeta|cta)\.?\s*\*\s?(\d{4})/i,
    admiteUSD: true,
  },
  {
    banco: 'davivienda',
    dominios: ['davivienda.com'],
    remitente: /davivienda|davibank/i,
    valor: /por\s+(?:COP\s*)?\$\s?([\d.,]+)/i,
    comercio: /\ben\s+(.+?)(?=\s+con\s+su|\s+el\s+\d|\s+\d{1,2}:\d{2}|\.\s|$)/i,
    tarjeta: /terminada\s+en\s+(\d{4})/i,
  },
  {
    banco: 'platapay',
    dominios: [],
    remitente: /plata/i,
    valor: /(?:valor|monto|por)\s*:?\s*(?:COP\s*)?\$\s?([\d.,]+)/i,
    comercio: /(?:comercio|en)\s*:?\s+(.+?)(?=\s+(?:valor|monto|fecha|tarjeta)\b|\.\s|$)/i,
    tarjeta: /(?:\*{2,4}|terminada\s+en\s+|tarjeta\s*\*?\s*)(\d{4})/i,
  },
];

export function detectarTipo(texto: string): TipoCorreo {
  const t = texto.toLowerCase();
  if (/revers|devoluci[oó]n|anulaci[oó]n/.test(t)) return 'reverso';
  if (/rechaz|declinad|no (fue )?aprobad|no (fue )?exitos/.test(t)) return 'rechazo';
  if (/compra|pago|retiro|transacci[oó]n aprobada|cargo/.test(t)) return 'compra';
  return 'otro';
}

/** Dominio del correo en «Nombre <correo@dominio>» o «correo@dominio». */
export function dominioDe(remitente: string): string | null {
  const m = remitente.trim().match(/@([a-z0-9.-]+)[>\s]*$/i);
  return m ? m[1].toLowerCase() : null;
}

export function detectarBanco(remitente: string): string | null {
  return PLANTILLAS.find((p) => p.remitente.test(remitente))?.banco ?? null;
}

export function interpretarCorreo(
  remitente: string,
  texto: string,
  fechaCorreo: Date,
): ResultadoParser {
  const plantilla = PLANTILLAS.find((p) => p.remitente.test(remitente));
  if (!plantilla) return { ok: false, banco: null, motivo: 'remitente sin plantilla' };
  // SEC-002: el nombre no basta; el dominio del correo debe ser el del banco (o un subdominio).
  // Plata Pay aún no tiene dominio configurado: se mantiene la validación por nombre (SEC-002 ABIERTO
  // para ese banco) para no dejar sin registrar sus compras. Ver documento interno.
  if (plantilla.dominios.length > 0) {
    const dom = dominioDe(remitente);
    if (!dom || !plantilla.dominios.some((d) => dom === d || dom.endsWith(`.${d}`))) {
      return { ok: false, banco: plantilla.banco, motivo: 'remitente no verificado' };
    }
  }
  // SEC-008: se recorta antes de aplicar los regex (evita backtracking costoso en correos enormes).
  const plano = texto.slice(0, 4000).replace(/\s+/g, ' ').trim();
  const tipo = detectarTipo(plano);
  if (tipo === 'otro') {
    // Un correo con un valor que no se entiende NO se ignora: puede ser una plantilla nueva.
    if (/\$\s?\d|\d[\d.,]*\s?COP\b/i.test(plano) || PATRONES_USD.some((p) => p.test(plano))) return { ok: false, banco: plantilla.banco, motivo: 'tipo no reconocido con valor' };
    return { ok: true, banco: plantilla.banco, datos: null, tipo: 'otro' };
  }

  const usd = plantilla.admiteUSD ? PATRONES_USD.map((p) => plano.match(p)).find(Boolean) : null;
  const moneda: Moneda = usd ? 'USD' : 'COP';
  const v = usd ?? plano.match(plantilla.valor);
  const c = plano.match(plantilla.comercio);
  const t = plano.match(plantilla.tarjeta);
  const valor = v ? (usd ? valorUSD(v[1]) : valorCOP(v[1])) : null;
  const comercio = c?.[1]?.trim().replace(/[.,;]+$/, '');
  if (!valor || !comercio || !t) {
    return { ok: false, banco: plantilla.banco, motivo: 'plantilla no coincide' };
  }
  // SEC-003: el comercio por regex pasa la misma validación que el extractor antes de llegar al chat.
  if (!COMERCIO_SEGURO.test(comercio.slice(0, 60))) {
    return { ok: false, banco: plantilla.banco, motivo: 'comercio no verificado' };
  }
  const fecha = fechaISO(plano) ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(fechaCorreo);
  return {
    ok: true,
    banco: plantilla.banco,
    datos: { tipo, comercio: comercio.slice(0, 60), valor, moneda, fecha, ultimos_4_tarjeta: t[1] },
  };
}
