// Lógica de los crons de Vercel (web/app/api/cron/*). Protegidos con CRON_SECRET:
// Vercel envía `Authorization: Bearer <CRON_SECRET>`. Sin secreto configurado, 503.
import type { Db } from './db';
import { type Efectos, respaldo } from './dominio';
import { tokenValido } from './http';
import { procesarRecordatorios } from './recordatorios-cron';

export interface RespuestaCron { status: number; json: unknown }

export function autorizadoCron(authorization: string | null | undefined, secreto: string | undefined): boolean {
  const a = authorization ?? '';
  const token = a.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : '';
  return tokenValido(token, secreto);
}

async function conCron(authorization: string | null | undefined, secreto: string | undefined, correr: () => Promise<unknown>): Promise<RespuestaCron> {
  if (!secreto) return { status: 503, json: { error: 'cron sin configurar' } };
  if (!autorizadoCron(authorization, secreto)) return { status: 401, json: { error: 'no autorizado' } };
  try {
    return { status: 200, json: await correr() };
  } catch (e) {
    console.error('[cron] fallo:', (e as Error).message);
    return { status: 500, json: { error: 'fallo interno' } };
  }
}

export function cronRecordatorios(authorization: string | null | undefined, deps: { db: () => Db; ef: () => Efectos; secreto: string | undefined; ahora?: () => number }) {
  return conCron(authorization, deps.secreto, () => procesarRecordatorios(deps.db(), deps.ef(), deps.ahora?.() ?? Date.now()));
}

export function cronRespaldo(authorization: string | null | undefined, deps: { db: () => Db; ef: () => Efectos; secreto: string | undefined }) {
  return conCron(authorization, deps.secreto, () => respaldo(deps.db(), deps.ef()));
}
