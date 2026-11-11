// Ingresos por chat, reembolsos de la empresa y saldo del mes. Datos SINTÉTICOS. Números de prueba.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db';
import { resumen } from '../src/lib/dominio';
import type { Entrada } from '../src/lib/esquemas';
import { registrarGasto } from '../src/lib/gastos';
import { asociarReembolso, comprasQueCuadran, descartarIngreso, esIngreso, registrarIngreso, reembolsos, tipoDeTexto } from '../src/lib/ingresos';
import { reembolsablesPendientes } from '../src/lib/ingresos-cifras';
import { efectosFalsos, nuevaDb } from './apoyo';

const MIGUEL = '+570000000001';
const KATERINE = '+570000000002';
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const haceDias = (n: number) => new Date(Date.parse(`${hoy()}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

let db: Db;
const { ef } = efectosFalsos();
beforeEach(async () => {
  ({ db } = await nuevaDb());
});

const ingreso = (extra: Partial<Entrada<'registrar_ingreso'>> = {}): Entrada<'registrar_ingreso'> => ({
  numero_remitente: MIGUEL, canal: 'privado', valor: 4_000_000, descripcion: 'Nómina', ...extra,
} as Entrada<'registrar_ingreso'>);

/** Compra reembolsable (categoría 12) registrada por chat, con fecha `dias` atrás. */
async function reembolsable(descripcion: string, valor: number, dias: number) {
  const r: any = await registrarGasto(db, ef, {
    numero_remitente: MIGUEL, canal: 'privado', valor, descripcion, medio_pago: 'efectivo', categoria_id: 12, fecha: haceDias(dias),
  } as Entrada<'registrar_gasto'>);
  expect(r.aplicado).toBe(true);
}
const cuenta = async (sql: string) => (await db.query(sql)).rows[0].n as number;

describe('qué es un ingreso y de qué tipo', () => {
  it.each(['Traslado desde ahorros', 'Retiro en cajero', 'Préstamo de mi mamá', 'Avance de la tarjeta', 'Transferencia propia', 'De Kati', 'Miguel me pasó'])(
    'rechaza «%s»', (d) => expect(esIngreso(d).ok).toBe(false),
  );
  it('acepta nómina, honorarios y ventas', () => {
    for (const d of ['Nómina noviembre', 'Honorarios proyecto', 'Venta de la bicicleta']) expect(esIngreso(d).ok).toBe(true);
  });
  it('deduce el tipo solo cuando es claro', () => {
    expect(tipoDeTexto('Nómina noviembre')).toBe('salario');
    expect(tipoDeTexto('Quincena')).toBe('salario');
    expect(tipoDeTexto('Reembolso viáticos')).toBe('reembolso');
    expect(tipoDeTexto('Venta de la bicicleta')).toBeNull();
  });
});

describe('registrar_ingreso', () => {
  it('registra un salario a nombre de quien escribe y deja constancia', async () => {
    const r: any = await registrarIngreso(db, ef, ingreso());
    expect(r).toMatchObject({ aplicado: true, tipo: 'salario', persona: 'miguel', fecha: hoy() });
    expect(r.mensaje).toMatch(/Nómina · \$4\.000\.000 · .* Salario · de Miguel/);
    expect(await cuenta(`SELECT count(*)::int AS n FROM ingresos WHERE tipo = 'salario' AND registrado_por = 'miguel'`)).toBe(1);
    expect(await cuenta(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'registrar_ingreso' AND actor = 'miguel'`)).toBe(1);
  });

  it('la otra persona como receptora y un número desconocido rechazado', async () => {
    const r: any = await registrarIngreso(db, ef, ingreso({ persona: 'katerine' }));
    expect(r).toMatchObject({ aplicado: true, persona: 'katerine' });
    await expect(registrarIngreso(db, ef, ingreso({ numero_remitente: '+579999999999' }))).rejects.toMatchObject({ status: 403 });
  });

  it('sin tipo claro pregunta con opciones y no escribe nada', async () => {
    const r: any = await registrarIngreso(db, ef, ingreso({ descripcion: 'Venta de la bicicleta', valor: 300_000 }));
    expect(r).toMatchObject({ aplicado: false, motivo: 'falta_tipo' });
    expect(r.opciones.map((o: any) => o.tipo)).toEqual(['salario', 'reembolso', 'otro']);
    expect(await cuenta(`SELECT count(*)::int AS n FROM ingresos`)).toBe(0);
    expect(await registrarIngreso(db, ef, ingreso({ descripcion: 'Venta de la bicicleta', valor: 300_000, tipo: 'otro' }))).toMatchObject({ aplicado: true, tipo: 'otro' });
  });

  it('no registra traslados ni fechas fuera de rango; avisa un posible duplicado', async () => {
    expect(await registrarIngreso(db, ef, ingreso({ descripcion: 'Traslado entre mis cuentas' }))).toMatchObject({ aplicado: false, motivo: 'no_es_ingreso' });
    expect(await registrarIngreso(db, ef, ingreso({ fecha: haceDias(-2) }))).toMatchObject({ aplicado: false, motivo: 'fecha_fuera_de_rango' });
    await registrarIngreso(db, ef, ingreso());
    const r: any = await registrarIngreso(db, ef, ingreso({ numero_remitente: KATERINE }));
    expect(r).toMatchObject({ aplicado: true, posible_duplicado: true });
    expect(r.mensaje).toMatch(/Ojo/);
  });
});

