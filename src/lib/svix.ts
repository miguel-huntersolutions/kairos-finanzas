// Verificación de firma Svix, tomada de app/api/webhooks/resend/route.ts de
// app-financial-services-home. Lo que no se debe deshacer:
//  1. La firma se verifica contra el cuerpo CRUDO, y el JSON se parsea después
//     de esa misma cadena (re-serializar cambia el texto y la firma falla).
//  2. En svix 2.x `verify` solo valida y LANZA si algo no cuadra.
import { Webhook } from 'svix';

export type Cabeceras = Record<string, string[] | string | undefined>;

function cabecera(h: Cabeceras, nombre: string): string {
  const clave = Object.keys(h).find((k) => k.toLowerCase() === nombre);
  const v = clave ? h[clave] : undefined;
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export function verificarFirmaSvix(secreto: string, cuerpoCrudo: string, h: Cabeceras): boolean {
  try {
    new Webhook(secreto).verify(cuerpoCrudo, {
      'svix-id': cabecera(h, 'svix-id'),
      'svix-timestamp': cabecera(h, 'svix-timestamp'),
      'svix-signature': cabecera(h, 'svix-signature'),
    });
    return true;
  } catch {
    return false;
  }
}

export { cabecera };
