// Tablero unificado: estados derivados, posible duplicado de extracto, totales sin doble
// conteo, filtros de mes y tarjeta, "Por atender" y reclasificar en cualquier tarjeta.
// Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import { estadoVista, posiblesDuplicados } from '../src/lib/conciliacion';
import type { Db } from '../src/lib/db';
import { datosExplorador, reclasificarExplorador } from '../src/lib/explorador';
import { type Mov, filtrar, kpisResumen, suma } from '../web/lib/explorador/calculos';
import { nuevaDb } from './apoyo';

describe('estado visible derivado de fuente + estado', () => {
  it('extracto = Conciliado, manual = Manual, correo = flujo + Por conciliar', () => {
    expect(estadoVista('extracto', 'confirmado')).toEqual({ etiqueta: 'Conciliado', por_conciliar: false, grupo: 'conciliado' });
    expect(estadoVista('manual', 'confirmado')).toEqual({ etiqueta: 'Manual', por_conciliar: false, grupo: 'manual' });
    expect(estadoVista('correo', 'esperando_respuesta')).toEqual({ etiqueta: 'Esperando respuesta', por_conciliar: true, grupo: 'pendiente' });
    expect(estadoVista('correo', 'requiere_revision')).toEqual({ etiqueta: 'Requiere revisión', por_conciliar: true, grupo: 'pendiente' });
    expect(estadoVista('correo', 'confirmado')).toEqual({ etiqueta: 'Confirmado', por_conciliar: true, grupo: 'por_conciliar' });
    // Fase de conciliación: con conciliado_con deja de estar "por conciliar".
    expect(estadoVista('correo', 'confirmado', '00000000-0000-4000-8000-000000000001')).toMatchObject({ por_conciliar: false, grupo: 'conciliado' });
  });
});

describe('posible duplicado de extracto', () => {
  const f = (id: string, fuente: string, tarjeta_id: string | null, valor: number, fecha: string) => ({ id, fuente, tarjeta_id, valor, fecha });

  it('misma tarjeta, mismo valor y fecha a ±3 días → duplicado; si falta algo, no', () => {
    const d = posiblesDuplicados([
      f('e1', 'extracto', 'visa', 50_000, '2026-10-10'),
      f('c-real', 'correo', 'visa', 50_000, '2026-10-08'), // 2 días antes
      f('e2', 'extracto', 'visa', 70_000, '2026-10-10'),
      f('c-4dias', 'correo', 'visa', 70_000, '2026-10-14'), // 4 días: fuera de la ventana
      f('e3', 'extracto', 'visa', 90_000, '2026-10-10'),
      f('c-otratarjeta', 'correo', 'master', 90_000, '2026-10-10'),
      f('c-otrovalor', 'correo', 'visa', 90_001, '2026-10-10'),
      f('c-sintarjeta', 'correo', null, 90_000, '2026-10-10'),
      f('m1', 'manual', 'visa', 90_000, '2026-10-10'), // solo el correo se marca
    ]);
    expect([...d]).toEqual([['c-real', 'e1']]);
  });

  it('uno a uno: dos correos iguales y una sola fila del extracto → solo el más cercano', () => {
    const d = posiblesDuplicados([
      f('e1', 'extracto', 'visa', 20_000, '2026-11-03'),
      f('c-lejos', 'correo', 'visa', 20_000, '2026-11-01'),
      f('c-cerca', 'correo', 'visa', 20_000, '2026-11-03'),
    ]);
    expect([...d]).toEqual([['c-cerca', 'e1']]);
  });

  it('cruza el cambio de mes (31 oct ↔ 2 nov)', () => {
    expect([...posiblesDuplicados([f('e', 'extracto', 'visa', 1000, '2026-11-02'), f('c', 'correo', 'visa', 1000, '2026-10-31')])]).toEqual([['c', 'e']]);
  });
});

