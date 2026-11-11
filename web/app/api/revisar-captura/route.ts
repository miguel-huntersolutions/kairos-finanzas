// Generado por scripts/generar-rutas-next.mjs desde src/functions/revisar-captura.ts. No editar a mano.
import { handler } from '@src/functions/revisar-captura';
import { ruta } from '../../../lib/rutas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const POST = ruta(handler);