describe('reembolsos de la empresa', () => {
  it('cuadra con las más viejas: las marca pagadas y dice cuánto queda', async () => {
    await reembolsable('Taxi aeropuerto', 50_000, 10);
    await reembolsable('Almuerzo cliente', 80_000, 5);
    await reembolsable('Hotel', 300_000, 2);
    const r: any = await registrarIngreso(db, ef, ingreso({ descripcion: 'Reembolso gastos', valor: 130_000 }));
    expect(r).toMatchObject({ aplicado: true, tipo: 'reembolso', compras_cubiertas: 2 });
    expect(r.mensaje).toMatch(/todavía debe \$300\.000/);
    const pendientes = await reembolsablesPendientes(db);
    expect(pendientes.map((p) => p.valor)).toEqual([300_000]);
    expect((await reembolsos(db)).texto).toMatch(/les debe \$300\.000 en 1 compra/);
  });

  it('cuadra con una sola compra aunque no sea la más vieja', () => {
    const p = [50_000, 80_000, 300_000].map((valor, i) => ({ n: i + 1, movimiento_id: String(i), fecha: '2026-11-01', comercio: 'x', valor }));
    expect(comprasQueCuadran(p, 300_000)!.map((c) => c.n)).toEqual([3]);
    expect(comprasQueCuadran(p, 380_000)).toBeNull();
  });

  it('si no cuadra, lo registra, muestra la lista y luego asocia las que diga', async () => {
    await reembolsable('Taxi aeropuerto', 50_000, 10);
    await reembolsable('Almuerzo cliente', 80_000, 5);
    await reembolsable('Hotel', 300_000, 2);
    const r: any = await registrarIngreso(db, ef, ingreso({ descripcion: 'Reembolso', valor: 345_000 }));
    expect(r).toMatchObject({ aplicado: true, por_asociar: true, compras_cubiertas: 0 });
    expect(r.texto).toMatch(/1\. .* · \$50\.000/);
    expect(r.texto).toMatch(/3\. .* · \$300\.000/);
    expect(await asociarReembolso(db, ef, { numero_remitente: MIGUEL, numeros: [9] })).toMatchObject({ aplicado: false, motivo: 'numero_invalido' });
    const a: any = await asociarReembolso(db, ef, { numero_remitente: KATERINE, numeros: [1, 3] });
    expect(a).toMatchObject({ aplicado: true, compras_cubiertas: 2 });
    expect(a.mensaje).toMatch(/Diferencia: \$5\.000 de menos/);
    expect(a.mensaje).toMatch(/todavía debe \$80\.000/);
    expect(await cuenta(`SELECT count(*)::int AS n FROM bitacora WHERE accion = 'asociar_reembolso' AND actor = 'katerine'`)).toBe(1);
  });

  it('una compra del correo con su fila del extracto cuenta una vez y se marcan las dos', async () => {
    const { rows: [c] } = await db.query(
      `INSERT INTO movimientos (fecha, descripcion_original, valor, estado, fuente, moneda, categoria_id, reembolsable, tarjeta_id)
       VALUES ($1, 'HOTEL CORREO', 200000, 'confirmado', 'correo', 'COP', 12, true, 'visa-bancolombia') RETURNING id`, [haceDias(3)]);
    await db.query(
      `INSERT INTO movimientos (fecha, descripcion_original, valor, estado, fuente, moneda, categoria_id, reembolsable, tarjeta_id, conciliado_con)
       VALUES ($1, 'HOTEL EXTRACTO', 200000, 'confirmado', 'extracto', 'COP', 12, true, 'visa-bancolombia', $2)`, [haceDias(3), c.id]);
    expect(await reembolsablesPendientes(db)).toHaveLength(1);
    await registrarIngreso(db, ef, ingreso({ descripcion: 'Reembolso hotel', valor: 200_000 }));
    expect(await cuenta(`SELECT count(*)::int AS n FROM movimientos WHERE reembolso_id IS NOT NULL`)).toBe(2);
    expect(await reembolsablesPendientes(db)).toHaveLength(0);
  });

  it('descartar el reembolso devuelve sus compras a pendientes', async () => {
    await reembolsable('Taxi aeropuerto', 50_000, 3);
    await registrarIngreso(db, ef, ingreso({ descripcion: 'Reembolso taxi', valor: 50_000 }));
    expect(await reembolsablesPendientes(db)).toHaveLength(0);
    const r: any = await descartarIngreso(db, ef, { numero_remitente: MIGUEL, referencia: 'el de 50.000' });
    expect(r).toMatchObject({ aplicado: true });
    expect(r.mensaje).toMatch(/volvieron a pendientes/);
    expect(await reembolsablesPendientes(db)).toHaveLength(1);
    expect(await cuenta(`SELECT count(*)::int AS n FROM ingresos WHERE estado = 'descartado'`)).toBe(1);
  });

  it('descartar sin coincidencia única no cambia nada', async () => {
    await registrarIngreso(db, ef, ingreso({ descripcion: 'Nómina', valor: 4_000_000 }));
    await registrarIngreso(db, ef, ingreso({ descripcion: 'Nómina', valor: 3_000_000, persona: 'katerine' }));
    expect(await descartarIngreso(db, ef, { numero_remitente: MIGUEL, referencia: 'la nómina' })).toMatchObject({ aplicado: false, motivo: 'ambigua' });
    expect(await descartarIngreso(db, ef, { numero_remitente: MIGUEL, referencia: 'arriendo' })).toMatchObject({ aplicado: false, motivo: 'ninguna' });
    expect(await descartarIngreso(db, ef, { numero_remitente: MIGUEL, referencia: 'el último' })).toMatchObject({ aplicado: true });
    expect(await cuenta(`SELECT count(*)::int AS n FROM ingresos WHERE estado = 'confirmado'`)).toBe(1);
  });
});

