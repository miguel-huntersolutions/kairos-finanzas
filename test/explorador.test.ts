// Tablero unificado (antes explorador VISA): endpoints (datos y reclasificar) y cálculos iguales al HTML.
// Datos SINTÉTICOS; código y secreto falsos.
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE, firmarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import { comercioDe, datosExplorador, personaDe, reclasificarExplorador } from '../src/lib/explorador';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { OTROS, type Mov, filtrar, kpisMes, kpisReclasificar, kpisResumen, topComercios } from '../web/lib/explorador/calculos';
import { nuevaDb } from './apoyo';

const env = { TABLERO_CORREOS: 'ana@ejemplo.com,beto@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-explorador-0123456789', TABLERO_PERSONAS: 'beto@ejemplo.com=katerine,ana@ejemplo.com=miguel' };
const HOST = 'tablero.ejemplo';
let db: Db;
const ids: Record<string, string> = {};

async function mov(clave: string, o: { fecha: string; valor: number; cat: number; nota?: string; desc: string; estado?: string; tarjeta?: string }) {
  const { rows } = await db.query(
    `INSERT INTO movimientos (fecha, valor, categoria_id, nota, descripcion_original, estado, tarjeta_id, fuente, clasificado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'extracto', 'sistema') RETURNING id`,
    [o.fecha, o.valor, o.cat, o.nota ?? null, o.desc, o.estado ?? 'confirmado', o.tarjeta ?? 'visa-bancolombia'],
  );
  ids[clave] = rows[0].id;
}

beforeEach(async () => {
  ({ db } = await nuevaDb());
  await mov('d1a', { fecha: '2026-01-05', valor: 45_000, cat: 1, desc: 'TIENDA D1 LOMA ES' });
  await mov('d1b', { fecha: '2026-02-07', valor: 18_000, cat: 1, desc: 'TIENDA D1 ENV LYON' });
  await mov('mp1', { fecha: '2026-01-10', valor: 120_000, cat: 11, nota: 'Comercio: MercadoPago', desc: 'MERCADOPAGO*TIENDAX' });
  await mov('mp2', { fecha: '2026-02-11', valor: 9_000, cat: 11, nota: 'Comercio: MercadoPago', desc: 'MERCADOPAGO*OTRA' });
  await mov('pan', { fecha: '2026-02-12', valor: 7_500, cat: 2, desc: 'PANADERIA LA ESQUINA 004512' });
  await mov('desc', { fecha: '2026-02-13', valor: 999_000, cat: 11, desc: 'COMPRA DUPLICADA', estado: 'descartado' });
  await mov('esp', { fecha: '2026-02-14', valor: 5_000, cat: 11, desc: 'PENDIENTE', estado: 'esperando_respuesta' });
  await mov('otra', { fecha: '2026-02-15', valor: 33_000, cat: 11, desc: 'OTRA TARJETA', tarjeta: 'plata-pay-miguel' });
});

const quienAna = { correo: 'ana@ejemplo.com', persona: 'miguel' as const };

describe('GET /explorador/datos', () => {
  it('todas las tarjetas y estados salvo descartados, sin campos de más', async () => {
    const d = await datosExplorador(db);
    expect(d.movimientos.map((m) => m.id).sort()).toEqual([ids.d1a, ids.d1b, ids.mp1, ids.mp2, ids.pan, ids.esp, ids.otra].sort());
    expect(Object.keys(d.movimientos[0]).sort()).toEqual(['categoria', 'categoria_id', 'categoria_inicial', 'comercio', 'cuenta', 'cuotas', 'desc', 'duplicado_de', 'estado', 'estado_vista',
      'fecha', 'fuente', 'grupo', 'id', 'mes', 'no_aparece', 'persona', 'por_conciliar', 'reclasificable', 'tarjeta', 'tarjeta_id', 'valor']);
    expect(d.tarjetas.map((t) => t.id).sort()).toEqual(['plata-pay-miguel', 'visa-bancolombia']);
    expect(d.meses).toEqual([{ mes: '2026-01', etiqueta: 'ene 26' }, { mes: '2026-02', etiqueta: 'feb 26' }]);
    expect(d.categorias.find((c) => c.id === 11)?.nombre).toBe(OTROS);
    const porId = new Map(d.movimientos.map((m) => [m.id, m]));
    expect(porId.get(ids.mp1)?.comercio).toBe('MercadoPago'); // de la nota
    expect(porId.get(ids.d1a)?.comercio).toBe('Tienda D1'); // por patrón conocido
    expect(porId.get(ids.pan)?.comercio).toBe('PANADERIA LA ESQUINA'); // descripción limpia
    expect(JSON.stringify(d)).not.toContain('Comercio:'); // la nota no sale
  });

  it('por HTTP exige sesión válida', async () => {
    const ev = (cookie?: string): EventoRuta => ({ __evento_http: true, method: 'GET', path: '/explorador/datos', headers: cookie ? { cookie: [cookie] } : {}, request_context: { host: HOST } });
    expect((await manejarTablero(ev(), { db: () => db, env })).statusCode).toBe(401);
    const r = await manejarTablero(ev(`${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET)}`), { db: () => db, env });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).movimientos).toHaveLength(7);
  });
});

