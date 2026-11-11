// Función `tablero` (HTTP, pública) servida bajo el frontend en /api/tablero
// (ruta del mismo origen → la cookie HttpOnly funciona).
//   GET  /sesion          → { correo } o 401
//   POST /login           → { correo, codigo }  (código)
//   POST /logout
//   GET  /datos?mes=AAAA-MM
//   GET  /explorador/datos              (VISA, solo confirmados)
//   POST /explorador/reclasificar       ({movimiento_id|comercio, categoria_id} o {cambios})
//   POST /extracto                      ({ pdf: base64 }) → lee, guarda y concilia el extracto
//   POST /categorias/renombrar          ({ id, nombre, confirmar_parecida? })
//   POST /categorias/borrar             ({ id, confirmar: true }) solo si no tiene registros
//   POST /borrar                        ({ movimiento_id, confirmar: true }) → borra la compra (irreversible)
//   GET  /medios                        orígenes (crédito, débito, efectivo…) y medios de pago
//   POST /medios/origen | /medios/medio  crear o editar un origen o un medio de pago
// Hace su propia autenticación: la plataforma no valida nada en estas rutas.
import {
  COOKIE, MENSAJE_BLOQUEO, MENSAJE_GENERICO, bloqueado, codigoConfigurado, cookieBorrada, cookieSesion,
  credencialesValidas, emisionSesion, esperaMs, fallosRecientes, firmarSesion, leerCookies, limpiarFallos,
  normalizarCorreo, reservarIntento, revocarSesiones, sesionRevocada, verificarSesion,
} from './acceso';
import type { Db } from './db';
import { ErrorDominio, atenderRevision, cambiarFechaTablero, confirmarTablero, crearCategoriaTablero, borrarCategoriaTablero, borrarMovimientoTablero, descartarTablero, detalleMovimiento, editarMovimientoTablero, renombrarCategoriaTablero, resolverEnvioSinConfirmar } from './dominio';
import { datosExplorador, personaDe, reclasificarExplorador, tienePersona } from './explorador';
import { type LectorExtracto, MAX_PDF_BYTES, lectorExtractoAnthropic, procesarExtracto } from './extracto';
import { type EventoHttp, cabecera, cuerpoTexto } from './http';
import { ErrorMedios, datosMedios, guardarMedio, guardarOrigen } from './medios';
import { MES, datosTablero, mesBogota } from './tablero';

export interface EventoRuta extends EventoHttp {
  path?: string;
  query?: Record<string, string[]>;
  request_context?: { host?: string; source_ip?: string };
}

export interface DepsTablero {
  db: () => Db;
  env: { TABLERO_CORREOS?: string; TABLERO_CODIGO?: string; TABLERO_SESION_SECRET?: string; TABLERO_PERSONAS?: string; ANTHROPIC_API_KEY?: string };
  /** Lector del extracto (las pruebas inyectan uno falso; nunca se llama a la API real). */
  lectorExtracto?: (apiKey: string) => LectorExtracto;
  dormir?: (ms: number) => Promise<void>;
  ahora?: () => number;
}

const responder = (statusCode: number, cuerpo: unknown, cookie?: string) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...(cookie ? { 'set-cookie': cookie } : {}),
  },
  body: JSON.stringify(cuerpo),
});

/**
 * Otros sitios bajo el mismo dominio padre son el mismo "site" para el navegador
 * (SameSite no los separa): solo se responde a páginas de este mismo origen.
 */
export function mismoOrigen(ev: EventoRuta): boolean {
  const host = ev.request_context?.host;
  const origen = cabecera(ev, 'origin');
  if (origen && (!host || origen !== `https://${host}`)) return false;
  const sfs = cabecera(ev, 'sec-fetch-site');
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  return true;
}

