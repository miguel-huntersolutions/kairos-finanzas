// Adaptador: petición de Next.js (Web API) → evento HTTP que entienden los handlers de
// src/functions. Así la lógica no se duplica.
import type { EventoRuta } from '../../src/lib/tablero-http';

export interface RespuestaHandler {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

type Manejador = (ev: EventoRuta) => Promise<RespuestaHandler> | RespuestaHandler;
type Contexto = { params: Promise<Record<string, string | string[] | undefined>> };

/** Ruta del handler dentro de su prefijo (p. ej. "/sesion" para /api/tablero/sesion). */
export type Ruta = (ctx: Contexto) => Promise<string> | string;

const SIN_RUTA: Ruta = () => '/';

export async function aEvento(req: Request, ruta: string): Promise<EventoRuta> {
  const headers: Record<string, string[]> = {};
  req.headers.forEach((valor, nombre) => {
    headers[nombre] = [valor];
  });
  const url = new URL(req.url);
  const query: Record<string, string[]> = {};
  url.searchParams.forEach((valor, nombre) => {
    (query[nombre] ??= []).push(valor);
  });
  // Detrás de Vercel la IP real viene en x-forwarded-for (primer valor).
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || req.headers.get('x-real-ip') || '';
  const cuerpo = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  return {
    __evento_http: true,
    method: req.method,
    path: ruta,
    headers,
    query,
    body: cuerpo,
    request_context: { host: req.headers.get('host') ?? url.host, source_ip: ip },
  } as EventoRuta;
}

/** Envuelve un handler de src/functions como Route Handler de Next.js. */
export function ruta(manejador: Manejador, ruta: Ruta = SIN_RUTA) {
  return async (req: Request, ctx: Contexto): Promise<Response> => {
    const r = await manejador(await aEvento(req, await ruta(ctx)));
    return new Response(r.body, { status: r.statusCode, headers: r.headers });
  };
}

/** Ruta del catch-all /api/tablero/[[...ruta]] → "/sesion", "/explorador/datos", "/" … */
export const rutaDeTablero: Ruta = async (ctx) => {
  const p = (await ctx?.params) ?? {};
  const partes = Array.isArray(p.ruta) ? p.ruta : p.ruta ? [p.ruta] : [];
  return '/' + partes.join('/');
};
