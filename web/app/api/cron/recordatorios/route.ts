// Vercel Cron cada 15 min: procesa los recordatorios vencidos (recordatorios_pendientes).
// Protegido con CRON_SECRET (Vercel envía Authorization: Bearer <CRON_SECRET>).
import { dbDesdeEntorno } from '@src/lib/db';
import { efectosDesdeEntorno } from '@src/lib/efectos';
import { cronRecordatorios } from '@src/lib/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const r = await cronRecordatorios(req.headers.get('authorization'), {
    db: dbDesdeEntorno,
    ef: () => efectosDesdeEntorno(),
    secreto: process.env.CRON_SECRET,
  });
  return Response.json(r.json, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