export async function manejarTablero(ev: EventoRuta, deps: DepsTablero) {
  const { env } = deps;
  const ahora = deps.ahora ?? Date.now;
  const dormir = deps.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!ev?.__evento_http) return responder(400, { error: 'solo HTTP' });
  if (!codigoConfigurado(env.TABLERO_CODIGO) || !env.TABLERO_SESION_SECRET || !env.TABLERO_CORREOS)
    return responder(503, { error: 'Tablero sin configurar' });
  if (!mismoOrigen(ev)) return responder(403, { error: 'Origen no permitido' });

  const metodo = (ev.method ?? '').toUpperCase();
  const ruta = `${metodo} ${(ev.path ?? '/').replace(/\/+$/, '') || '/'}`;
  const tokenSesion = leerCookies(cabecera(ev, 'cookie'))[COOKIE];
  let sesion = verificarSesion(tokenSesion, env.TABLERO_SESION_SECRET, env.TABLERO_CORREOS, ahora());
  // SEC-010: una sesión cerrada (o de antes de un cierre) ya no vale aunque la firma sea buena.
  if (sesion && (await sesionRevocada(deps.db(), sesion, emisionSesion(tokenSesion, env.TABLERO_SESION_SECRET)))) sesion = null;
  // SEC-012: sin persona asignada (TABLERO_PERSONAS) no hay sesión: nada se atribuye por defecto.
  if (sesion && !tienePersona(sesion, env.TABLERO_PERSONAS)) sesion = null;

  if (ruta === 'GET /sesion') return sesion ? responder(200, { correo: sesion }) : responder(401, { error: 'Sin sesión' });

  if (ruta === 'POST /logout') {
    if (sesion) await revocarSesiones(deps.db(), sesion, ahora());
    return responder(200, { ok: true }, cookieBorrada());
  }

  if (ruta === 'POST /login') {
    let cuerpo: { correo?: unknown; codigo?: unknown } = {};
    try {
      const t = cuerpoTexto(ev);
      cuerpo = t.length <= 2000 ? JSON.parse(t || '{}') : {};
    } catch {
      cuerpo = {};
    }
    const correo = normalizarCorreo(cuerpo.correo);
    const ip = (ev.request_context?.source_ip ?? '').slice(0, 64);
    const db = deps.db();
    // SEC-005: el intento se reserva ANTES de verificar; así N peticiones simultáneas no pasan todas.
    const reservados = await reservarIntento(db, correo, ip);
    const cuenta = await fallosRecientes(db, correo || '(vacío)', ip || '(sin ip)');
    if (bloqueado(cuenta)) return responder(429, { error: MENSAJE_BLOQUEO });
    await dormir(esperaMs(Math.max(cuenta.par, cuenta.ip) - 1));
    if (!credencialesValidas(correo, cuerpo.codigo, env.TABLERO_CORREOS, env.TABLERO_CODIGO!)) {
      console.warn('[tablero] intento de ingreso fallido'); // sin correo, IP ni código
      return responder(401, { error: MENSAJE_GENERICO });
    }
    await limpiarFallos(db, correo, ip, reservados);
    return responder(200, { correo }, cookieSesion(firmarSesion(correo, env.TABLERO_SESION_SECRET, ahora())));
  }

  if (ruta === 'GET /datos') {
    if (!sesion) return responder(401, { error: 'Sin sesión' });
    const pedido = ev.query?.mes?.[0];
    const mes = pedido && MES.test(pedido) ? pedido : mesBogota();
    try {
      return responder(200, await datosTablero(deps.db(), mes));
    } catch (e) {
      console.error('[tablero] error al leer datos:', (e as Error).message);
      return responder(500, { error: 'No se pudieron leer los datos' });
    }
  }

  if (ruta === 'GET /explorador/datos' || ruta === 'POST /explorador/reclasificar') {
    if (!sesion) return responder(401, { error: 'Sin sesión' });
    try {
      if (metodo === 'GET') return responder(200, await datosExplorador(deps.db()));
      let cuerpo: unknown;
      try {
        const t = cuerpoTexto(ev);
        cuerpo = t.length <= 100_000 ? JSON.parse(t || '{}') : null;
      } catch {
        return responder(400, { error: 'entrada inválida' });
      }
      const quien = { correo: sesion, persona: personaDe(sesion, env.TABLERO_PERSONAS) };
      return responder(200, await reclasificarExplorador(deps.db(), cuerpo, quien));
    } catch (e) {
      if (e instanceof ErrorDominio) return responder(e.status, { error: e.message });
      console.error('[tablero] error en el explorador:', (e as Error).message);
      return responder(500, { error: 'No se pudo completar' });
    }
  }

  if (ruta === 'POST /extracto') return cargarExtracto(ev, deps, sesion);

  // Configuración de medios de pago y sus orígenes.
  if (ruta === 'GET /medios' || ruta === 'POST /medios/origen' || ruta === 'POST /medios/medio') {
    if (!sesion) return responder(401, { error: 'Sin sesión' });
    try {
      if (metodo === 'GET') return responder(200, await datosMedios(deps.db()));
      let cuerpo: unknown;
      try {
        const t = cuerpoTexto(ev);
        cuerpo = t.length <= 5000 ? JSON.parse(t || '{}') : null;
      } catch {
        cuerpo = null;
      }
      if (!cuerpo || typeof cuerpo !== 'object') return responder(400, { error: 'entrada inválida' });
      const quien = { correo: sesion, persona: personaDe(sesion, env.TABLERO_PERSONAS) };
      return responder(200, ruta === 'POST /medios/origen' ? await guardarOrigen(deps.db(), cuerpo, quien) : await guardarMedio(deps.db(), cuerpo, quien));
    } catch (e) {
      if (e instanceof ErrorMedios || e instanceof ErrorDominio) return responder(e.status, { error: e.message });
      console.error('[tablero] error en medios de pago:', (e as Error).message);
      return responder(500, { error: 'No se pudo completar' });
    }
  }

  // Acciones de una persona desde «Por atender» y Reclasificar.
  // Detalle de una compra con el mensaje original (correo limpio o línea del extracto).
  if (ruta === 'GET /detalle') {
    if (!sesion) return responder(401, { error: 'Sin sesión' });
    const id = ev.query?.id?.[0] ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return responder(400, { error: 'entrada inválida' });
    try {
      return responder(200, await detalleMovimiento(deps.db(), id));
    } catch (e) {
      if (e instanceof ErrorDominio) return responder(e.status, { error: e.message });
      console.error('[tablero] error al leer el detalle:', (e as Error).message);
      return responder(500, { error: 'No se pudo leer el detalle' });
    }
  }

  if (ruta === 'POST /envio' || ruta === 'POST /categorias' || ruta === 'POST /revision' || ruta === 'POST /confirmar' || ruta === 'POST /fecha' || ruta === 'POST /editar' || ruta === 'POST /borrar' || ruta === 'POST /categorias/renombrar' || ruta === 'POST /categorias/borrar') {
    if (!sesion) return responder(401, { error: 'Sin sesión' });
    let cuerpo: any;
    try {
      const t = cuerpoTexto(ev);
      cuerpo = t.length <= 2000 ? JSON.parse(t || '{}') : null;
    } catch {
      cuerpo = null;
    }
    if (!cuerpo || typeof cuerpo !== 'object') return responder(400, { error: 'entrada inválida' });
    const quien = { correo: sesion, persona: personaDe(sesion, env.TABLERO_PERSONAS) };
    try {
      if (ruta === 'POST /categorias') return responder(200, await crearCategoriaTablero(deps.db(), cuerpo.nombre, quien, cuerpo.confirmar_nueva === true));
      if (ruta === 'POST /fecha') return responder(200, await cambiarFechaTablero(deps.db(), cuerpo, quien, ahora()));
      if (ruta === 'POST /editar') return responder(200, await editarMovimientoTablero(deps.db(), cuerpo, quien, ahora()));
      if (ruta === 'POST /categorias/renombrar') return responder(200, await renombrarCategoriaTablero(deps.db(), cuerpo, quien));
      if (ruta === 'POST /categorias/borrar') return responder(200, await borrarCategoriaTablero(deps.db(), cuerpo, quien));
      if (ruta === 'POST /borrar') return responder(200, await borrarMovimientoTablero(deps.db(), cuerpo, quien));
      if (ruta === 'POST /confirmar') {
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof cuerpo.movimiento_id !== 'string' || !UUID.test(cuerpo.movimiento_id) || !Number.isInteger(cuerpo.categoria_id) || cuerpo.categoria_id < 1)
          return responder(400, { error: 'entrada inválida' });
        const r: any = await confirmarTablero(deps.db(), { movimiento_id: cuerpo.movimiento_id, categoria_id: cuerpo.categoria_id }, quien);
        return responder(r.aplicado === false ? 409 : 200, r);
      }
      if (ruta === 'POST /revision') {
        const { accion, ...resto } = cuerpo;
        if (accion === 'completar') return responder(200, await atenderRevision(deps.db(), resto, quien));
        if (accion === 'descartar') return responder(200, await descartarTablero(deps.db(), resto, quien));
        return responder(400, { error: 'entrada inválida' });
      }
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (typeof cuerpo.movimiento_id !== 'string' || !UUID.test(cuerpo.movimiento_id) || !['si_llego', 'volver_a_preguntar'].includes(cuerpo.accion))
        return responder(400, { error: 'entrada inválida' });
      return responder(200, await resolverEnvioSinConfirmar(deps.db(), cuerpo.movimiento_id, cuerpo.accion, quien));
    } catch (e) {
      if (e instanceof ErrorDominio) return responder(e.status, { error: e.message });
      console.error('[tablero] error en una acción:', (e as Error).message);
      return responder(500, { error: 'No se pudo completar' });
    }
  }

  return responder(404, { error: 'No existe' });
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** POST /extracto: { pdf: "<base64>" } (máx. MAX_PDF_BYTES, debe empezar con %PDF-). */
async function cargarExtracto(ev: EventoRuta, deps: DepsTablero, sesion: string | null) {
  if (!sesion) return responder(401, { error: 'Sin sesión' });
  const llave = deps.env.ANTHROPIC_API_KEY;
  if (!llave) return responder(503, { error: 'Lector de extractos sin configurar (falta ANTHROPIC_API_KEY)' });
  let pdf: Buffer;
  try {
    const t = cuerpoTexto(ev);
    if (t.length > Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1000) return responder(413, { error: 'El PDF pasa de 8 MB' });
    const cuerpo = JSON.parse(t || '{}') as { pdf?: unknown };
    const b64 = typeof cuerpo.pdf === 'string' ? cuerpo.pdf.replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '') : '';
    if (!b64 || b64.length % 4 !== 0 || !BASE64.test(b64)) return responder(400, { error: 'Falta el PDF en base64' });
    pdf = Buffer.from(b64, 'base64');
  } catch {
    return responder(400, { error: 'entrada inválida' });
  }
  if (pdf.length > MAX_PDF_BYTES) return responder(413, { error: 'El PDF pasa de 8 MB' });
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return responder(400, { error: 'El archivo no es un PDF' });
  try {
    const lector = (deps.lectorExtracto ?? lectorExtractoAnthropic)(llave);
    return responder(200, await procesarExtracto(deps.db(), pdf, lector, sesion, new Date((deps.ahora ?? Date.now)())));
  } catch (e) {
    if (e instanceof ErrorDominio) return responder(e.status, { error: e.message });
    console.error('[tablero] error al cargar el extracto:', (e as Error).message); // sin datos del PDF ni la llave
    return responder(502, { error: 'No se pudo leer el extracto. Intenta de nuevo.' });
  }
}
