// Compras que NO suman en las cifras (resumen del agente, resumen diario, tablero).
// Es la misma regla del tablero (`posiblesDuplicados` + `cuenta` de conciliacion.ts),
// aplicada en un solo lugar: una compra por correo que tiene su fila del extracto
// (por la regla provisional de ±VENTANA_DIAS o por `conciliado_con`) no se cuenta dos veces.
import { cuenta, type FilaConciliable, posiblesDuplicados } from './conciliacion';
import type { Db } from './db';

/**
 * Ids de movimientos que no deben sumar. Lee todas las filas de correo, captura y extracto
 * (no descartadas, con valor, fecha y tarjeta), igual que el tablero, para que el
 * emparejamiento uno a uno dé el mismo resultado en las dos partes.
 */
export async function idsQueNoSuman(db: Db): Promise<string[]> {
  const filas: FilaConciliable[] = (await db.query(
    `SELECT id::text AS id, fuente, tarjeta_id, valor, fecha::text AS fecha, conciliado_con::text AS conciliado_con,
            extracto_id::text AS extracto_id, no_aparece_en_extracto::text AS no_aparece_en_extracto
     FROM movimientos
     WHERE estado <> 'descartado' AND fuente IN ('correo', 'captura', 'extracto')
       AND valor IS NOT NULL AND fecha IS NOT NULL AND tarjeta_id IS NOT NULL`,
  )).rows.map((f: any) => ({ ...f, valor: Number(f.valor) }));
  const dups = posiblesDuplicados(filas);
  return filas.filter((f) => !cuenta(f, dups)).map((f) => f.id);
}