describe('POST /explorador/reclasificar', () => {
  it('por movimiento: actualiza, registra quién y cuándo, y deshacer devuelve el valor', async () => {
    const r = await reclasificarExplorador(db, { movimiento_id: ids.mp1, categoria_id: 3 }, quienAna);
    expect(r).toEqual({ actualizados: 1, cambios: [{ movimiento_id: ids.mp1, antes: 11, despues: 3 }] });
    expect((await db.query('SELECT categoria_id, clasificado_por FROM movimientos WHERE id = $1', [ids.mp1])).rows[0]).toEqual({ categoria_id: 3, clasificado_por: 'miguel' });
    const b = (await db.query(`SELECT actor, instruido_por, accion, antes, despues, creado_en FROM bitacora WHERE movimiento_id = $1`, [ids.mp1])).rows[0];
    expect(b).toMatchObject({ actor: 'miguel', instruido_por: 'ana@ejemplo.com', accion: 'reclasificar_explorador', antes: { categoria_id: 11 }, despues: { categoria_id: 3, via: 'movimiento' } });
    expect(b.creado_en).toBeTruthy();
    await reclasificarExplorador(db, { cambios: [{ movimiento_id: ids.mp1, categoria_id: 11 }] }, quienAna);
    const d = await datosExplorador(db);
    expect(d.movimientos.find((m) => m.id === ids.mp1)).toMatchObject({ categoria: OTROS, categoria_inicial: OTROS });
  });

  it('por comercio: mueve todas sus compras confirmadas; categoría inicial se conserva', async () => {
    const r = await reclasificarExplorador(db, { comercio: 'MercadoPago', categoria_id: 7 }, { correo: 'beto@ejemplo.com', persona: personaDe('beto@ejemplo.com', env.TABLERO_PERSONAS) });
    expect(r.actualizados).toBe(2);
    const d = await datosExplorador(db);
    expect(d.movimientos.filter((m) => m.comercio === 'MercadoPago').map((m) => [m.categoria, m.categoria_inicial])).toEqual([['Entretenimiento', OTROS], ['Entretenimiento', OTROS]]);
    expect((await db.query('SELECT DISTINCT clasificado_por FROM movimientos WHERE id = ANY($1::uuid[])', [[ids.mp1, ids.mp2]])).rows).toEqual([{ clasificado_por: 'katerine' }]);
  });

  it('valida categoría y estado; no toca descartados ni pendientes', async () => {
    await expect(reclasificarExplorador(db, { movimiento_id: ids.mp1, categoria_id: 999 }, quienAna)).rejects.toThrow(/categoría/);
    await expect(reclasificarExplorador(db, { movimiento_id: ids.desc, categoria_id: 1 }, quienAna)).rejects.toThrow(/descartado o pendiente/);
    await expect(reclasificarExplorador(db, { movimiento_id: ids.esp, categoria_id: 1 }, quienAna)).rejects.toThrow(/descartado o pendiente/);
    await expect(reclasificarExplorador(db, { movimiento_id: ids.mp1, categoria_id: 1, extra: 1 }, quienAna)).rejects.toThrow(/entrada/);
    await db.query(`UPDATE categorias SET estado = 'inactiva' WHERE id = 10`);
    await expect(reclasificarExplorador(db, { movimiento_id: ids.mp1, categoria_id: 10 }, quienAna)).rejects.toThrow(/inactiva/);
    expect((await db.query('SELECT count(*)::int AS n FROM bitacora')).rows[0].n).toBe(0);
  });

  it('por HTTP: sin sesión 401, otro origen 403, errores con su estado', async () => {
    const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET)}`;
    const ev = (cuerpo: unknown, o: { cookie?: string; origen?: string } = {}): EventoRuta => ({
      __evento_http: true, method: 'POST', path: '/explorador/reclasificar', body: JSON.stringify(cuerpo),
      headers: { origin: [o.origen ?? `https://${HOST}`], ...(o.cookie ? { cookie: [o.cookie] } : {}) }, request_context: { host: HOST },
    });
    const deps = { db: () => db, env };
    expect((await manejarTablero(ev({ movimiento_id: ids.mp1, categoria_id: 3 }), deps)).statusCode).toBe(401);
    expect((await manejarTablero(ev({ movimiento_id: ids.mp1, categoria_id: 3 }, { cookie, origen: 'https://otro.ejemplo' }), deps)).statusCode).toBe(403);
    expect((await manejarTablero(ev({ movimiento_id: ids.esp, categoria_id: 3 }, { cookie }), deps)).statusCode).toBe(404);
    expect((await manejarTablero(ev({ movimiento_id: ids.mp1, categoria_id: 999 }, { cookie }), deps)).statusCode).toBe(400);
    expect((await manejarTablero(ev({ movimiento_id: ids.mp1, categoria_id: 3 }, { cookie }), deps)).statusCode).toBe(200);
  });

  it('comercio: nota primero, luego patrón, luego descripción limpia', () => {
    const comercios = [{ id: 1, nombre: 'Uber', patrones: ['UBER RIDES'] }];
    expect(comercioDe('Comercio: Rappi\nOtra cosa', 'RAPPI*COL', comercios)).toBe('Rappi');
    expect(comercioDe(null, 'UBER RIDES BOGOTA', comercios)).toBe('Uber');
    expect(comercioDe(null, 'ferreteria  el tornillo   88213', comercios)).toBe('FERRETERIA EL TORNILLO');
  });
});

