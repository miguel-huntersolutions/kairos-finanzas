// Acceso al tablero con correo + código.
// - El código vive solo en la variable TABLERO_CODIGO; se compara en tiempo constante
//   y nunca se registra, se guarda ni se devuelve. Formato: 6 a 32 letras o dígitos
//   (recomendado: 12 o más; el código sigue siendo válido por compatibilidad).
// - Bloqueo (SEC-005/009): cada intento se RESERVA en la base antes de verificar y cuenta
//   contra dos límites: por par correo+IP y por IP. Más de MAX_FALLOS en 15 minutos bloquea.
//   Un tercero desde otra IP no puede bloquear el correo de la persona autorizada.
// - Espera creciente antes de verificar si ya hubo intentos.
// - Sesión: cookie __Host-, HttpOnly, Secure, SameSite=Lax, firmada con HMAC-SHA256
//   (TABLERO_SESION_SECRET), 30 días. Cerrar sesión la revoca (SEC-010): se guarda una marca
//   de tiempo por correo y las sesiones emitidas antes de ella dejan de valer.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db';

export const MAX_FALLOS = 5;
export const VENTANA_MIN = 15;
export const SESION_DIAS = 30;
export const COOKIE = '__Host-tablero_sesion';
export const MENSAJE_GENERICO = 'Correo o código incorrecto';
export const MENSAJE_BLOQUEO = 'Demasiados intentos. Intenta de nuevo en 15 minutos.';

