// finanzas-mcp y las capturas: el modelo solo da la ruta del adjunto; el MCP lo lee con
// guardas (carpeta, enlaces simbólicos, «..», extensión, tamaño) y lo manda a Vercel. El
// contenido del archivo nunca vuelve al modelo. Datos SINTÉTICOS; fetch falso hacia el dominio real.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, ErrorRechazo, MAX_ARCHIVO_MCP, ejecutar, esCopiaDeOpenClaw, leerAdjunto } from '../mcp/servidor';
import type { Db } from '../src/lib/db';
import type { Herramienta } from '../src/lib/esquemas';
import { ejecutarHerramienta } from '../src/lib/http';
import { efectosFalsos, nuevaDb } from './apoyo';
import { crearXlsx, serie } from './fixtures/xlsx';

const hoy = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dia = (n: number) => new Date(hoy().getTime() - n * 86_400_000).toISOString().slice(0, 10);

let raiz: string;
let inbound: string;
beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'kairos-capturas-'));
  inbound = join(raiz, 'media', 'inbound');
  mkdirSync(inbound, { recursive: true });
});

describe('guardas del adjunto', () => {
  it('lee un adjunto de la carpeta, con la ruta como la muestra el mensaje', async () => {
    writeFileSync(join(inbound, 'file_68---abc.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const a = await leerAdjunto(`[media attached: ${join(inbound, 'file_68---abc.jpg')} (image/jpeg) | otra cosa]`, inbound);
    expect(a).toMatchObject({ nombre: 'file_68---abc.jpg', mime: 'image/jpeg' });
    expect((await leerAdjunto('file_68---abc.jpg', inbound)).bytes.length).toBe(4);
  });

  it('acepta la copia temporal que OpenClaw crea por agente (openclaw-staged)', () => {
    const ok = '/root/.openclaw/workspace-personal/media/inbound/openclaw-staged-5098a981-9c79/input-Movimientos---7b8c.xlsx';
    expect(esCopiaDeOpenClaw(ok)).toBe(true);
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-finanzas/media/inbound/openclaw-staged-x/input-a.pdf')).toBe(true);
    // Fuera del patrón: otra carpeta, un nivel de más, o un archivo del sistema.
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-personal/secreto.xlsx')).toBe(false);
    expect(esCopiaDeOpenClaw('/root/.openclaw/workspace-personal/media/inbound/openclaw-staged-x/sub/a.xlsx')).toBe(false);
    expect(esCopiaDeOpenClaw('/root/.openclaw/tools/finanzas/token')).toBe(false);
    expect(esCopiaDeOpenClaw('/root/.openclaw/media/inbound/a.xlsx')).toBe(false);
  });

  it.each([
    ['fuera de la carpeta', () => { writeFileSync(join(raiz, 'fuera.png'), 'x'); return join(raiz, 'fuera.png'); }, 'carpeta de WhatsApp'],
    ['con ..', () => `${inbound}/../fuera.png`, '«..»'],
    ['enlace simbólico que sale', () => { writeFileSync(join(raiz, 'secreto.png'), 'x'); symlinkSync(join(raiz, 'secreto.png'), join(inbound, 'enlace.png')); return join(inbound, 'enlace.png'); }, 'carpeta de WhatsApp'],
    ['extensión no permitida', () => { writeFileSync(join(inbound, 'a.gif'), 'x'); return join(inbound, 'a.gif'); }, 'solo acepto'],
    ['enlace que cambia la extensión', () => { writeFileSync(join(inbound, 'b.txt'), 'x'); symlinkSync(join(inbound, 'b.txt'), join(inbound, 'b.png')); return join(inbound, 'b.png'); }, 'solo acepto'],
    ['demasiado grande', () => { writeFileSync(join(inbound, 'grande.pdf'), Buffer.alloc(MAX_ARCHIVO_MCP + 1)); return join(inbound, 'grande.pdf'); }, 'el máximo es 3.3 MB'],
    ['no existe', () => join(inbound, 'no.png'), 'no encontré'],
    ['una carpeta', () => { mkdirSync(join(inbound, 'dir.png')); return join(inbound, 'dir.png'); }, 'no es un archivo'],
  ])('rechaza: %s', async (_n, preparar, mensaje) => {
    const ruta = preparar();
    const e = await leerAdjunto(ruta, inbound).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorRechazo);
    expect(e.message).toContain(mensaje);
  });
});

describe('MCP → Vercel de punta a punta', () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await nuevaDb());
  });

  function mcp(leerCaptura?: (c: Uint8Array | string, m: string) => Promise<unknown>) {
    const { ef, hooks } = efectosFalsos();
    const llamadas: Array<{ h: Herramienta; entrada: any; operacion_id?: string }> = [];
    const cfg: Config = {
      token: 't',
      mediaDir: inbound,
      urls: { confirmar_envio: 'http://vercel/api/confirmar-envio' },
      enviar: async () => 'wa-1',
      fetch: (async (url: string, init: any) => {
        const h = url.split('/').pop()!.replaceAll('-', '_') as Herramienta;
        const { entrada, contexto, operacion_id } = JSON.parse(init.body);
        llamadas.push({ h, entrada, operacion_id });
        const r = await ejecutarHerramienta(h, entrada, contexto, db, { ...ef, leerCaptura }, operacion_id);
        return new Response(r.body, { status: r.statusCode });
      }) as any,
    };
    return { cfg, llamadas, hooks };
  }

  it('Excel: revisar → el modelo ve solo el texto del servidor → «sí» → cargar', async () => {
    const ruta = join(inbound, 'movimientos.xlsx');
    writeFileSync(ruta, crearXlsx([['Fecha', 'Descripción', 'Valor', 'Tipo de moneda'], [serie(dia(2)), 'UBER RIDES', 14_000, 'COP'], [serie(dia(1)), 'ZZ PRUEBA', 9_000, 'COP']]));
    const { cfg, llamadas, hooks } = mcp();
    const r: any = await ejecutar(cfg, 'revisar_captura', { archivo: ruta, numero_remitente: '+570000000001', canal: 'grupo', tarjeta: 'VISA' });
    expect(Object.keys(r).sort()).toEqual(['codigo', 'instruccion', 'repetido', 'texto']);
    expect(r.texto).toContain('Faltan 2:');
    expect(JSON.stringify(r)).not.toContain(llamadas[0].entrada.contenido_base64.slice(0, 40));
    expect(llamadas[0]).toMatchObject({ h: 'revisar_captura', entrada: { archivo_nombre: 'movimientos.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', canal: 'grupo', tarjeta: 'VISA' } });
    expect(llamadas[0].operacion_id).toMatch(/^[0-9a-f-]{36}$/);
    const c: any = await ejecutar(cfg, 'cargar_faltantes', { codigo: `#${r.codigo}`, numero_remitente: '+570000000002' });
    expect(c).toMatchObject({ aplicado: true, cargadas: 2, por_preguntar: 1 });
    expect(hooks).toHaveLength(1);
    // El esquema que ve el modelo es estricto: no acepta contenido ni campos de más.
    await expect(ejecutar(cfg, 'revisar_captura', { archivo: ruta, numero_remitente: '+570000000001', canal: 'grupo', contenido_base64: 'AAAA' })).rejects.toThrow();
  });

  it('imagen: un archivo fuera de la carpeta se rechaza sin llamar a Vercel; la imagen buena pasa por el lector una vez', async () => {
    let llamadasModelo = 0;
    const { cfg, llamadas } = mcp(async () => (llamadasModelo++, { lineas: [{ fecha: dia(1), descripcion: 'ZZ FOTO', valor: 5_500, moneda: 'COP', estado_app: 'verificado' }] }));
    writeFileSync(join(raiz, 'afuera.png'), 'x');
    await expect(ejecutar(cfg, 'revisar_captura', { archivo: join(raiz, 'afuera.png'), numero_remitente: '+570000000001', canal: 'privado' })).rejects.toBeInstanceOf(ErrorRechazo);
    expect(llamadas).toHaveLength(0);
    const foto = join(inbound, 'file_1---x.png');
    writeFileSync(foto, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('sintética')]));
    const a: any = await ejecutar(cfg, 'revisar_captura', { archivo: foto, numero_remitente: '+570000000001', canal: 'privado' });
    const b: any = await ejecutar(cfg, 'revisar_captura', { archivo: foto, numero_remitente: '+570000000001', canal: 'privado' });
    expect(b.codigo).toBe(a.codigo);
    expect(b.repetido).toBe(true);
    expect(llamadasModelo).toBe(1);
    // Alguien que no es Miguel ni Katerine: rechazado.
    await expect(ejecutar(cfg, 'cargar_faltantes', { codigo: a.codigo, numero_remitente: '+579999999999' })).rejects.toBeInstanceOf(ErrorRechazo);
  });
});