describe('datos del tablero unificado', () => {
  let db: Db;
  const ids: Record<string, string> = {};
  async function mov(clave: string, o: { fecha: string | null; valor: number | null; fuente: string; tarjeta?: string | null; estado?: string; cat?: number | null; desc?: string; nota?: string }) {
    const { rows } = await db.query(
      `INSERT INTO movimientos (fecha, valor, categoria_id, descripcion_original, estado, tarjeta_id, fuente, nota, clasificado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sistema') RETURNING id`,
      [o.fecha, o.valor, o.cat === undefined ? 2 : o.cat, o.desc ?? `COMERCIO ${clave.toUpperCase()}`, o.estado ?? 'confirmado',
        o.tarjeta === undefined ? 'visa-bancolombia' : o.tarjeta, o.fuente, o.nota ?? null],
    );
    ids[clave] = rows[0].id;
  }

  beforeEach(async () => {
    ({ db } = await nuevaDb());
    // Octubre: extracto de la VISA (Conciliado) y un correo de la misma compra.
    await mov('ext1', { fecha: '2026-10-10', valor: 100_000, fuente: 'extracto' });
    await mov('ext2', { fecha: '2026-10-20', valor: 40_000, fuente: 'extracto', cat: 3 });
    await mov('dup', { fecha: '2026-10-08', valor: 100_000, fuente: 'correo' }); // posible duplicado de ext1
    // Noviembre: compras por correo sin extracto todavía.
    await mov('nov1', { fecha: '2026-11-05', valor: 147_750, fuente: 'correo' });
    await mov('nov2', { fecha: '2026-11-06', valor: 20_980, fuente: 'correo', estado: 'esperando_respuesta', cat: null });
    await mov('plata', { fecha: '2026-11-04', valor: 15_000, fuente: 'correo', tarjeta: 'plata-pay-katerine', cat: 3 });
    await mov('manual', { fecha: '2026-11-02', valor: 8_000, fuente: 'manual', tarjeta: null });
    await mov('desc', { fecha: '2026-11-03', valor: 999_000, fuente: 'correo', estado: 'descartado' });
    await mov('rev', { fecha: null, valor: null, fuente: 'correo', estado: 'requiere_revision', tarjeta: null, cat: null, nota: 'tarjeta desconocida' });
  });

  const sinFiltros = { mes: '', cat: '', monto: '' as const, q: '' };

  it('estado por compra, posible duplicado marcado y totales sin doble conteo', async () => {
    const d = await datosExplorador(db);
    const por = new Map(d.movimientos.map((m) => [m.id, m]));
    expect(por.has(ids.desc)).toBe(false); // descartado: ni se ve ni suma
    expect(por.has(ids.rev)).toBe(false); // sin valor ni fecha: va en "Por atender"
    expect(por.get(ids.ext1)).toMatchObject({ estado_vista: 'Conciliado', grupo: 'conciliado', por_conciliar: false, cuenta: true, fuente: 'extracto' });
    expect(por.get(ids.dup)).toMatchObject({ duplicado_de: ids.ext1, cuenta: false, por_conciliar: true });
    expect(por.get(ids.nov1)).toMatchObject({ estado_vista: 'Confirmado', grupo: 'por_conciliar', por_conciliar: true, cuenta: true });
    expect(por.get(ids.nov2)).toMatchObject({ estado_vista: 'Esperando respuesta', grupo: 'pendiente', reclasificable: false });
    expect(por.get(ids.manual)).toMatchObject({ estado_vista: 'Manual', tarjeta: 'Sin tarjeta' });

    const movs = d.movimientos as Mov[];
    // Octubre: 100.000 + 40.000 (el correo duplicado no suma).
    const oct = filtrar(movs, { ...sinFiltros, mes: '2026-10' });
    expect(oct.map((m) => m.id).sort()).toEqual([ids.ext1, ids.ext2].sort());
    expect(suma(oct)).toBe(140_000);
    expect(kpisResumen(oct)).toMatchObject({ total: 140_000, compras: 2 });
    // La tabla de Movimientos sí lo muestra, pero el total sigue sin contarlo.
    const octTabla = filtrar(movs, { ...sinFiltros, mes: '2026-10' }, { conDuplicados: true });
    expect(octTabla).toHaveLength(3);
    expect(suma(octTabla)).toBe(140_000);
    // Total general: todas las fuentes, sin descartados ni duplicados.
    expect(suma(filtrar(movs, sinFiltros))).toBe(100_000 + 40_000 + 147_750 + 20_980 + 15_000 + 8_000);
  });

  it('filtros de mes, tarjeta y estado', async () => {
    const movs = (await datosExplorador(db)).movimientos as Mov[];
    const ids_ = (f: Partial<typeof sinFiltros & { tarjeta: string; estado: any }>) => filtrar(movs, { ...sinFiltros, ...f }).map((m) => m.id).sort();
    expect(ids_({ mes: '2026-11', tarjeta: 'visa-bancolombia' })).toEqual([ids.nov1, ids.nov2].sort());
    expect(ids_({ tarjeta: 'plata-pay-katerine' })).toEqual([ids.plata]);
    expect(ids_({ mes: '2026-11' })).toEqual([ids.nov1, ids.nov2, ids.plata, ids.manual].sort());
    expect(ids_({ estado: 'conciliado' })).toEqual([ids.ext1, ids.ext2].sort());
    expect(ids_({ estado: 'pendiente' })).toEqual([ids.nov2]);
    expect(ids_({ estado: 'manual' })).toEqual([ids.manual]);
    expect(ids_({ estado: 'duplicado' })).toEqual([ids.dup]);
    expect(ids_({ estado: 'por_conciliar' })).toEqual([ids.nov1, ids.nov2, ids.plata].sort()); // el duplicado no suma
  });

  it('"Por atender": esperando respuesta y requiere revisión, sin notas largas ni ids de más', async () => {
    const d = await datosExplorador(db);
    expect(d.por_atender.map((p) => p.estado).sort()).toEqual(['Esperando respuesta', 'Requiere revisión']);
    expect(d.por_atender.find((p) => p.id === ids.rev)).toMatchObject({ valor_texto: 'sin valor', tarjeta: 'Sin tarjeta', motivo: 'tarjeta desconocida' });
    expect(d.por_atender.find((p) => p.id === ids.nov2)).toMatchObject({ valor_texto: '$20.980', tarjeta: 'VISA' });
  });

  it('reclasificar funciona en otra tarjeta y en filas del correo; la bitácora sigue igual', async () => {
    const quien = { correo: 'ana@ejemplo.com', persona: 'katerine' as const };
    const r = await reclasificarExplorador(db, { movimiento_id: ids.plata, categoria_id: 4 }, quien);
    expect(r).toEqual({ actualizados: 1, cambios: [{ movimiento_id: ids.plata, antes: 3, despues: 4 }] });
    const b = (await db.query(`SELECT actor, instruido_por, accion, antes, despues FROM bitacora WHERE movimiento_id = $1`, [ids.plata])).rows;
    expect(b).toEqual([{ actor: 'katerine', instruido_por: 'ana@ejemplo.com', accion: 'reclasificar_explorador', antes: { categoria_id: 3 }, despues: { categoria_id: 4, via: 'movimiento' } }]);
    // Pendiente de respuesta: se responde por WhatsApp, no desde el tablero.
    await expect(reclasificarExplorador(db, { movimiento_id: ids.nov2, categoria_id: 4 }, quien)).rejects.toThrow(/pendiente/);
  });

  it('reclasificar por comercio puede limitarse a la tarjeta del filtro', async () => {
    await mov('a', { fecha: '2026-09-01', valor: 1000, fuente: 'extracto', desc: 'KIOSCO PRUEBA' });
    await mov('b', { fecha: '2026-09-02', valor: 2000, fuente: 'correo', tarjeta: 'plata-pay-miguel', desc: 'KIOSCO PRUEBA' });
    const quien = { correo: 'ana@ejemplo.com', persona: 'miguel' as const };
    const r = await reclasificarExplorador(db, { comercio: 'KIOSCO PRUEBA', categoria_id: 5, tarjeta_id: 'plata-pay-miguel' }, quien);
    expect(r.cambios.map((c) => c.movimiento_id)).toEqual([ids.b]);
    const r2 = await reclasificarExplorador(db, { comercio: 'KIOSCO PRUEBA', categoria_id: 5 }, quien);
    expect(r2.cambios.map((c) => c.movimiento_id)).toEqual([ids.a]);
  });
});
