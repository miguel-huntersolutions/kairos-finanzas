// Acciones del tablero: envío sin confirmar («sí llegó» / «volver a preguntar»), categoría
// nueva y regla propuesta al reclasificar por comercio. Datos SINTÉTICOS.
import { beforeEach, describe, expect, it } from 'vitest';
import { COOKIE, firmarSesion } from '../src/lib/acceso';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import { datosExplorador } from '../src/lib/explorador';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

let db: Db;
let n = 0;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});
const quien = { correo: 'ana@ejemplo.com', persona: 'katerine' as const };

/** Compra con la pregunta preparada, el plazo vencido y el envío sin confirmar. */
async function envioSinConfirmar(ef: d.Efectos) {
  const r = await d.ingresarCorreo(db, ef, {
    correo_id: `acc-${++n}`, remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY,
    texto: F.compraBancolombia('PANADERIA LA ESQUINA', '9.000'),
  });
  const id = r.movimiento_id!;
  await d.tomarMovimiento(db, { movimiento_id: id });
  const p = await d.preguntar(db, { movimiento_id: id });
  await db.query(`UPDATE movimientos SET en_proceso_hasta = now() - interval '1 minute' WHERE id = $1`, [id]);
  await d.respaldo(db, ef);
  return { id, codigo: p.pregunta_codigo };
}
const mov = async (id: string) => (await db.query('SELECT * FROM movimientos WHERE id = $1', [id])).rows[0];

describe('envío sin confirmar', () => {
  it('aparece en «Por atender» con acción', async () => {
    const { ef } = efectosFalsos();
    const { id, codigo } = await envioSinConfirmar(ef);
    const x = (await datosExplorador(db)).por_atender.find((p: any) => p.id === id) as any;
    expect(x).toMatchObject({ estado: 'Envío sin confirmar', accion: 'envio' });
    expect(x.motivo).toContain(`#${codigo}`);
  });

  it('«sí llegó»: queda esperando respuesta con el mismo código y su recordatorio', async () => {
    const { ef } = efectosFalsos();
    const { id, codigo } = await envioSinConfirmar(ef);
    await d.resolverEnvioSinConfirmar(db, id, 'si_llego', quien);
    expect(await mov(id)).toMatchObject({ estado: 'esperando_respuesta', pregunta_codigo: codigo });
    expect((await db.query('SELECT count(*)::int AS n FROM recordatorios_pendientes WHERE movimiento_id = $1', [id])).rows[0].n).toBe(1);
    await expect(d.resolverEnvioSinConfirmar(db, id, 'si_llego', quien)).rejects.toThrow(/ya no tiene/);
  });

  it('«volver a preguntar»: borra el código y el respaldo vuelve a avisar', async () => {
    const { ef, hooks } = efectosFalsos();
    const { id } = await envioSinConfirmar(ef);
    hooks.length = 0;
    await d.resolverEnvioSinConfirmar(db, id, 'volver_a_preguntar', quien);
    expect(await mov(id)).toMatchObject({ estado: 'por_preguntar', pregunta_codigo: null, intentos_preguntar: 0 });
    expect((await d.respaldo(db, ef)).avisos).toBe(1);
    expect(hooks).toEqual([{ movimiento_id: id, evento: 'nuevo' }]);
  });
});

describe('categoría nueva desde el tablero', () => {
  it('nace activa; una parecida devuelve la existente', async () => {
    const r: any = await d.crearCategoriaTablero(db, 'Mascotas', quien);
    expect(r).toMatchObject({ creada: true, categoria: { nombre: 'Mascotas', estado: 'activa' } });
    const otra: any = await d.crearCategoriaTablero(db, 'mascota', quien);
    expect(otra.creada).toBe(false);
    await expect(d.crearCategoriaTablero(db, 'ab', quien)).rejects.toThrow(/3 a 40/);
  });
});

