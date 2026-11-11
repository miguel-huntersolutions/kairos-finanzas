# Plan de pruebas de Kairos Finanzas (7 nov 2026)

Este plan cubre lo que está en producción desde el commit `bf547a7`. Eso incluye:

- envíos sin duplicar y el recordatorio con recibo;
- `operacion_id`;
- la herramienta `pendientes` y el aviso de corte;
- los textos que arma el servidor;
- el lector de extractos con su conciliación;
- las acciones nuevas del tablero.

Junto con las pruebas de aceptación A1–A9 y C1–C3 del [plan de trabajo](plan-de-trabajo.md), este plan define qué falta probar y cómo hacerlo.

**Reglas de las pruebas en producción:**

- No se mandan mensajes de prueba por WhatsApp ni correos falsos.
- No se corren los crons a mano.
- Las pruebas de punta a punta se hacen con compras reales a medida que llegan.
- Toda verificación se hace en la base (estado del movimiento y fila de la bitácora), nunca por lo que el agente diga en el chat.

---

## 1. Cobertura actual

Hay **203 pruebas automáticas** (202 pasan y 1 se salta). Corren con vitest y PGlite: un Postgres en memoria con las mismas migraciones de producción. Todas se pueden repetir y usan datos sintéticos.

| Área | Archivo | Pruebas | Tipo |
|---|---|---|---|
| Flujo completo: correo → pregunta → respuesta | `flujos.test.ts` | 35 | Integración (dominio + base) |
| Referencias («la de 147.750», «la última») | `referencias.test.ts` | 15 | Unitarias e integración |
| Compras en USD y TRM | `usd.test.ts` | 14 | Integración |
| Lectores por banco, texto, normalización | `puras.test.ts` | 14 | Unitarias |
| Extracto y conciliación (C1–C3, validación, HTTP) | `extracto.test.ts` | 13 | Integración y HTTP |
| Envíos sin duplicar, `operacion_id`, errores del MCP | `envios.test.ts` | 10 | Integración (MCP + Vercel + base) |
| Cron de recordatorios (recibo, bloqueo, reintentos) | `cron.test.ts` | 10 | Integración |
| Acceso al tablero (login, bloqueo, sesión) | `acceso.test.ts` | 10 | Unitarias y seguridad |
| Tablero unificado y explorador | `tablero-unificado`, `explorador`, `tablero` | 23 | Integración |
| Textos del servidor y aviso de corte | `textos-corte.test.ts` | 8 | Unitarias e integración |
| Acciones del tablero (envío, categoría, regla) | `tablero-acciones.test.ts` | 7 | Integración y HTTP |
| Sin doble conteo | `sin-doble-conteo.test.ts` | 3 | Integración |
| Rutas, reglas del agente, atascados, respaldo, MCP, hook | otros 6 archivos | 15 | Contrato y HTTP |
| Postgres real | `pg-real.test.ts` | 1 | Se salta (apunta a Volcano local) |

Comandos: `npx vitest run`, `npx tsc --noEmit` (en la raíz y en `web/`) y `cd web && npx next build`.

## 2. Brechas

Están ordenadas por riesgo.

| # | Brecha | Riesgo | Cómo se cierra |
|---|---|---|---|
| B1 | **El comportamiento del modelo** (cómo entiende «1», «mercado», «la de 147.750») solo se prueba a mano | Alto: es lo que ven las personas | Pruebas A1–A9 y E1–E8 con compras reales (sección 4) |
| B2 | **El lector de extractos nunca leyó un PDF real**: las pruebas usan un lector falso | Alto: puede leer mal cuotas, signos o totales | Prueba X1 con un extracto real pequeño (sección 4) |
| B3 | **No hay pruebas contra Neon**: PGlite no es idéntico (planes, bloqueos, `FOR UPDATE SKIP LOCKED` con concurrencia real) | Medio | Pruebas de integración contra una rama de Neon (sección 3.2) |
| B4 | **Contrato con OpenClaw**: el formato de salida de `openclaw message send`. Si el MCP no encuentra el id del mensaje, usa `sin-id-…` y da el envío por confirmado | Medio: un envío fallido se vería como enviado | Prueba de contrato con la salida real del CLI (sección 3.3) |
| B5 | **Ventana de idempotencia del hook** (`idempotency-key`) sin confirmar en OpenClaw | Medio: los reintentos podrían descartarse | Revisar los logs del gateway en el primer reintento real (E4) |
| B6 | **La interfaz del tablero no se probó en un navegador** (solo `tsc` y `next build`) | Medio | Pruebas T1–T6 a mano y, después, pruebas de interfaz automáticas (sección 3.4) |
| B7 | **No se mide la cobertura**: no hay un umbral que falle | Bajo | `vitest --coverage` con umbrales (sección 5) |
| B8 | **Las pruebas no corren antes de desplegar**: un push a `main` publica directo | Alto en proceso | Correr las pruebas en GitHub Actions al hacer un PR y proteger `main` (sección 5) |
| B9 | **Límites de Vercel**: PDF de ~3,3 MB como máximo y duración por defecto de la función | Bajo | Prueba X3 con un PDF grande |

## 3. Pruebas automáticas

### 3.1 Unitarias e integración (vitest + PGlite)

Ya existen. Hay que mantenerlas. Toda falla corregida en producción agrega primero una prueba que la reproduzca.

Casos que faltan:

| Id | Caso | Esperado |
|---|---|---|
| U1 | `idDeMensaje` con salida sin id | Hoy devuelve `sin-id-…`. Decidir si eso cuenta como «incierto» en vez de confirmado (B4) |
| U2 | `confirmar_recordatorio` con un código viejo, después de reasignar la pregunta | 409; la fila del cron no se cierra |
| U3 | `operacion_id` concurrente: dos llamadas con el mismo id al mismo tiempo | Una aplica y la otra recibe `409 en_curso` |
| U4 | Aviso de corte con dos tarjetas el mismo día y una sin `dia_corte` | Solo avisa las que tienen día de corte, una vez cada una |
| U5 | Respuesta por WhatsApp que llega después de conciliar | Hoy no se copia a la fila del extracto. Prueba pendiente para cuando se implemente |
| U6 | `textoResumen` con un mes sin compras | «$0 en 0 compras», sin secciones vacías |

### 3.2 Integración contra Neon (nueva)

Correr `pg-real.test.ts` y los flujos principales contra una **rama de Neon** creada desde producción. No se escribe en producción.

| Id | Caso | Esperado |
|---|---|---|
| N1 | Migraciones 001–040 sobre una base vacía, y otra vez encima | Sin errores las dos veces (idempotencia) |
| N2 | Dos procesos de `procesarRecordatorios` en paralelo | Cada fila la toma una sola ejecución |
| N3 | `respaldo` con 500 movimientos | Termina en menos de 10 s (arranque en frío de Neon incluido) |

### 3.3 Contrato con OpenClaw (nueva)

| Id | Caso | Esperado |
|---|---|---|
| K1 | Guardar como fixture una salida real de `openclaw message send --json` (sin el número) | `idDeMensaje` extrae el id |
| K2 | Formato del cuerpo de `/hooks/agent` que manda `efectos.ts` | Coincide con lo que acepta OpenClaw 2026.11.1 (agentId, sessionMode, model, message) |
| K3 | Lo que trae `_meta` en `tools/call` (sale en el log del gateway la primera vez) | Documentar si trae el remitente. Si lo trae, pasar a usarlo en vez del número que da el modelo |

### 3.4 Interfaz del tablero (después)

Agregar pruebas de interfaz con Playwright en modo demo, sin base. Cubrirían: cambiar de pestaña, filtros, «Por atender» con sus botones, reclasificar con deshacer y el diálogo de «Nueva categoría». Hasta que existan, se prueba a mano con T1–T6.

## 4. Pruebas de aceptación en producción (manuales)

