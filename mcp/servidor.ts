// finanzas-mcp: única interfaz del agente Kairos Finanzas con el servidor (stdio).
// Esquemas estrictos (Zod) que orientan al modelo; el servidor repite la validación.
// `preguntar`, `reasignar_pregunta` y `recordar` además ENVÍAN el mensaje por
// WhatsApp con el CLI de OpenClaw (el destino lo decide el servidor, no el modelo).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { z } from 'zod';
import { ESQUEMAS, ESQUEMA_MCP_REVISAR_CAPTURA, type Herramienta } from '../src/lib/esquemas';

const exec = promisify(execFile);

export interface Config {
  urls: Partial<Record<Herramienta, string>>;
  token: string;
  modelo?: string;
  enviar: (target: string, mensaje: string) => Promise<string>;
  fetch?: typeof fetch;
  /** Carpeta de adjuntos de OpenClaw: `revisar_captura` solo lee archivos de aquí. */
  mediaDir?: string;
}

/** Lee el token de un archivo chmod 600 (nunca del workspace del agente). */
export function configDesdeEntorno(env = process.env): Config {
  const token = env.FINANZAS_API_TOKEN_FILE ? readFileSync(env.FINANZAS_API_TOKEN_FILE, 'utf8').trim() : env.FINANZAS_API_TOKEN ?? '';
  if (!token) throw new Error('falta FINANZAS_API_TOKEN_FILE');
  const urls = env.FINANZAS_URLS_FILE ? JSON.parse(readFileSync(env.FINANZAS_URLS_FILE, 'utf8')) : {};
  if (env.FINANZAS_URL_PLANTILLA)
    for (const h of Object.keys(ESQUEMAS) as Herramienta[])
      urls[h] ??= env.FINANZAS_URL_PLANTILLA.replace('{nombre}', h.replaceAll('_', '-'));
  const bin = env.OPENCLAW_BIN ?? 'openclaw';
  return {
    urls,
    token,
    modelo: env.FINANZAS_MODELO,
    mediaDir: env.FINANZAS_MEDIA_DIR || MEDIA_DIR,
    async enviar(target, mensaje) {
      const args = ['message', 'send', '--channel', 'whatsapp', '--target', target, '-m', mensaje, '--json'];
      if (env.FINANZAS_WHATSAPP_ACCOUNT) args.push('--account', env.FINANZAS_WHATSAPP_ACCOUNT);
      const { stdout } = await exec(bin, args, { timeout: 30_000 });
      return idDeMensaje(stdout);
    },
  };
}

export function idDeMensaje(stdout: string): string {
  try {
    const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
    const id = j.messageId ?? j.id ?? j.result?.messageId ?? j.result?.id ?? j.message?.id;
    if (id) return String(id);
  } catch {}
  return `sin-id-${Date.now()}`;
}

/** Vercel rechazó la llamada (4xx): no se aplicó nada. */
export class ErrorRechazo extends Error {}
/** Falla de red, vencimiento o 5xx tras el reintento: no se sabe si se aplicó. */
export class ErrorIncierto extends Error {}

/** Herramientas que solo leen: se reintentan sin operacion_id. */
const SOLO_LECTURA = new Set<Herramienta>(['resumen', 'repaso', 'pendientes', 'reembolsos']);

/** URL de la herramienta; si falta en urls.json, se deriva de otra con el mismo patrón /api/<nombre>. */
export function urlDe(cfg: Config, h: Herramienta): string {
  const directa = cfg.urls[h];
  if (directa) return directa;
  const base = cfg.urls.confirmar_envio ?? Object.values(cfg.urls).find(Boolean);
  if (!base) throw new Error(`sin URL para ${h}`);
  return base.replace(/[^/]+\/?$/, h.replaceAll('_', '-'));
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama una herramienta de Vercel. Cada escritura lleva un `operacion_id`: si la llamada vence
 * después de aplicarse, el reintento (uno solo, con el mismo id) devuelve el resultado original
 * sin aplicar nada otra vez. 4xx → ErrorRechazo (no se aplicó). Red/5xx tras reintento → ErrorIncierto.
 */
export async function llamar(cfg: Config, h: Herramienta, entrada: unknown, opciones: { operacion_id?: string; esperaMs?: number; timeoutMs?: number } = {}): Promise<any> {
  const url = urlDe(cfg, h);
  const operacion_id = SOLO_LECTURA.has(h) ? undefined : opciones.operacion_id ?? randomUUID();
  const cuerpoPeticion = JSON.stringify({ entrada, contexto: cfg.modelo ? { modelo: cfg.modelo } : {}, ...(operacion_id ? { operacion_id } : {}) });
  let ultimo = '';
  for (let intento = 0; intento < 2; intento++) {
    if (intento > 0) await dormir(opciones.esperaMs ?? 1500);
    let r: Response;
    try {
      r = await (cfg.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: cuerpoPeticion,
        signal: AbortSignal.timeout(opciones.timeoutMs ?? 20_000),
      });
    } catch (e) {
      ultimo = `${h}: sin respuesta (${(e as Error).name})`;
      continue;
    }
    const cuerpo = (await r.json().catch(() => ({}))) as any;
    if (r.ok) return cuerpo;
    if (r.status === 409 && cuerpo.en_curso) {
      ultimo = `${h}: la operación sigue en curso`;
      continue;
    }
    if (r.status < 500) throw new ErrorRechazo(`${h}: ${r.status} ${cuerpo.error ?? ''}`.trim());
    ultimo = `${h}: ${r.status}`;
  }
  throw new ErrorIncierto(ultimo);
}