describe('regla propuesta al reclasificar por comercio', () => {
  it('sin regla nace propuesta; otra categoría la reinicia; la misma no cambia; genéricos nunca', async () => {
    const r1 = await db.tx((tx) => d.aprenderReglaTablero(tx, 'Tienda D1', 2, quien));
    expect(r1).toMatchObject({ regla: { estado: 'propuesta' }, motivo: 'regla propuesta' });
    expect((await d.aprenderReglaTablero(db, 'Tienda D1', 2, quien)).motivo).toBe('la regla ya tiene esa categoría');
    await db.query(`UPDATE reglas_comercio SET estado = 'confirmada'`);
    expect((await d.aprenderReglaTablero(db, 'Tienda D1', 3, quien)).motivo).toBe('regla reiniciada en propuesta');
    const [regla] = (await db.query(`SELECT estado, categoria_id, coincidencias_humanas FROM reglas_comercio`)).rows;
    expect(regla).toEqual({ estado: 'propuesta', categoria_id: 3, coincidencias_humanas: 1 });
    await db.query(`INSERT INTO comercios (nombre, patrones) VALUES ('PAYU COLOMBIA', ARRAY['PAYU COLOMBIA'])`);
    expect(await d.aprenderReglaTablero(db, 'PAYU COLOMBIA', 2, quien)).toMatchObject({ regla: null, motivo: /genérico/ });
    expect((await d.aprenderReglaTablero(db, 'No existe SA', 2, quien)).regla).toBeNull();
  });
});

describe('rutas del tablero', () => {
  const AHORA = HOY.getTime();
  const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-falso-acciones-0123456789', TABLERO_PERSONAS: 'ana@ejemplo.com=katerine' };
  const HOST = 'tablero.ejemplo';
  const cookie = `${COOKIE}=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET, AHORA)}`;
  const ev = (path: string, cuerpo: unknown, conSesion = true): EventoRuta => ({
    __evento_http: true, method: 'POST', path, body: JSON.stringify(cuerpo),
    headers: { origin: [`https://${HOST}`], ...(conSesion ? { cookie: [cookie] } : {}) }, request_context: { host: HOST },
  });
  const deps = () => ({ db: () => db, env, ahora: () => AHORA });

  it('401 sin sesión, 400 con entrada mala, 200 y 409 con la acción', async () => {
    const { ef } = efectosFalsos();
    const { id } = await envioSinConfirmar(ef);
    expect((await manejarTablero(ev('/envio', { movimiento_id: id, accion: 'si_llego' }, false), deps())).statusCode).toBe(401);
    expect((await manejarTablero(ev('/envio', { movimiento_id: 'x', accion: 'si_llego' }), deps())).statusCode).toBe(400);
    expect((await manejarTablero(ev('/envio', { movimiento_id: id, accion: 'borrar' }), deps())).statusCode).toBe(400);
    expect((await manejarTablero(ev('/envio', { movimiento_id: id, accion: 'si_llego' }), deps())).statusCode).toBe(200);
    expect((await manejarTablero(ev('/envio', { movimiento_id: id, accion: 'si_llego' }), deps())).statusCode).toBe(409);
    const b = (await db.query(`SELECT actor, instruido_por FROM bitacora WHERE accion = 'resolver_envio_sin_confirmar'`)).rows[0];
    expect(b).toEqual({ actor: 'katerine', instruido_por: 'ana@ejemplo.com' });
  });

  it('POST /categorias crea la categoría', async () => {
    // «Viajes largos» se parece a «Transporte y viajes»: no se crea hasta confirmar la nueva.
    const r0 = await manejarTablero(ev('/categorias', { nombre: 'Viajes largos' }), deps());
    expect(JSON.parse(r0.body)).toMatchObject({ creada: false, existente: { nombre: 'Transporte y viajes' } });
    const r = await manejarTablero(ev('/categorias', { nombre: 'Viajes largos', confirmar_nueva: true }), deps());
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ creada: true, categoria: { estado: 'activa' } });
    expect((await manejarTablero(ev('/categorias', { nombre: 7 }), deps())).statusCode).toBe(400);
  });
});
