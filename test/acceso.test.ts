// Login propio del tablero: correo + código. Valores FALSOS, solo de prueba.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE, MAX_FALLOS, firmarSesion, verificarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import { type DepsTablero, type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { nuevaDb } from './apoyo';

const CODIGO_FALSO = '482917';
const SECRETO_FALSO = 'secreto-de-sesion-falso-para-pruebas-0123456789';
const HOST = 'tablero.frontends.ejemplo';
const env = { TABLERO_CORREOS: 'ana@ejemplo.com, beto@ejemplo.com', TABLERO_CODIGO: CODIGO_FALSO, TABLERO_SESION_SECRET: SECRETO_FALSO, TABLERO_PERSONAS: 'ana@ejemplo.com=miguel,beto@ejemplo.com=katerine' };

let db: Db;
let esperas: number[];
let salidas: unknown[];
let deps: DepsTablero;
const registros: string[] = [];

beforeEach(async () => {
  ({ db } = await nuevaDb());
  esperas = [];
  salidas = [];
  registros.length = 0;
  for (const m of ['log', 'warn', 'error', 'info'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void registros.push(a.map(String).join(' ')));
  deps = { db: () => db, env, dormir: async (ms) => void esperas.push(ms) };
});
afterEach(() => vi.restoreAllMocks());

async function pedir(metodo: string, path: string, o: { cuerpo?: unknown; cookie?: string; ip?: string; origen?: string; sfs?: string; query?: Record<string, string[]> } = {}) {
  const headers: Record<string, string[]> = { 'content-type': ['application/json'] };
  if (o.cookie) headers.cookie = [o.cookie];
  if (o.origen !== undefined) headers.origin = [o.origen];
  else if (metodo === 'POST') headers.origin = [`https://${HOST}`];
  if (o.sfs) headers['sec-fetch-site'] = [o.sfs];
  const ev: EventoRuta = {
    __evento_http: true, method: metodo, path, headers, query: o.query ?? {},
    body: o.cuerpo === undefined ? '' : JSON.stringify(o.cuerpo),
    request_context: { host: HOST, source_ip: o.ip ?? '203.0.113.7' },
  };
  const r = await manejarTablero(ev, deps);
  salidas.push(r);
  return { ...r, json: JSON.parse(r.body) };
}
const login = (correo: string, codigo: string, ip?: string) => pedir('POST', '/login', { cuerpo: { correo, codigo }, ip });
const cookieDe = (r: { headers: Record<string, string> }) => r.headers['set-cookie']?.split(';')[0];

describe('login del tablero', () => {
  it('correo no autorizado y código incorrecto dan la MISMA respuesta genérica', async () => {
    const a = await login('intruso@ejemplo.com', CODIGO_FALSO);
    const b = await login('ana@ejemplo.com', '111111');
    const c = await login('ana@ejemplo.com', 'abc');
    for (const r of [a, b, c]) {
      expect(r.statusCode).toBe(401);
      expect(r.json).toEqual({ error: 'Correo o código incorrecto' });
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const fallos = (await db.query(`SELECT tipo, clave FROM tablero_intentos ORDER BY id`)).rows;
    expect(fallos).toHaveLength(9); // 3 intentos × (ip + correo global + par correo+IP)
    expect(fallos.map((f: any) => f.tipo)).toEqual(Array(3).fill(['ip', 'correo', 'correo']).flat());
  });

  it('correcto: cookie __Host- HttpOnly, Secure, SameSite=Lax, 30 días; luego sesión y datos', async () => {
    const r = await login('ANA@ejemplo.com ', CODIGO_FALSO);
    expect(r.statusCode).toBe(200);
    const sc = r.headers['set-cookie'];
    expect(sc).toMatch(new RegExp(`^${COOKIE}=v1\\.`));
    for (const p of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${30 * 86400}`]) expect(sc).toContain(p);
    expect(sc).not.toMatch(/Domain=/i);
    const cookie = cookieDe(r);
    expect((await pedir('GET', '/sesion', { cookie })).json).toEqual({ correo: 'ana@ejemplo.com' });
    const d = await pedir('GET', '/datos', { cookie, query: { mes: ['2026-01'] } });
    expect(d.statusCode).toBe(200);
    expect(d.json.mes).toBe('2026-01');
    expect(JSON.stringify(d.json)).not.toContain('FINANZAS_API_TOKEN');
  });

  it('bloqueo tras 5 intentos fallidos desde la misma IP, con espera creciente; ni el código correcto entra', async () => {
    for (let i = 0; i < MAX_FALLOS; i++) expect((await login('ana@ejemplo.com', '000000', '198.51.100.7')).statusCode).toBe(401);
    expect(esperas).toEqual([0, 500, 1000, 2000, 4000]);
    const r = await login('ana@ejemplo.com', CODIGO_FALSO, '198.51.100.7');
    expect(r.statusCode).toBe(429);
    expect(r.json.error).toMatch(/15 minutos/);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('bloqueo por IP aunque se cambie de correo', async () => {
    for (let i = 0; i < MAX_FALLOS; i++) await login(`otro${i}@ejemplo.com`, '000000', '192.0.2.50');
    expect((await login('beto@ejemplo.com', CODIGO_FALSO, '192.0.2.50')).statusCode).toBe(429);
    expect((await login('beto@ejemplo.com', CODIGO_FALSO, '192.0.2.51')).statusCode).toBe(200); // otra IP sí entra
  });

  it('se desbloquea a los 15 minutos y un ingreso correcto limpia los fallos del correo', async () => {
    for (let i = 0; i < MAX_FALLOS; i++) await login('ana@ejemplo.com', '000000');
    expect((await login('ana@ejemplo.com', CODIGO_FALSO)).statusCode).toBe(429);
    await db.query(`UPDATE tablero_intentos SET creado_en = now() - interval '16 minutes'`);
    expect((await login('ana@ejemplo.com', CODIGO_FALSO)).statusCode).toBe(200);
    // Se borran los intentos del par correo+IP; el conteo global por correo queda (sigue en ventana).
    expect((await db.query(`SELECT count(*)::int AS n FROM tablero_intentos WHERE clave LIKE '[%'`)).rows[0].n).toBe(0);
  });

  it('ingresos correctos repetidos desde la misma IP no bloquean ni dejan filas de intento', async () => {
    for (let i = 0; i < MAX_FALLOS + 2; i++) {
      expect((await login('ana@ejemplo.com', CODIGO_FALSO, '198.51.100.9')).statusCode).toBe(200);
    }
    expect((await db.query(`SELECT count(*)::int AS n FROM tablero_intentos`)).rows[0].n).toBe(0);
    // Un fallo después de los aciertos no bloquea.
    expect((await login('ana@ejemplo.com', '000000', '198.51.100.9')).statusCode).toBe(401);
  });

  it('SEC-005: una ráfaga simultánea no verifica más de MAX_FALLOS intentos', async () => {
    const intentos = Array.from({ length: 12 }, () => login('ana@ejemplo.com', '000000', '198.51.100.100'));
    const res = await Promise.all(intentos);
    const verificados = res.filter((r) => r.statusCode === 401).length;
    const bloqueados = res.filter((r) => r.statusCode === 429).length;
    expect(verificados).toBeLessThanOrEqual(MAX_FALLOS);
    expect(verificados + bloqueados).toBe(12);
  });

  it('SEC-009: un tercero desde otra IP no bloquea el correo de la persona autorizada', async () => {
    for (let i = 0; i < MAX_FALLOS + 2; i++) await login('beto@ejemplo.com', '000000', '203.0.113.200');
    expect((await login('beto@ejemplo.com', CODIGO_FALSO, '198.51.100.7')).statusCode).toBe(200);
  });

  it('SEC-010: cerrar sesión revoca la cookie aunque siga siendo válida por firma y fecha', async () => {
    const cookie = cookieDe(await login('ana@ejemplo.com', CODIGO_FALSO));
    expect((await pedir('GET', '/sesion', { cookie })).statusCode).toBe(200);
    await pedir('POST', '/logout', { cookie });
    expect((await pedir('GET', '/sesion', { cookie })).statusCode).toBe(401);
    // Un ingreso nuevo sí funciona.
    const nueva = cookieDe(await login('ana@ejemplo.com', CODIGO_FALSO));
    expect((await pedir('GET', '/sesion', { cookie: nueva })).statusCode).toBe(200);
  });

  it('sin configuración completa no deja entrar (503)', async () => {
    deps = { ...deps, env: { ...env, TABLERO_CODIGO: '12345' } };
    expect((await login('ana@ejemplo.com', '12345')).statusCode).toBe(503);
    deps = { ...deps, env: { ...env, TABLERO_SESION_SECRET: undefined } };
    expect((await login('ana@ejemplo.com', CODIGO_FALSO)).statusCode).toBe(503);
  });
});

describe('sesión', () => {
  const ahora = Date.now();
  it('caducada, alterada, con otro secreto o de un correo retirado: no sirve', async () => {
    const vieja = firmarSesion('ana@ejemplo.com', SECRETO_FALSO, ahora - 31 * 86_400_000);
    expect(verificarSesion(vieja, SECRETO_FALSO, env.TABLERO_CORREOS, ahora)).toBeNull();
    const buena = firmarSesion('ana@ejemplo.com', SECRETO_FALSO, ahora);
    expect(verificarSesion(buena, SECRETO_FALSO, env.TABLERO_CORREOS, ahora)).toBe('ana@ejemplo.com');
    const [v, carga, firma] = buena.split('.');
    const otraCarga = Buffer.from(JSON.stringify({ c: 'beto@ejemplo.com', e: ahora + 9e9 })).toString('base64url');
    expect(verificarSesion(`${v}.${otraCarga}.${firma}`, SECRETO_FALSO, env.TABLERO_CORREOS, ahora)).toBeNull();
    expect(verificarSesion(`${v}.${carga}.${firma.slice(0, -2)}xx`, SECRETO_FALSO, env.TABLERO_CORREOS, ahora)).toBeNull();
    expect(verificarSesion(buena, 'otro-secreto', env.TABLERO_CORREOS, ahora)).toBeNull();
    expect(verificarSesion(buena, SECRETO_FALSO, 'beto@ejemplo.com', ahora)).toBeNull();
    expect(verificarSesion('basura', SECRETO_FALSO, env.TABLERO_CORREOS, ahora)).toBeNull();
    expect((await pedir('GET', '/datos', { cookie: `${COOKIE}=${vieja}` })).statusCode).toBe(401);
  });

  it('logout borra la cookie', async () => {
    const r = await pedir('POST', '/logout');
    expect(r.headers['set-cookie']).toMatch(new RegExp(`^${COOKIE}=;.*Max-Age=0`));
  });

  it('peticiones desde otro origen (otro frontend del mismo dominio) se rechazan', async () => {
    expect((await pedir('POST', '/login', { cuerpo: { correo: 'ana@ejemplo.com', codigo: CODIGO_FALSO }, origen: 'https://malo.frontends.ejemplo' })).statusCode).toBe(403);
    const cookie = cookieDe(await login('ana@ejemplo.com', CODIGO_FALSO));
    expect((await pedir('GET', '/datos', { cookie, sfs: 'same-site' })).statusCode).toBe(403);
    expect((await pedir('GET', '/datos', { cookie, sfs: 'same-origin' })).statusCode).toBe(200);
  });
});

describe('el código nunca se filtra', () => {
  it('no aparece en respuestas, cabeceras, registros de consola ni en la base', async () => {
    await login('ana@ejemplo.com', CODIGO_FALSO);
    await login('ana@ejemplo.com', '000000');
    await login('intruso@ejemplo.com', CODIGO_FALSO);
    for (let i = 0; i < 6; i++) await login('beto@ejemplo.com', '999999');
    const respuestas = JSON.stringify(salidas);
    expect(respuestas).not.toContain(CODIGO_FALSO);
    expect(respuestas).not.toContain(SECRETO_FALSO);
    expect(registros.join('\n')).not.toContain(CODIGO_FALSO);
    expect(registros.join('\n')).not.toContain('999999');
    expect(registros.join('\n')).not.toMatch(/ana@|beto@|intruso@/);
    const base = JSON.stringify((await db.query(`SELECT * FROM tablero_intentos`)).rows) + JSON.stringify((await db.query(`SELECT * FROM bitacora`)).rows);
    expect(base).not.toContain(CODIGO_FALSO);
    expect(base).not.toContain('999999');
  });
});
