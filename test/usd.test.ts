// Compras en USD con TRM del día. Todo SINTÉTICO: correos, TRM y tarjetas inventados.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { obtenerTrmDatosGov } from '../src/lib/efectos';
import { validarExtraccion } from '../src/lib/extractor';
import { interpretarCorreo } from '../src/lib/parser';
import { fechaISO, valorUSD } from '../src/lib/texto';
import { HOY, efectosFalsos, fechaTexto, mesActual, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

const HOY_ISO = fechaISO(fechaTexto())!;
const TRM_FICTICIA = 4000; // valor redondo e inventado, solo para pruebas

const compraUSD = (formato: string, comercio = 'AMAZON WEB SERVICES', ult4 = '1111') =>
  `Bancolombia le informa Compra por ${formato} en ${comercio} 14:32. ${fechaTexto()} T.Cred *${ult4}.`;

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});
const correo = (texto: string, remitente = F.BANCOLOMBIA): d.CorreoEntrante => ({
  correo_id: `usd-${++n}`, remitente, asunto: 'Alerta', fecha_correo: HOY, texto,
});
const mov = async (id: string) => { const m = (await db.query('SELECT *, valor_original::float8 AS vo, trm::float8 AS t FROM movimientos WHERE id = $1', [id])).rows[0]; return { ...m, valor: m.valor == null ? null : Number(m.valor) } as Record<string, any>; };
const cachear = (valor = TRM_FICTICIA) =>
  db.query(`INSERT INTO trm (fecha, valor, fuente) VALUES ($1, $2, 'prueba')`, [HOY_ISO, valor]);

describe('parser: compras en USD (Bancolombia)', () => {
  it.each([
    ['USD 12.50', 12.5],
    ['US$12,50', 12.5],
    ['USD12.50', 12.5],
    ['USD 1,234.56', 1234.56],
    ['12,50 dólares', 12.5],
  ])('reconoce "%s"', (formato, valor) => {
    const r = interpretarCorreo(F.BANCOLOMBIA, compraUSD(formato), HOY);
    expect(r.ok && r.datos).toMatchObject({ moneda: 'USD', valor, comercio: 'AMAZON WEB SERVICES', ultimos_4_tarjeta: '1111' });
  });
  it('una compra en pesos sigue en COP', () => {
    const r = interpretarCorreo(F.BANCOLOMBIA, F.compraBancolombia('TIENDA D1 X', '45.900,00'), HOY);
    expect(r.ok && r.datos).toMatchObject({ moneda: 'COP', valor: 45900 });
  });
  it('Davivienda es solo COP: un "USD" no se toma como dólares', () => {
    const r = interpretarCorreo(F.DAVIVIENDA, 'Davivienda le informa una compra aprobada por USD 10 en TIENDA X con su tarjeta terminada en 3333.', HOY);
    expect(r.ok).toBe(false); // pasa al extractor en cuarentena
  });
  it('valorUSD', () => {
    expect(valorUSD('12.5')).toBe(12.5);
    expect(valorUSD('1.234,56')).toBe(1234.56);
    expect(valorUSD('20')).toBe(20);
    expect(valorUSD('abc')).toBeNull();
  });
});

