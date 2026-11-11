// Medios de pago (origen crédito/débito/efectivo), edición y registro en lote desde el chat,
// categorías sin aprobación con validación de similitud. Casos sacados del chat del 09/11.
// Datos SINTÉTICOS; números de prueba.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import * as d from '../src/lib/dominio';
import type { Entrada } from '../src/lib/esquemas';
import { editarMovimientoChat, registrarGasto, registrarGastos } from '../src/lib/gastos';
import { cargarMedios, datosMedios, guardarMedio, guardarOrigen, medioDeTexto } from '../src/lib/medios';
import { categoriaDeTexto } from '../src/lib/referencias';
import { efectosFalsos, nuevaDb } from './apoyo';

const MIGUEL = '+570000000001';
const KATERINE = '+570000000002';
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const haceDias = (n: number) => new Date(Date.parse(`${hoy()}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const QUIEN = { correo: 'ana@ejemplo.com', persona: 'miguel' };

let db: Db;
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

const gasto = (extra: Partial<Entrada<'registrar_gasto'>> = {}): Entrada<'registrar_gasto'> => ({
  numero_remitente: KATERINE, canal: 'grupo', valor: 100_000, descripcion: 'Terapia física', categoria: 'salud', ...extra,
} as Entrada<'registrar_gasto'>);

describe('medioDeTexto: nunca adivina', () => {
  it('reconoce por alias, nombre, canal y últimos 4', async () => {
    const medios = await cargarMedios(db);
    const id = (t: string) => { const r = medioDeTexto(t, medios); return r.tipo === 'unico' ? r.medio.id : r.tipo; };
    expect(id('NU Kate')).toBe('nu-katerine');
    expect(id('Tarjeta Débito NU Kate')).toBe('nu-katerine');
    expect(id('Debito Bancolombia')).toBe('bancolombia-debito');
    expect(id('desde mi débito bancolombia con transferencia')).toBe('bancolombia-debito');
    expect(id('Plata Pay Katerine')).toBe('plata-pay-katerine');
    expect(id('efectivo')).toBe('efectivo');
    expect(id('PSE')).toBe('pse');
    expect(id('VISA')).toBe('visa-bancolombia');
    expect(id('*1111')).toBe('visa-bancolombia');
    expect(id('de la master')).toBe('mastercard-bancolombia');
    expect(id('débito')).toBe('ambiguo');
    expect(id('Davivienda débito')).toBe('ninguno');
  });

  it('«PSE desde débito Bancolombia»: el medio es la cuenta y el canal es PSE', async () => {
    const r = medioDeTexto('PSE desde débito Bancolombia', await cargarMedios(db));
    expect(r).toMatchObject({ tipo: 'unico', medio: { id: 'bancolombia-debito' }, canal: 'pse' });
  });

  it('sin el medio NU, «NU Kate» NO cae en Plata Pay Katerine (antes sí)', async () => {
    await db.query(`UPDATE tarjetas SET activa = false WHERE id = 'nu-katerine'`);
    expect(medioDeTexto('NU Kate', await cargarMedios(db)).tipo).toBe('ninguno');
  });
});

describe('registrar_gasto con medios de pago', () => {
  it('transferencia desde el débito queda con su cuenta (el arriendo del 09/11)', async () => {
    const { ef } = efectosFalsos();
    await d.crearCategoria(db, { nombre: 'Arrendamientos' });
    const r: any = await registrarGasto(db, ef, gasto({
      numero_remitente: MIGUEL, valor: 2_500_000, descripcion: 'Arriendo del apartamento', medio: 'débito Bancolombia',
      medio_pago: 'transferencia', categoria: 'arriendo', fecha: haceDias(3),
    }));
    expect(r).toMatchObject({ aplicado: true, categoria: 'Arrendamientos', persona: 'miguel' });
    expect(r.mensaje).toContain('transferencia desde Bancolombia débito');
    expect((await db.query(`SELECT tarjeta_id, medio_pago FROM movimientos`)).rows[0]).toEqual({ tarjeta_id: 'bancolombia-debito', medio_pago: 'transferencia' });
  });

  it('transferencia sin decir la cuenta: pregunta desde cuál', async () => {
    const { ef } = efectosFalsos();
    expect(await registrarGasto(db, ef, gasto({ medio_pago: 'transferencia' }))).toMatchObject({ aplicado: false, motivo: 'falta_cuenta' });
    expect(await registrarGasto(db, ef, gasto({ medio: 'por transferencia' }))).toMatchObject({ aplicado: false, motivo: 'falta_cuenta' });
    expect(await registrarGasto(db, ef, gasto({ medio: 'Bre-B' }))).toMatchObject({ aplicado: false, motivo: 'falta_cuenta' });
  });

  it('NU Kate es de Katerine aunque escriba Miguel; el mensaje lo dice', async () => {
    const { ef } = efectosFalsos();
    const r: any = await registrarGasto(db, ef, gasto({ numero_remitente: MIGUEL, medio: 'Tarjeta Débito NU Kate' }));
    expect(r).toMatchObject({ aplicado: true, persona: 'katerine', medio: 'NU Katerine (débito)' });
    expect(r.mensaje).toMatch(/a nombre de Katerine/);
  });

  it('cuenta compartida: queda a nombre de quien escribe (los créditos de Katerine)', async () => {
    const { ef } = efectosFalsos();
    const r: any = await registrarGasto(db, ef, gasto({ valor: 1_495_500, descripcion: 'Crédito Bancolombia - 3255', medio: 'Debito Bancolombia', categoria: 'Créditos' }));
    // «Créditos» no existe: no se registra hasta crearla.
    expect(r).toMatchObject({ aplicado: false, motivo: 'categoria_no_reconocida' });
    expect((await d.crearCategoria(db, { nombre: 'Créditos' })).creada).toBe(true);
    const r2: any = await registrarGasto(db, ef, gasto({ valor: 1_495_500, descripcion: 'Crédito Bancolombia - 3255', medio: 'Debito Bancolombia', categoria: 'Créditos' }));
    expect(r2).toMatchObject({ aplicado: true, persona: 'katerine', categoria: 'Créditos' });
    // Libre inversión es un crédito, no una inversión: sí es gasto.
    const r3: any = await registrarGasto(db, ef, gasto({ valor: 1_987_600, descripcion: 'Crédito Bancolombia - Libre inversión - 0000', medio: 'Debito Bancolombia', categoria: 'crédito' }));
    expect(r3).toMatchObject({ aplicado: true, categoria: 'Créditos' });
  });

  it('medio desconocido: no registra y muestra opciones (solo medios que se registran por chat)', async () => {
    const { ef } = efectosFalsos();
    const r: any = await registrarGasto(db, ef, gasto({ medio: 'Davivienda débito' }));
    expect(r).toMatchObject({ aplicado: false, motivo: 'medio_no_reconocido' });
    expect(r.opciones.map((o: any) => o.medio)).not.toContain('VISA');
    expect(r.opciones.map((o: any) => o.medio)).toContain('Efectivo');
  });
});

describe('registrar_gastos (varios en un mensaje)', () => {
  it('registra los completos y dice qué falta de los otros', async () => {
    const { ef } = efectosFalsos();
    const r: any = await registrarGastos(db, ef, {
      numero_remitente: KATERINE, canal: 'grupo',
      gastos: [
        { valor: 15_000, descripcion: 'Copago salud', medio: 'efectivo', categoria: 'salud' },
        { valor: 25_000, descripcion: 'Crispetas', medio: 'efectivo', categoria: 'restaurantes' },
        { valor: 46_000, descripcion: 'Póliza salud Hugo', medio: 'Plata Pay Katerine' },
      ],
    });
    expect(r).toMatchObject({ aplicados: 2, pendientes: 1 });
    expect(r.texto).toMatch(/^Registré 2 de 3:/);
    expect(r.texto).toMatch(/3\. ✗ Póliza salud Hugo · \$46\.000: falta la categoría/);
    expect(r.resultados[2].opciones.length).toBeGreaterThan(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM movimientos`)).rows[0].n).toBe(2);
  });
});

