// Envíos sin duplicar y escrituras idempotentes (flujos 2 y 3 del diseño):
// - una pregunta preparada cuyo envío no se confirmó NO se vuelve a avisar;
// - el MCP nunca reenvía: solo repite la confirmación;
// - operacion_id: un reintento devuelve el resultado original sin aplicar otra vez;
// - errores del MCP separados en «rechazado» e «incierto».
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Config, ErrorIncierto, ErrorRechazo, describirMeta, ejecutar, errorParaAgente, llamar, urlDe,
} from '../mcp/servidor';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import type { Herramienta } from '../src/lib/esquemas';
import { ejecutarHerramienta } from '../src/lib/http';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function compra(ef: d.Efectos, valor = '12.000') {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `envio-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', valor),
  });
  return r.movimiento_id!;
}

/** MCP de prueba contra el dominio real; `fallas` permite simular red o 5xx por herramienta. */
function mcp(ef: d.Efectos, opciones: { enviar?: Config['enviar']; fallas?: Partial<Record<Herramienta, Array<'red' | 'despues' | 500>>> } = {}) {
  const llamadas: Array<{ h: Herramienta; operacion_id?: string }> = [];
  const enviados: Array<[string, string]> = [];
  const cfg: Config = {
    token: 't',
    urls: { confirmar_envio: 'http://vercel/api/confirmar-envio' },
    enviar: opciones.enviar ?? (async (target, mensaje) => (enviados.push([target, mensaje]), `wa-${enviados.length}`)),
    fetch: (async (url: string, init: any) => {
      const h = url.split('/').pop()!.replaceAll('-', '_') as Herramienta;
      const { entrada, contexto, operacion_id } = JSON.parse(init.body);
      llamadas.push({ h, operacion_id });
      const falla = opciones.fallas?.[h]?.shift();
      if (falla === 'red') throw new TypeError('fetch failed');
      if (falla === 500) return new Response('{"error":"error interno"}', { status: 500 });
      const r = await ejecutarHerramienta(h, entrada, contexto, db, ef, operacion_id);
      if (falla === 'despues') throw new DOMException('vencida', 'TimeoutError'); // se aplicó, pero no llegó la respuesta
      return new Response(r.body, { status: r.statusCode });
    }) as any,
  };
  return { cfg, llamadas, enviados };
}
const espera = { esperaMs: 0 };
const mov = async (id: string) => (await db.query('SELECT * FROM movimientos WHERE id = $1', [id])).rows[0];

describe('pregunta duplicada', () => {
  it('envío sin confirmar: el respaldo libera pero NO vuelve a avisar; una confirmación tardía la cierra', async () => {
    const { ef, hooks } = efectosFalsos();
    const id = await compra(ef);
    await d.tomarMovimiento(db, { movimiento_id: id });
    const p = await d.preguntar(db, { movimiento_id: id });
    await db.query(`UPDATE movimientos SET en_proceso_hasta = now() - interval '1 minute'`);
    hooks.length = 0;
    const r1 = await d.respaldo(db, ef);
    expect(r1.atascados[0].motivo).toMatch(/envío no se confirmó/);
    await db.query(`UPDATE movimientos SET actualizado_en = now() - interval '5 minutes'`);
    expect((await d.respaldo(db, ef)).avisos).toBe(0);
    expect(hooks).toHaveLength(0);
    // El mensaje sí había salido: la confirmación tardía se acepta desde por_preguntar.
    await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: 'wa-tarde' });
    expect(await mov(id)).toMatchObject({ estado: 'esperando_respuesta', whatsapp_message_id: 'wa-tarde' });
  });

  it('el MCP reintenta solo confirmar_envio: un solo mensaje, aunque la confirmación falle una vez', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const { cfg, enviados, llamadas } = mcp(ef, { fallas: { confirmar_envio: [500, 'red'] } });
    await ejecutar(cfg, 'tomar_movimiento', { movimiento_id: id });
    const fin = await ejecutar(cfg, 'preguntar', { movimiento_id: id });
    expect(fin).toMatch(/^Enviado \(#[A-Z0-9]+\)\. FIN$/);
    expect(enviados).toHaveLength(1);
    const confirmaciones = llamadas.filter((l) => l.h === 'confirmar_envio');
    expect(confirmaciones.length).toBe(3);
    expect(new Set(confirmaciones.map((c) => c.operacion_id)).size).toBe(1); // mismo operacion_id
    expect((await mov(id)).estado).toBe('esperando_respuesta');
  });

  it('si el envío falla, no confirma ni reenvía: error incierto y la compra queda para el respaldo', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const { cfg, llamadas } = mcp(ef, { enviar: async () => { throw new Error('openclaw: timeout'); } });
    await ejecutar(cfg, 'tomar_movimiento', { movimiento_id: id });
    await expect(ejecutar(cfg, 'preguntar', { movimiento_id: id })).rejects.toBeInstanceOf(ErrorIncierto);
    expect(llamadas.some((l) => l.h === 'confirmar_envio')).toBe(false);
    expect((await mov(id)).estado).toBe('en_proceso');
  });
});

describe('recordatorio por el MCP', () => {
  it('texto del servidor, un envío y recibo con el id del mensaje', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const { cfg, enviados } = mcp(ef);
    await ejecutar(cfg, 'tomar_movimiento', { movimiento_id: id });
    await ejecutar(cfg, 'preguntar', { movimiento_id: id });
    expect(await ejecutar(cfg, 'recordar', { movimiento_id: id, texto: 'el modelo no redacta esto' })).toBe('Recordatorio enviado. FIN');
    expect(enviados[1][1]).toMatch(/^Recordatorio: ¿De qué fue esta compra/);
    expect(enviados[1][1]).not.toContain('el modelo no redacta');
    expect((await mov(id)).recordado).toBe(true);
  });
});

describe('operacion_id', () => {
  it('la llamada venció después de aplicarse: el reintento devuelve lo original y no clasifica otra compra', async () => {
    const { ef } = efectosFalsos();
    const a = await compra(ef, '11.000');
    const b = await compra(ef, '22.000');
    const { cfg } = mcp(ef, { fallas: { clasificar: ['despues'] } });
    for (const id of [a, b]) {
      await ejecutar(cfg, 'tomar_movimiento', { movimiento_id: id });
      await ejecutar(cfg, 'preguntar', { movimiento_id: id });
    }
    const r = await llamar(cfg, 'clasificar', { movimiento_id: a, categoria: 'mercado', numero_remitente: '+570000000001', canal: 'grupo' }, espera);
    expect(r.aplicado).toBe(true);
    expect((await mov(a)).estado).toBe('confirmado');
    expect((await mov(b)).estado).toBe('esperando_respuesta');
    expect((await db.query(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'clasificar'`)).rows[0].n).toBe(1);
  });

  it('mismo id con otro contenido: 409; misma herramienta y contenido: respuesta guardada', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const op = '6f1c1d0e-0b8a-4f5e-9d61-2a3b4c5d6e7f';
    const r1 = await ejecutarHerramienta('tomar_movimiento', { movimiento_id: id }, {}, db, ef, op);
    const r2 = await ejecutarHerramienta('tomar_movimiento', { movimiento_id: id }, {}, db, ef, op);
    expect(JSON.parse(r1.body).tomado).toBe(true);
    expect(JSON.parse(r2.body)).toEqual(JSON.parse(r1.body)); // sin el id, el segundo intento diría tomado=false
    const otro = await compra(ef);
    expect((await ejecutarHerramienta('tomar_movimiento', { movimiento_id: otro }, {}, db, ef, op)).statusCode).toBe(409);
    expect((await ejecutarHerramienta('tomar_movimiento', { movimiento_id: id }, {}, db, ef, 'no-es-uuid')).statusCode).toBe(400);
  });

  it('una operación aún en curso responde 409 en_curso; un 5xx no se guarda', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const op = '0e9b5a7c-1111-4222-8333-944455556666';
    await db.query(`INSERT INTO operaciones (id, herramienta, huella) VALUES ($1, 'x', 'y')`, ['0e9b5a7c-1111-4222-8333-944455556667']);
    const enCurso = await ejecutarHerramienta('tomar_movimiento', { movimiento_id: id }, {}, db, ef, '0e9b5a7c-1111-4222-8333-944455556667');
    expect(enCurso.statusCode).toBe(409);
    const caida = { ...db, tx: async () => { throw new Error('db caída'); } } as Db;
    const r = await ejecutarHerramienta('preguntar', { movimiento_id: id }, {}, caida, ef, op);
    expect(r.statusCode).toBe(500);
    expect((await db.query('SELECT count(*)::int AS n FROM operaciones WHERE id = $1', [op])).rows[0].n).toBe(0);
  });
});

