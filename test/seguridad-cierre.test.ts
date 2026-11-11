// Cierre de la revisión: SEC-011 (adjuntos solo de finanzas y personal), SEC-012 (sesión sin persona
// asignada se rechaza) y M2 (fecha de respaldo en hora de Bogotá). Datos SINTÉTICOS.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { esCopiaDeOpenClaw } from '../mcp/servidor';
import { interpretarCorreo } from '../src/lib/parser';
import { tienePersona } from '../src/lib/explorador';
import { firmarSesion } from '../src/lib/acceso';
import { type EventoRuta, manejarTablero } from '../src/lib/tablero-http';
import { nuevaDb } from './apoyo';
import type { Db } from '../src/lib/db';

describe('SEC-011: adjuntos', () => {
  it('solo las copias de finanzas y personal se aceptan', () => {
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-finanzas/media/inbound/openclaw-staged-x/input-a.pdf')).toBe(true);
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-personal/media/inbound/openclaw-staged-x/input-a.pdf')).toBe(true);
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-main/media/inbound/openclaw-staged-x/input-a.pdf')).toBe(false);
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-lexia/media/inbound/openclaw-staged-x/input-a.pdf')).toBe(false);
  });
});

describe('SEC-012: persona asignada', () => {
  it('tienePersona exige mapeo explícito', () => {
    expect(tienePersona('ana@ejemplo.com', 'ana@ejemplo.com=miguel')).toBe(true);
    expect(tienePersona('ana@ejemplo.com', 'beto@ejemplo.com=katerine')).toBe(false);
    expect(tienePersona('ana@ejemplo.com', undefined)).toBe(false);
  });

  it('una sesión válida de un correo sin persona no entra al tablero (401)', async () => {
    const { db } = await nuevaDb();
    const env = { TABLERO_CORREOS: 'ana@ejemplo.com', TABLERO_CODIGO: '135790', TABLERO_SESION_SECRET: 'secreto-cierre-0123456789abcdef', TABLERO_PERSONAS: '' };
    const cookie = `__Host-tablero_sesion=${firmarSesion('ana@ejemplo.com', env.TABLERO_SESION_SECRET)}`;
    const ev: EventoRuta = { __evento_http: true, method: 'GET', path: '/sesion', headers: { cookie: [cookie] }, query: {}, body: '', request_context: { host: 'x', source_ip: '203.0.113.1' } };
    const r = await manejarTablero(ev, { db: () => db as Db, env, dormir: async () => {} });
    expect(r.statusCode).toBe(401);
  });
});

describe('M2: fecha de respaldo en Bogotá', () => {
  beforeEach(() => vi.useRealTimers());
  it('un correo sin fecha completa recibido a las 20:30 del 31/10 (Bogotá) queda el 31/10, no el 1/11', () => {
    // 2026-11-01T01:30Z es 31/10 20:30 en Bogotá (UTC-5).
    const r = interpretarCorreo(
      'Bancolombia <alertasynotificaciones@notificacionesbancolombia.com>',
      'Bancolombia le informa Compra por $10.000 en PANADERIA LA ESQUINA 20:30. T.Cred *4444.',
      new Date('2026-11-01T01:30:00Z'),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.datos) expect(r.datos.fecha).toBe('2026-10-31');
  });
});
