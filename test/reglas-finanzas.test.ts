// El bloque único de reglas de finanzas: el AGENTS.md del agente `finanzas` lo trae igual,
// y solo nombra herramientas y campos que existen en los esquemas estrictos.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ESQUEMAS } from '../src/lib/esquemas';

const bloque = readFileSync('openclaw/reglas-finanzas.md', 'utf8');

describe('bloque único de reglas de finanzas', () => {
  it('openclaw/finanzas-AGENTS.md lleva el bloque idéntico', () => {
    expect(() => execFileSync('node', ['scripts/reglas-finanzas.mjs', '--check', 'openclaw/finanzas-AGENTS.md'])).not.toThrow();
  });

  it('solo nombra herramientas que existen', () => {
    const nombradas = [...bloque.matchAll(/finanzas__([a-z_]+)/g)].map((m) => m[1]);
    expect(nombradas.length).toBeGreaterThan(5);
    for (const h of nombradas) expect(Object.keys(ESQUEMAS)).toContain(h);
  });

  it('cambiar_cuotas no acepta canal ni numero_remitente (el bloque no se los pide)', () => {
    const forma = (ESQUEMAS as any).cambiar_cuotas;
    expect(forma.safeParse({ referencia: 'la última', cuotas: 6 }).success).toBe(true);
    expect(forma.safeParse({ referencia: 'la última', cuotas: 6, canal: 'privado' }).success).toBe(false);
  });
});
