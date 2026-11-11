// Tablero web: login propio (correo + código), sesión en cookie y datos.
// HTTP pública, servida en el frontend bajo /api/tablero.
import { dbDesdeEntorno } from '../lib/db';
import { type EventoRuta, manejarTablero } from '../lib/tablero-http';

export const handler = (ev: EventoRuta) =>
  manejarTablero(ev, {
    db: dbDesdeEntorno,
    env: {
      TABLERO_CORREOS: process.env.TABLERO_CORREOS,
      TABLERO_CODIGO: process.env.TABLERO_CODIGO,
      TABLERO_SESION_SECRET: process.env.TABLERO_SESION_SECRET,
      TABLERO_PERSONAS: process.env.TABLERO_PERSONAS,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });
