// Efectos externos reales (en pruebas se reemplazan por dobles). El recordatorio
// se programa en la tabla recordatorios_pendientes (dominio.encolarRecordatorio).
import type { Efectos } from './dominio';
import { leerCapturaModelo } from './captura';
import { extractorAnthropic } from './extractor';

/** Mensaje del turno que abre el hook: solo ids y el evento, nunca texto del correo. */
export function mensajeHook(p: { movimiento_id: string; evento: string } | { tarjeta_id: string; evento: 'corte' }): string {
  if ('tarjeta_id' in p) return `Aviso de corte. tarjeta_id=${p.tarjeta_id}. evento=corte. Usa aviso_corte con ese tarjeta_id.`;
  if (p.evento === 'recordatorio') return `Recordatorio. movimiento_id=${p.movimiento_id}. evento=recordatorio. Usa recordar con ese id, sin texto.`;
  return `Compra nueva para revisar. movimiento_id=${p.movimiento_id}. evento=${p.evento}. Usa tomar_movimiento con ese id.`;
}

export function efectosDesdeEntorno(env: NodeJS.ProcessEnv = process.env): Efectos {
  async function enviarAlHook(clave: string, mensaje: string): Promise<boolean> {
    const url = env.OPENCLAW_HOOK_URL;
    if (!url || !env.OPENCLAW_HOOK_TOKEN) {
      console.warn('[hook] OPENCLAW_HOOK_URL/TOKEN sin definir; el respaldo reintentará');
      return false;
    }
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENCLAW_HOOK_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': clave },
        body: JSON.stringify({
          agentId: 'finanzas', name: 'compra-nueva', sessionMode: 'isolated', deliver: false,
          model: env.OPENCLAW_HOOK_MODEL || 'anthropic/claude-haiku-5-5', thinking: 'off', message: mensaje,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) console.warn(`[hook] respuesta ${r.status}`);
      return r.ok;
    } catch (e) {
      console.warn('[hook] falló:', (e as Error).message);
      return false;
    }
  }
  return {
    async avisarCorte(tarjeta_id, intento = 1) {
      const clave = `corte:${tarjeta_id}:${new Date().toISOString().slice(0, 7)}:${intento}`;
      if (!(await enviarAlHook(clave, mensajeHook({ tarjeta_id, evento: 'corte' }))))
        throw new Error('hook de corte sin respuesta');
    },
    async avisarHook({ movimiento_id, evento, intento }) {
      // Tareas operativas (compra nueva, recordatorio) en Haiku; las preguntas de las personas
      // usan el modelo del agente (Sonnet). Se puede cambiar con OPENCLAW_HOOK_MODEL.
      // Un fallo no se lanza: el respaldo y el cron de recordatorios reintentan.
      await enviarAlHook(`${movimiento_id}:${evento}${intento ? `:${intento}` : ''}`, mensajeHook({ movimiento_id, evento }));
    },
    extractor: env.ANTHROPIC_API_KEY ? extractorAnthropic(env.ANTHROPIC_API_KEY) : undefined,
    // Mismo patrón que el extractor: sin llave, revisar_captura responde 503 (salvo Excel/CSV reconocidos).
    leerCaptura: env.ANTHROPIC_API_KEY ? (contenido, mime) => leerCapturaModelo(contenido, mime, env.ANTHROPIC_API_KEY!) : undefined,
    obtenerTrm: (fecha) => obtenerTrmDatosGov(fecha),
  };
}

/**
 * TRM vigente en `fecha` (aaaa-mm-dd) según la Superfinanciera, dataset abierto
 * 32sa-8pi3 de datos.gov.co (campos valor, vigenciadesde, vigenciahasta; sin llave).
 * Devuelve null si no hay registro para esa fecha y lanza si la API falla.
 * Nunca inventa: valores fuera de un rango plausible se descartan.
 */
export async function obtenerTrmDatosGov(fecha: string, fetchImpl: typeof fetch = fetch) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const dia = `${fecha}T00:00:00`;
  const url = new URL('https://www.datos.gov.co/resource/32sa-8pi3.json');
  url.searchParams.set('$where', `vigenciadesde <= '${dia}' AND vigenciahasta >= '${dia}'`);
  url.searchParams.set('$order', 'vigenciadesde DESC');
  url.searchParams.set('$limit', '1');
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`datos.gov.co ${r.status}`);
  const filas = (await r.json()) as Array<{ valor?: string; vigenciadesde?: string; vigenciahasta?: string }>;
  const f = filas[0];
  const valor = Number(f?.valor);
  if (!f || !Number.isFinite(valor) || valor < 1000 || valor > 20000) return null;
  return {
    valor,
    fuente: `datos.gov.co 32sa-8pi3 vigencia ${f.vigenciadesde?.slice(0, 10)}..${f.vigenciahasta?.slice(0, 10)}`,
  };
}
