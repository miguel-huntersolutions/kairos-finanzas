// Textos armados por el servidor (resumen, repaso, recordatorio) y aviso de corte mensual.
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { mensajeHook } from '../src/lib/efectos';
import { HOY, efectosFalsos, mesActual, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function respondida(ef: d.Efectos, valor: string, categoria: string) {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `txt-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', valor),
  });
  const id = r.movimiento_id!;
  await d.tomarMovimiento(db, { movimiento_id: id });
  const p = await d.preguntar(db, { movimiento_id: id });
  await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: `wa-${n}` });
  await d.clasificar(db, { movimiento_id: id, categoria, numero_remitente: '+570000000001', canal: 'grupo' });
  return id;
}

describe('texto del resumen', () => {
  it('cifras del servidor, en pesos y por categoría', async () => {
    const { ef } = efectosFalsos();
    await respondida(ef, '40.000', 'mercado');
    await respondida(ef, '60.000', 'mercado');
    const r = await d.resumen(db, { mes: mesActual() });
    expect(r.texto).toMatch(/^Gastos de [a-z]+ \d{4}: \$100\.000 en 2 compras\./);
    expect(r.texto).toMatch(/• .*: \$100\.000/);
  });

  it('textoResumen: persona, variaciones y pendientes', () => {
    const t = d.textoResumen({
      mes: '2026-11', persona: 'katerine', total: 1234567, cantidad: 1, reembolsable: 0,
      por_persona: [], por_categoria: [{ categoria: 'Salud', total: 1234567 }],
      variaciones: [{ categoria: 'Salud', variacion_pct: 45 }], esperando: 2, alertas: 1,
    });
    expect(t).toContain('Gastos de Katerine de noviembre 2026: $1.234.567 en 1 compra.');
    expect(t).toContain('Salud +45%');
    expect(t).toContain('Faltan por responder: 2.');
    expect(t).toContain('Hay 1 compra por revisar');
  });
});

describe('repaso', () => {
  it('numeración única de categorías y reglas, con texto y métricas de la semana', async () => {
    const { ef } = efectosFalsos();
    await respondida(ef, '15.000', '1');
    // Una categoría propuesta de antes (las nuevas ya nacen activas): el repaso todavía la muestra.
    await db.query(`INSERT INTO categorias (nombre, nombre_normalizado, estado, creada_por) VALUES ('Mascotas', 'mascota', 'propuesta', 'agente')`);
    const r = await d.repaso(db);
    expect(r.numeracion[0]).toMatchObject({ n: 1, tipo: 'categoria', texto: 'Categoría nueva: Mascotas' });
    expect(r.numeracion.map((x) => x.n)).toEqual(r.numeracion.map((_, i) => i + 1));
    expect(r.texto).toContain('1. Categoría nueva: Mascotas');
    expect(r.texto).toContain('«sí a todo»');
    expect(r.metricas).toMatchObject({ respondidas: 1, pct_acierto_primera: 100, pct_en_lista: 100 });
    expect(r.texto).toMatch(/respondieron 1 pregunta \(mediana \d+ min\); la primera opción acertó 100%/);
  });

  it('sin nada que aprobar lo dice', () => {
    expect(d.textoRepaso([], 0, { respondidas: 0, mediana_respuesta_min: null, pct_acierto_primera: null })).toBe(
      'Repaso de la semana.\nNo hay reglas ni categorías nuevas para aprobar.',
    );
  });
});

describe('mensaje del hook', () => {
  it('solo ids y la herramienta que toca', () => {
    expect(mensajeHook({ movimiento_id: 'abc', evento: 'nuevo' })).toMatch(/tomar_movimiento/);
    expect(mensajeHook({ movimiento_id: 'abc', evento: 'recordatorio' })).toMatch(/Usa recordar con ese id, sin texto/);
    expect(mensajeHook({ tarjeta_id: 'visa-bancolombia', evento: 'corte' })).toMatch(/aviso_corte/);
  });
});

describe('aviso de corte', () => {
  // 15 nov 2026, 9 a. m. en Bogotá = 14:00 UTC.
  const nueveAm = Date.UTC(2026, 10, 15, 14, 0);
  const corteFalso = () => {
    const avisos: string[] = [];
    const { ef } = efectosFalsos();
    return { avisos, ef: { ...ef, avisarCorte: async (t: string) => void avisos.push(t) } as d.Efectos };
  };

  it('avisa una vez el día de corte desde las 8 a. m., no antes ni otro día', async () => {
    const { ef, avisos } = corteFalso();
    await db.query(`UPDATE tarjetas SET dia_corte = 15 WHERE id = 'visa-bancolombia'`);
    expect(await d.avisosCorte(db, ef, Date.UTC(2026, 10, 15, 12, 0))).toBe(0); // 7 a. m.
    expect(await d.avisosCorte(db, ef, Date.UTC(2026, 10, 14, 14, 0))).toBe(0); // otro día
    expect(await d.avisosCorte(db, ef, nueveAm)).toBe(1);
    expect(avisos).toEqual(['visa-bancolombia']);
    // El agente prepara el aviso: queda enviado y no se repite.
    const a = await d.avisoCorte(db, { tarjeta_id: 'visa-bancolombia' });
    expect(a.target).toBe('grupo-prueba@g.us');
    expect(a.mensaje).toMatch(/corte de la .*\*1111.*Cargar extracto/);
    expect(await d.avisosCorte(db, ef, nueveAm + 3600_000)).toBe(0);
  });

  it('corte el 31 avisa el último día del mes; sin respuesta del hook reintenta y luego queda fallido', async () => {
    const avisos: string[] = [];
    const { ef: base } = efectosFalsos();
    let falla = true;
    const ef = { ...base, avisarCorte: async (t: string) => { if (falla) throw new Error('hook caído'); avisos.push(t); } } as d.Efectos;
    await db.query(`UPDATE tarjetas SET dia_corte = 31 WHERE id = 'visa-bancolombia'`);
    const treinta = Date.UTC(2026, 10, 30, 14, 0); // noviembre tiene 30 días
    expect(await d.avisosCorte(db, ef, treinta)).toBe(0);
    falla = false;
    expect(await d.avisosCorte(db, ef, treinta)).toBe(1);
    falla = true;
    await db.query(`UPDATE avisos_corte SET estado = 'pendiente', intentos = 2`);
    await d.avisosCorte(db, ef, treinta);
    expect((await db.query(`SELECT estado FROM avisos_corte`)).rows[0].estado).toBe('fallido');
  });

  it('el respaldo corre los avisos de corte', async () => {
    const { ef, avisos } = corteFalso();
    await db.query(`UPDATE tarjetas SET dia_corte = 15 WHERE id = 'visa-bancolombia'`);
    expect((await d.respaldo(db, ef, nueveAm)).avisos_corte).toBe(1);
    expect(avisos).toHaveLength(1);
  });
});
