// Cambiar la fecha de una compra desde el tablero. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE, firmarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});
const quien = { correo: 'ana@ejemplo.com', persona: 'katerine' as const };
const AHORA = Date.UTC(2026, 10, 7, 20, 0);

async function compra(ef: d.Efectos) {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: 'fecha-1', remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY, texto: F.compraBancolombia('PANADERIA LA ESQUINA', '9.000'),
  });
  return r.movimiento_id!;
}
const fechaDe = async (id: string) => (await db.query('SELECT fecha::text AS f FROM movimientos WHERE id = $1', [id])).rows[0].f;

describe('cambiar fecha', () => {
  it('cambia la fecha y deja la anterior en la bitácora', async () => {
    const id = await compra(efectosFalsos().ef);
    const antes = await fechaDe(id);
    const r: any = await d.cambiarFechaTablero(db, { movimiento_id: id, fecha: '2026-11-03' }, quien, AHORA);
    expect(r).toMatchObject({ aplicado: true, fecha: '2026-11-03', antes });
    expect(await fechaDe(id)).toBe('2026-11-03');
    const b = (await db.query(`SELECT actor, instruido_por, antes, despues FROM bitacora WHERE movimiento_id = $1 AND accion = 'cambiar_fecha'`, [id])).rows[0];
    expect(b).toMatchObject({ actor: 'katerine', instruido_por: 'ana@ejemplo.com', antes: { fecha: antes }, despues: { fecha: '2026-11-03' } });
  });

  it('la misma fecha no cambia nada ni escribe bitácora', async () => {
    const id = await compra(efectosFalsos().ef);
    const f = await fechaDe(id);
    expect(await d.cambiarFechaTablero(db, { movimiento_id: id, fecha: f }, quien, Date.now())).toMatchObject({ sin_cambios: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'cambiar_fecha'`)).rows[0].n).toBe(0);
  });

  it('rechaza fechas futuras, anteriores a 2020, imposibles y compras descartadas', async () => {
    const id = await compra(efectosFalsos().ef);
    for (const fecha of ['2026-11-20', '2019-12-31', '2026-02-30', 'hoy'])
      await expect(d.cambiarFechaTablero(db, { movimiento_id: id, fecha }, quien, AHORA)).rejects.toThrow();
    await db.query(`UPDATE movimientos SET estado = 'descartado', motivo_descarte = 'otro' WHERE id = $1`, [id]);
    await expect(d.cambiarFechaTablero(db, { movimiento_id: id, fecha: '2026-11-03' }, quien, AHORA)).rejects.toThrow(/descartada/);
  });

  it('ruta POST /fecha: 401 sin sesión, 400 mala entrada, 200 con sesión', async () => {
    const id = await compra(efectosFalsos().ef);
    const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-fecha-0123456789', TABLERO_PERSONAS: 'ana@ejemplo.com=katerine' };
    const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET, AHORA)}`;
    const ev = (cuerpo: unknown, conSesion = true): EventoRuta => ({
      __evento_http: true, method: 'POST', path: '/fecha', body: JSON.stringify(cuerpo),
      headers: { origin: ['https://t.ejemplo'], ...(conSesion ? { cookie: [cookie] } : {}) }, request_context: { host: 't.ejemplo' },
    });
    const deps = { db: () => db, env, ahora: () => AHORA };
    expect((await manejarTablero(ev({ movimiento_id: id, fecha: '2026-11-03' }, false), deps)).statusCode).toBe(401);
    expect((await manejarTablero(ev({ movimiento_id: id, fecha: 'x' }), deps)).statusCode).toBe(400);
    expect((await manejarTablero(ev({ movimiento_id: id, fecha: '2026-11-03' }), deps)).statusCode).toBe(200);
    expect(await fechaDe(id)).toBe('2026-11-03');
  });
});