describe('cálculos iguales al HTML', () => {
  const m = (id: string, mes: string, valor: number, categoria: string, comercio: string, ini = categoria): Mov => ({
    id, mes, fecha: `${mes}-10`, desc: comercio.toUpperCase(), comercio, valor, cuotas: 1, categoria_id: null, categoria, categoria_inicial: ini,
  });
  const movs = [
    m('1', '2026-01', 15_000, OTROS, 'Kiosco'), m('2', '2026-01', 80_000, 'Supermercado y mercado', 'Tienda D1'),
    m('3', '2026-02', 250_000, OTROS, 'MercadoPago', OTROS), m('4', '2026-02', 20_000, 'Restaurantes y domicilios', 'Café'),
    m('5', '2026-02', 100_000, 'Transporte y viajes', 'Uber', OTROS), m('6', '2026-02', 20_001, 'Supermercado y mercado', 'Tienda D1'),
  ];
  const f0 = { mes: '', cat: '', monto: '' as const, q: '' };

  it('filtros de monto y búsqueda con los mismos cortes del HTML', () => {
    expect(filtrar(movs, { ...f0, monto: 'h' }).map((x) => x.id)).toEqual(['1', '4']); // ≤ 20.000
    expect(filtrar(movs, { ...f0, monto: 'p' }).map((x) => x.id)).toEqual(['1', '2', '4', '5', '6']); // ≤ 100.000
    expect(filtrar(movs, { ...f0, monto: 'g' }).map((x) => x.id)).toEqual(['3']); // > 100.000
    expect(filtrar(movs, { ...f0, q: 'd1' }).map((x) => x.id)).toEqual(['2', '6']);
    expect(filtrar(movs, { ...f0, mes: '2026-01', cat: OTROS }, { ignoreCat: true }).map((x) => x.id)).toEqual(['1', '2']);
  });

  it('KPIs de Resumen: consumo, por corte, hormiga y «Otros»', () => {
    const k = kpisResumen(movs);
    const total = 15_000 + 80_000 + 250_000 + 20_000 + 100_000 + 20_001;
    expect(k).toMatchObject({ total, compras: 6, meses: 2, porMes: total / 2, promedio: total / 6 });
    expect(k.hormiga).toEqual({ total: 35_000, compras: 2, pct: 35_000 / total });
    expect(k.otros).toEqual({ total: 265_000, pct: 265_000 / total });
    expect(kpisResumen([])).toMatchObject({ total: 0, compras: 0, meses: 1, otros: { total: 0, pct: 0 } });
  });

  it('KPIs del mes frente al anterior y de Reclasificar', () => {
    const k = kpisMes(movs.filter((x) => x.mes === '2026-02'), movs.filter((x) => x.mes === '2026-01'));
    expect(k).toEqual({ consumo: { actual: 390_001, anterior: 95_000 }, compras: { actual: 4, anterior: 2 }, hormiga: { actual: 20_000, anterior: 15_000, compras: 1 } });
    const r = kpisReclasificar(movs);
    expect(r).toMatchObject({ otrosOrig: 365_000, otrosNow: 265_000, comprasAjustadas: 1, comerciosAjustados: 1 });
    expect(topComercios(movs, 2)).toEqual([{ k: 'MercadoPago', t: 250_000, n: 1, c: OTROS }, { k: 'Tienda D1', t: 100_001, n: 2, c: 'Supermercado y mercado' }]);
  });
});
