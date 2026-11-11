import { lectorResend, procesarWebhookCorreo } from '../lib/correo-http';
import { dbDesdeEntorno } from '../lib/db';
import { efectosDesdeEntorno } from '../lib/efectos';
import type { EventoHttp } from '../lib/http';

export const handler = (ev: EventoHttp) =>
  procesarWebhookCorreo(ev, {
    secreto: process.env.RESEND_WEBHOOK_SECRET,
    db: dbDesdeEntorno(),
    ef: efectosDesdeEntorno(),
    leer: lectorResend(process.env.RESEND_API_KEY),
  });
