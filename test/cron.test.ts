// Crons de Vercel: recordatorios (bloqueo, no duplica, reintento, fallido) y respaldo
// protegido con CRON_SECRET. Datos SINTÉTICOS; secreto falso.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { ESPERA_RECORDATORIO_MS } from '../src/lib/dominio';
import { cronRecordatorios, cronRespaldo } from '../src/lib/cron';
import { ESPERA_RECIBO_MS, MAX_INTENTOS_RECORDATORIO, REINTENTO_RECORDATORIO_MS, procesarRecordatorios } from '../src/lib/recordatorios-cron';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

const SECRETO = 'cron-secreto-falso-para-pruebas-0123456789';
const BEARER = { authorization: `Bearer ${SECRETO}` };
let db: Db;
let n = 0;

beforeEach(async () => {
  ({ db } = await nuevaDb());
});

/** Compra en tarjeta compartida, tomada y preguntada: queda un recordatorio en cola. */
async function preguntada(ef: d.Efectos) {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `cron-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', '12.000'),
  });
  await d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! });
  const p = await d.preguntar(db, { movimiento_id: r.movimiento_id!, texto: '¿Qué fue?' });
  await d.confirmarEnvio(db, ef, { movimiento_id: r.movimiento_id!, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: `wa-${n}` });
  return { id: r.movimiento_id!, codigo: p.pregunta_codigo };
}
const filas = async () => (await db.query('SELECT estado, paso, intentos, datos, ultimo_error FROM recordatorios_pendientes ORDER BY id')).rows;

describe('encolar recordatorio', () => {
  it('al confirmar el envío queda una fila con revisión a las 4 h; repetirlo no duplica', async () => {
    const { ef } = efectosFalsos();
    const p = await preguntada(ef);
    const [f] = (await db.query('SELECT movimiento_id, pregunta_codigo, estado, proxima_revision FROM recordatorios_pendientes')).rows;
    expect(f).toMatchObject({ movimiento_id: p.id, pregunta_codigo: p.codigo, estado: 'pendiente' });
    expect(new Date(f.proxima_revision).getTime() - Date.now()).toBeGreaterThan(ESPERA_RECORDATORIO_MS - 60_000);
    await d.encolarRecordatorio(db, p.id, p.codigo);
    expect((await db.query('SELECT count(*)::int AS n FROM recordatorios_pendientes')).rows[0].n).toBe(1);
  });
});

describe('procesar recordatorios', () => {
  it('no toma los que aún no vencen; al vencer avisa y queda esperando el recibo; con el recibo cierra', async () => {
    const { ef, hooks } = efectosFalsos();
    const p = await preguntada(ef);
    hooks.length = 0;
    expect(await procesarRecordatorios(db, ef, Date.now())).toMatchObject({ revisados: 0 });
    const t = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    expect(await procesarRecordatorios(db, ef, t)).toMatchObject({ revisados: 1, avisados: 1, hechos: 0 });
    expect(hooks).toEqual([{ movimiento_id: p.id, evento: 'recordatorio' }]);
    expect((await filas())[0]).toMatchObject({ estado: 'pendiente', paso: 'esperando_recibo' });
    // Sin recibo todavía no se marca: el envío puede haber fallado.
    expect((await db.query('SELECT recordado FROM movimientos WHERE id = $1', [p.id])).rows[0].recordado).toBe(false);
    // El agente pide el texto (lo arma el servidor) y el MCP confirma el recibo.
    const r = await d.recordar(db, { movimiento_id: p.id });
    // SEC-006: la pregunta la arma el servidor (el texto que mande el modelo no se usa).
    expect(r.mensaje).toMatch(/^Recordatorio: ¿De qué fue esta compra de /);
    expect(r.mensaje).toContain(`#${p.codigo}`);
    await d.confirmarRecordatorio(db, { movimiento_id: p.id, pregunta_codigo: p.codigo, whatsapp_message_id: 'wa-r1' });
    expect((await filas())[0]).toMatchObject({ estado: 'hecho', datos: { resultado: 'recordado', whatsapp_message_id: 'wa-r1' } });
    expect((await db.query('SELECT recordado FROM movimientos WHERE id = $1', [p.id])).rows[0].recordado).toBe(true);
    // Repetir el recibo no falla ni duplica la bitácora; recordar ya no procede.
    await d.confirmarRecordatorio(db, { movimiento_id: p.id, pregunta_codigo: p.codigo, whatsapp_message_id: 'wa-r1' });
    expect((await db.query(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'recordar'`)).rows[0].n).toBe(1);
    await expect(d.recordar(db, { movimiento_id: p.id })).rejects.toThrow(/no hay recordatorio/);
    expect((await procesarRecordatorios(db, ef, t + 2 * ESPERA_RECORDATORIO_MS)).revisados).toBe(0);
    expect(hooks).toHaveLength(1);
  });

  it('sin recibo vuelve a avisar en la siguiente revisión; tras el máximo queda fallido', async () => {
    const { ef, hooks } = efectosFalsos();
    const p = await preguntada(ef);
    let t = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    for (let i = 0; i < MAX_INTENTOS_RECORDATORIO; i++) {
      expect((await procesarRecordatorios(db, ef, t)).avisados).toBe(1);
      t += ESPERA_RECIBO_MS + 1000;
    }
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toHaveLength(MAX_INTENTOS_RECORDATORIO);
    expect((await procesarRecordatorios(db, ef, t)).fallidos).toBe(1);
    expect((await filas())[0]).toMatchObject({ estado: 'fallido', ultimo_error: 'sin recibo del envío del recordatorio' });
    expect((await db.query('SELECT recordado FROM movimientos WHERE id = $1', [p.id])).rows[0].recordado).toBe(false);
  });

  it('si llega el recibo entre revisiones, la siguiente cierra sin volver a avisar', async () => {
    const { ef, hooks } = efectosFalsos();
    const p = await preguntada(ef);
    const t = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    await procesarRecordatorios(db, ef, t);
    await d.marcarRecordatorio(db, p.id, p.codigo); // recibo que no alcanzó a cerrar la fila
    expect((await procesarRecordatorios(db, ef, t + ESPERA_RECIBO_MS + 1000)).hechos).toBe(1);
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toHaveLength(1);
  });

  it('bloqueo: dos ejecuciones seguidas no toman la misma fila', async () => {
    const { ef, hooks } = efectosFalsos();
    await preguntada(ef);
    const ahora = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    const [a, b] = [await procesarRecordatorios(db, ef, ahora), await procesarRecordatorios(db, ef, ahora)];
    expect(a.revisados + b.revisados).toBe(1);
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toHaveLength(1);
  });

  it('una ejecución que murió a mitad (bloqueo vencido) se retoma y avisa', async () => {
    const { ef, hooks } = efectosFalsos();
    const p = await preguntada(ef);
    const ahora = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    await procesarRecordatorios(db, { ...ef, avisarHook: async () => { throw new Error('caída simulada'); } }, ahora);
    expect((await filas())[0]).toMatchObject({ estado: 'pendiente', intentos: 1 });
    const despues = ahora + REINTENTO_RECORDATORIO_MS + 1000;
    expect((await procesarRecordatorios(db, ef, despues)).avisados).toBe(1);
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toEqual([{ movimiento_id: p.id, evento: 'recordatorio' }]);
  });

  it('reintento: un fallo deja la fila pendiente con su motivo; tras 5 intentos queda fallido', async () => {
    const { ef, hooks } = efectosFalsos();
    await preguntada(ef);
    const roto = { ...ef, avisarHook: async () => { throw new Error('hook 503'); } };
    let t = Date.now() + ESPERA_RECORDATORIO_MS + 1000;
    for (let i = 1; i < MAX_INTENTOS_RECORDATORIO; i++) {
      expect((await procesarRecordatorios(db, roto, t)).reintentos).toBe(1);
      expect((await filas())[0]).toMatchObject({ estado: 'pendiente', intentos: i, ultimo_error: 'hook 503' });
      t += REINTENTO_RECORDATORIO_MS + 1000;
    }
    expect((await procesarRecordatorios(db, roto, t)).fallidos).toBe(1);
    expect((await filas())[0]).toMatchObject({ estado: 'fallido', intentos: MAX_INTENTOS_RECORDATORIO });
    // Un fallido ya no se vuelve a tomar.
    expect((await procesarRecordatorios(db, ef, t + 10 * REINTENTO_RECORDATORIO_MS)).revisados).toBe(0);
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toHaveLength(0);
  });

  it('si la pregunta ya se respondió o se reasignó, cierra sin avisar', async () => {
    const { ef, hooks } = efectosFalsos();
    const p = await preguntada(ef);
    await db.query(`UPDATE movimientos SET estado = 'confirmado' WHERE id = $1`, [p.id]);
    expect((await procesarRecordatorios(db, ef, Date.now() + ESPERA_RECORDATORIO_MS + 1000)).hechos).toBe(1);
    expect((await filas())[0].datos.resultado).toMatch(/sin recordatorio: estado confirmado/);
    expect(hooks.filter((h) => h.evento === 'recordatorio')).toHaveLength(0);
  });
});

describe('crons protegidos con CRON_SECRET', () => {
  it('sin secreto configurado: 503; sin Bearer o con otro: 401; con el correcto: 200', async () => {
    const { ef } = efectosFalsos();
    const deps = { db: () => db, ef: () => ef, secreto: undefined };
    expect((await cronRecordatorios(`Bearer ${SECRETO}`, deps)).status).toBe(503);
    const con = { ...deps, secreto: SECRETO };
    expect((await cronRecordatorios(null, con)).status).toBe(401);
    expect((await cronRecordatorios('Bearer otro', con)).status).toBe(401);
    expect((await cronRespaldo('Basic x', con)).status).toBe(401);
    expect((await cronRespaldo(BEARER.authorization, con)).status).toBe(200);
    expect((await cronRecordatorios(BEARER.authorization, con)).status).toBe(200);
  });
  it('un fallo interno responde 500 sin detalles', async () => {
    const r = await cronRespaldo(BEARER.authorization, { db: () => { throw new Error('secreto-interno'); }, ef: () => efectosFalsos().ef, secreto: SECRETO });
    expect(r).toEqual({ status: 500, json: { error: 'fallo interno' } });
    expect(JSON.stringify(r)).not.toContain('secreto-interno');
  });
});
