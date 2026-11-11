// Clasificación simple por WhatsApp: referencia en texto libre, persona por número,
// una sola pregunta con categorías numeradas y descarte de duplicadas reales.
// Reproduce el caso del grupo del 2026-11-06 con datos SINTÉTICOS (comercios y
// valores parecidos, números de prueba de test/apoyo.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, ejecutar } from '../mcp/servidor';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import type { Herramienta } from '../src/lib/esquemas';
import { ejecutarHerramienta } from '../src/lib/http';
import { categoriaDeTexto, elegir, valoresEnTexto } from '../src/lib/referencias';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

// Números de prueba (config destino_* de test/apoyo.ts), en el formato que entrega el canal.
const MIGUEL = '+57 000 000 0001';
const KATERINE = '+570000000002';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

const mov = async (id: string) => (await db.query('SELECT * FROM movimientos WHERE id = $1', [id])).rows[0];

async function compra(comercio: string, valor: string, ult4 = '1111') {
  const { ef } = efectosFalsos();
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `ref-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY, texto: F.compraBancolombia(comercio, valor, ult4),
  });
  return r.movimiento_id!;
}

/** Compra en la VISA compartida, preguntada por el flujo normal (sin texto: el servidor arma la pregunta). */
async function preguntada(comercio: string, valor: string, ult4 = '1111') {
  const { ef } = efectosFalsos();
  const id = await compra(comercio, valor, ult4);
  const t = await d.tomarMovimiento(db, { movimiento_id: id });
  const p = await d.preguntar(db, { movimiento_id: id });
  await d.confirmarEnvio(db, ef, { movimiento_id: id, pregunta_codigo: p.pregunta_codigo, whatsapp_message_id: `wa-${n}` });
  return { id, t, p };
}

describe('una sola pregunta con categorías numeradas', () => {
  it('"¿De qué fue?" con 2–3 opciones; la de droguería sugiere Salud primero', async () => {
    const { t, p } = await preguntada('DROGUERIA PASTEUR', '20.980');
    expect(t.categorias_sugeridas!.length).toBeGreaterThanOrEqual(2);
    expect(t.categorias_sugeridas!.length).toBeLessThanOrEqual(3);
    expect(t.categorias_sugeridas![0]).toMatchObject({ n: 1, nombre: 'Salud y bienestar' });
    expect(p.mensaje).toMatch(/^¿De qué fue esta compra de \$20\.980 en /);
    expect(p.mensaje).toContain('1. Salud y bienestar');
    expect(p.mensaje).toMatch(/Responde con el número o dime qué fue\.\n\(#[A-Z0-9]+\)$/);
  });

  it('acepta el número de la lista, el nombre o texto libre', async () => {
    const cats = [
      { id: 1, nombre: 'Supermercado y mercado' }, { id: 2, nombre: 'Restaurantes y domicilios' },
      { id: 5, nombre: 'Salud y bienestar' }, { id: 11, nombre: 'Otros / pagos a comercios' },
    ];
    expect(categoriaDeTexto('2', cats, [5, 1, 11])).toBe(1);
    expect(categoriaDeTexto('la 3', cats, [5, 1, 11])).toBe(11);
    expect(categoriaDeTexto('esta compra es mercado', cats, [5, 1, 11])).toBe(1);
    expect(categoriaDeTexto('fue en la droguería, unas medicinas', cats, [])).toBe(5);
    expect(categoriaDeTexto('Restaurantes y domicilios', cats, [])).toBe(2);
    expect(categoriaDeTexto('fue una pizza', cats, [5, 1, 11])).toBe(2);
    expect(categoriaDeTexto('no sé, algo raro', cats, [5, 1, 11])).toBeNull();
    expect(categoriaDeTexto('7', cats, [5, 1, 11])).toBeNull();
  });

  it('valores en el texto: puntos, comas, "mil"; ignora fechas y números chicos', () => {
    expect(valoresEnTexto('la de 147.750')).toEqual([147750]);
    expect(valoresEnTexto('$20,980 del 06/11/2026')).toEqual([20980]);
    expect(valoresEnTexto('la de 147 mil y la de 3 cuotas')).toEqual([147000]);
    expect(valoresEnTexto('147750')).toEqual([147750]);
  });
});

describe('referencia en texto libre', () => {
  it('única: por valor, por comercio o "la última" → actúa sin id', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('DROGUERIA PASTEUR', '20.980');
    const r1 = await d.clasificar(db, { referencia: 'la de 147.750', categoria: 'mercado', numero_remitente: MIGUEL, canal: 'grupo' });
    expect(r1).toMatchObject({ aplicado: true, categoria: 'Supermercado y mercado', persona: 'miguel', metodo: 'valor' });
    expect(await mov(a.id)).toMatchObject({ estado: 'confirmado', categoria_id: 1, persona: 'miguel', clasificado_por: 'miguel' });
    const r2 = await d.cambiarCuotas(db, { referencia: 'la de pasteur', cuotas: 3 });
    expect(r2).toMatchObject({ aplicado: true, cuotas: 3 });
    expect((await mov(b.id)).cuotas).toBe(3);
    // "la última": la más reciente (misma fecha → la última creada)
    const r3 = await d.clasificar(db, { referencia: 'la última', categoria: '1', numero_remitente: KATERINE, canal: 'grupo' });
    expect(r3).toMatchObject({ aplicado: true, persona: 'katerine' });
  });

  it('respuesta sin código con una sola compra esperando: se aplica a esa', async () => {
    const a = await preguntada('DROGUERIA PASTEUR', '20.980');
    const r = await d.clasificar(db, { categoria: '1', numero_remitente: KATERINE, canal: 'grupo' });
    expect(r).toMatchObject({ aplicado: true, metodo: 'unico_pendiente', categoria: 'Salud y bienestar', persona: 'katerine' });
    expect((await mov(a.id)).estado).toBe('confirmado');
  });

  it('ambigua: varias esperando y nada que las distinga → lista numerada sin ids en el texto, nada cambia', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('DROGUERIA PASTEUR', '20.980');
    const r: any = await d.clasificar(db, { categoria: 'mercado', numero_remitente: MIGUEL, canal: 'grupo' });
    expect(r).toMatchObject({ aplicado: false, motivo: 'ambigua' });
    expect(r.opciones.map((o: any) => o.n)).toEqual([1, 2]);
    expect(r.opciones.map((o: any) => o.descripcion).join(' ')).toMatch(/147\.750.*20\.980|20\.980.*147\.750/);
    for (const o of r.opciones) expect(o.descripcion).not.toContain(o.movimiento_id);
    expect((await mov(a.id)).estado).toBe('esperando_respuesta');
    expect((await mov(b.id)).estado).toBe('esperando_respuesta');
    // Con la opción elegida, el agente usa el movimiento_id de esa opción.
    const elegido = r.opciones.find((o: any) => o.descripcion.includes('147.750'));
    expect(await d.clasificar(db, { movimiento_id: elegido.movimiento_id, categoria: 'mercado', numero_remitente: MIGUEL, canal: 'grupo' })).toMatchObject({ aplicado: true });
    expect((await mov(a.id)).estado).toBe('confirmado');
  });

  it('ninguna: un valor que no existe → lo dice y muestra las pendientes; nada cambia', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const r: any = await d.clasificar(db, { referencia: 'la de 99.999', categoria: '1', numero_remitente: MIGUEL, canal: 'grupo' });
    expect(r).toMatchObject({ aplicado: false, motivo: 'ninguna' });
    expect(r.mensaje).toContain('99.999');
    expect(r.opciones).toHaveLength(1);
    expect((await mov(a.id)).estado).toBe('esperando_respuesta');
  });

  it('elegir es pura: con varias por valor y una sola pendiente, toma la pendiente', () => {
    const base = { fecha: '2026-11-06', moneda: 'COP', valor_original: null, trm: null, trm_fecha: null, tarjeta_id: 'v', tarjeta: 'VISA', descripcion_original: null, pregunta_codigo: null };
    const s = elegir('la de 50.000', [
      { ...base, movimiento_id: 'a', estado: 'confirmado', valor: 50000, comercio: 'Tienda D1' },
      { ...base, movimiento_id: 'b', estado: 'esperando_respuesta', valor: 50000, comercio: 'Carulla' },
      { ...base, movimiento_id: 'c', estado: 'esperando_respuesta', valor: 8000, comercio: 'Ara' },
    ]);
    expect(s).toMatchObject({ tipo: 'unica', movimiento: { movimiento_id: 'b' } });
  });
});

describe('persona por defecto', () => {
  it('compartida: quien responde por su número; si el mensaje dice otra persona, esa', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('DROGUERIA PASTEUR', '20.980');
    await d.clasificar(db, { referencia: 'farmatodo', categoria: 'salud', numero_remitente: KATERINE, canal: 'grupo' });
    expect(await mov(a.id)).toMatchObject({ persona: 'katerine', clasificado_por: 'katerine' });
    await d.clasificar(db, { referencia: 'pasteur', categoria: 'salud', persona: 'miguel', numero_remitente: KATERINE, canal: 'grupo' });
    expect(await mov(b.id)).toMatchObject({ persona: 'miguel', clasificado_por: 'katerine' });
  });

  it('individual: manda la dueña de la tarjeta aunque responda la otra persona', async () => {
    const id = await compra('MERCADO PAGO*TIENDA', '35.000', '4444'); // Plata Pay Katerine, genérico: pregunta
    await d.tomarMovimiento(db, { movimiento_id: id });
    await d.preguntar(db, { movimiento_id: id });
    const r = await d.clasificar(db, { movimiento_id: id, categoria: 'restaurante', numero_remitente: MIGUEL, persona: 'miguel', canal: 'grupo' });
    expect(r).toMatchObject({ aplicado: true, persona: 'katerine' });
  });

  it('el número manda sobre el nombre; un número ajeno sin nombre se rechaza', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    await d.clasificar(db, { categoria: '1', respondido_por: 'katerine', numero_remitente: MIGUEL, canal: 'grupo' });
    expect((await mov(a.id)).clasificado_por).toBe('miguel');
    await expect(d.clasificar(db, { categoria: '1', numero_remitente: '+573999999999', canal: 'grupo' })).rejects.toThrow(/no corresponde/);
    await expect(d.clasificar(db, { categoria: '1', canal: 'grupo' })).rejects.toThrow(/respondido_por o numero_remitente/);
  });
});

describe('descartar como duplicada', () => {
  it('falso duplicado (Farmatodo y Pasteur): no descarta nada y muestra las compras', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('DROGUERIA PASTEUR', '20.980');
    const r: any = await d.descartarMovimiento(db, efectosFalsos().ef, { referencia: 'están repetidas borra una', motivo: 'duplicada', numero_remitente: MIGUEL });
    expect(r).toMatchObject({ aplicado: false, motivo: 'sin_duplicado' });
    expect(r.opciones).toHaveLength(2);
    expect((await mov(a.id)).estado).toBe('esperando_respuesta');
    expect((await mov(b.id)).estado).toBe('esperando_respuesta');
    // Con un id directo tampoco: no hay gemela.
    expect(await d.descartarMovimiento(db, efectosFalsos().ef, { movimiento_id: a.id, motivo: 'duplicada' })).toMatchObject({ aplicado: false, motivo: 'sin_duplicado' });
  });

  it('duplicado real (mismo valor, fecha y tarjeta): descarta una sin pedir id y conserva la otra', async () => {
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('FARMATODO CALLE 80', '147.750');
    await preguntada('DROGUERIA PASTEUR', '20.980');
    const r: any = await d.descartarMovimiento(db, efectosFalsos().ef, { referencia: 'están repetidas borra una', motivo: 'duplicada', numero_remitente: MIGUEL });
    expect(r).toMatchObject({ aplicado: true, estado: 'descartado' });
    expect(r.se_conserva).toContain('147.750');
    const estados = [(await mov(a.id)).estado, (await mov(b.id)).estado].sort();
    expect(estados).toEqual(['descartado', 'esperando_respuesta']);
    const desc = (await db.query(`SELECT instruido_por, motivo_descarte FROM movimientos m JOIN bitacora b ON b.movimiento_id = m.id AND b.accion = 'descartar' WHERE m.estado = 'descartado'`)).rows[0];
    expect(desc).toEqual({ instruido_por: 'miguel', motivo_descarte: 'duplicada' });
  });

  it('misma compra en otra tarjeta no es duplicada', async () => {
    await preguntada('FARMATODO CALLE 80', '147.750', '1111');
    await preguntada('FARMATODO CALLE 80', '147.750', '3333');
    const r: any = await d.descartarMovimiento(db, efectosFalsos().ef, { referencia: 'la de 147.750', motivo: 'duplicada' });
    expect(r).toMatchObject({ aplicado: false, motivo: 'sin_duplicado' });
  });
});

describe('MCP sin ids', () => {
  it('clasificar y reasignar por referencia a través del MCP; reasignar ambigua no envía nada', async () => {
    const { ef } = efectosFalsos();
    const enviados: string[] = [];
    const cfg: Config = {
      token: 't',
      urls: Object.fromEntries(['clasificar', 'reasignar_pregunta', 'confirmar_envio'].map((h) => [h, `http://api/${h}`])),
      enviar: async (_t, m) => (enviados.push(m), `wa-mcp-${enviados.length}`),
      fetch: (async (url: string, init: any) => {
        const { entrada, contexto } = JSON.parse(init.body);
        const r = await ejecutarHerramienta(url.split('/').pop() as Herramienta, entrada, contexto, db, ef);
        return new Response(r.body, { status: r.statusCode });
      }) as any,
    };
    const a = await preguntada('FARMATODO CALLE 80', '147.750');
    const b = await preguntada('DROGUERIA PASTEUR', '20.980');
    expect(await ejecutar(cfg, 'reasignar_pregunta', { persona_destino: 'katerine' })).toMatchObject({ aplicado: false, motivo: 'ambigua' });
    expect(enviados).toHaveLength(0);
    expect(await ejecutar(cfg, 'reasignar_pregunta', { referencia: 'pasteur', persona_destino: 'katerine' })).toMatch(/FIN$/);
    expect(enviados[0]).toContain('1. Salud y bienestar');
    expect(await mov(b.id)).toMatchObject({ preguntado_a: 'katerine', whatsapp_message_id: 'wa-mcp-1' });
    expect(await ejecutar(cfg, 'clasificar', { referencia: 'farmatodo', categoria: 'mercado', numero_remitente: MIGUEL, canal: 'grupo' })).toMatchObject({ aplicado: true });
    expect((await mov(a.id)).estado).toBe('confirmado');
  });
});
