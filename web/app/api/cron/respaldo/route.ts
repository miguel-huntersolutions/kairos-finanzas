// Vercel Cron cada 30 min: el respaldo (libera arrendamientos, reintenta TRM y extractor,
// re-avisa). Protegido con CRON_SECRET. Sustituye al cron de OpenClaw `finanzas-respaldo`.
import { dbDesdeEntorno } from '@src/lib/db';
import { efectosDesdeEntorno } from '@src/lib/efectos';
import { cronRespaldo } from '@src/lib/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const r = await cronRespaldo(req.headers.get('authorization'), {
    db: dbDesdeEntorno,
    ef: () => efectosDesdeEntorno(),
    secreto: process.env.CRON_SECRET,
  });
  return Response.json(r.json, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
