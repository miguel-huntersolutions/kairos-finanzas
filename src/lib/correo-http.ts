// POST /correo: webhook de Resend (correo entrante). Flujo tomado de la app
// anterior: firma Svix sobre el cuerpo crudo → JSON → solo email.received →
// contenido (aviso o API de Resend) → captura. Las respuestas siguen la misma
// lógica: 200 cuando es una decisión, 500 cuando conviene que Resend reintente.
import type { Db } from './db';
import { type Efectos, ingresarCorreo } from './dominio';
import { type EventoHttp, cuerpoTexto, responder } from './http';
import { verificarFirmaSvix } from './svix';
import { textoParaExtractor } from './texto';

interface EventoResend {
  type: string;
  created_at?: string;
  data?: { email_id?: string; id?: string; from?: string; subject?: string; text?: string | null; html?: string | null; created_at?: string };
}

export interface CorreoLeido { from: string; subject: string; text: string | null; html: string | null; created_at?: string }
export type LectorResend = (emailId: string) => Promise<CorreoLeido | null>;

export function lectorResend(apiKey: string | undefined): LectorResend {
  return async (id) => {
    if (!apiKey) return null;
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return (await r.json()) as CorreoLeido;
  };
}

export async function procesarWebhookCorreo(
  ev: EventoHttp,
  deps: { secreto: string | undefined; db: Db; ef: Efectos; leer: LectorResend },
) {
  if (!deps.secreto) return responder(500, { error: 'Webhook sin configurar' });
  if ((ev.method ?? 'POST').toUpperCase() !== 'POST') return responder(405, { error: 'usar POST' });
  const cuerpo = cuerpoTexto(ev);
  if (!verificarFirmaSvix(deps.secreto, cuerpo, ev.headers ?? {})) return responder(400, { error: 'Firma inválida' });

  let evento: EventoResend;
  try {
    evento = JSON.parse(cuerpo);
  } catch {
    return responder(400, { error: 'El cuerpo no es JSON' });
  }
  if (evento.type !== 'email.received') return responder(200, { ignorado: evento.type });
  const emailId = evento.data?.email_id ?? evento.data?.id;
  if (!emailId) return responder(400, { error: 'Evento sin email_id' });

  let correo: CorreoLeido | null =
    evento.data?.text || evento.data?.html
      ? { from: evento.data.from ?? '', subject: evento.data.subject ?? '', text: evento.data.text ?? null, html: evento.data.html ?? null }
      : null;
  if (!correo) {
    try {
      correo = await deps.leer(emailId);
    } catch {
      correo = null;
    }
  }
  if (!correo) return responder(500, { error: 'No se pudo leer el correo' });

  try {
    const fecha = new Date(evento.data?.created_at ?? correo.created_at ?? evento.created_at ?? Date.now());
    const r = await ingresarCorreo(deps.db, deps.ef, {
      correo_id: emailId,
      remitente: correo.from ?? '',
      asunto: correo.subject ?? '',
      fecha_correo: Number.isNaN(fecha.getTime()) ? new Date() : fecha,
      texto: textoParaExtractor(correo.text, correo.html),
    });
    // Sin texto del correo en la respuesta: solo el resultado.
    return responder(200, { ok: true, ...r });
  } catch (e) {
    console.error('[correo] error interno:', e);
    return responder(500, { error: 'Error interno' });
  }
}
