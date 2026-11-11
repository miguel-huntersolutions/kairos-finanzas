// Adaptador de Route Handlers (web/lib/rutas.ts): mapeo de la petición de Next al evento interno.
import { describe, expect, it } from 'vitest';
import { aEvento, rutaDeTablero, ruta } from '../web/lib/rutas';

describe('adaptador de rutas', () => {
  it('convierte la petición: método, cabeceras en arrays, query, cuerpo crudo, host e IP', async () => {
    const req = new Request('https://app.ejemplo/api/correo?x=1&x=2', {
      method: 'POST', body: '{"a":1}',
      headers: { 'svix-id': 'msg_1', host: 'app.ejemplo', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    const ev = await aEvento(req, '/');
    expect(ev).toMatchObject({ __evento_http: true, method: 'POST', path: '/', body: '{"a":1}' });
    expect(ev.headers?.['svix-id']).toEqual(['msg_1']);
    expect(ev.query).toEqual({ x: ['1', '2'] });
    expect(ev.request_context).toEqual({ host: 'app.ejemplo', source_ip: '203.0.113.9' });
  });

  it('el catch-all del tablero se convierte en la ruta interna (/sesion, /explorador/datos, /)', async () => {
    expect(await rutaDeTablero({ params: Promise.resolve({ ruta: ['sesion'] }) })).toBe('/sesion');
    expect(await rutaDeTablero({ params: Promise.resolve({ ruta: ['explorador', 'datos'] }) })).toBe('/explorador/datos');
    expect(await rutaDeTablero({ params: Promise.resolve({}) })).toBe('/');
  });

  it('un manejador se envuelve en Response con el mismo estado y cuerpo', async () => {
    const h = ruta(async (ev) => ({ statusCode: 201, headers: { 'x-ruta': ev.path ?? '' }, body: JSON.stringify({ ok: ev.method }) }), rutaDeTablero);
    const r = await h(new Request('https://x/api/tablero/sesion', { method: 'GET' }), { params: Promise.resolve({ ruta: ['sesion'] }) });
    expect(r.status).toBe(201);
    expect(r.headers.get('x-ruta')).toBe('/sesion');
    expect(await r.json()).toEqual({ ok: 'GET' });
  });
});
