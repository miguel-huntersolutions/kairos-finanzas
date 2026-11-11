// Editar todos los datos de una compra desde el tablero. Datos SINTÉTICOS.
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
const AHORA = Date.UTC(2026, 10, 8, 15, 0);

async function compra(ef: d.Efectos, id = 'editar-1') {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: id, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY, texto: F.compraBancolombia('PANADERIA LA ESQUINA', '9.000'),
  });
  return r.movimiento_id!;
}
const fila = async (id: string) =>
  (await db.query(`SELECT fecha::text AS fecha, valor::int AS valor, tarjeta_id, categoria_id, persona, nota, reembolsable, clasificado_por FROM movimientos WHERE id = $1`, [id])).rows[0];
const tarjetaIndividual = async () =>
  (await db.query(`SELECT id, persona_default FROM tarjetas WHERE tipo = 'individual' AND persona_default IS NOT NULL LIMIT 1`)).rows[0];

describe('editar compra desde el tablero', () => {
  it('cambia valor, fecha, comercio, categoría y nota; deja el antes y el después en la bitácora', async () => {
    const id = await compra(efectosFalsos().ef);
    const r: any = await d.editarMovimientoTablero(db, { movimiento_id: id, valor: 12500, fecha: '2026-11-03', comercio: 'Panadería Nueva', categoria_id: 2, nota: 'corregida' }, quien, AHORA);
    expect(r).toMatchObject({ aplicado: true });
    expect(r.cambios).toEqual(expect.arrayContaining(['valor', 'fecha', 'comercio', 'categoria_id', 'nota']));
    const f = await fila(id);
    expect(f).toMatchObject({ fecha: '2026-11-03', valor: 12500, categoria_id: 2, nota: 'corregida', clasificado_por: 'katerine' });
    const b = (await db.query(`SELECT antes, despues FROM bitacora WHERE movimiento_id = $1 AND accion = 'editar_tablero'`, [id])).rows[0];
    expect(b.despues).toMatchObject({ valor: 12500, fecha: '2026-11-03', nota: 'corregida' });
    expect(b.antes.valor).not.toBe(12500);
  });

  it('reembolsable sigue a la categoría 12', async () => {
    const id = await compra(efectosFalsos().ef, 'editar-reemb');
    await d.editarMovimientoTablero(db, { movimiento_id: id, categoria_id: 12 }, quien, AHORA);
    expect((await fila(id)).reembolsable).toBe(true);
    await d.editarMovimientoTablero(db, { movimiento_id: id, categoria_id: 2 }, quien, AHORA);
    expect((await fila(id)).reembolsable).toBe(false);
  });

  it('una tarjeta individual fija la persona: otra persona se rechaza', async () => {
    const t = await tarjetaIndividual();
    if (!t) return; // sin tarjeta individual en el seed: no aplica
    const id = await compra(efectosFalsos().ef, 'editar-ind');
    const otra = t.persona_default === 'miguel' ? 'katerine' : 'miguel';
    await d.editarMovimientoTablero(db, { movimiento_id: id, tarjeta_id: t.id }, quien, AHORA);
    expect((await fila(id)).persona).toBe(t.persona_default);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, persona: otra }, quien, AHORA)).rejects.toThrow(/esa tarjeta es de/);
  });

  it('sin cambios reales responde sin_cambios y no escribe en la bitácora', async () => {
    const id = await compra(efectosFalsos().ef, 'editar-same');
    const f = await fila(id);
    expect(await d.editarMovimientoTablero(db, { movimiento_id: id, valor: f.valor, fecha: f.fecha }, quien, Date.now())).toMatchObject({ sin_cambios: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'editar_tablero'`)).rows[0].n).toBe(0);
  });

  it('rechaza: sin campos, fecha futura, categoría inexistente, tarjeta inexistente, compra descartada', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef, 'editar-err');
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id }, quien, AHORA)).rejects.toThrow(/nada que cambiar/);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, fecha: '2026-12-30' }, quien, AHORA)).rejects.toThrow(/futura/);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, categoria_id: 999999 }, quien, AHORA)).rejects.toThrow(/categoría/);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, tarjeta_id: 'no-existe-xx' }, quien, AHORA)).rejects.toThrow(/tarjeta no existe/);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, valor: 1, campo_raro: 1 }, quien, AHORA)).rejects.toThrow(/entrada inválida/);
    await d.descartarTablero(db, { movimiento_id: id, motivo: 'otro' }, quien);
    await expect(d.editarMovimientoTablero(db, { movimiento_id: id, valor: 5 }, quien, AHORA)).rejects.toThrow(/descartada/);
  });

  it('ruta POST /editar: 401 sin sesión, 400 mala entrada, 200 con sesión', async () => {
    const { ef } = efectosFalsos();
    const id = await compra(ef, 'editar-ruta');
    const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-editar-0123456789', TABLERO_PERSONAS: 'ana@ejemplo.com=katerine' };
    const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET, AHORA)}`;
    const ev = (cuerpo: unknown, conSesion: boolean): EventoRuta => ({
      __evento_http: true, method: 'POST', path: '/editar', body: JSON.stringify(cuerpo),
      headers: { origin: ['https://t.ejemplo'], ...(conSesion ? { cookie: [cookie] } : {}) }, request_context: { host: 't.ejemplo' },
    });
    const deps = { db: () => db, env, ahora: () => AHORA };
    expect((await manejarTablero(ev({ movimiento_id: id, valor: 7000 }, false), deps)).statusCode).toBe(401);
    expect((await manejarTablero(ev({ movimiento_id: id }, true), deps)).statusCode).toBe(400);
    const ok = await manejarTablero(ev({ movimiento_id: id, valor: 7000 }, true), deps);
    expect(ok.statusCode).toBe(200);
    expect((await fila(id)).valor).toBe(7000);
  });
});
