// Ruta de una herramienta: expone su operación del dominio.
import { herramienta } from '../lib/http';
export const handler = herramienta('cambiar_cuotas');
