// Gastos registrados por chat (fuente manual). Datos SINTÉTICOS. Números de prueba.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { descartarMovimiento } from '../src/lib/dominio';
import { esGasto, registrarGasto } from '../src/lib/gastos';
import type { Entrada } from '../src/lib/esquemas';
import { efectosFalsos, nuevaDb } from './apoyo';

const MIGUEL = '+570000000001';
const KATERINE = '+570000000002';
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

const entrada = (extra: Partial<Entrada<'registrar_gasto'>> = {}): Entrada<'registrar_gasto'> => ({
  numero_remitente: MIGUEL,
  canal: 'privado',
  valor: 35_000,
  descripcion: 'Plaza de mercado',
  medio_pago: 'efectivo',
  ...extra,
} as Entrada<'registrar_gasto'>);

describe('reglas de la fase 1: qué NO es un gasto', () => {
  it.each([
    ['Pago tarjeta de crédito', 'transferencia'],
    ['Pago de la tarjeta', 'pse'],
    ['Retiro en cajero', 'efectivo'],
    ['Ahorro en Nequi', 'transferencia'],
    ['Inversión CDT', 'bre_b'],
    ['Transferencia propia a mi cuenta', 'transferencia'],
    ['Entre mis cuentas', 'bre_b'],
    ['Para Katerine', 'bre_b'],
    ['Kati', 'transferencia'],
    ['Recarga Nequi', 'pse'],
  ])('rechaza «%s» (%s)', (descripcion, medio) => {
    expect(esGasto(descripcion, medio).ok).toBe(false);
  });

  it('un pago PSE a un servicio sí es gasto; las cuotas de créditos también', () => {
    expect(esGasto('Pago PSE Netflix', 'pse').ok).toBe(true);
    expect(esGasto('Mercado', 'efectivo').ok).toBe(true);
    expect(esGasto('Crédito Bancolombia - Libre inversión - 0000', 'tarjeta_debito').ok).toBe(true);
    expect(esGasto('Crédito Bancolombia (Libre inversión) 0000', 'transferencia').ok).toBe(true);
    expect(esGasto('Recarga celular Claro', 'pse').ok).toBe(true);
    expect(esGasto('Póliza salud Miguel', 'transferencia').ok).toBe(true);
  });

  it('el servidor no registra un pago de tarjeta aunque el modelo lo pida', async () => {
    const { ef, hooks } = efectosFalsos();
    const r = await registrarGasto(db, ef, entrada({ descripcion: 'Pago tarjeta VISA', medio_pago: 'pse', valor: 500_000 }));
    expect(r).toMatchObject({ aplicado: false, motivo: 'no_es_gasto' });
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos`)).rows[0].n).toBe(0);
    expect(hooks).toHaveLength(0);
  });
});

describe('registro', () => {
  it('efectivo con categoría: confirmado, fuente manual, medio Efectivo, persona de quien escribe', async () => {
    const { ef, hooks } = efectosFalsos();
    const r = await registrarGasto(db, ef, entrada({ categoria: 'supermercado' }));
    expect(r).toMatchObject({ aplicado: true, motivo: 'confirmado', posible_duplicado: false, persona: 'miguel', medio: 'Efectivo' });
    expect(r.mensaje).toMatch(/a nombre de Miguel/);
    const [m] = (await db.query(`SELECT * FROM movimientos`)).rows;
    expect(m).toMatchObject({ valor: 35_000, fuente: 'manual', estado: 'confirmado', persona: 'miguel', medio_pago: 'efectivo', tarjeta_id: 'efectivo', moneda: 'COP' });
    expect((await db.query(`SELECT fecha::text AS f FROM movimientos`)).rows[0].f).toBe(hoy());
    expect(hooks).toHaveLength(0);
  });

  it('sin categoría NO registra: devuelve opciones para preguntar en la conversación (sin hook)', async () => {
    const { ef, hooks } = efectosFalsos();
    const r: any = await registrarGasto(db, ef, entrada({ numero_remitente: KATERINE, medio_pago: 'pse', descripcion: 'Pago PSE Spotify' }));
    expect(r).toMatchObject({ aplicado: false, motivo: 'falta_categoria' });
    expect(r.sugeridas[0]).toMatchObject({ n: 1, nombre: 'Suscripciones digitales' });
    expect(r.opciones.length).toBeGreaterThan(5);
    expect(hooks).toHaveLength(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos`)).rows[0].n).toBe(0);
    const r2: any = await registrarGasto(db, ef, entrada({ numero_remitente: KATERINE, medio_pago: 'pse', descripcion: 'Pago PSE Spotify', categoria: 'Inventada xyz' }));
    expect(r2).toMatchObject({ aplicado: false, motivo: 'categoria_no_reconocida' });
  });

  it('débito: pide el medio, nunca acepta crédito, y asigna por nombre o alias', async () => {
    const { ef } = efectosFalsos();
    expect(await registrarGasto(db, ef, entrada({ medio_pago: 'tarjeta_debito' }))).toMatchObject({ aplicado: false, motivo: 'falta_medio' });
    // Las tarjetas de crédito llegan por correo o extracto: no se registran a mano.
    expect(await registrarGasto(db, ef, entrada({ medio: 'VISA', categoria: 'mercado' }))).toMatchObject({ aplicado: false, motivo: 'origen_no_se_registra' });
    expect(await registrarGasto(db, ef, entrada({ medio_pago: 'tarjeta_debito', tarjeta: '1111', categoria: 'mercado' }))).toMatchObject({ aplicado: false, motivo: 'origen_no_se_registra' });
    const r = await registrarGasto(db, ef, entrada({ medio_pago: 'tarjeta_debito', tarjeta: 'Plata Pay Miguel', categoria: 'mercado' }));
    expect(r).toMatchObject({ aplicado: true, motivo: 'confirmado' });
    expect((await db.query(`SELECT tarjeta_id, medio_pago FROM movimientos`)).rows[0]).toEqual({ tarjeta_id: 'plata-pay-miguel', medio_pago: 'tarjeta_debito' });
  });
  it('fecha: rechaza futuro y más de 60 días atrás; acepta un día reciente', async () => {
    const { ef } = efectosFalsos();
    const manana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const viejo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    expect(await registrarGasto(db, ef, entrada({ fecha: manana }))).toMatchObject({ aplicado: false, motivo: 'fecha_fuera_de_rango' });
    expect(await registrarGasto(db, ef, entrada({ fecha: viejo }))).toMatchObject({ aplicado: false, motivo: 'fecha_fuera_de_rango' });
    const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await registrarGasto(db, ef, entrada({ fecha: ayer, categoria: 'mercado' }))).toMatchObject({ aplicado: true });
  });

  it('advierte un posible duplicado (mismo valor y día, por correo) pero registra igual', async () => {
    const { ef } = efectosFalsos();
    await db.query(`INSERT INTO movimientos (fecha, descripcion_original, valor, tarjeta_id, estado, fuente, persona, moneda)
      VALUES ($1, 'Compra correo', 35000, 'visa-bancolombia', 'confirmado', 'correo', 'miguel', 'COP')`, [hoy()]);
    const r = await registrarGasto(db, ef, entrada({ categoria: 'mercado' }));
    expect(r).toMatchObject({ aplicado: true, posible_duplicado: true });
    expect(r.mensaje).toMatch(/descarte/);
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos`)).rows[0].n).toBe(2);
  });

  it('se deshace con descartar_movimiento (motivo otro) y deja de contar', async () => {
    const { ef } = efectosFalsos();
    const r = await registrarGasto(db, ef, entrada({ categoria: 'mercado' }));
    const id = (await db.query(`SELECT id::text AS id FROM movimientos`)).rows[0].id;
    await descartarMovimiento(db, ef, { movimiento_id: id, motivo: 'otro', numero_remitente: MIGUEL, canal: 'privado' } as any);
    expect((await db.query(`SELECT estado, motivo_descarte FROM movimientos WHERE id = $1`, [id])).rows[0]).toEqual({ estado: 'descartado', motivo_descarte: 'otro' });
    expect(r.aplicado).toBe(true);
  });

  it('solo Miguel o Katerine registran; un número ajeno recibe 403', async () => {
    const { ef } = efectosFalsos();
    await expect(registrarGasto(db, ef, entrada({ numero_remitente: '+571234567890' }))).rejects.toMatchObject({ status: 403 });
  });
});
