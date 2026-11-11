// Validación de entrada: comercio por regex (SEC-003), topes de valor (SEC-007) y
// costo acotado con entradas grandes (SEC-008). Funciones puras, datos SINTÉTICOS.
import { describe, expect, it } from 'vitest';
import { interpretarCorreo } from '../src/lib/parser';
import { htmlATexto, valorCOP, valorUSD } from '../src/lib/texto';

const FECHA = new Date('2026-11-08T12:00:00Z');

const REMITENTE_BANCO = 'alertasynotificaciones@notificacionesbancolombia.com';

describe('SEC-003: comercio por regex', () => {
  it('un comercio con etiquetas o caracteres no permitidos no pasa como compra válida', () => {
    const texto = 'Bancolombia le informa Compra por $10.000 en TIENDA <b>x</b> 14:32. 08/11/2026 T.Cred *4444.';
    const r = interpretarCorreo(REMITENTE_BANCO, texto, FECHA);
    expect(r.ok).toBe(false);
  });

  it('un comercio normal sigue siendo válido', () => {
    const texto = 'Bancolombia le informa Compra por $10.000 en PANADERIA LA ESQUINA 14:32. 08/11/2026 T.Cred *4444.';
    const r = interpretarCorreo(REMITENTE_BANCO, texto, FECHA);
    expect(r.ok).toBe(true);
    if (r.ok && r.datos) expect(r.datos.comercio).toBe('PANADERIA LA ESQUINA');
  });
});

describe('SEC-002: remitente por dominio, no por nombre', () => {
  const texto = 'Bancolombia le informa Compra por $10.000 en PANADERIA LA ESQUINA 14:32. 08/11/2026 T.Cred *4444.';

  it('el nombre del banco con otro dominio no se acepta', () => {
    for (const falso of ['Bancolombia <alertas@evil.example>', 'bancolombia@notificacionesbancolombia.com.evil.example', 'Bancolombia-alertas@bancolombia-alertas.xyz']) {
      const r = interpretarCorreo(falso, texto, FECHA);
      expect(r).toMatchObject({ ok: false, motivo: 'remitente no verificado' });
    }
  });

  it('el dominio real del banco (con nombre visible) sí se acepta', () => {
    expect(interpretarCorreo(`Bancolombia <${REMITENTE_BANCO}>`, texto, FECHA).ok).toBe(true);
  });
});

describe('SEC-007: topes de valor', () => {
  it('COP por encima de 1.000 millones se rechaza (la columna es int4)', () => {
    expect(valorCOP('2.000.000.000')).toBeNull();
    expect(valorCOP('1.000.000.000')).toBe(1_000_000_000);
  });

  it('USD por encima de 50.000 se rechaza', () => {
    expect(valorUSD('60000')).toBeNull();
    expect(valorUSD('50000')).toBe(50000);
  });
});

describe('SEC-008: costo acotado', () => {
  it('HTML grande sin cerrar etiquetas se procesa en tiempo acotado', () => {
    const adversarial = '<script>'.repeat(40_000);
    const t0 = Date.now();
    htmlATexto(adversarial);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('un correo muy largo no tumba el parser', () => {
    const largo = 'Bancolombia le informa Compra por $10.000 en TIENDA X 14:32. 08/11/2026 T.Cred *4444. ' + ' '.repeat(200_000);
    const t0 = Date.now();
    interpretarCorreo('alertas@bancolombia.com.co', largo, FECHA);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('A2: centavos en pesos enteros', () => {
  it('93.663,75 queda en 93.664, igual que el extracto y la captura', () => {
    expect(valorCOP('$93.663,75')).toBe(93_664);
    expect(valorCOP('$93.663,49')).toBe(93_663);
    expect(valorCOP('$45.900,00')).toBe(45_900);
  });
});