/** Confirma un envío ya hecho. Nunca reenvía el mensaje: solo repite la confirmación. */
async function confirmarTrasEnvio(cfg: Config, h: 'confirmar_envio' | 'confirmar_recordatorio', entrada: Record<string, string>) {
  const operacion_id = randomUUID();
  for (let ronda = 0; ; ronda++) {
    try {
      return await llamar(cfg, h, entrada, { operacion_id });
    } catch (e) {
      if (e instanceof ErrorRechazo || ronda >= 1) throw e;
      await dormir(3000);
    }
  }
}

// Regla común: el usuario NUNCA da ids. Sin movimiento_id, pasa `referencia` con lo que dijo
// ("la de 147.750", "Farmatodo", "la última") y el servidor resuelve. Si la respuesta trae
// aplicado=false, NO se registró nada: muestra `opciones` numeradas (sin ids) y pregunta.
const DESCRIPCIONES: Record<Herramienta, string> = {
  tomar_movimiento: 'Toma un movimiento por preguntar (transición atómica). Si devuelve tomado=false, otro proceso lo tomó: termina. Luego llama preguntar SIN texto.',
  preguntar: 'Envía "¿De qué fue?" con 2–3 categorías numeradas. Omite texto: el servidor arma la pregunta, decide el destino y agrega el código. ÚLTIMA llamada del turno: tras ella responde FIN.',
  confirmar_envio: 'Uso interno.',
  recordar: 'Envía el recordatorio de una pregunta abierta (solo tras el evento recordatorio). SIN texto: el servidor lo arma. Tras ella, FIN.',
  confirmar_recordatorio: 'Uso interno.',
  pendientes: '«¿Qué me falta por responder?»: compras que esperan respuesta de quien escribe y las del grupo. Pasa numero_remitente. Muestra la lista tal cual (código y descripción).',
  resolver_respuesta: 'Opcional: a qué compra corresponde una respuesta (cita, código, valor o comercio mencionado, o única pendiente). Pasa numero_remitente. Si hay varias, muestra `lista` numerada.',
  reasignar_pregunta: 'Mueve la pregunta al chat privado de la otra persona ("no fui yo, pregúntale a Kati"). Usa referencia si no tienes el id.',
  clasificar: 'Registra de qué fue una compra. Pasa numero_remitente (número de WhatsApp de quien escribe), canal y categoria con lo que dijo ("1", "mercado", "droguería"); referencia solo si mencionó cuál compra. persona solo si el mensaje nombra a otra persona. Éxito solo si aplicado=true.',
  cambiar_cuotas: 'Cambia el número de cuotas (1–48). Usa referencia si no tienes el id.',
  descartar_movimiento: 'Descarta (rechazada, reversada, duplicada, no_reconocida, otro) con referencia en texto libre. duplicada solo procede si hay otra compra igual (valor, fecha, tarjeta); si no, devuelve sin_duplicado. no_reconocida alerta a los dos.',
  proponer_regla: 'Propone una regla de comercio (nace en propuesta; bloqueada para comercios genéricos).',
  crear_categoria: 'Crea una categoría (sin aprobación). Primero valida similitud: si hay parecidas NO la crea y devuelve `parecidas`; pregunta si usa una de esas o la nueva, y solo con un "la nueva" vuelve a llamar con confirmar_nueva: true. Pasa numero_remitente.',
  reclasificar: 'Dos fases: dry_run=true devuelve cantidad, muestra y token. Si son más del umbral, pedir "sí" en el grupo y llamar con token y aprobado_por.',
  resumen: 'Cifras del mes calculadas en SQL. Nunca hagas cuentas tú.',
  repaso: 'Datos del repaso dominical: categorías y reglas propuestas, movimientos en revisión.',
  confirmar_repaso: 'Confirma en lote categorías y reglas tras el "sí" de Miguel o Katerine.',
  modo_preguntas: 'por_comercio (usa reglas) o siempre (pregunta todo).',
  enviar_detalle: 'Envía al chat el detalle de una compra con el mensaje original del banco (lo arma y envía el servidor; tú no lo ves). Pasa referencia con lo que dijo la persona, numero_remitente y canal.',
  aviso_corte: 'Solo tras el evento corte del hook: envía el aviso de corte de la tarjeta (el servidor arma el texto y el destino). Tras ella, FIN.',
  revisar_captura: 'Revisa una captura, PDF, Excel o CSV de movimientos de la app del banco y dice cuáles faltan. Pasa en archivo la ruta del adjunto tal como aparece en el mensaje ([media attached: …]), numero_remitente, canal y tarjeta solo si la persona la dijo. Tú no lees el archivo. Publica `texto` tal cual. Una sola vez por archivo.',
  cargar_faltantes: 'Carga las compras que faltan de una revisión (#R..), SOLO tras un «sí» explícito de Miguel o Katerine. numeros solo si dijo cuáles («solo la 1,3»); correcciones [{n, categoria?, tarjeta?}] para «la 2 es salud» o «la 3 es de la Mastercard»; tarjeta si dijo una para todas. Publica `texto` tal cual.',
  registrar_gasto: 'Registra UN gasto contado por chat. Pasa valor en pesos, descripcion, medio (con qué pagó, como lo dijo: "efectivo", "PSE", "débito Bancolombia", "NU Kate"), medio_pago solo si dijo cómo (transferencia, bre_b), categoria con lo que dijo, fecha (aaaa-mm-dd) solo si dijo otro día, numero_remitente y canal. Si falta un dato devuelve aplicado:false con `opciones`: pregunta y vuelve a llamar. NUNCA para pagos de tarjeta, retiros, ahorros o movimientos entre cuentas o entre ustedes. Publica `mensaje` tal cual.',
  registrar_gastos: 'Varios gastos de UN mensaje en una sola llamada (`gastos`: lista con los mismos campos de registrar_gasto). Publica `texto` tal cual y pregunta solo lo que falte de los ✗.',
  registrar_ingreso: 'Registra un INGRESO contado por chat (nómina, reembolso de la empresa, otro). Pasa valor en pesos, descripcion, tipo solo si lo dijo claro (salario, reembolso, otro), fecha (aaaa-mm-dd) solo si dijo otro día, persona solo si lo recibió la otra persona, numero_remitente y canal. Si falta el tipo devuelve aplicado:false con `opciones`: pregunta y vuelve a llamar. NUNCA para traslados entre cuentas, retiros, préstamos o plata entre ustedes. Publica `mensaje` (o `texto` si viene) tal cual.',
  asociar_reembolso: 'Tras un reembolso que no cuadró: asocia las compras reembolsables que la persona dijo («la 1 y la 3») con `numeros` de la lista que se publicó. Publica `mensaje` tal cual.',
  reembolsos: '«¿Cuánto nos debe la empresa?»: compras reembolsables pendientes de pago. Publica `texto` tal cual.',
  descartar_ingreso: 'Deshace un ingreso mal registrado. Pasa `referencia` con lo que dijo («la nómina», «el de 4.000.000», «el último») y numero_remitente. Para corregir un ingreso: descártalo y regístralo de nuevo. Publica `mensaje` tal cual.',
  editar_movimiento: 'Corrige una compra ya registrada: fecha, valor, descripcion, medio, categoria, persona o nota. Pasa `referencia` con lo que dijo ("el arriendo", "la última") y solo los campos que cambian. Nunca descartes y vuelvas a registrar para corregir. Publica `mensaje` tal cual.',
};