describe('editar_movimiento desde el chat', () => {
  it('cambia fecha y medio sin descartar ni duplicar; la persona sigue a la tarjeta individual', async () => {
    const { ef } = efectosFalsos();
    await d.crearCategoria(db, { nombre: 'Colegio Niños' });
    await registrarGasto(db, ef, gasto({ valor: 1_234_500, descripcion: 'Mensualidad Colegio', medio: 'Plata Pay Katerine', categoria: 'Colegio Niños' }));
    const r: any = await editarMovimientoChat(db, ef, {
      numero_remitente: KATERINE, canal: 'grupo', referencia: 'Mensualidad Colegio', fecha: haceDias(8), medio: 'NU Kate',
    });
    expect(r).toMatchObject({ aplicado: true, persona: 'katerine', medio: 'NU Katerine (débito)', fecha: haceDias(8) });
    const filas = (await db.query(`SELECT estado, tarjeta_id, medio_pago, fecha::text AS f FROM movimientos`)).rows;
    expect(filas).toEqual([{ estado: 'confirmado', tarjeta_id: 'nu-katerine', medio_pago: 'tarjeta_debito', f: haceDias(8) }]);
    expect((await db.query(`SELECT accion FROM bitacora WHERE accion = 'editar_chat'`)).rows).toHaveLength(1);
  });

  it('pasar un gasto en efectivo a débito Bancolombia cambia su forma de pago; persona y categoría también se editan', async () => {
    const { ef } = efectosFalsos();
    await registrarGasto(db, ef, gasto({ medio: 'efectivo', descripcion: 'Arriendo del apartamento', valor: 2_500_000, categoria: 'hogar' }));
    const r: any = await editarMovimientoChat(db, ef, {
      numero_remitente: KATERINE, canal: 'grupo', referencia: 'Arriendo del apartamento', medio: 'Debito Bancolombia', persona: 'miguel', categoria: 'otros',
    });
    expect(r).toMatchObject({ aplicado: true, persona: 'miguel' });
    expect((await db.query(`SELECT tarjeta_id, medio_pago, persona FROM movimientos`)).rows[0]).toEqual({ tarjeta_id: 'bancolombia-debito', medio_pago: 'tarjeta_debito', persona: 'miguel' });
  });

  it('una tarjeta individual no se puede poner a nombre de la otra persona', async () => {
    const { ef } = efectosFalsos();
    await registrarGasto(db, ef, gasto({ medio: 'NU Kate' }));
    const r: any = await editarMovimientoChat(db, ef, { numero_remitente: MIGUEL, canal: 'grupo', referencia: 'Terapia física', persona: 'miguel' });
    expect(r).toMatchObject({ aplicado: false, motivo: 'no_permitido' });
  });

  it('una compra esperando categoría se clasifica (con su ciclo de reglas)', async () => {
    const { ef } = efectosFalsos();
    const { rows: [m] } = await db.query(
      `INSERT INTO movimientos (fecha, descripcion_original, valor, tarjeta_id, estado, fuente, moneda) VALUES ($1, 'Google', 79000, 'visa-bancolombia', 'por_preguntar', 'correo', 'COP') RETURNING id::text AS id`,
      [hoy()],
    );
    const r: any = await editarMovimientoChat(db, ef, { numero_remitente: MIGUEL, canal: 'grupo', movimiento_id: m.id, categoria: 'suscripciones' });
    expect(r).toMatchObject({ aplicado: true, categoria: 'Suscripciones digitales' });
    expect((await db.query(`SELECT estado FROM movimientos`)).rows[0].estado).toBe('confirmado');
  });
});

