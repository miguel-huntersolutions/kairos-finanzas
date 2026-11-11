import { describe, expect, it } from 'vitest';
import { type Config, ejecutar, idDeMensaje } from '../mcp/servidor';
import * as d from '../src/lib/dominio';
import { ejecutarHerramienta } from '../src/lib/http';
import type { Herramienta } from '../src/lib/esquemas';
import { HOY, efectosFalsos, nuevaDb } from './apoyo';
import * as F from './fixtures/correos';

describe('finanzas-mcp', () => {
  it('preguntar: el servidor decide destino → envía → confirma envío → FIN', async () => {
    const { db } = await nuevaDb();
    const { ef } = efectosFalsos();
    const enviados: Array<[string, string]> = [];
    const cfg: Config = {
      token: 't',
      urls: Object.fromEntries(['tomar_movimiento', 'preguntar', 'confirmar_envio', 'clasificar'].map((h) => [h, `http://servidor/${h}`])),
      enviar: async (target, mensaje) => (enviados.push([target, mensaje]), 'wa-123'),
      fetch: (async (url: string, init: any) => {
        const h = url.split('/').pop() as Herramienta;
        const { entrada, contexto } = JSON.parse(init.body);
        const r = await ejecutarHerramienta(h, entrada, contexto, db, ef);
        return new Response(r.body, { status: r.statusCode });
      }) as any,
    };
    const r = await d.ingresarCorreo(db, ef, { correo_id: 'm1', remitente: F.BANCOLOMBIA, asunto: 'a', fecha_correo: HOY, texto: F.compraBancolombia('PANADERIA X', '7.000') });
    expect((await ejecutar(cfg, 'tomar_movimiento', { movimiento_id: r.movimiento_id })).tomado).toBe(true);
    const fin = await ejecutar(cfg, 'preguntar', { movimiento_id: r.movimiento_id, texto: '¿Qué fue esta compra de $7.000?' });
    expect(fin).toMatch(/FIN$/);
    expect(enviados[0][0]).toBe('grupo-prueba@g.us');
    const m = (await db.query('SELECT estado, whatsapp_message_id FROM movimientos WHERE id = $1', [r.movimiento_id])).rows[0];
    expect(m).toEqual({ estado: 'esperando_respuesta', whatsapp_message_id: 'wa-123' });
    // El esquema estricto también actúa en el MCP.
    await expect(ejecutar(cfg, 'clasificar', { movimiento_id: r.movimiento_id, categoria_id: 'Mercado' })).rejects.toThrow();
  });

  it('extrae el id del mensaje de la salida del CLI', () => {
    expect(idDeMensaje('{"ok":true,"messageId":"ABC"}')).toBe('ABC');
    expect(idDeMensaje('log\n{"result":{"messageId":"X1"}}')).toBe('X1');
    expect(idDeMensaje('sin json')).toMatch(/^sin-id-/);
  });
});