// ───────────────────────────── archivos de revisar_captura ─────────────────────────────

/** Carpeta donde OpenClaw deja los adjuntos de WhatsApp. */
export const MEDIA_DIR = '/root/.openclaw/media/inbound';
/** Tope del archivo: en base64 debe caber en el cuerpo de Vercel (~4,5 MB). */
export const MAX_ARCHIVO_MCP = 3_300_000;
const MIME_POR_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv',
};

/**
 * OpenClaw copia cada adjunto a una carpeta temporal del workspace del agente que lo recibe
 * (`workspace-<agente>/media/inbound/openclaw-staged-<id>/input-<archivo>`) y le da esa ruta al modelo.
 * Solo se admite ese patrón exacto: un archivo directo dentro de una carpeta openclaw-staged-*.
 */
const COPIA_OPENCLAW = /^\/root\/\.openclaw\/workspace-(finanzas|personal)\/media\/inbound\/openclaw-staged-[^/]+\/[^/]+$/;
export function esCopiaDeOpenClaw(ruta: string): boolean {
  return COPIA_OPENCLAW.test(ruta);
}

/**
 * Lee el adjunto con guardas: la ruta real (sin enlaces simbólicos) debe quedar dentro de la
 * carpeta de adjuntos, sin `..`; solo jpg, jpeg, png, webp, pdf, xlsx o csv; máximo 3,3 MB.
 * Acepta la ruta como la muestra el mensaje (con o sin « (image/jpeg)» al final) o solo el nombre.
 */
