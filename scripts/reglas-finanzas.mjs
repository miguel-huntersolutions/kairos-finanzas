#!/usr/bin/env node
// Copia el bloque único de reglas de finanzas (openclaw/reglas-finanzas.md) dentro de un
// AGENTS.md, entre las marcas `<!-- reglas-finanzas:inicio … -->` y `<!-- reglas-finanzas:fin -->`.
//   node scripts/reglas-finanzas.mjs <AGENTS.md>          reemplaza el bloque (o lo agrega al final)
//   node scripts/reglas-finanzas.mjs --check <AGENTS.md>  sale con 1 si el bloque no es idéntico
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BLOQUE = readFileSync(join(raiz, 'openclaw/reglas-finanzas.md'), 'utf8').trimEnd();
const MARCA = /<!-- reglas-finanzas:inicio[\s\S]*?<!-- reglas-finanzas:fin -->/;

export function conBloque(texto) {
  if (MARCA.test(texto)) return texto.replace(MARCA, () => BLOQUE);
  return `${texto.trimEnd()}\n\n${BLOQUE}\n`;
}

const args = process.argv.slice(2);
const check = args[0] === '--check';
const archivo = check ? args[1] : args[0];
if (!archivo) {
  console.error('uso: node scripts/reglas-finanzas.mjs [--check] <AGENTS.md>');
  process.exit(2);
}
const actual = readFileSync(archivo, 'utf8');
const nuevo = conBloque(actual);
if (check) {
  if (actual.match(MARCA)?.[0] !== BLOQUE) {
    console.error(`${archivo}: el bloque de finanzas no es igual al de openclaw/reglas-finanzas.md`);
    process.exit(1);
  }
  console.log(`${archivo}: bloque igual`);
} else if (nuevo !== actual) {
  writeFileSync(archivo, nuevo);
  console.log(`${archivo}: bloque actualizado (${Buffer.byteLength(nuevo)} bytes)`);
} else {
  console.log(`${archivo}: sin cambios`);
}
