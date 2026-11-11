// Confirmar desde el tablero una compra pendiente (misma regla que WhatsApp). Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE, firmarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { datosExplorador } from '../src/lib/explorador';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});
const quien = { correo: 'ana@ejemplo.com', persona: 'katerine' as const };
const mov = async (id: string) => (await db.query('SELECT * FROM movimientos WHERE id = $1', [id])).rows[0];

async function esperando(ef: d.Efectos, valor = '18.000') {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `conf-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', valor),
  });
  const id = r.movimiento_id!;
  await d.tomarMovimiento(db, { movimiento_id: id });
  const p = await d.preguntar(db, { movimiento_id: id });
  await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: `wa-${n}` });
  return id;
}

describe('confirmar desde el tablero', () => {
  it('una compra esperando respuesta queda confirmada, a nombre de quien confirma', async () => {
    const { ef } = efectosFalsos();
    const id = await esperando(ef);
    const r: any = await d.confirmarTablero(db, { movimiento_id: id, categoria_id: 2 }, quien);
    expect(r).toMatchObject({ aplicado: true });
    expect(await mov(id)).toMatchObject({ estado: 'confirmado', categoria_id: 2, clasificado_por: 'katerine' });
    const b = (await db.query(`SELECT instruido_por, accion FROM bitacora WHERE movimiento_id = $1 AND accion = 'clasificar'`, [id])).rows[0];
    expect(b).toEqual({ instruido_por: 'katerine', accion: 'clasificar' });
  });

  it('no confirma una compra descartada y deja la categoría como estaba', async () => {
    const { ef } = efectosFalsos();
    const id = await esperando(ef);
    await db.query(`UPDATE movimientos SET estado = 'descartado', motivo_descarte = 'otro' WHERE id = $1`, [id]);
    await expect(d.confirmarTablero(db, { movimiento_id: id, categoria_id: 2 }, quien)).rejects.toThrow(/descartado/);
    expect((await mov(id)).estado).toBe('descartado');
  });

  it('aparece en «Por atender» con la acción confirmar', async () => {
    const { ef } = efectosFalsos();
    const id = await esperando(ef);
    expect((await datosExplorador(db)).por_atender.find((p: any) => p.id === id)).toMatchObject({ accion: 'confirmar' });
  });

  it('ruta POST /confirmar: 401 sin sesión, 400 con entrada mala, 200; repetirlo no cambia nada', async () => {
    const { ef } = efectosFalsos();
    const id = await esperando(ef);
    const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-confirmar-0123456789', TABLERO_PERSONAS: 'ana@ejemplo.com=katerine' };
    const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET, HOY.getTime())}`;
    const ev = (cuerpo: unknown, conSesion = true): EventoRuta => ({
      __evento_http: true, method: 'POST', path: '/confirmar', body: JSON.stringify(cuerpo),
      headers: { origin: ['https://t.ejemplo'], ...(conSesion ? { cookie: [cookie] } : {}) }, request_context: { host: 't.ejemplo' },
    });
    const deps = { db: () => db, env, ahora: () => HOY.getTime() };
    expect((await manejarTablero(ev({ movimiento_id: id, categoria_id: 2 }, false), deps)).statusCode).toBe(401);
    expect((await manejarTablero(ev({ movimiento_id: 'x', categoria_id: 2 }), deps)).statusCode).toBe(400);
    expect((await manejarTablero(ev({ movimiento_id: id, categoria_id: 'mercado' }), deps)).statusCode).toBe(400);
    expect((await manejarTablero(ev({ movimiento_id: id, categoria_id: 2 }), deps)).statusCode).toBe(200);
    // Repetir la misma confirmación no cambia nada (idempotente).
    expect((await manejarTablero(ev({ movimiento_id: id, categoria_id: 2 }), deps)).statusCode).toBe(200);
    expect((await mov(id)).estado).toBe('confirmado');
  });
});
