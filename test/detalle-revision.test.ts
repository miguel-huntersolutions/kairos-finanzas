// Mensaje original y detalle (tablero y agente), compras en revisión atendidas desde el
// tablero, y respuestas desde el privado a preguntas del grupo. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, ejecutar } from '../mcp/servidor';
import { COOKIE, firmarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import type { Herramienta } from '../src/lib/esquemas';
import { datosExplorador } from '../src/lib/explorador';
import { ejecutarHerramienta } from '../src/lib/http';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});
const quien = { correo: 'ana@ejemplo.com', persona: 'katerine' as const };

async function delGrupo(ef: d.Efectos, valor = '12.000') {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `det-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'Alerta de compra', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', valor),
  });
  const id = r.movimiento_id!;
  await d.tomarMovimiento(db, { movimiento_id: id });
  const p = await d.preguntar(db, { movimiento_id: id });
  await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: `wa-${n}` });
  return id;
}
async function enRevision(texto: string) {
  await db.query(`INSERT INTO correos (correo_id, remitente, asunto, texto) VALUES ($1, 'alertas@banco.example', 'Compra', $2)`, [`rev-${++n}`, texto]);
  const { rows } = await db.query(
    `INSERT INTO movimientos (correo_id, descripcion_original, estado, fuente, nota) VALUES ($1, 'COMPRA RARA', 'requiere_revision', 'correo', 'tarjeta desconocida')
     RETURNING id::text AS id`,
    [`rev-${n}`],
  );
  return rows[0].id as string;
}
const mov = async (id: string) => (await db.query('SELECT * FROM movimientos WHERE id = $1', [id])).rows[0];

describe('preguntas del grupo respondidas en privado', () => {
  it('se aplican (ya no quedan como sugerencia)', async () => {
    const { ef } = efectosFalsos();
    const id = await delGrupo(ef);
    const r: any = await d.clasificar(db, { referencia: 'la de 12.000', categoria: 'mercado', numero_remitente: '+570000000001', canal: 'privado' });
    expect(r.aplicado).toBe(true);
    expect((await mov(id)).estado).toBe('confirmado');
  });

  it('si la pregunta era para la otra persona, sigue siendo sugerencia', async () => {
    const { ef } = efectosFalsos();
    const id = await delGrupo(ef);
    await d.reasignarPregunta(db, { movimiento_id: id, persona_destino: 'katerine' });
    const r: any = await d.clasificar(db, { movimiento_id: id, categoria: 'mercado', numero_remitente: '+570000000001', canal: 'privado' });
    expect(r).toMatchObject({ aplicado: false, sugerencia: true });
  });
});

describe('mensaje original', () => {
  it('textoLegible: sin HTML, entidades decodificadas y números largos enmascarados', () => {
    const t = d.textoLegible('<html><style>.x{}</style><p>Compra por&nbsp;$58.900</p><br>Tarjeta 4111 1111 1111 1234<div>  Gracias </div></html>');
    expect(t).toBe('Compra por $58.900\n\nTarjeta •••• 1234\nGracias');
  });

  it('detalle de una compra con su correo', async () => {
    const { ef } = efectosFalsos();
    const id = await delGrupo(ef, '33.000');
    const det = await d.detalleMovimiento(db, id);
    expect(det).toMatchObject({ fuente: 'correo', estado: 'esperando_respuesta', correo: { asunto: 'Alerta de compra' } });
    expect(det.correo!.texto).toContain('33.000');
    expect(d.textoDetalle(det)).toMatch(/^Detalle: .*\$33\.000/);
  });

  it('el agente pide el detalle: el MCP lo envía al chat y el modelo no ve el texto del correo', async () => {
    const { ef } = efectosFalsos();
    await delGrupo(ef, '44.000');
    const enviados: Array<[string, string]> = [];
    const cfg: Config = {
      token: 't', urls: { confirmar_envio: 'http://vercel/api/confirmar-envio' },
      enviar: async (t, m) => (enviados.push([t, m]), 'wa-d'),
      fetch: (async (url: string, init: any) => {
        const h = url.split('/').pop()!.replaceAll('-', '_') as Herramienta;
        const { entrada, contexto, operacion_id } = JSON.parse(init.body);
        const r = await ejecutarHerramienta(h, entrada, contexto, db, ef, operacion_id);
        return new Response(r.body, { status: r.statusCode });
      }) as any,
    };
    const priv = await ejecutar(cfg, 'enviar_detalle', { referencia: 'la de 44.000', numero_remitente: '+570000000002', canal: 'privado' });
    expect(enviados[0][0]).toBe('+570000000002');
    expect(enviados[0][1]).toContain('Alerta de compra');
    expect(String(priv)).not.toContain('Alerta de compra');
    expect(String(priv)).toMatch(/Detalle enviado/);
    await ejecutar(cfg, 'enviar_detalle', { referencia: 'la de 44.000', numero_remitente: '+570000000001', canal: 'grupo' });
    expect(enviados[1][0]).toBe('grupo-prueba@g.us');
    await expect(ejecutar(cfg, 'enviar_detalle', { referencia: 'la de 44.000', numero_remitente: '+579999999999', canal: 'privado' })).rejects.toThrow();
  });
});

describe('compras en revisión desde el tablero', () => {
  it('aparecen con la acción «revision»', async () => {
    const id = await enRevision('Compra por $58.900');
    expect((await datosExplorador(db)).por_atender.find((p: any) => p.id === id)).toMatchObject({ accion: 'revision' });
  });

  it('completar con categoría la confirma; sin categoría queda por preguntar', async () => {
    const a = await enRevision('Compra por $58.900 en TIENDA RARA');
    const r: any = await d.atenderRevision(db, { movimiento_id: a, valor: 58900, fecha: '2026-11-05', tarjeta_id: 'visa-bancolombia', comercio: 'Tienda Rara', categoria_id: 2 }, quien);
    expect(r).toMatchObject({ aplicado: true, estado: 'confirmado' });
    const ma = await mov(a);
    expect(Number(ma.valor)).toBe(58900);
    expect(ma).toMatchObject({ estado: 'confirmado', categoria_id: 2, tarjeta_id: 'visa-bancolombia', clasificado_por: 'katerine' });
    const b = await enRevision('otra');
    expect((await d.atenderRevision(db, { movimiento_id: b, valor: 1000, fecha: '2026-11-05', tarjeta_id: 'visa-bancolombia', comercio: 'Otra' }, quien)).estado).toBe('por_preguntar');
    await expect(d.atenderRevision(db, { movimiento_id: a, valor: 1, fecha: '2026-11-05', tarjeta_id: 'visa-bancolombia', comercio: 'X1' }, quien)).rejects.toThrow(/ya no está en revisión/);
    await expect(d.atenderRevision(db, { movimiento_id: b, fecha: '2026-11-05' }, quien)).rejects.toThrow(/datos incompletos/);
  });

  it('descartar desde el tablero', async () => {
    const id = await enRevision('informativo');
    await d.descartarTablero(db, { movimiento_id: id, motivo: 'otro' }, quien);
    expect(await mov(id)).toMatchObject({ estado: 'descartado', motivo_descarte: 'otro' });
  });

  it('rutas GET /detalle y POST /revision', async () => {
    const id = await enRevision('Compra por $9.999');
    const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-detalle-0123456789', TABLERO_PERSONAS: 'ana@ejemplo.com=katerine' };
    const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET, HOY.getTime())}`;
    const ev = (method: string, path: string, cuerpo?: unknown, query?: Record<string, string[]>): EventoRuta => ({
      __evento_http: true, method, path, query, body: cuerpo ? JSON.stringify(cuerpo) : '',
      headers: { origin: ['https://t.ejemplo'], cookie: [cookie] }, request_context: { host: 't.ejemplo' },
    });
    const deps = { db: () => db, env, ahora: () => HOY.getTime() };
    const det = await manejarTablero(ev('GET', '/detalle', undefined, { id: [id] }), deps);
    expect(det.statusCode).toBe(200);
    expect(JSON.parse(det.body).correo.texto).toBe('Compra por $9.999');
    expect((await manejarTablero(ev('GET', '/detalle', undefined, { id: ['x'] }), deps)).statusCode).toBe(400);
    expect((await manejarTablero(ev('POST', '/revision', { accion: 'otra', movimiento_id: id }), deps)).statusCode).toBe(400);
    const r = await manejarTablero(ev('POST', '/revision', { accion: 'descartar', movimiento_id: id, motivo: 'otro' }), deps);
    expect(r.statusCode).toBe(200);
  });
});
