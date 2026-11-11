// Genera los Route Handlers de web/app/api a partir de src/functions/*.ts.
// Cada archivo de src/functions pasa a /api/<nombre-del-archivo> (mismo nombre, otra base).
// La función `recordatorio` (duradera) no se expone: la reemplaza el cron.
// Uso: node scripts/generar-rutas-next.mjs   (vuelve a generar y sobrescribe)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const fuentes = join(raiz, 'src', 'functions');
const api = join(raiz, 'web', 'app', 'api');
const CABECERA = (f) => `// Generado por scripts/generar-rutas-next.mjs desde src/functions/${f}.ts. No editar a mano.\n`;

// Rutas que llaman al modelo con un archivo (imagen o PDF): más tiempo que el predeterminado.
const DURACION = { 'revisar-captura': 60 };

const generadas = [];
for (const archivo of readdirSync(fuentes).filter((f) => f.endsWith('.ts')).sort()) {
  const nombre = archivo.replace(/\.ts$/, '');
  const dir = join(api, nombre);
  mkdirSync(dir, { recursive: true });
  const cuerpo = `${CABECERA(nombre)}import { handler } from '@src/functions/${nombre}';
import { ruta${nombre === 'tablero' ? ', rutaDeTablero' : ''} } from '../../../lib/rutas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
${DURACION[nombre] ? `export const maxDuration = ${DURACION[nombre]};\n` : ''}${nombre === 'tablero'
  ? "export const GET = ruta(handler, rutaDeTablero);\nexport const POST = ruta(handler, rutaDeTablero);\n"
  : 'export const POST = ruta(handler);\n'}`;
  // La ruta del tablero es un catch-all opcional: /api/tablero, /api/tablero/sesion, …
  const destino = nombre === 'tablero' ? join(api, 'tablero', '[[...ruta]]') : dir;
  mkdirSync(destino, { recursive: true });
  writeFileSync(join(destino, 'route.ts'), cuerpo.replace(`'../../../lib/rutas'`, nombre === 'tablero' ? `'../../../../lib/rutas'` : `'../../../lib/rutas'`));
  generadas.push(nombre);
}
console.log(`rutas generadas: ${generadas.length}`);
