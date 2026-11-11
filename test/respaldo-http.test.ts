// El endpoint HTTP del respaldo exige el token; sin token no hace nada.
import { describe, expect, it } from 'vitest';
import { handler } from '../src/functions/respaldo';

process.env.FINANZAS_API_TOKEN = 'token-de-prueba-sintetico-0123456789abcdef';

const ev = (headers: Record<string, string[]>, method = 'POST') => ({ __evento_http: true, method, headers, body: '' });

describe('respaldo por HTTP', () => {
  it('sin token o con token incorrecto: 401 y no toca la base', async () => {
    expect((await handler(ev({}) as any)).statusCode).toBe(401);
    expect((await handler(ev({ authorization: ['Bearer otro'] }) as any)).statusCode).toBe(401);
  });
  it('GET o evento no HTTP: rechazado', async () => {
    expect((await handler(ev({ authorization: [`Bearer ${process.env.FINANZAS_API_TOKEN}`] }, 'GET') as any)).statusCode).toBe(405);
    expect((await handler({ method: 'POST' } as any)).statusCode).toBe(400);
  });
});
