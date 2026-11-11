// Generado por scripts/generar-rutas-next.mjs desde src/functions/tablero.ts. No editar a mano.
import { handler } from '@src/functions/tablero';
import { ruta, rutaDeTablero } from '../../../../lib/rutas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = ruta(handler, rutaDeTablero);
export const POST = ruta(handler, rutaDeTablero);
