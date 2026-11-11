// Renombrar y borrar categorías desde el tablero. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { borrarCategoriaTablero, crearCategoria, renombrarCategoriaTablero } from '../src/lib/dominio';
import { datosExplorador } from '../src/lib/explorador';
import { nuevaDb } from './apoyo';

let db: Db;
const QUIEN = { correo: 'ana@ejemplo.com', persona: 'miguel' as const };

beforeEach(async () => {
  ({ db } = await nuevaDb());
});

async function nueva(nombre: string): Promise<number> {
  const r: any = await crearCategoria(db, { nombre, confirmar_nueva: true });
  return r.categoria.id;
}
const existe = async (id: number) => (await db.query(`SELECT count(*)::int AS n FROM categorias WHERE id = $1`, [id])).rows[0].n === 1;

describe('renombrar categoría', () => {
  it('cambia el nombre, conserva el id y deja constancia', async () => {
    const id = await nueva('Mascotas');
    const r: any = await renombrarCategoriaTablero(db, { id, nombre: 'Veterinario y mascotas' }, QUIEN);
    expect(r).toMatchObject({ aplicado: true, categoria: { id, nombre: 'Veterinario y mascotas' }, antes: 'Mascotas' });
    expect((await db.query(`SELECT nombre, nombre_normalizado FROM categorias WHERE id = $1`, [id])).rows[0]).toEqual({ nombre: 'Veterinario y mascotas', nombre_normalizado: 'veterinario y mascota' });
    const b = (await db.query(`SELECT actor, antes, despues FROM bitacora WHERE accion = 'renombrar_categoria'`)).rows[0];
    expect(b).toMatchObject({ actor: 'miguel', antes: { nombre: 'Mascotas' }, despues: { nombre: 'Veterinario y mascotas' } });
  });

  it('las compras siguen en la categoría con el nombre nuevo', async () => {
    const id = await nueva('Colegio Niños');
    await db.query(`INSERT INTO movimientos (fecha, descripcion_original, valor, estado, fuente, moneda, categoria_id) VALUES ('2026-11-01', 'Mensualidad', 1000, 'confirmado', 'manual', 'COP', $1)`, [id]);
    await renombrarCategoriaTablero(db, { id, nombre: 'Educación de los niños', confirmar_parecida: true }, QUIEN);
    const m = (await db.query(`SELECT c.nombre FROM movimientos m JOIN categorias c ON c.id = m.categoria_id`)).rows[0];
    expect(m.nombre).toBe('Educación de los niños');
  });

  it('un nombre que ya existe: 409', async () => {
    const id = await nueva('Mascotas');
    await expect(renombrarCategoriaTablero(db, { id, nombre: 'supermercado y mercado' }, QUIEN)).rejects.toMatchObject({ status: 409 });
    // Mismo nombre normalizado (singular/plural, tildes): también cuenta como repetido.
    await expect(renombrarCategoriaTablero(db, { id, nombre: 'Supermercado y mercados' }, QUIEN)).rejects.toMatchObject({ status: 409 });
  });

  it('si se parece a otra, no cambia hasta confirmar', async () => {
    const id = await nueva('Mascotas');
    const r: any = await renombrarCategoriaTablero(db, { id, nombre: 'Mercado de mascotas' }, QUIEN);
    expect(r).toMatchObject({ aplicado: false, motivo: 'parecida' });
    expect(r.parecidas.map((p: any) => p.nombre)).toContain('Supermercado y mercado');
    expect((await db.query(`SELECT nombre FROM categorias WHERE id = $1`, [id])).rows[0].nombre).toBe('Mascotas');
    const ok: any = await renombrarCategoriaTablero(db, { id, nombre: 'Mercado de mascotas', confirmar_parecida: true }, QUIEN);
    expect(ok).toMatchObject({ aplicado: true, categoria: { nombre: 'Mercado de mascotas' } });
  });

  it('cambiar solo mayúsculas o tildes se permite; el mismo nombre no cambia nada', async () => {
    const id = await nueva('Creditos');
    expect(await renombrarCategoriaTablero(db, { id, nombre: 'Créditos' }, QUIEN)).toMatchObject({ aplicado: true, categoria: { nombre: 'Créditos' } });
    expect(await renombrarCategoriaTablero(db, { id, nombre: 'Créditos' }, QUIEN)).toMatchObject({ aplicado: true, sin_cambios: true });
  });

  it('una categoría base también se renombra; nombres inválidos o inexistentes se rechazan', async () => {
    expect(await renombrarCategoriaTablero(db, { id: 11, nombre: 'Imprevistos' }, QUIEN)).toMatchObject({ aplicado: true });
    await expect(renombrarCategoriaTablero(db, { id: 11, nombre: 'ab' }, QUIEN)).rejects.toMatchObject({ status: 400 });
    await expect(renombrarCategoriaTablero(db, { id: 99999, nombre: 'Otra cosa' }, QUIEN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('borrar categoría', () => {
  it('sin registros: se borra y queda constancia', async () => {
    const id = await nueva('Mascotas');
    expect(await borrarCategoriaTablero(db, { id, confirmar: true }, QUIEN)).toMatchObject({ aplicado: true, borrada: true, nombre: 'Mascotas' });
    expect(await existe(id)).toBe(false);
    expect((await db.query(`SELECT antes FROM bitacora WHERE accion = 'borrar_categoria'`)).rows[0].antes).toMatchObject({ nombre: 'Mascotas' });
  });

  it('exige confirmar: true', async () => {
    const id = await nueva('Mascotas');
    await expect(borrarCategoriaTablero(db, { id }, QUIEN)).rejects.toMatchObject({ status: 400 });
    expect(await existe(id)).toBe(true);
  });

  it('con compras (incluso descartadas) no se borra y dice cuántas', async () => {
    const id = await nueva('Créditos');
    await db.query(`INSERT INTO movimientos (fecha, descripcion_original, valor, estado, fuente, moneda, categoria_id) VALUES ('2026-11-01', 'Cuota', 1000, 'descartado', 'manual', 'COP', $1)`, [id]);
    const err: any = await borrarCategoriaTablero(db, { id, confirmar: true }, QUIEN).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
    expect(err.message).toMatch(/1 compra/);
    expect(await existe(id)).toBe(true);
  });

  it('con una regla de comercio no se borra', async () => {
    const id = await nueva('Mascotas');
    const { rows: [c] } = await db.query(`SELECT id FROM comercios LIMIT 1`);
    await db.query(`INSERT INTO reglas_comercio (comercio_id, categoria_id, estado, coincidencias_humanas, creada_por) VALUES ($1, $2, 'propuesta', 1, 'miguel')`, [c.id, id]);
    await expect(borrarCategoriaTablero(db, { id, confirmar: true }, QUIEN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/regla/) });
  });

  it('con un comercio que la usa de semilla no se borra', async () => {
    const id = await nueva('Mascotas');
    await db.query(`UPDATE comercios SET categoria_semilla_id = $1 WHERE id = (SELECT id FROM comercios LIMIT 1)`, [id]);
    await expect(borrarCategoriaTablero(db, { id, confirmar: true }, QUIEN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/semilla/) });
  });

  it('las categorías base no se borran aunque estén vacías', async () => {
    await expect(borrarCategoriaTablero(db, { id: 7, confirmar: true }, QUIEN)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/base/) });
    expect(await existe(7)).toBe(true);
  });

  it('una categoría que no existe: 404', async () => {
    await expect(borrarCategoriaTablero(db, { id: 99999, confirmar: true }, QUIEN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('datos del tablero para gestionar categorías', () => {
  it('traen los registros de cada una y marcan las base', async () => {
    const id = await nueva('Créditos');
    await db.query(`INSERT INTO movimientos (fecha, descripcion_original, valor, estado, fuente, moneda, categoria_id) VALUES ('2026-11-01', 'Cuota', 1000, 'confirmado', 'manual', 'COP', $1)`, [id]);
    const d: any = await datosExplorador(db);
    const c = d.categorias_gestion.find((x: any) => x.id === id);
    expect(c).toMatchObject({ nombre: 'Créditos', compras: 1, reglas: 0, base: false });
    expect(d.categorias_gestion.find((x: any) => x.id === 1)).toMatchObject({ base: true });
  });
});
