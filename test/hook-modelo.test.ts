import { afterEach, describe, expect, it, vi } from 'vitest';
import { efectosDesdeEntorno } from '../src/lib/efectos';

// El aviso de compra nueva es una tarea operativa: va en Haiku y sin razonamiento.
// Las preguntas de las personas usan el modelo del agente (Sonnet).
describe('hook a OpenClaw: modelo de las tareas operativas', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function cuerpoEnviado(env: Record<string, string>) {
    const fetchFalso = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchFalso);
    await efectosDesdeEntorno({ OPENCLAW_HOOK_URL: 'https://hook.test/hooks/agent', OPENCLAW_HOOK_TOKEN: 't', ...env } as any)
      .avisarHook({ movimiento_id: 'm-1', evento: 'nuevo' } as any);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchFalso.mock.calls[0][1].body);
  }

  it('usa Haiku y thinking off por defecto', async () => {
    const b = await cuerpoEnviado({});
    expect(b.model).toBe('anthropic/claude-haiku-5-5');
    expect(b.thinking).toBe('off');
    expect(b.agentId).toBe('finanzas');
    expect(b.message).toContain('movimiento_id=m-1');
  });

  it('OPENCLAW_HOOK_MODEL cambia el modelo', async () => {
    const b = await cuerpoEnviado({ OPENCLAW_HOOK_MODEL: 'anthropic/claude-sonnet-5-5' });
    expect(b.model).toBe('anthropic/claude-sonnet-5-5');
  });
});