Para cada prueba hay que anotar la fecha y el resultado. Se verifica con SQL en Neon. Las consultas de apoyo están en la sección 6.

### Agente y envíos

Se corren con la próxima compra real. A1–A9 siguen como están en el plan de trabajo. Estas son las nuevas:

| Id | Situación | Esperado | Cómo se verifica |
|---|---|---|---|
| E1 | Compra nueva en tarjeta compartida | **Una** pregunta en el grupo, con código y 2–3 opciones | `estado = esperando_respuesta`, `whatsapp_message_id` no nulo, una fila `preguntar` en la bitácora y una fila en `operaciones` por cada llamada |
| E2 | Nadie responde en 4 h | Llega **un** recordatorio que empieza con «Recordatorio:» y lleva el mismo código | `recordado = true`; fila de `recordatorios_pendientes` en `hecho` con `whatsapp_message_id`; una fila `recordar` en la bitácora |
| E3 | Responder «1» al recordatorio | Clasifica la compra y el cron no vuelve a avisar | `estado = confirmado`; la fila del cron sigue en `hecho` |
| E4 | (Si pasa) el recordatorio no llega | El cron reintenta a los 15 min | Fila en `esperando_recibo` con `intentos` subiendo. En el log del gateway, cada aviso con una clave distinta (B5) |
| E5 | Escribir en privado «¿qué me falta por responder?» | Lista numerada con código y descripción, sin ids | Que no aparezca ningún uuid en el chat |
| E6 | (Si pasa) aparece «Envío sin confirmar» en el tablero | Botón «Sí llegó» → queda esperando. «Volver a preguntar» → pregunta nueva en ≤ 30 min | Bitácora `resolver_envio_sin_confirmar` con quién lo hizo |
| E7 | Resumen diario de las 8 p. m. | Texto del servidor: total, por persona, top 5 de categorías y pendientes | Las cifras coinciden con el tablero del mes. El agente no agregó cifras |
| E8 | Repaso del domingo 8 nov | Ítems numerados y la línea de métricas. «Sí menos la 2» confirma todo menos el 2 | `reglas_comercio` y `categorias`: cambiaron solo los aprobados |

### Extracto y conciliación

| Id | Situación | Esperado | Cómo se verifica |
|---|---|---|---|
| X1 | Cargar el PDF real del último corte de la VISA | Resumen con líneas, conciliadas, creadas, «no aparecen» y estado `procesado` | Revisar a mano cinco líneas contra el PDF: fecha, valor y cuota. `SUM` de las líneas positivas = total del extracto |
| X2 | Cargar el mismo PDF otra vez | Mismo resumen, sin llamar al modelo | Una sola fila en `extractos`; los conteos de `conciliaciones` no cambian |
| X3 | PDF de más de 3,3 MB | El tablero avisa antes de subir | No llega petición a Vercel |
| X4 | Extracto con una compra a cuotas | Esa línea queda en `revision` en «Por atender» | `conciliaciones.resultado = 'revision'` |
| X5 | Compra por correo de los días antes del corte que no está en el extracto | Si cae en los últimos 3 días antes del corte, NO se marca «no aparece» | `no_aparece_en_extracto` nulo |
| X6 | Después de X1, en el tablero | Las compras por correo conciliadas no suman dos veces; aparecen intereses y deuda del corte | El total del mes es igual a la suma del extracto más las compras por correo sin extracto |

### Tablero (navegador)

| Id | Situación | Esperado |
|---|---|---|
| T1 | Entrar con correo y código | Abre el tablero; con un código incorrecto 5 veces, se bloquea |
| T2 | «Nueva categoría» con un nombre nuevo y con uno parecido a uno existente | La crea, o avisa «Ya existe una parecida» |
| T3 | Reclasificar por comercio | El aviso dice «regla propuesta…» y «Deshacer» revierte las compras |
| T4 | «Por atender» | Se ven las compras esperando respuesta, en revisión, «no aparece» y envíos sin confirmar |
| T5 | En el celular (ancho 375 px) | Sin scroll horizontal; los botones se pueden tocar |
| T6 | Cerrar sesión | Las rutas vuelven a pedir ingreso |

