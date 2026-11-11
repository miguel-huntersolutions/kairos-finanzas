// Parte db/esquema.sql y db/semilla.sql en db/migrations/NNN_nombre.sql
// (una sentencia por archivo).
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const destino = join(raiz, 'db', 'migrations');

export function bloques() {
  const salida = [];
  for (const fuente of ['esquema.sql', 'semilla.sql', 'cambios.sql']) {
    const texto = readFileSync(join(raiz, 'db', fuente), 'utf8');
    for (const parte of texto.split(/^-- @@ /m).slice(1)) {
      const [nombre, ...resto] = parte.split('\n');
      const sql = resto
        .filter((l) => !/^\s*--/.test(l))
        .join('\n')
        .trim();
      if (sql) salida.push({ nombre: nombre.trim(), sql });
    }
  }
  return salida;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(destino, { recursive: true });
  for (const f of readdirSync(destino)) if (f.endsWith('.sql')) rmSync(join(destino, f));
  bloques().forEach(({ nombre, sql }, i) => {
    const archivo = `${String(i + 1).padStart(3, '0')}_${nombre}.sql`;
    writeFileSync(join(destino, archivo), sql + '\n');
  });
  console.log(`migraciones: ${bloques().length} archivos en db/migrations/`);
}
