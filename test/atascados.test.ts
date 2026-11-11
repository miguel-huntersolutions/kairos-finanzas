// Fallos de `preguntar` visibles: destino faltante → motivo guardado, respaldo lo
// devuelve y lo lista, y el resumen muestra la alerta. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { HOY, efectosFalsos, mesActual, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function compraTomada(ef: d.Efectos) {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `atasco-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'ASUNTO-SECRETO-DEL-CORREO', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', '12.000'),
  });
  await d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! });
  return r.movimiento_id!;
}

describe('pendientes atascados', () => {
  it('destino del grupo sin definir: preguntar falla, queda el motivo, respaldo lo devuelve y el resumen alerta', async () => {
    await db.query(`UPDATE config SET valor = 'null' WHERE clave = 'destino_grupo'`);
    const { ef, hooks } = efectosFalsos();
    const id = await compraTomada(ef);

    await expect(d.preguntar(db, { movimiento_id: id, texto: '¿Qué fue esta compra?' })).rejects.toThrow(/destino_grupo/);
    const m = (await db.query('SELECT estado, ultimo_error FROM movimientos WHERE id = $1', [id])).rows[0];
    expect(m).toEqual({ estado: 'en_proceso', ultimo_error: 'config destino_grupo sin definir' });
    expect((await db.query(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'error_preguntar'`)).rows[0].n).toBe(1);

    // Vence el arrendamiento (10 min): el respaldo lo devuelve y dice por qué.
    await db.query(`UPDATE movimientos SET en_proceso_hasta = now() - interval '1 minute', creado_en = now() - interval '12 minutes'`);
    hooks.length = 0;
    const r = await d.respaldo(db, ef);
    expect(r.liberados).toBe(1);
    expect(r.atascados).toEqual([
      expect.objectContaining({
        movimiento_id: id, comercio: 'Panaderia la esquina', valor: 12000, valor_texto: '$12.000 COP',
        motivo: 'falló preguntar: config destino_grupo sin definir', intentos: 1,
      }),
    ]);
    expect(r.atascados[0].minutos).toBeGreaterThanOrEqual(11);
    expect((await db.query('SELECT estado FROM movimientos WHERE id = $1', [id])).rows[0].estado).toBe('por_preguntar');

    const res = await d.resumen(db, { mes: mesActual() });
    expect(res.alertas.pendientes_atascados).toEqual([
      expect.objectContaining({ movimiento_id: id, comercio: 'Panaderia la esquina', valor: 12000, motivo: expect.stringContaining('destino_grupo') }),
    ]);
    // Nunca sale texto del correo (ni el asunto) en estas respuestas.
    expect(JSON.stringify(r.atascados)).not.toContain('ASUNTO-SECRETO');
    expect(JSON.stringify(res.alertas.pendientes_atascados)).not.toContain('ASUNTO-SECRETO');
  });

  it('tomado y sin pregunta enviada: motivo propio; tras 3 intentos el respaldo deja de re-avisar', async () => {
    const { ef, hooks } = efectosFalsos();
    const id = await compraTomada(ef);
    await db.query(`UPDATE movimientos SET en_proceso_hasta = now() - interval '1 minute'`);
    expect((await d.respaldo(db, ef)).atascados[0].motivo).toBe('el agente lo tomó y no preguntó');

    await db.query(`UPDATE movimientos SET intentos_preguntar = ${d.MAX_INTENTOS_PREGUNTA}, actualizado_en = now() - interval '5 minutes'`);
    hooks.length = 0;
    expect((await d.respaldo(db, ef)).avisos).toBe(0);
    expect(hooks).toHaveLength(0);
    expect((await d.resumen(db, { mes: mesActual() })).alertas.pendientes_atascados).toHaveLength(1);
  });

  it('pregunta preparada pero envío no confirmado; un envío confirmado limpia el error', async () => {
    const { ef } = efectosFalsos();
    const id = await compraTomada(ef);
    const p = await d.preguntar(db, { movimiento_id: id, texto: '¿Qué fue?' });
    await db.query(`UPDATE movimientos SET en_proceso_hasta = now() - interval '1 minute', ultimo_error = 'viejo'`);
    await db.query(`UPDATE movimientos SET ultimo_error = NULL`);
    expect((await d.respaldo(db, ef)).atascados[0].motivo).toBe(`pregunta preparada (#${p.pregunta_codigo}) pero el envío no se confirmó`);

    await d.tomarMovimiento(db, { movimiento_id: id });
    await db.query(`UPDATE movimientos SET ultimo_error = 'algo'`);
    const p2 = await d.preguntar(db, { movimiento_id: id, texto: '¿Qué fue?' });
    await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p2.pregunta_codigo, whatsapp_message_id: 'wa-x' });
    expect((await db.query('SELECT ultimo_error FROM movimientos WHERE id = $1', [id])).rows[0].ultimo_error).toBeNull();
  });
});
