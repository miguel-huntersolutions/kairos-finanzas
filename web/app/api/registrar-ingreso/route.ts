// Generado por scripts/generar-rutas-next.mjs desde src/functions/registrar-ingreso.ts. No editar a mano.
import { handler } from '@src/functions/registrar-ingreso';
import { ruta } from '../../../lib/rutas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = ruta(handler);
