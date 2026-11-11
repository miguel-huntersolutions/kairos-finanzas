// Respaldo. Lo llama el cron de OpenClaw por HTTP con el mismo
// token que usa finanzas-mcp (FINANZAS_API_TOKEN). No es turno de agente:
// libera arrendamientos vencidos, reintenta el extractor y la TRM, y re-avisa.
import { dbDesdeEntorno } from '../lib/db';
import { respaldo } from '../lib/dominio';
import { efectosDesdeEntorno } from '../lib/efectos';
import { type EventoHttp, cabecera, responder, tokenValido } from '../lib/http';

export const handler = async (ev: EventoHttp) => {
  if (!ev?.__evento_http) return responder(400, { error: 'solo HTTP' });
  if ((ev.method ?? '').toUpperCase() !== 'POST') return responder(405, { error: 'usar POST' });
  const auth = cabecera(ev, 'authorization');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!tokenValido(token, process.env.FINANZAS_API_TOKEN)) return responder(401, { error: 'no autorizado' });
  return responder(200, await respaldo(dbDesdeEntorno(), efectosDesdeEntorno()));
};