describe('saldo del mes en el resumen', () => {
  const mes = () => hoy().slice(0, 7);

  it('muestra ingresos por persona, el saldo sin contar lo reembolsable y lo que debe la empresa', async () => {
    await registrarGasto(db, ef, { numero_remitente: MIGUEL, canal: 'privado', valor: 1_000_000, descripcion: 'Mercado', medio_pago: 'efectivo', categoria_id: 1 } as Entrada<'registrar_gasto'>);
    await reembolsable('Hotel', 300_000, 0);
    await registrarIngreso(db, ef, ingreso({ valor: 4_000_000 }));
    await registrarIngreso(db, ef, ingreso({ numero_remitente: KATERINE, valor: 3_000_000 }));
    const r: any = await resumen(db, { mes: mes() });
    expect(r.saldo).toEqual({ entro: 7_000_000, salio: 1_000_000, quedo: 6_000_000 });
    expect(r.debe_empresa).toBe(300_000);
    expect(r.texto).toMatch(/Ingresos: \$7\.000\.000 \(Miguel \$4\.000\.000 · Katerine \$3\.000\.000\)\./);
    expect(r.texto).toMatch(/Saldo: entró \$7\.000\.000, salió \$1\.000\.000, quedó \$6\.000\.000\./);
    expect(r.texto).toMatch(/La empresa les debe \$300\.000 en total\./);
  });

  it('un reembolso no cuenta como ingreso propio; el saldo negativo dice «faltó»', async () => {
    await registrarGasto(db, ef, { numero_remitente: MIGUEL, canal: 'privado', valor: 500_000, descripcion: 'Mercado', medio_pago: 'efectivo', categoria_id: 1 } as Entrada<'registrar_gasto'>);
    await registrarIngreso(db, ef, ingreso({ descripcion: 'Reembolso viáticos', valor: 200_000 }));
    const r: any = await resumen(db, { mes: mes() });
    expect(r.saldo).toEqual({ entro: 0, salio: 500_000, quedo: -500_000 });
    expect(r.texto).toMatch(/De ellos, reembolsos de la empresa: \$200\.000\./);
    expect(r.texto).toMatch(/faltó \$500\.000/);
  });

  it('sin ingresos no muestra saldo; filtrado por categoría tampoco', async () => {
    await registrarGasto(db, ef, { numero_remitente: MIGUEL, canal: 'privado', valor: 500_000, descripcion: 'Mercado', medio_pago: 'efectivo', categoria_id: 1 } as Entrada<'registrar_gasto'>);
    const sin: any = await resumen(db, { mes: mes() });
    expect(sin.saldo).toBeNull();
    expect(sin.texto).not.toMatch(/Saldo/);
    await registrarIngreso(db, ef, ingreso());
    const cat: any = await resumen(db, { mes: mes(), categoria_id: 1 });
    expect(cat.ingresos).toBeNull();
    expect(cat.texto).not.toMatch(/Ingresos/);
  });
});
