// Cada herramienta del MCP llama a /api/<nombre>: sin función y ruta, en producción daría 404.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESQUEMAS } from '../src/lib/esquemas';

describe('rutas de las herramientas', () => {
  it.each(Object.keys(ESQUEMAS))('%s tiene función y ruta web', (h) => {
    const nombre = h.replaceAll('_', '-');
    expect(existsSync(join('src/functions', `${nombre}.ts`))).toBe(true);
    expect(existsSync(join('web/app/api', nombre, 'route.ts'))).toBe(true);
  });
});