export async function leerAdjunto(archivo: string, carpeta = MEDIA_DIR): Promise<{ nombre: string; mime: string; bytes: Buffer }> {
  const limpio = archivo.trim().replace(/^\[?media attached:\s*/i, '').replace(/\s*\(([a-z]+\/[\w.+-]+)\).*$/i, '').replace(/\s*\|.*$/, '').trim();
  if (!limpio || limpio.includes('\0')) throw new ErrorRechazo('revisar_captura: ruta de archivo vacía');
  if (limpio.split(/[\\/]/).includes('..')) throw new ErrorRechazo('revisar_captura: la ruta no puede tener «..»');
  let base: string;
  let real: string;
  try {
    base = await realpath(carpeta);
  } catch {
    throw new ErrorRechazo('revisar_captura: la carpeta de adjuntos no existe');
  }
  const pedido = isAbsolute(limpio) ? limpio : resolve(base, limpio);
  try {
    real = await realpath(pedido);
  } catch {
    throw new ErrorRechazo('revisar_captura: no encontré el archivo adjunto');
  }
  if (!real.startsWith(base + sep) && !esCopiaDeOpenClaw(real)) throw new ErrorRechazo('revisar_captura: solo leo adjuntos de la carpeta de WhatsApp');
  const ext = extname(real).toLowerCase();
  const mime = MIME_POR_EXTENSION[ext];
  if (!mime || extname(pedido).toLowerCase() !== ext) throw new ErrorRechazo('revisar_captura: solo acepto jpg, png, webp, pdf, xlsx o csv');
  const info = await stat(real);
  if (!info.isFile()) throw new ErrorRechazo('revisar_captura: la ruta no es un archivo');
  if (info.size > MAX_ARCHIVO_MCP)
    throw new ErrorRechazo(`revisar_captura: el archivo pesa ${(info.size / 1e6).toFixed(1)} MB y el máximo es ${(MAX_ARCHIVO_MCP / 1e6).toFixed(1)} MB; manda una captura más liviana o el Excel`);
  const f = await open(real, 'r');
  try {
    const bytes = await f.readFile();
    if (bytes.length > MAX_ARCHIVO_MCP) throw new ErrorRechazo('revisar_captura: el archivo es demasiado grande');
    return { nombre: basename(real).slice(0, 200), mime, bytes };
  } finally {
    await f.close();
  }
}

const texto = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });

/** Esquema que ve el modelo (en revisar_captura, la ruta del adjunto en vez del contenido). */
const esquemaModelo = (h: Herramienta) => (h === 'revisar_captura' ? ESQUEMA_MCP_REVISAR_CAPTURA : ESQUEMAS[h]) as z.ZodObject<any>;