describe('errores del MCP', () => {
  it('4xx es rechazo (sin reintento); red o 5xx dos veces es incierto', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef);
    const { cfg, llamadas } = mcp(ef, { fallas: { tomar_movimiento: [500, 500] } });
    await expect(llamar(cfg, 'tomar_movimiento', { movimiento_id: id }, espera)).rejects.toBeInstanceOf(ErrorIncierto);
    expect(llamadas).toHaveLength(2);
    await expect(llamar(cfg, 'preguntar', { movimiento_id: id }, espera)).rejects.toBeInstanceOf(ErrorRechazo); // 409: no tomada
    expect(errorParaAgente(new ErrorIncierto('x'))).toMatchObject({ tipo: 'incierto' });
    expect(errorParaAgente(new ErrorRechazo('x'))).toMatchObject({ tipo: 'rechazado' });
    expect(errorParaAgente(new ErrorIncierto('x')).instruccion).toMatch(/NO repitas/);
  });

  it('URL derivada para herramientas nuevas y _meta enmascarado', () => {
    const cfg = { urls: { confirmar_envio: 'https://x.vercel.app/api/confirmar-envio' } } as unknown as Config;
    expect(urlDe(cfg, 'confirmar_recordatorio')).toBe('https://x.vercel.app/api/confirmar-recordatorio');
    expect(describirMeta({ remitente: '+573001234567', n: 3 })).toEqual({ remitente: 'string(13) +••••••••••••', n: 'number' });
    expect(describirMeta(undefined)).toEqual({});
  });
});

describe('¿qué me falta por responder?', () => {
  it('lista las del grupo y las de quien escribe, con código y sin ids', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef, '33.000');
    await d.tomarMovimiento(db, { movimiento_id: id });
    const p = await d.preguntar(db, { movimiento_id: id });
    await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: 'wa-1' });
    const r = await d.pendientes(db, { numero_remitente: '+570000000002' });
    expect(r).toMatchObject({ persona: 'katerine', cantidad: 1 });
    expect(r.lista[0]).toMatchObject({ n: 1, codigo: `#${p.pregunta_codigo}` });
    expect(r.lista[0].descripcion).toContain('$33.000');
    expect(JSON.stringify(r)).not.toContain(id);
    await expect(d.pendientes(db, { numero_remitente: '+579999999999' })).rejects.toThrow(/no corresponde/);
  });
});
