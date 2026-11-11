// A5: una referencia que no coincide con nada NO clasifica la única compra pendiente. Pura, sin base.
import { describe, expect, it } from 'vitest';
import { elegir } from '../src/lib/referencias';

const base = { fecha: '2026-11-06', moneda: 'COP', valor_original: null, trm: null, trm_fecha: null, tarjeta_id: 'v', tarjeta: 'VISA', descripcion_original: null, categorias_sugeridas: null };
const confirmada = { ...base, movimiento_id: 'k', estado: 'confirmado', valor: 30000, comercio: 'Farmatodo', pregunta_codigo: 'K7' };
const pendiente = { ...base, movimiento_id: 't', estado: 'esperando_respuesta', valor: 45000, comercio: 'Exito', pregunta_codigo: 'T3' };

describe('A5: referencia sin coincidencia', () => {
  it('un código que no existe entre las preguntas abiertas no clasifica la única pendiente', () => {
    const s = elegir('#K7', [confirmada, pendiente] as any);
    expect(s.tipo).toBe('ninguna');
  });

  it('un comercio que no coincide con ninguna compra no clasifica la única pendiente', () => {
    const s = elegir('la de Panamericana', [pendiente] as any);
    expect(s.tipo).toBe('ninguna');
  });

  it('una referencia genérica («esa») sigue tomando la única pendiente', () => {
    const s = elegir('esa', [pendiente] as any);
    expect(s).toMatchObject({ tipo: 'unica', movimiento: { movimiento_id: 't' } });
  });

  it('el código correcto sí clasifica', () => {
    expect(elegir('#T3', [confirmada, pendiente] as any)).toMatchObject({ tipo: 'unica', movimiento: { movimiento_id: 't' } });
  });
});
