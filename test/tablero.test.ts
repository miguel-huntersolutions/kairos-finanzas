// Tablero: acceso por lista de correos y datos en COP (con el USD original). Datos SINTÉTICOS.
import { describe, expect, it } from 'vitest';
import * as d from '../src/lib/dominio';
import { correoPermitido, datosTablero, mesBogota } from '../src/lib/tablero';
import { handler } from '../src/functions/tablero';
import { HOY, efectosFalsos, fechaTexto, mesActual, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';
import { fechaISO } from '../src/lib/texto';

describe('acceso al tablero', () => {
  it('solo correos de la lista; sin lista nadie entra', () => {
    expect(correoPermitido('Ana@Ejemplo.com', 'ana@ejemplo.com, beto@ejemplo.com')).toBe(true);
    expect(correoPermitido('otro@ejemplo.com', 'ana@ejemplo.com')).toBe(false);
    expect(correoPermitido('ana@ejemplo.com', undefined)).toBe(false);
    expect(correoPermitido(undefined, 'ana@ejemplo.com')).toBe(false);
  });
  it('la función rechaza sin sesión (401), sin configuración (503) y eventos no HTTP (400)', async () => {
    const ev = { __evento_http: true, method: 'GET', path: '/datos', headers: {}, request_context: { host: 'tablero.ejemplo' } };
    delete process.env.TABLERO_CODIGO;
    expect((await handler(ev as any)).statusCode).toBe(503);
    process.env.TABLERO_CORREOS = 'ana@ejemplo.com';
    process.env.TABLERO_CODIGO = '000000'; // valor falso, solo de prueba
    process.env.TABLERO_SESION_SECRET = 'secreto-falso-de-prueba-0123456789';
    expect((await handler(ev as any)).statusCode).toBe(401);
    expect((await handler({} as any)).statusCode).toBe(400);
  });
  it('mes de Bogotá', () => {
    expect(mesBogota(new Date('2026-12-01T03:00:00Z'))).toBe('2026-11'); // aún 30-nov en Bogotá
  });
});

describe('datos del tablero', () => {
  it('totales en COP, tendencia, categorías por mes, USD con su original y sin asunto del correo', async () => {
    const { db } = await nuevaDb();
    const { ef } = efectosFalsos();
    await db.query(`INSERT INTO trm (fecha, valor, fuente) VALUES ($1, 4000, 'prueba')`, [fechaISO(fechaTexto())]);
    await d.ingresarCorreo(db, ef, { correo_id: 't1', remitente: F.BANCOLOMBIA, asunto: 'ASUNTO-SECRETO', fecha_correo: HOY, texto: F.compraBancolombia('TIENDA D1 X', '40.000', '2222') });
    await d.ingresarCorreo(db, ef, { correo_id: 't2', remitente: F.BANCOLOMBIA, asunto: 'ASUNTO-SECRETO', fecha_correo: HOY, texto: `Bancolombia le informa Compra por USD 10.00 en NETFLIX.COM 14:32. ${fechaTexto()} T.Cred *4444.` });
    await d.ingresarCorreo(db, ef, { correo_id: 't3', remitente: 'alertas@desconocido.co', asunto: 'ASUNTO-SECRETO', fecha_correo: HOY, texto: F.correoMalicioso });

    const t = await datosTablero(db, mesActual());
    expect(t.resumen.total).toBe(80000);
    expect(t.tendencia.at(-1)).toMatchObject({ mes: mesActual(), total: 80000, cantidad: 2, compras_usd: 1 });
    expect(t.categorias_por_mes).toEqual(expect.arrayContaining([expect.objectContaining({ categoria: 'Supermercado y mercado', total: 40000 })]));
    const usd = t.movimientos.find((m: any) => m.moneda === 'USD');
    expect(usd).toMatchObject({ valor: 40000, valor_original: 10, valor_texto: expect.stringContaining('USD 10,00') });
    expect(t.resumen.alertas.requiere_revision).toHaveLength(1);
    expect(JSON.stringify(t)).not.toContain('ASUNTO-SECRETO');
  });
});
