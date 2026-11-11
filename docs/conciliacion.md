# Tablero unificado y conciliación

## Hoy: vista derivada, sin tocar datos

El tablero de `/` lee una sola fuente, la tabla `movimientos`, con todas las tarjetas y todas las fuentes. `/explorador` redirige a `/`. Los descartados no se muestran ni suman.

### Estado visible

El estado de cada fila lo calcula `src/lib/conciliacion.ts` (`estadoVista`) a partir de `fuente`, `estado` y `conciliado_con`:

| fuente   | Columna "Estado"                                      | Marca                                    |
|----------|-------------------------------------------------------|------------------------------------------|
| extracto | Conciliado                                            | —                                        |
| correo   | el estado del flujo (Esperando respuesta, Confirmado…) | «Por conciliar» mientras `conciliado_con` sea NULL |
| manual   | Manual                                                | —                                        |

### Regla provisional de posible duplicado (`posiblesDuplicados`)

Una fila de **correo** sin `conciliado_con` se marca como «posible duplicado de extracto» si existe una fila del **extracto** que cumple tres condiciones:

- es de la misma tarjeta (`tarjeta_id` igual y no NULL);
- tiene el mismo `valor` en COP;
- su fecha está a **±3 días** (`VENTANA_DIAS`) de la del correo, aunque caiga en otro mes.

Cómo se emparejan:

- El emparejamiento es **uno a uno**: cada fila del extracto absorbe como máximo una fila de correo.
- Gana el par con la fecha más cercana. Si hay empate, gana la fecha de correo más antigua.

Efecto en el tablero:

- La fila marcada se ve en «Movimientos» con su valor tachado.
- No suma en KPIs, gráficos ni totales; cuenta solo la del extracto.
- Una fila de correo que ya tiene `conciliado_con` tampoco suma, porque su extracto ya la representa.

## Pendientes ("Por atender")

Hay una banda visible en todas las pestañas con dos grupos:

- compras en `esperando_respuesta`;
- compras en `requiere_revision`, por ejemplo con tarjeta desconocida.

Se muestran aunque todavía no tengan valor ni fecha.

## Reclasificar

Funciona en cualquier tarjeta y fuente, sobre filas `confirmado` o `provisional`. Las pendientes se responden por WhatsApp. La acción en la bitácora sigue siendo `reclasificar_explorador`. Al reclasificar por comercio se puede limitar el cambio a la tarjeta elegida en el filtro (`tarjeta_id`).

## Conciliación con el extracto (fase 2, en el repo desde el 7 nov)

### Cómo se usa

En el tablero, **Cargar extracto** sube el PDF del extracto de una tarjeta (`POST /api/tablero/extracto`, con sesión; cuerpo `{ "pdf": "<base64>" }`). La respuesta resume: líneas leídas, conciliadas, sin correo, compras que no aparecen, líneas a revisar a mano, intereses y deuda. El mismo PDF subido dos veces no se duplica ni vuelve a llamar al modelo (huella sha256; el PDF no se guarda). Requiere `ANTHROPIC_API_KEY` (sin ella responde 503).

Límite práctico: Vercel corta el cuerpo de la petición en unos 4,5 MB, así que el PDF puede pesar hasta ~3,3 MB (el servidor acepta hasta 8 MB si el transporte lo deja pasar).

### Qué hace (`src/lib/extracto.ts`)

1. **Lector** (`lectorExtractoAnthropic`): una llamada a Haiku (`claude-haiku-5-5`) con el PDF como bloque `document` y una única herramienta de salida forzada; sin herramientas reales. El PDF es dato, no instrucciones.
2. **Validación determinista** (`validarExtracto`): tarjeta existente por últimos 4, fecha de corte válida, cada línea con fecha dentro del periodo, valor finito distinto de 0, descripción limpia de máximo 80 caracteres y cuota `n/m` válida; si el extracto trae total de compras, la suma de las líneas positivas debe cuadrar (±1 peso). Si algo falla, el extracto queda `en_revision` con su motivo y no se concilia nada.
3. **Guardado**: tabla `extractos` (tarjeta, corte, total de compras, intereses, saldo, estado, motivo, quién y cuándo) y una fila por línea en `conciliaciones` (tabla de la fase 1, reutilizada).
4. **Conciliación** (`conciliarExtracto`), con la misma regla del tablero (`emparejar` en `conciliacion.ts`, única implementación):
   - cada línea normal queda como fila de fuente `extracto` (adopta la del historial con la misma tarjeta, valor y fecha, o crea una nueva en «Otros»);
   - si empareja con una compra por correo, esta recibe `conciliado_con` y `conciliado_en`, y la fila del extracto hereda la categoría (si sigue en «Otros») y la persona;
   - las compras por correo de la tarjeta entre el inicio del periodo y el corte menos 3 días que no aparecen quedan con `no_aparece_en_extracto` y salen en «Por atender»; siguen sumando;
   - cada acción queda en la bitácora (`conciliar`, actor `sistema`). Correrla dos veces no cambia nada.
5. **Regla provisional**: `posiblesDuplicados` ya no se aplica a lo que pasó por la conciliación (filas con `extracto_id`, filas del extracto con un correo conciliado, correos marcados «no aparece»). Queda solo para el historial cargado sin conciliar.

«Detalle del mes» muestra intereses y deuda del corte del mes (de la tarjeta filtrada o la suma de todas).

### Lo que sigue siendo manual

- Líneas a cuotas (`n/m` con m > 1), abonos, pagos y reversos (valor negativo), y líneas con una compra en USD parecida (±10 %): quedan como `revision` en «Por atender», sin tocar movimientos. No hay todavía pantalla para resolverlas.
- Compras «no aparece en el extracto»: alguien decide si es un duplicado (descartarla) o si se cobra en el próximo corte.
- Extractos en revisión: no hay reintento; se corrige el problema y se sube de nuevo otro archivo (el mismo PDF devuelve el resultado guardado).
- Si después del cruce responden por WhatsApp la categoría de la compra por correo, no pasa sola a la fila del extracto.
- Correos con tarjeta desconocida no entran en la conciliación.
- El lector no se ha probado con un PDF real contra la API (las pruebas usan un lector falso).

## Compras cargadas desde una captura (fuente `captura`)

Las compras que faltaban y se cargan con `cargar_faltantes` (docs/plan-capturas.md) nacen con
fuente `captura`. En todo lo de este documento se tratan igual que las de `correo`
(`FUENTES_A_CONCILIAR` en `src/lib/conciliacion.ts`): `posiblesDuplicados`, `cuenta`,
`idsQueNoSuman` y `conciliarExtracto`. En el tablero se ven como «Captura · <estado>» con la marca
«Por conciliar» hasta que llega el extracto. Así una compra cargada desde la app nunca cuenta dos veces.