/** Formato aceptado para el código del tablero (y para lo que escribe la persona). */
export const CODIGO_FORMATO = /^[A-Za-z0-9]{6,32}$/;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Comparación en tiempo constante (sobre hashes del mismo largo). */
export function igualSeguro(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

export const codigoConfigurado = (c: string | undefined): c is string => !!c && CODIGO_FORMATO.test(c);

export function normalizarCorreo(c: unknown): string {
  return typeof c === 'string' ? c.trim().toLowerCase().slice(0, 254) : '';
}

/**
 * ¿Correo permitido y código correcto? Siempre evalúa las dos partes (sin cortocircuito)
 * para que el tiempo de respuesta no delate cuál falló.
 */
export function credencialesValidas(correo: string, codigo: unknown, lista: string | undefined, esperado: string): boolean {
  const permitidos = (lista ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  let correoOk = false;
  for (const p of permitidos) correoOk = igualSeguro(p, correo) || correoOk;
  const dado = typeof codigo === 'string' && CODIGO_FORMATO.test(codigo) ? codigo : '------';
  const codigoOk = igualSeguro(dado, esperado);
  return correoOk && codigoOk;
}

// ─────────────── Bloqueo y espera ───────────────

/** Clave del par correo+IP. JSON evita ambigüedad con separadores dentro del correo. */
export const clavePar = (correo: string, ip: string) => JSON.stringify([correo, ip]);

/**
 * Reserva un intento ANTES de verificar el código (SEC-005: evita que N peticiones simultáneas
 * vean 0 fallos). Un intento correcto se descuenta después con limpiarFallos.
 */
export async function reservarIntento(db: Db, correo: string, ip: string): Promise<number[]> {
  const c = correo || '(vacío)';
  const i = ip || '(sin ip)';
  // Tres conteos: por IP, por par correo+IP y global por correo (freno a fuerza bruta distribuida).
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO tablero_intentos (tipo, clave) VALUES ('ip', $1), ('correo', $2), ('correo', $3) RETURNING id`,
    [i, c, clavePar(c, i)],
  );
  // Limpieza de registros viejos (no hacen falta para el bloqueo).
  await db.query(`DELETE FROM tablero_intentos WHERE creado_en < now() - interval '30 days'`);
  return rows.map((r) => Number(r.id));
}

/** Intentos recientes (incluido el reservado): por IP, por par correo+IP y global del correo. */
export async function fallosRecientes(db: Db, correo: string, ip: string): Promise<{ par: number; ip: number; correo: number }> {
  const c = correo || '(vacío)';
  const i = ip || '(sin ip)';
  const { rows } = await db.query<{ tipo: string; clave: string; n: number }>(
    `SELECT tipo, clave, count(*)::int AS n FROM tablero_intentos
     WHERE creado_en > now() - make_interval(mins => $4)
       AND ((tipo = 'correo' AND clave IN ($1, $3)) OR (tipo = 'ip' AND clave = $2))
     GROUP BY tipo, clave`,
    [c, i, clavePar(c, i), VENTANA_MIN],
  );
  const n = (f: (r: { tipo: string; clave: string }) => boolean) => rows.filter(f).reduce((s, r) => s + r.n, 0);
  return {
    par: n((r) => r.tipo === 'correo' && r.clave !== c),
    ip: n((r) => r.tipo === 'ip'),
    correo: n((r) => r.tipo === 'correo' && r.clave === c),
  };
}

/** Límite global por correo (SEC-009: alto, para no dejar que un tercero bloquee el correo con pocos intentos). */
export const MAX_FALLOS_CORREO = 20;

/** Bloquea cuando el intento reservado supera el máximo (el intento número MAX_FALLOS+1 ya no verifica). */
export const bloqueado = (f: { par: number; ip: number; correo: number }) =>
  f.par > MAX_FALLOS || f.ip > MAX_FALLOS || f.correo > MAX_FALLOS_CORREO;

/** Espera creciente (ms) según los intentos previos: 0, 0.5, 1, 2, 4 s. */
export function esperaMs(fallos: number): number {
  return fallos <= 0 ? 0 : Math.min(4000, 500 * 2 ** (fallos - 1));
}

/**
 * Ingreso correcto: borra los fallos previos del par correo+IP y las filas que reservó este
 * mismo intento (IP, correo global y par). Así un acierto no cuenta contra el límite (SEC-005/009).
 */
export async function limpiarFallos(db: Db, correo: string, ip: string, reservados: number[]): Promise<void> {
  await db.query(`DELETE FROM tablero_intentos WHERE tipo = 'correo' AND clave = $1`, [clavePar(correo || '(vacío)', ip || '(sin ip)')]);
  if (reservados.length) await db.query(`DELETE FROM tablero_intentos WHERE id = ANY($1::bigint[])`, [reservados]);
}

// ─────────────── Sesión firmada ───────────────

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function firmarSesion(correo: string, secreto: string, ahora = Date.now()): string {
  const carga = b64(JSON.stringify({ c: correo, e: ahora + SESION_DIAS * 86_400_000, i: ahora }));
  const firma = b64(createHmac('sha256', secreto).update(`v1.${carga}`).digest());
  return `v1.${carga}.${firma}`;
}

/** Carga de una sesión con firma válida (sin mirar vigencia ni revocación), o null. */
function cargaSesion(token: string | undefined, secreto: string): { c: string; e: number; i?: number } | null {
  if (!token || !secreto) return null;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return null;
  const esperada = createHmac('sha256', secreto).update(`v1.${partes[1]}`).digest();
  let dada: Buffer;
  try {
    dada = Buffer.from(partes[2], 'base64url');
  } catch {
    return null;
  }
  if (dada.length !== esperada.length || !timingSafeEqual(dada, esperada)) return null;
  let carga: { c?: unknown; e?: unknown; i?: unknown };
  try {
    carga = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof carga.c !== 'string' || typeof carga.e !== 'number') return null;
  return { c: carga.c, e: carga.e, i: typeof carga.i === 'number' ? carga.i : undefined };
}

/** Devuelve el correo de una sesión válida, vigente y aún autorizada; si no, null. */
export function verificarSesion(token: string | undefined, secreto: string, lista: string | undefined, ahora = Date.now()): string | null {
  const carga = cargaSesion(token, secreto);
  if (!carga || carga.e <= ahora) return null;
  const permitidos = (lista ?? '').split(',').map((c) => c.trim().toLowerCase());
  return permitidos.includes(carga.c) ? carga.c : null;
}

/** Momento en que se emitió una sesión con firma válida (o null). Para revocaciones. */
export function emisionSesion(token: string | undefined, secreto: string): number | null {
  return cargaSesion(token, secreto)?.i ?? null;
}

// ─────────────── Revocación (SEC-010) ───────────────

const claveRevocacion = (correo: string) => `tablero_sesion_minima:${correo}`;

/** Sesiones de ese correo emitidas en este instante o antes dejan de valer. */
export async function revocarSesiones(db: Db, correo: string, ahora = Date.now()): Promise<void> {
  await db.query(
    `INSERT INTO config (clave, valor) VALUES ($1, $2::jsonb)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [claveRevocacion(correo), JSON.stringify(ahora)],
  );
}

/** ¿La sesión fue emitida antes de la última revocación de su correo? */
export async function sesionRevocada(db: Db, correo: string, emitida: number | null): Promise<boolean> {
  const { rows } = await db.query<{ valor: unknown }>(`SELECT valor FROM config WHERE clave = $1`, [claveRevocacion(correo)]);
  const minima = Number(rows[0]?.valor ?? 0);
  if (!minima) return false;
  // Sesiones anteriores a este cambio (sin marca de emisión) también se consideran revocadas.
  return emitida === null || emitida <= minima;
}

export const cookieSesion = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESION_DIAS * 86_400}`;
export const cookieBorrada = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function leerCookies(cabecera: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) r[parte.slice(0, i).trim()] = parte.slice(i + 1).trim();
  }
  return r;
}