describe('TRM: caché, API caída y reintento', () => {
  it('USD con TRM en caché: valor en COP, sin llamar a la API, y texto con ambos valores', async () => {
    await cachear();
    let llamadas = 0;
    const { ef, hooks } = efectosFalsos();
    ef.obtenerTrm = async () => (llamadas++, { valor: 1, fuente: 'no debería usarse' });
    const r = await d.ingresarCorreo(db, ef, correo(compraUSD('USD 12.50')));
    expect(r.estado).toBe('por_preguntar');
    expect(llamadas).toBe(0);
    const m = await mov(r.movimiento_id!);
    expect(m).toMatchObject({ moneda: 'USD', vo: 12.5, t: TRM_FICTICIA, valor: 50000 });
    expect(m.trm_fecha).toBeTruthy();
    expect(hooks).toEqual([{ movimiento_id: r.movimiento_id, evento: 'nuevo' }]);
    const t = await d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! });
    expect(t.movimiento?.valor_texto).toBe('USD 12,50 (≈ $50.000 COP con TRM $4.000,00 del ' + HOY_ISO + ')');
  });

  it('sin caché consulta la API una vez y guarda la TRM', async () => {
    const { ef } = efectosFalsos();
    let llamadas = 0;
    ef.obtenerTrm = async () => (llamadas++, { valor: TRM_FICTICIA, fuente: 'falsa' });
    await d.ingresarCorreo(db, ef, correo(compraUSD('USD 10.00')));
    await d.ingresarCorreo(db, ef, correo(compraUSD('USD 20.00')));
    expect(llamadas).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM trm')).rows[0].n).toBe(1);
  });

  it('API caída: queda requiere_trm (sin inventar), alerta en el resumen y se resuelve al reintentar', async () => {
    const { ef, hooks } = efectosFalsos();
    ef.obtenerTrm = async () => {
      throw new Error('datos.gov.co 503');
    };
    const r = await d.ingresarCorreo(db, ef, correo(compraUSD('USD 12.50')));
    expect(r.estado).toBe('requiere_trm');
    expect(await mov(r.movimiento_id!)).toMatchObject({ valor: null, trm: null, moneda: 'USD', vo: 12.5 });
    expect(hooks).toHaveLength(0);
    const res = await d.resumen(db, { mes: mesActual() }, ef);
    expect(res.total).toBe(0);
    expect(res.alertas.requiere_trm).toEqual([expect.objectContaining({ movimiento_id: r.movimiento_id, valor_usd: 12.5 })]);
    expect(res.pendientes).toEqual(expect.arrayContaining([{ estado: 'requiere_trm', cantidad: 1 }]));
    await expect(d.clasificar(db, { movimiento_id: r.movimiento_id!, categoria_id: 6, persona: 'miguel', reembolsable: false, respondido_por: 'miguel', canal: 'grupo' })).rejects.toThrow(/TRM/);

    ef.obtenerTrm = async () => ({ valor: TRM_FICTICIA, fuente: 'falsa' });
    expect((await d.respaldo(db, ef)).trm_resueltas).toBe(1);
    expect(await mov(r.movimiento_id!)).toMatchObject({ estado: 'por_preguntar', valor: 50000, t: TRM_FICTICIA });
    expect(hooks).toEqual([{ movimiento_id: r.movimiento_id, evento: 'nuevo' }]);
    expect((await d.resumen(db, { mes: mesActual() }, ef)).total).toBe(50000);
  });

  it('el resumen también reintenta la TRM antes de calcular', async () => {
    const { ef } = efectosFalsos();
    const r = await d.ingresarCorreo(db, ef, correo(compraUSD('USD 5.00')));
    expect(r.estado).toBe('requiere_trm'); // sin fuente de TRM configurada
    await cachear();
    const res = await d.resumen(db, { mes: mesActual() }, ef);
    expect(res.total).toBe(20000);
    expect(res.alertas.requiere_trm).toHaveLength(0);
  });

  it('USD en tarjeta individual con comercio verificado: se confirma solo, en COP', async () => {
    await cachear();
    const r = await d.ingresarCorreo(db, efectosFalsos().ef, correo(compraUSD('USD 15.99', 'NETFLIX.COM', '2222')));
    expect(r.estado).toBe('confirmado');
    expect(await mov(r.movimiento_id!)).toMatchObject({ valor: 63960, persona: 'miguel', clasificado_por: 'sistema' });
  });

  it('reverso en USD empareja por el valor original', async () => {
    await cachear();
    const { ef } = efectosFalsos();
    const a = await d.ingresarCorreo(db, ef, correo(compraUSD('USD 12.50')));
    const rev = await d.ingresarCorreo(db, ef, correo(`Bancolombia le informa Reverso de compra por USD 12.50 en AMAZON WEB SERVICES 09:10. ${fechaTexto()} T.Cred *1111.`));
    expect(rev).toMatchObject({ estado: 'descartado', movimiento_id: a.movimiento_id });
  });

  it('COP sin cambios: moneda COP, sin TRM', async () => {
    const r = await d.ingresarCorreo(db, efectosFalsos().ef, correo(F.compraBancolombia('PANADERIA X', '7.000')));
    expect(await mov(r.movimiento_id!)).toMatchObject({ moneda: 'COP', valor: 7000, vo: 7000, trm: null, trm_fecha: null });
    const t = await d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! });
    expect(t.movimiento?.valor_texto).toBe('$7.000 COP');
  });
});

describe('extractor en cuarentena con moneda', () => {
  const base = { tipo: 'compra', comercio: 'AMAZON', valor: 12.5, moneda: 'USD', fecha: HOY_ISO, ultimos_4_tarjeta: '1111' };
  it('valida la moneda y los decimales', () => {
    expect(validarExtraccion(base, HOY, ['1111']).ok).toBe(true);
    expect(validarExtraccion({ ...base, valor: 12.555 }, HOY, ['1111']).ok).toBe(false);
    expect(validarExtraccion({ ...base, moneda: 'EUR' }, HOY, ['1111']).ok).toBe(false);
    expect(validarExtraccion({ ...base, moneda: 'COP' }, HOY, ['1111']).ok).toBe(false); // COP debe ser entero
    const { moneda: _m, ...sinMoneda } = base;
    expect(validarExtraccion(sinMoneda, HOY, ['1111']).ok).toBe(false);
  });
  it('una salida en USD del extractor usa la TRM', async () => {
    await cachear();
    const { ef } = efectosFalsos(async () => base);
    const r = await d.ingresarCorreo(db, ef, correo(F.plantillaNueva));
    expect(r.estado).toBe('por_preguntar');
    expect(await mov(r.movimiento_id!)).toMatchObject({ moneda: 'USD', valor: 50000, fuente_interpretacion: 'llm_cuarentena' });
  });
});

describe('cliente de datos.gov.co', () => {
  const respuesta = (cuerpo: unknown, status = 200) => (async () => new Response(JSON.stringify(cuerpo), { status })) as any;
  it('lee valor y vigencia', async () => {
    const r = await obtenerTrmDatosGov('2026-01-02', respuesta([{ valor: '3999.50', vigenciadesde: '2026-01-02T00:00:00.000', vigenciahasta: '2026-01-02T00:00:00.000' }]));
    expect(r).toEqual({ valor: 3999.5, fuente: 'datos.gov.co 32sa-8pi3 vigencia 2026-01-02..2026-01-02' });
  });
  it('sin datos o valor absurdo → null; error HTTP → lanza', async () => {
    expect(await obtenerTrmDatosGov('2026-01-02', respuesta([]))).toBeNull();
    expect(await obtenerTrmDatosGov('2026-01-02', respuesta([{ valor: '4' }]))).toBeNull();
    await expect(obtenerTrmDatosGov('2026-01-02', respuesta({}, 503))).rejects.toThrow(/503/);
  });
});