export async function ejecutar(cfg: Config, h: Herramienta, args: unknown) {
  const e = esquemaModelo(h).parse(args) as any; // validación estricta también aquí
  if (h === 'revisar_captura') {
    // El modelo solo da la ruta: el MCP lee el archivo y lo manda; el contenido nunca vuelve al modelo.
    const a = await leerAdjunto(e.archivo, cfg.mediaDir ?? MEDIA_DIR);
    const entrada = {
      archivo_nombre: a.nombre, mime: a.mime, contenido_base64: a.bytes.toString('base64'),
      numero_remitente: e.numero_remitente, canal: e.canal, ...(e.tarjeta ? { tarjeta: e.tarjeta } : {}),
    };
    const p = await llamar(cfg, h, entrada, { timeoutMs: 90_000 });
    return { codigo: p.codigo, texto: p.texto, repetido: p.repetido, instruccion: p.instruccion };
  }
  if (h === 'preguntar' || h === 'reasignar_pregunta') {
    const p = await llamar(cfg, h, e);
    if (p.aplicado === false) return p; // referencia ambigua o sin coincidencias: nada se envía
    let waId: string;
    try {
      waId = await cfg.enviar(p.target, p.mensaje);
    } catch {
      // No se sabe si el mensaje salió: no se reintenta el envío. La compra queda en «Por atender».
      throw new ErrorIncierto('no se pudo confirmar el envío de la pregunta');
    }
    const movimiento_id = p.movimiento_id ?? e.movimiento_id;
    await confirmarTrasEnvio(cfg, 'confirmar_envio', { movimiento_id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: waId });
    return `Enviado (#${p.pregunta_codigo}). FIN`;
  }
  if (h === 'enviar_detalle') {
    const p = await llamar(cfg, h, e);
    if (p.aplicado === false) return p; // ambigua o sin coincidencias: muestra las opciones
    try {
      await cfg.enviar(p.target, p.mensaje);
    } catch {
      throw new ErrorIncierto('no se pudo confirmar el envío del detalle');
    }
    // El texto del correo NO vuelve al modelo: solo la confirmación.
    return `Detalle enviado al chat (${p.movimiento}). No lo repitas ni lo resumas. FIN`;
  }
  if (h === 'aviso_corte') {
    const p = await llamar(cfg, h, e);
    await cfg.enviar(p.target, p.mensaje);
    return 'Aviso de corte enviado. FIN';
  }
  if (h === 'recordar') {
    const p = await llamar(cfg, h, { movimiento_id: e.movimiento_id });
    let waId: string;
    try {
      waId = await cfg.enviar(p.target, p.mensaje);
    } catch {
      throw new ErrorIncierto('no se pudo confirmar el envío del recordatorio; el cron lo reintenta');
    }
    await confirmarTrasEnvio(cfg, 'confirmar_recordatorio', { movimiento_id: e.movimiento_id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: waId });
    return 'Recordatorio enviado. FIN';
  }
  return llamar(cfg, h, e);
}

/** Respuesta de error para el agente: corta, con qué hacer, sin detalles internos. */
export function errorParaAgente(err: unknown) {
  if (err instanceof ErrorIncierto)
    return { error: err.message, tipo: 'incierto', instruccion: 'No sé si quedó registrado. NO repitas la llamada. Dile a la persona que no pudiste confirmar el registro y que queda para revisar en el tablero.' };
  if (err instanceof ErrorRechazo)
    return { error: err.message, tipo: 'rechazado', instruccion: 'No se registró nada. Explícalo en una frase y no repitas la misma llamada.' };
  if (err && typeof err === 'object' && 'issues' in err)
    return { error: 'entrada inválida', tipo: 'entrada_invalida', instruccion: 'Revisa los campos según el esquema y vuelve a intentar una sola vez.' };
  return { error: (err as Error)?.message ?? 'error', tipo: 'incierto', instruccion: 'No sé si quedó registrado. NO repitas la llamada.' };
}

/**
 * Diagnóstico de una sola vez: qué trae `_meta` en tools/call (¿OpenClaw pasa el remitente?).
 * Solo claves y tipos, con los dígitos enmascarados: nunca valores completos.
 */
let metaRegistrado = false;
export function describirMeta(meta: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((meta as Record<string, unknown>) ?? {}))
    out[k] = typeof v === 'string' ? `string(${v.length}) ${v.replace(/\d/g, '•').slice(0, 24)}` : typeof v;
  return out;
}

export function crearServidor(cfg: Config) {
  const server = new McpServer({ name: 'finanzas-mcp', version: '0.3.0' });
  for (const h of Object.keys(ESQUEMAS) as Herramienta[]) {
    if (h === 'confirmar_envio' || h === 'confirmar_recordatorio') continue; // las hace el propio MCP tras enviar
    const esquema = esquemaModelo(h);
    server.registerTool(
      h,
      { description: DESCRIPCIONES[h], inputSchema: esquema.shape },
      async (args: unknown, extra: any) => {
        if (!metaRegistrado) {
          metaRegistrado = true;
          console.error(`[finanzas-mcp] _meta en tools/call: ${JSON.stringify(describirMeta(extra?._meta))}`);
        }
        try {
          return texto(await ejecutar(cfg, h, args));
        } catch (err) {
          return { ...texto(errorParaAgente(err)), isError: true };
        }
      },
    );
  }
  return server;
}

if (require.main === module) {
  crearServidor(configDesdeEntorno())
    .connect(new StdioServerTransport())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