describe('categorías: sin aprobación, con validación de similitud', () => {
  it.each([
    ['Supermercado', 'Supermercado y mercado'],
    ['Mercado', 'Supermercado y mercado'],
    ['Tiendas', 'Supermercado y mercado'],
  ])('«%s» se parece a «%s»: propone esa antes de crear', async (nombre, parecida) => {
    const r: any = await d.crearCategoria(db, { nombre });
    expect(r.creada).toBe(false);
    expect(r.parecidas.map((p: any) => p.nombre)).toContain(parecida);
  });

  it('con «la nueva» confirmada se crea activa aunque se parezca (Educación niños)', async () => {
    await d.crearCategoria(db, { nombre: 'Educación Miguel' });
    const r1: any = await d.crearCategoria(db, { nombre: 'Educación niños' });
    expect(r1).toMatchObject({ creada: false, existente: { nombre: 'Educación Miguel' } });
    const r2: any = await d.crearCategoria(db, { nombre: 'Educación niños', confirmar_nueva: true });
    expect(r2).toMatchObject({ creada: true, categoria: { nombre: 'Educación niños', estado: 'activa' } });
    // Un nombre igual nunca se crea dos veces.
    expect(await d.crearCategoria(db, { nombre: 'educacion ninos', confirmar_nueva: true })).toMatchObject({ creada: false, ya_existe: true });
  });

  it('desde el chat la crea a nombre de quien escribe', async () => {
    const r: any = await d.crearCategoriaChat(db, { nombre: 'Mascotas', numero_remitente: KATERINE });
    expect(r).toMatchObject({ creada: true, categoria: { estado: 'activa' } });
    expect((await db.query(`SELECT actor FROM bitacora WHERE accion = 'crear_categoria'`)).rows[0].actor).toBe('katerine');
  });

  it('sinónimos para categorías creadas después: arriendo, cuota, mensualidad', async () => {
    for (const n of ['Arrendamientos', 'Créditos']) await d.crearCategoria(db, { nombre: n });
    const cats = (await db.query(`SELECT id, nombre FROM categorias WHERE estado = 'activa' ORDER BY id`)).rows as any[];
    const nombre = (t: string) => cats.find((c) => c.id === categoriaDeTexto(t, cats))?.nombre ?? null;
    expect(nombre('arriendo')).toBe('Arrendamientos');
    expect(nombre('Arrendaminetos')).toBe(null);
    expect(nombre('cuota del préstamo')).toBe('Créditos');
    expect(nombre('crédito')).toBe('Créditos');
  });
});

