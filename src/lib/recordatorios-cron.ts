// Procesa los recordatorios vencidos (reemplaza la función duradera `recordatorio`).
// Pasos guardados en la fila:  leer_estado → (aviso al hook) → esperando_recibo → hecho
// - Tomar una fila es UN UPDATE con FOR UPDATE SKIP LOCKED: dos ejecuciones simultáneas
//   no toman la misma. En proceso se marca `en_proceso_hasta` (bloqueo de 5 min); si la
//   ejecución muere, la fila vuelve a tomarse cuando vence el bloqueo.
// - El recordatorio queda hecho SOLO con el recibo del envío (`confirmar_recordatorio`, que
//   llama el MCP con el whatsapp_message_id). Mientras no llegue, cada revisión (15 min)
//   vuelve a avisar al hook si la compra sigue esperando con el mismo código. Un recordatorio
//   repetido es una molestia menor que uno perdido. Tras MAX_INTENTOS_RECORDATORIO queda
//   `fallido`, visible con su motivo.
// - Un error al avisar devuelve la fila a `pendiente` con reintento en 5 min.
// - Las filas viejas en paso 'marcar' o 'avisar' (flujo anterior) se tratan como leer_estado.
import type { Db } from './db';
import type { Efectos } from './dominio';

export const MAX_INTENTOS_RECORDATORIO = 5;
export const BLOQUEO_RECORDATORIO_MS = 5 * 60_000;
export const REINTENTO_RECORDATORIO_MS = 5 * 60_000;
/** Espera del recibo del envío antes de volver a avisar (el cron corre cada 15 min). */
export const ESPERA_RECIBO_MS = 14 * 60_000;

type Paso = 'leer_estado' | 'marcar' | 'avisar' | 'esperando_recibo';
interface Fila { id: string; movimiento_id: string; pregunta_codigo: string; paso: Paso; intentos: number }
export interface ResultadoCron { revisados: number; hechos: number; avisados: number; reintentos: number; fallidos: number }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function cerrar(db: Db, id: string, resultado: string, estado: 'hecho' | 'fallido' = 'hecho') {
  await db.query(
    `UPDATE recordatorios_pendientes SET estado = $3, en_proceso_hasta = NULL, datos = jsonb_build_object('resultado', $2::text),
       ultimo_error = CASE WHEN $3 = 'fallido' THEN $2::text ELSE ultimo_error END, actualizado_en = now() WHERE id = $1`,
    [id, resultado, estado],
  );
}

/** Revisa una fila: cierra, falla o avisa al hook y queda esperando el recibo. */
async function avanzar(db: Db, ef: Efectos, f: Fila, ahora: number): Promise<'hecho' | 'avisado' | 'fallido'> {
  const { rows } = await db.query<{ estado: string; pregunta_codigo: string | null; recordado: boolean }>(
    'SELECT estado, pregunta_codigo, recordado FROM movimientos WHERE id = $1',
    [f.movimiento_id],
  );
  const m = rows[0];
  if (!m || m.estado !== 'esperando_respuesta' || m.pregunta_codigo !== f.pregunta_codigo) {
    await cerrar(db, f.id, m ? `sin recordatorio: estado ${m.estado}, código ${m.pregunta_codigo}` : 'sin recordatorio: el movimiento no existe');
    return 'hecho';
  }
  if (m.recordado) {
    await cerrar(db, f.id, 'recordado');
    return 'hecho';
  }
  if (f.paso === 'esperando_recibo' && f.intentos > MAX_INTENTOS_RECORDATORIO) {
    await cerrar(db, f.id, 'sin recibo del envío del recordatorio', 'fallido');
    return 'fallido';
  }
  await ef.avisarHook({ movimiento_id: f.movimiento_id, evento: 'recordatorio', intento: `${f.pregunta_codigo}-${f.intentos}` });
  await db.query(
    `UPDATE recordatorios_pendientes SET estado = 'pendiente', paso = 'esperando_recibo', en_proceso_hasta = NULL,
       proxima_revision = $2, actualizado_en = now() WHERE id = $1`,
    [f.id, new Date(ahora + ESPERA_RECIBO_MS)],
  );
  return 'avisado';
}

/** Toma (con bloqueo) hasta `lote` recordatorios vencidos y los procesa. */
export async function procesarRecordatorios(db: Db, ef: Efectos, ahora = Date.now(), lote = 20): Promise<ResultadoCron> {
  const { rows } = await db.query<Fila>(
    `UPDATE recordatorios_pendientes SET estado = 'en_proceso', en_proceso_hasta = $2, intentos = intentos + 1, actualizado_en = now()
     WHERE id IN (
       SELECT id FROM recordatorios_pendientes
       WHERE (estado = 'pendiente' AND proxima_revision <= $1)
          OR (estado = 'en_proceso' AND en_proceso_hasta < $1)
       ORDER BY proxima_revision
       LIMIT $3
       FOR UPDATE SKIP LOCKED)
     RETURNING id, movimiento_id, pregunta_codigo, paso, intentos`,
    [new Date(ahora), new Date(ahora + BLOQUEO_RECORDATORIO_MS), lote],
  );
  const out: ResultadoCron = { revisados: rows.length, hechos: 0, avisados: 0, reintentos: 0, fallidos: 0 };
  for (const f of rows) {
    try {
      const r = await avanzar(db, ef, f, ahora);
      if (r === 'hecho') out.hechos++;
      else if (r === 'avisado') out.avisados++;
      else out.fallidos++;
    } catch (e) {
      const agotado = f.intentos >= MAX_INTENTOS_RECORDATORIO;
      await db.query(
        `UPDATE recordatorios_pendientes SET estado = $2, en_proceso_hasta = NULL, proxima_revision = $3, ultimo_error = $4,
           actualizado_en = now() WHERE id = $1`,
        [f.id, agotado ? 'fallido' : 'pendiente', new Date(ahora + REINTENTO_RECORDATORIO_MS), msg(e)],
      );
      if (agotado) out.fallidos++;
      else out.reintentos++;
    }
  }
  return out;
}