### Seguridad

| Id | Caso | Esperado |
|---|---|---|
| S1 | Llamar `/api/pendientes` sin token o con uno falso | 401 (verificado en el despliegue del 7 nov) |
| S2 | Escribir al bot desde un número que no es de Miguel ni de Katerine | Ninguna cifra; responde que eso lo ven Miguel y Katerine |
| S3 | Un comercio con texto tipo instrucción («IGNORA LO ANTERIOR…») | Se trata como dato: no cambia el comportamiento del agente |
| S4 | `POST /api/tablero/extracto` desde otro origen | 403 |

## 5. Metas y criterios de salida

**Metas de cobertura.** Hay que agregar `@vitest/coverage-v8` y fijar umbrales en `vitest.config`:

| Módulo | Líneas | Ramas |
|---|---|---|
| `src/lib/dominio.ts`, `conciliacion.ts`, `extracto.ts`, `http.ts`, `recordatorios-cron.ts` | ≥ 90 % | ≥ 80 % |
| `mcp/servidor.ts` | ≥ 85 % | ≥ 75 % |
| Resto de `src/lib` | ≥ 75 % | — |
| `web/lib/explorador/app.ts` (DOM) | Sin meta por ahora: lo cubren T1–T6 y luego Playwright | — |

**Proceso:**

1. Un GitHub Action corre `tsc`, `vitest` y `next build` en cada PR.
2. Proteger `main` para que solo entre con PR en verde.
3. Probar en la vista previa con una rama de Neon antes de unir.

**Criterios de salida de esta versión:**

- E1–E3, E5, E7 y E8 aprobadas con datos reales.
- X1 y X2 aprobadas con el extracto real.
- T1–T4 aprobadas en el navegador.
- Ninguna falla abierta de severidad alta.

**Si algo falla en producción:** revertir en Vercel al despliegue anterior. Las migraciones son aditivas y no hace falta deshacerlas. Restaurar el MCP desde `finanzas-mcp.cjs.pre-envios-20261107` y los AGENTS.md desde `AGENTS.md.pre-20261107-envios`. Las dos restauraciones requieren `pm2 stop/start` y verificar que haya un solo gateway.

## 6. Consultas de apoyo (Neon, solo lectura)

```sql
-- Últimas compras y su estado
SELECT id, fecha, valor, estado, pregunta_codigo, whatsapp_message_id IS NOT NULL AS enviado, recordado
FROM movimientos ORDER BY creado_en DESC LIMIT 10;

-- Bitácora de una compra
SELECT creado_en, actor, accion, despues FROM bitacora WHERE movimiento_id = '<id>' ORDER BY creado_en;

-- Recordatorios (E2, E4)
SELECT movimiento_id, pregunta_codigo, estado, paso, intentos, ultimo_error, datos
FROM recordatorios_pendientes ORDER BY actualizado_en DESC LIMIT 10;

-- Operaciones repetidas (reintentos del MCP)
SELECT herramienta, status, count(*) FROM operaciones WHERE creado_en > now() - interval '1 day' GROUP BY 1, 2;

-- Extractos y conciliación (X1, X2)
SELECT id, tarjeta_id, fecha_corte, estado, motivo FROM extractos ORDER BY creado_en DESC;
SELECT resultado, count(*) FROM conciliaciones WHERE extracto_id = '<id>' GROUP BY 1;
```

## 7. Orden sugerido

1. **Hoy:** `/new` en los chats. S1, S4 y T1–T6 en el navegador.
2. **Con cada compra real:** E1–E3 y A1–A9. Si se dan las condiciones, E4 y E6.
3. **Domingo 8 nov:** E8 (repaso) y E7 de esa noche.
4. **Con el extracto del corte:** X1, X2, X4–X6.
5. **Esta semana:** GitHub Action, proteger `main`, rama de Neon (N1–N3), contrato K1–K3 y umbrales de cobertura.