describe('resumen del mes en curso', () => {
  it('compara con los mismos días del mes anterior, no con el mes completo', async () => {
    const t = d.textoResumen({
      mes: '2026-11', total: 1, cantidad: 1, reembolsable: 0, por_persona: [], por_categoria: [{ categoria: 'X', total: 1 }],
      variaciones: [{ categoria: 'X', variacion_pct: -50 }], esperando: 0, alertas: 0, corte: 9,
    });
    expect(t).toContain('Frente al 1–9 del mes anterior: X -50%.');
  });
});

describe('tablero: configurar medios y orígenes', () => {
  it('lista orígenes y medios; crea un origen y un medio; valida reglas', async () => {
    const datos: any = await datosMedios(db);
    expect(datos.origenes.map((o: any) => o.id)).toEqual(['credito', 'debito', 'efectivo']);
    expect(datos.medios.find((m: any) => m.id === 'pse')).toMatchObject({ origen: 'debito', canal: 'pse' });

    const o: any = await guardarOrigen(db, { nombre: 'Billetera digital' }, QUIEN);
    expect(o.origen).toMatchObject({ id: 'billetera-digital', registro_chat: true });
    const m: any = await guardarMedio(db, { nombre: 'Nequi Miguel', origen: 'billetera-digital', tipo: 'individual', persona_default: 'miguel', alias: ['Nequi'] }, QUIEN);
    expect(m.medio).toMatchObject({ id: 'nequi-miguel', clase: 'billetera-digital', alias: ['nequi'] });
    expect(medioDeTexto('pagué con nequi', await cargarMedios(db))).toMatchObject({ tipo: 'unico', medio: { id: 'nequi-miguel' } });

    await expect(guardarMedio(db, { nombre: 'Otra', origen: 'debito', tipo: 'compartida', alias: ['nequi'] }, QUIEN)).rejects.toMatchObject({ status: 409 });
    await expect(guardarMedio(db, { nombre: 'Sin dueña', origen: 'debito', tipo: 'individual' }, QUIEN)).rejects.toMatchObject({ status: 400 });
    await expect(guardarMedio(db, { nombre: 'Débito con corte', origen: 'debito', tipo: 'compartida', dia_corte: 5 }, QUIEN)).rejects.toMatchObject({ status: 400 });
    await expect(guardarOrigen(db, { id: 'billetera-digital', nombre: 'Billetera digital', activo: false }, QUIEN)).rejects.toMatchObject({ status: 409 });
  });

  it('no cambia el origen de un medio que ya tiene movimientos', async () => {
    const { ef } = efectosFalsos();
    await registrarGasto(db, ef, gasto({ medio: 'Debito Bancolombia' }));
    await expect(guardarMedio(db, { id: 'bancolombia-debito', nombre: 'Bancolombia débito', origen: 'credito', tipo: 'compartida' }, QUIEN))
      .rejects.toMatchObject({ status: 409 });
    const ok: any = await guardarMedio(db, { id: 'bancolombia-debito', nombre: 'Débito Bancolombia', origen: 'debito', tipo: 'compartida', alias: ['debito bancolombia'] }, QUIEN);
    expect(ok.medio.nombre).toBe('Débito Bancolombia');
  });

  it('un origen que no se registra por chat bloquea sus medios en registrar_gasto', async () => {
    const { ef } = efectosFalsos();
    await guardarOrigen(db, { id: 'debito', nombre: 'Débito', registro_chat: false }, QUIEN);
    expect(await registrarGasto(db, ef, gasto({ medio: 'NU Kate' }))).toMatchObject({ aplicado: false, motivo: 'origen_no_se_registra' });
  });
});
