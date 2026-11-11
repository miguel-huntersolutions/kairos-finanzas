// Humo contra un Postgres real (por ejemplo, una rama de Neon o un Postgres local), solo si PG_URL está
// definido: PG_URL="<URI de Postgres>" npx vitest run test/pg-real.test.ts
// Usa la tarjeta ficticia 'humo-prueba' y borra lo que crea.
import { afterAll, describe, expect, it } from 'vitest';
import { dbDesdeEntorno } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { HOY, efectosFalsos } from './apoyo';
import * as F from './fixtures/correos';

const url = process.env.PG_URL;
describe.skipIf(!url)('Postgres real', () => {
  process.env.DATABASE_URL = url;
  const db = dbDesdeEntorno();
  const id = `humo-${Date.now()}`;
  afterAll(async () => {
    await db.query(`DELETE FROM bitacora WHERE movimiento_id IN (SELECT id FROM movimientos WHERE correo_id = $1)`, [id]);
    await db.query(`DELETE FROM movimientos WHERE correo_id = $1`, [id]);
    await db.query(`DELETE FROM correos WHERE correo_id = $1`, [id]);
    await db.query(`DELETE FROM tarjetas WHERE id = 'humo-prueba'`);
  });
  it('correo → por_preguntar → tomar (atómico) en pg', async () => {
    await db.query(`INSERT INTO tarjetas (id, nombre, banco, tipo, ultimos_4) VALUES ('humo-prueba', 'Humo', 'Bancolombia', 'compartida', '0909') ON CONFLICT DO NOTHING`);
    const { ef } = efectosFalsos();
    const r = await d.ingresarCorreo(db, ef, { correo_id: id, remitente: F.BANCOLOMBIA, asunto: 'humo', fecha_correo: HOY, texto: F.compraBancolombia('PANADERIA HUMO', '1.000', '0909') });
    expect(r.estado).toBe('por_preguntar');
    expect((await d.ingresarCorreo(db, ef, { correo_id: id, remitente: F.BANCOLOMBIA, asunto: 'humo', fecha_correo: HOY, texto: '' })).duplicado).toBe(true);
    const [a, b] = await Promise.all([d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! }), d.tomarMovimiento(db, { movimiento_id: r.movimiento_id! })]);
    expect([a.tomado, b.tomado].filter(Boolean)).toHaveLength(1);
    const c = await d.crearCategoria(db, { nombre: 'Restaurante' });
    expect(c.creada).toBe(false);
  });
});
