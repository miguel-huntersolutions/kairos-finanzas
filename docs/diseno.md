> **Nota histórica (8 nov 2026):** Volcano ya no se usa. La app corre en Vercel + Neon; ver el [README](../README.md).

# Diseño del agente de finanzas del hogar (OpenClaw, Vercel y Neon)

Estado: v6.1 (7 nov 2026). Describe lo que hoy está construido y desplegado. Los cambios que salen de la revisión de arquitectura del 7 nov están marcados como «Propuesto» y tienen su tarea en [plan-de-trabajo.md](plan-de-trabajo.md). Nada marcado como propuesto está construido.

- La v5 era un borrador sobre Volcano. Sus diferencias con lo construido están al final, en «Cambios frente a la v5».
- La regla de conciliación está en [conciliacion.md](conciliacion.md).

## Intención
Un agente en OpenClaw que gestiona los gastos del hogar de Miguel y Katerine:

- se entera de cada compra por el correo del banco;
- la registra y la clasifica;
- pregunta por WhatsApp solo lo que no sabe, una pregunta corta por compra;
- aprende reglas por comercio y reporta.

El extracto del banco es la verdad final. Hoy está cargado el historial de la VISA y la conciliación automática está pendiente.

## Decisión de arquitectura
El sistema es un flujo fijo controlado por código, con el modelo en tres puntos acotados. No es un agente autónomo y no necesita serlo: en ningún paso el siguiente movimiento depende de evidencia nueva que el código no pueda evaluar. Los estados, las transiciones y los destinos ya están definidos en SQL.

| Punto | Patrón | Qué hace el modelo | Qué lo limita |
|---|---|---|---|
| Correo que el lector por banco no entiende | Llamada única, sin herramientas | Devuelve JSON con fecha, valor, tarjeta y comercio | Validación determinista en Vercel. Si no pasa, `requiere_revision` |
| Mensaje de una persona en el grupo o en privado | Traductor de lenguaje natural a una llamada de herramienta | Pasa el texto de la persona a `resolver_respuesta`, `clasificar` u otra herramienta, y relaya el `mensaje` que devuelve el servidor | El servidor resuelve compra, categoría y persona. El modelo no decide nada que cambie datos |
| Resumen diario | Redacción | Pone en prosa cifras que ya vienen calculadas | No hace cuentas |

El turno del hook (compra nueva y recordatorio) hoy usa el modelo, pero lo que hace es mecánico: `tomar_movimiento` → `preguntar` → `FIN`. Propuesto: que lo ejecute un *transform* del hook, sin turno del modelo. OpenClaw 2026.11.1 lo permite: un `hooks.mappings` con `transform.module` (archivo en `~/.openclaw/hooks/transforms/`) recibe el payload, puede hacer trabajo asíncrono y, si devuelve `null`, el hook responde 204 sin abrir turno. El transform llamaría a `tomar_movimiento` y `preguntar` en Vercel y enviaría con `openclaw message send`, como hoy hace el MCP. Corre dentro del proceso del gateway: debe ser corto, con tiempo límite y sin lanzar errores.

Qué no se agrega, y por qué:

- Un segundo agente que reciba delegaciones de `personal` con `sessions_send`. Toda la interpretación ya vive en el servidor; la delegación suma un salto y un estado compartido sin cambiar el resultado.
- Una herramienta de respuestas en lote antes de medir cuántas veces pasa.
- Un subagente con herramientas para leer el PDF del extracto. Basta una llamada única sin herramientas, igual al extractor de correos, con validación determinista.
- Conciliación hecha por el modelo. Es un emparejamiento uno a uno en SQL.

## Principio rector: determinista primero, IA solo donde aporta
| Lo hace el código (Vercel y Postgres) | Lo hace el modelo (OpenClaw) |
|---|---|
| Leer el correo por banco, normalizar el comercio, aplicar reglas, confirmar compras conocidas | Pasar a la herramienta lo que dijo la persona |
| Armar la pregunta («¿De qué fue…?» con 2 o 3 categorías numeradas) y decidir a quién va | Mostrar opciones numeradas cuando el servidor dice que hay ambigüedad |
| Encontrar la compra a partir de texto libre («la de 147.750», «Farmatodo», «la última») | Traducir un pedido («¿cuánto va Katerine?») a una llamada estructurada |
| Entender la categoría («1», «mercado», «unas medicinas») y saber quién responde por su número | Redactar el resumen con cifras que ya vienen calculadas |
| Sumas, totales, variaciones, duplicados, posible duplicado de extracto | No aplica |
| Idempotencia, estados, correlación pregunta y respuesta, bitácora | No aplica |

El agente nunca hace cuentas, nunca pide un id y nunca dice que registró algo sin que la herramienta haya devuelto `aplicado: true`. Si recibe `aplicado: false`, no se hizo nada; muestra el `mensaje` o las `opciones`.

Estas tres reglas viven hoy en el AGENTS.md, y un prompt no las hace cumplir. Lo que sí las hace cumplir es que el servidor resuelve todo y devuelve el texto listo. La prueba de que se cumplen es comparar el chat con la bitácora (ver «Pruebas de aceptación» en el plan).

## Arquitectura

```
Banco ──correo──▶ Resend ──webhook (Svix)──▶ Vercel  /api/correo
                                               │  Next.js (web/) + lógica en src/lib
                                               │  Postgres en Neon
                                               │
              hook (solo movimiento_id) ◀──────┘
                     │
                     ▼
OpenClaw (VPS Hostinger, Coolify)
  agente finanzas ── MCP finanzas (stdio) ──HTTP + token──▶ Vercel /api/<herramienta>
  agente personal ── mismo MCP (herramientas finanzas__*)
        │
        └── openclaw message send ──▶ WhatsApp (número del bot)
                                       · grupo «Cosas Familia»
                                       · chats privados de Miguel y Katerine

Tablero: https://<tu-proyecto>.vercel.app (correo + código)
```

### Piezas
| Pieza | Dónde | Rol |
|---|---|---|
| Vercel, proyecto `kairos-finanzas` | Raíz `web/`; importa `../src/lib`. Push a `main` = despliegue a producción | Toda la lógica determinista: rutas `/api/<herramienta>`, `/api/correo`, `/api/tablero/*`, crons |
| Neon (Postgres, plan Free, integración de Vercel) | Variable `KAIROS_AGENT_DATABASE_URL` | Sistema de registro. Migraciones en `db/esquema.sql`, `db/semilla.sql` y `db/cambios.sql` → `db/migrations/` (001 a 031) |
| Resend | Webhook a `/api/correo` (firma Svix con `RESEND_WEBHOOK_SECRET`) | Recibe los correos de los bancos |
| Agente `finanzas` (Kairos Finanzas) | OpenClaw, workspace `/root/.openclaw/workspace-finanzas`, reglas en `AGENTS.md` (copia en `openclaw/finanzas-AGENTS.md`) | Atiende el grupo «Cosas Familia» solo cuando lo mencionan. Modelo Sonnet 5.5, `thinking off`. Los turnos del hook corren en Haiku 5.5 (`OPENCLAW_HOOK_MODEL`). Herramientas: perfil `minimal` + `finanzas__*` |
| Agente `personal` (Kairos Personal) | OpenClaw, enlazado a WhatsApp `default` (chats privados) | Atiende los privados de Miguel y Katerine, incluidas las finanzas, con las herramientas `finanzas__*`, `numero_remitente` y `canal` = privado. Modelo Haiku 5.5 |
| MCP `finanzas` | `/root/.openclaw/tools/finanzas/` (`finanzas-mcp.cjs`, `token` chmod 600, `urls.json`). Código en `mcp/servidor.ts`, se compila con `npm run build:mcp` | Única interfaz del modelo con el sistema. Valida con Zod y Vercel repite la validación. `preguntar`, `reasignar_pregunta` y `recordar` además envían el mensaje con `openclaw message send` y confirman el envío |
| Crons de Vercel | `web/vercel.json` | `/api/cron/recordatorios` cada 15 min y `/api/cron/respaldo` cada 30 min (con `CRON_SECRET`) |
| Crons de OpenClaw | `openclaw cron list` | Resumen diario a las 20:00 y repaso del domingo a las 20:00, los dos del agente `finanzas` y anunciados en el grupo |
| Volcano | Proyecto anterior | Apagándose: respaldo hasta cerca del 13 nov. Ya no recibe tráfico |

Los agentes `main` y `lexia` tienen negadas las herramientas `finanzas__*` y `sofia__*`.

### Una sola fuente de reglas para los dos agentes
Los dos agentes que atienden finanzas usan modelos distintos y AGENTS.md distintos, y eso ya produjo una contradicción en el de `personal`. Se mantiene que `personal` atienda los privados directamente.

El bloque de reglas de finanzas vive en un solo archivo del repo, `openclaw/reglas-finanzas.md` (hecho el 7 nov, falta copiarlo al servidor). `node scripts/reglas-finanzas.mjs <AGENTS.md>` lo copia entre las marcas `<!-- reglas-finanzas:inicio -->` y `<!-- reglas-finanzas:fin -->`, y una prueba revisa que el de `finanzas` sea idéntico y que solo nombre herramientas que existen. Lo propio de cada agente queda fuera del bloque: los turnos automáticos en `finanzas` y salud e imágenes en `personal`. Propuesto: los dos agentes usan el mismo modelo para finanzas; cuál, se decide con la prueba de punta a punta del plan.

### Tarjetas
| Tarjeta | Tipo | Dónde se pregunta |
|---|---|---|
| VISA, Mastercard, DaviBank, Bancolombia débito | Compartidas | Grupo «Cosas Familia» |
| Plata Pay Miguel / Plata Pay Katerine | Individuales (`persona_default`) | Chat privado del dueño |
| Compartida con regla que ya fija la persona | No aplica | Chat privado de esa persona |

## Flujos

### 1. Compra nueva: camino determinista (sin modelo)
Correo → Resend → `POST /api/correo`:

1. Recepción: verifica la firma Svix sobre el cuerpo crudo. Es idempotente por `correo_id`: un reintento no crea otra compra.
2. Lectura del correo: lo lee el lector por banco (regex por remitente), que también reconoce el tipo (`compra`, `reverso`, `rechazo`, `otro`).
   - Un reverso o rechazo con el mismo valor, tarjeta y comercio que una compra de los últimos 7 días la pasa a `descartado` sin preguntar.
   - Compras en USD: guarda `valor_original` y busca la TRM del día. El `valor` queda en COP. Si la TRM no está disponible, la compra queda en `requiere_trm` hasta que la haya.
3. Si el lector por banco falla, entra el extractor en cuarentena:
   - Llama a Haiku 5.5 por la API de Anthropic (`ANTHROPIC_API_KEY` de Vercel), sin herramientas y con salida JSON obligatoria.
   - Valida el resultado sin modelo: valor mayor que cero, fecha a ±7 días, tarjeta existente, comercio de 60 caracteres o menos y sin caracteres raros.
   - Si no valida, la compra pasa a `requiere_revision`, por ejemplo con «tarjeta desconocida».
   - El agente nunca ve el texto del correo.
4. Regla de comercio: normaliza el comercio y busca una regla activa. Confirma la compra en SQL, con `actor = sistema` en la bitácora, cuando se cumplen todas estas condiciones:
   - hay regla confirmada;
   - el modo de preguntas es `por_comercio`;
   - el comercio no es genérico;
   - la persona ya se sabe.
5. Si no hay regla, la compra pasa a `por_preguntar` y Vercel avisa al hook de OpenClaw solo con el `movimiento_id`.

### 2. Compra nueva: envío de la pregunta
El hook abre un turno aislado de `finanzas` en Haiku:

1. `tomar_movimiento(id)`: cambio atómico de `por_preguntar` a `en_proceso`, con plazo de 10 min. Si devuelve `tomado: false`, otro proceso ya la tomó y el turno termina.
2. `preguntar(id)` sin texto. El servidor arma la pregunta: «¿De qué fue esta compra de $X en COMERCIO (TARJETA)?», 2 o 3 categorías numeradas, «Responde con el número o dime qué fue» y el código `#K7`.
   - Las categorías sugeridas salen de la regla o la semilla del comercio, su historial, palabras asociadas y lo más frecuente de los últimos 90 días. Se guardan en `categorias_sugeridas`.
   - El servidor decide el destino (grupo o privado de quién).
   - El MCP envía el mensaje, guarda el `whatsapp_message_id` (`confirmar_envio`), pasa la compra a `esperando_respuesta` y encola el recordatorio.
3. El turno responde `FIN`. `preguntar` es la última llamada permitida.

Falla que hoy puede duplicar la pregunta: si `openclaw message send` envía pero `confirmar_envio` falla, la compra se queda en `en_proceso`, el plazo de 10 min la devuelve a `por_preguntar` y el respaldo la vuelve a avisar. La persona recibe la pregunta dos veces con códigos distintos.

Propuesto, sin estados nuevos:

- El MCP sube `intentos_preguntar` antes de enviar.
- Si el envío salió y `confirmar_envio` falla, el MCP reintenta solo `confirmar_envio` con el mismo `whatsapp_message_id`. Nunca reenvía el mensaje.
- El respaldo no vuelve a avisar una compra con `intentos_preguntar > 0` y sin `whatsapp_message_id`. La deja en `ultimo_error` = «envío sin confirmar» y aparece en «Por atender» del tablero, donde una persona decide.

### 3. Respuesta de la persona
- Grupo: responde el agente `finanzas`. Privado: responde el agente `personal`. Los dos llaman las mismas herramientas.
- Quién responde: el agente pasa siempre `numero_remitente`. El servidor lo compara con `config.destino_miguel` y `config.destino_katerine` para saber si es Miguel o Katerine. Si llega también un nombre, gana el número.
  - Límite actual: el número lo pasa el modelo, que lo toma del contexto del mensaje. En el grupo, `groupAllowFrom` ya restringe quién puede escribir a los dos números, así que el riesgo es que el modelo confunda a Miguel con Katerine, no que entre un tercero.
  - La documentación de OpenClaw 2026.11.1 no ofrece una forma de pasar el remitente a un MCP por stdio; la identidad «per-requester» es solo para OAuth en servidores HTTP. Propuesto: registrar una vez el `_meta` que llega en `tools/call` para confirmarlo. Si no trae el remitente, se mantiene el número que pasa el modelo, y el servidor solo acepta los números de Miguel y Katerine.
- A qué compra corresponde (`referencia` en texto libre, id opcional), en este orden:
  1. el código `#K7`;
  2. el valor («147.750», «147750», «147 mil»);
  3. la fecha dd/mm;
  4. el comercio;
  5. «la última».
  - Sin nada de eso: la única compra que espera respuesta.
  - Una coincidencia: actúa. Varias: devuelve `aplicado:false, motivo:'ambigua'` con `opciones` numeradas, sin ids visibles. Ninguna: devuelve `motivo:'ninguna'`.
- Categoría: acepta el número de la lista sugerida, el nombre o texto libre traducido a una de las 12 categorías por palabras asociadas. Si no la reconoce, devuelve `categoria_no_reconocida` con todas las categorías.
- Persona de la compra: quien responde. En una tarjeta individual, la dueña. Solo cambia si el mensaje nombra a otra («la hizo Kati»).
- `reembolsable`: por defecto, sí cuando la categoría es «Reembolsable empresa».
- Respuesta de quien no la hizo: si en un chat privado responde alguien distinto de `preguntado_a`, la respuesta queda como sugerencia y se pide confirmar.
- Otros pedidos sobre la compra:
  - «No fui yo, pregúntale a Kati»: `reasignar_pregunta`, que cambia `preguntado_a`, crea un código nuevo y la envía por privado.
  - «Pásala a 6 cuotas»: `cambiar_cuotas`.
  - Rechazada, reversada o no reconocida: `descartar_movimiento`. Con «no reconocida» avisa a los dos y recomienda llamar al banco.
  - «Duplicada»: solo descarta si existe otra fila con el mismo valor, fecha y tarjeta. Se conserva una y se descarta la pendiente. Si no hay pareja, devuelve `sin_duplicado`.
- Aprendizaje: al clasificar puede proponer una regla (ver «Ciclo de vida de las reglas»), salvo que la persona diga «solo por esta vez».

Riesgo de reintento: si la llamada HTTP de `clasificar` vence después de que el servidor aplicó el cambio y el modelo la repite con la misma referencia sin código («1»), el servidor busca «la única compra que espera respuesta», que ahora puede ser otra. La segunda llamada clasificaría una compra distinta.

Propuesto: el MCP genera un `operacion_id` por cada llamada de escritura y lo manda a Vercel. Vercel lo guarda con restricción única en la bitácora; si llega repetido con el mismo contenido, devuelve el resultado original sin aplicar nada, y si llega con contenido distinto, lo rechaza. El MCP hace como máximo un reintento propio con el mismo `operacion_id`. Si tampoco hay respuesta, devuelve `incierto` y el agente dice que no pudo confirmar el registro, sin repetir la llamada.

Errores del MCP: un `aplicado: false` es una respuesta de negocio válida. Una falla de red o un 5xx de Vercel se devuelve como error de la herramienta (`isError: true`) con un mensaje corto para la persona. El agente nunca trata un error como éxito.

### 4. Pedidos sueltos
«¿Cuánto llevamos / va Katerine este mes?» → `resumen` (cifras de SQL).

| Pedido | Herramienta |
|---|---|
| Categoría nueva | `proponer_categoria` (compuerta de similitud) |
| Reclasificar | `reclasificar` en dos fases |
| «Pregúntame siempre / solo lo nuevo» | `modo_preguntas` |
| Pedir el tablero | Enlace |

### 5. Rutinas automáticas
| Qué | Cuándo | Dónde corre |
|---|---|---|
| Recordatorio de una pregunta sin respuesta | 4 h después, una sola vez. Solo si la compra sigue en `esperando_respuesta` con el mismo código | Tabla `recordatorios_pendientes` + cron de Vercel cada 15 min → hook → `recordar` |
| Respaldo | Cada 30 min | Cron de Vercel (`/api/cron/respaldo`). Libera plazos vencidos de `en_proceso`, reintenta el extractor y la TRM, y vuelve a avisar las compras atascadas en `por_preguntar` |
| Resumen diario | 20:00 | Cron de OpenClaw → agente `finanzas` → grupo |
| Repaso dominical | Domingo 20:00 | Cron de OpenClaw → grupo. Bloques: categorías propuestas, reglas nuevas, compras en `requiere_revision`. «Sí a todo» / «sí menos la 2» → `confirmar_repaso` |

El cron viejo de OpenClaw que llamaba a `/api/respaldo` (`finanzas-respaldo`) está desactivado y la ruta se conserva.

Propuesto para los envíos automáticos:

- `recordar` sin texto, igual a `preguntar`: el servidor arma el recordatorio. El modelo no redacta nada en un envío automático.
- El recordatorio se marca como enviado solo cuando hay `whatsapp_message_id`. Hoy se marca antes y, si el hook falla, se pierde. Con el cambio, el cron de 15 min lo vuelve a intentar mientras la compra siga en `esperando_respuesta` con el mismo código. Un recordatorio repetido es una molestia menor que uno perdido.
- El resumen diario y el repaso llegan con el texto armado por el servidor, y el agente solo lo publica. Así ninguna cifra pasa por el modelo.

### 6. Extracto y conciliación (fase 2, parcial)
- El historial de la VISA se cargó como filas de fuente `extracto`.
- No hay lector de PDF ni conciliación automática todavía.
- Mientras tanto, el tablero aplica una regla provisional de «posible duplicado de extracto» ([conciliacion.md](conciliacion.md)): una compra por correo con la misma tarjeta, el mismo valor y fecha a ±3 días de una fila del extracto no suma. El emparejamiento es uno a uno.
- Columnas listas para la conciliación: `conciliado_con` y `conciliado_en` (migración 031).
- Sin doble conteo (hecho en el repo el 7 nov, sin desplegar): `src/lib/efectivos.ts` (`idsQueNoSuman`) aplica la misma regla del tablero y excluye esas filas de `resumen` (agente y resumen diario), de la tendencia y de las categorías de `GET /api/tablero/datos`. Se descartó una vista SQL porque el emparejamiento uno a uno ya existe en TypeScript y probado; una segunda versión en SQL podría separarse de la del tablero. Cuando exista la conciliación automática, la misma función lee `conciliado_con` y la regla provisional se retira de un solo lugar (`posiblesDuplicados`).

Lector de extracto propuesto: llamada única a Haiku sin herramientas, igual al extractor de correos, que devuelve líneas `{fecha, descripcion, valor, cuota}`. Vercel valida cada línea y la suma contra el total del extracto antes de guardarla; si no cuadra, el extracto queda en revisión y no se concilia.

## Tablero
`https://<tu-proyecto>.vercel.app`, un solo tablero en `/` (`/explorador` redirige):

- Acceso: correo de la lista (`TABLERO_CORREOS`) + código (`TABLERO_CODIGO`). La sesión va en una cookie HttpOnly firmada. Se bloquea tras varios intentos por correo y por IP.
- Datos: todas las tarjetas y fuentes de `movimientos`, sin los descartados.
- Pestañas: Resumen, Detalle del mes, Comparar categorías, Reclasificar, Movimientos.
- Filtros: mes, tarjeta, estado, categoría, monto y búsqueda.
- Estado de cada compra:
  - Del extracto: «Conciliado».
  - Del correo: el estado del flujo más «Por conciliar».
  - Manual: «Manual».
  - «Posible duplicado de extracto»: se ve tachada y no suma.
- Por atender: una banda con las compras que esperan respuesta y las que requieren revisión. Propuesto: también las de envío sin confirmar.
- Reclasificar: por compra o por comercio (opcionalmente solo en la tarjeta filtrada), en cualquier tarjeta, sobre compras confirmadas o provisionales, con deshacer. Queda en la bitácora como `reclasificar_explorador`, con quien lo hizo (`TABLERO_PERSONAS`).

## Herramientas MCP
Todas tienen esquema estricto (`src/lib/esquemas.ts`, sin propiedades extra) y Vercel repite la validación.

| Herramienta | Entradas | Escribe | Notas |
|---|---|---|---|
| `tomar_movimiento` | `movimiento_id` | Sí | Cambio atómico de estado |
| `preguntar` | `movimiento_id`, `texto?` | Sí, y envía | Sin texto: el servidor arma la pregunta numerada. Es la última llamada del turno |
| `recordar` | `movimiento_id`, `texto` | Sí, y envía | La envía el MCP. Propuesto: sin `texto` |
| `resolver_respuesta` | `texto`, `canal`, `numero_remitente?`, `remitente?`, `reply_to?`, `movimiento_codigo?` | Sí | Correlación determinista |
| `reasignar_pregunta` | `referencia?`/`movimiento_id?`, `persona_destino` | Sí, y envía | Si es ambigua, no envía nada |
| `clasificar` | `referencia?`/`movimiento_id?`, `categoria` (número, nombre o texto)/`categoria_id?`, `numero_remitente?`, `canal`, `persona?`, `reembolsable?`, `solo_esta_vez?` | Sí | Devuelve `aplicado` + descripción, categoría y persona |
| `cambiar_cuotas` | `referencia?`/`movimiento_id?`, `cuotas` 1 a 48 | Sí | |
| `descartar_movimiento` | `referencia?`/`movimiento_id?`, `motivo`, `numero_remitente?`, `detalle?` | Sí | `duplicada` exige gemela real. `no_reconocida` avisa a los dos |
| `proponer_regla` | `comercio_id`, `categoria_id`, `persona?`, `reembolsable?` | Sí | Bloqueada para comercios genéricos |
| `proponer_categoria` | `nombre` | Sí | Similitud de trigramas mayor que 0,6 devuelve la existente. Nace como `propuesta` |
| `reclasificar` | `dry_run`, `token_confirmacion?`, `aprobado_por?` | Sí, con token | Más de 5 cambios exige token y el «sí» de una persona |
| `resumen` | `mes`, `persona?`, `tarjeta?`, `categoria_id?`, `reembolsable?` | No | SQL. No suma las compras por correo que ya tienen su fila del extracto (`efectivos.ts`; en el repo, sin desplegar) |
| `modo_preguntas` | `por_comercio` \| `siempre` | Sí | |
| `repaso` / `confirmar_repaso` | Ninguna / confirmación en lote | No / Sí | Repaso dominical |
| `revisar_captura` | Modelo: `archivo` (ruta del adjunto), `numero_remitente`, `canal`, `tarjeta?`. Servidor: `archivo_nombre`, `mime`, `contenido_base64` | Sí (revisión) | El MCP lee el archivo con guardas; el modelo nunca lo ve. Devuelve `texto` para publicar tal cual (docs/plan-capturas.md) |
| `cargar_faltantes` | `codigo`, `numeros?`, `correcciones?` (`n`, `categoria?`, `tarjeta?`), `tarjeta?`, `numero_remitente` | Sí | Solo Miguel o Katerine, tras un «sí». Nacen con fuente `captura`. No enseña reglas |

Propuesto para todas las de escritura: `operacion_id` generado por el MCP (ver flujo 3).

## Política anti-envenenamiento de reglas
- Comercios genéricos (`comercios_genericos`: MERCADO PAGO, PAYU, WOMPI, BOLD, NEQUI, DAVIPLATA, AMAZON, dLocal, PSE y otros): nunca tienen regla de categoría y siempre se pregunta. Solo se fija la persona en tarjetas individuales.
- Solo se clasifica sin preguntar con una regla confirmada o con la semilla verificada del comercio. La confianza del modelo no habilita nada.

## Ciclo de vida de las reglas
| Paso | Qué pasa |
|---|---|
| Nace | Al clasificar una respuesta humana de un comercio no genérico, queda en `propuesta` con `coincidencias_humanas = 1`. No se crea si dijeron «solo por esta vez» |
| Se confirma sola | Con la segunda respuesta humana idéntica en otra compra |
| Se confirma en lote | En el repaso dominical, con un «sí» |
| Se reinicia | Si una respuesta humana la contradice, el contador vuelve a 1 con los valores nuevos |
| Se suspende | Si se corrige una compra clasificada por una regla confirmada, la regla vuelve a `propuesta` |
| Nunca | Las respuestas del modelo no cuentan. Reclasificar desde el tablero no crea reglas todavía. Una carga en lote desde una captura (`cargar_faltantes`) tampoco cuenta |

## Estados del movimiento
- Interpretación: `requiere_interpretacion` → `provisional` | `requiere_revision`. `requiere_trm` mientras falte la TRM.
- Flujo normal: `provisional` → `confirmado` (por regla) o `por_preguntar` → `en_proceso` → `esperando_respuesta` → `confirmado`.
- Descarte: desde cualquier estado no final, `descartado` con `motivo_descarte`.
- Plazo: `en_proceso` con más de 10 min vuelve a `por_preguntar`, salvo que haya un envío sin confirmar (propuesto, flujo 2).
- Vista derivada del tablero, no es un estado guardado: Conciliado / Por conciliar / Manual / posible duplicado.

## Datos (Neon)
- `movimientos`:
  - Base: id, correo_id (único), fecha, comercio_id, descripcion_original, valor (COP), cuotas, tarjeta_id, persona, categoria_id, reembolsable, estado, motivo_descarte, fuente (`correo` | `extracto` | `manual`), fuente_interpretacion, confianza, regla_id, clasificado_por, nota.
  - Pregunta: pregunta_codigo, pregunta_texto, `categorias_sugeridas int[]` (030), whatsapp_message_id, preguntado_a, destino, preguntado_en, recordado, en_proceso_hasta, ultimo_error, intentos_preguntar.
  - USD: moneda, valor_original, trm, trm_fecha.
  - Conciliación: `conciliado_con`, `conciliado_en` (031).
- `correos`: texto completo que nunca sale al agente, tipo, estado, resultado del lector.
- `comercios` (patrones, categoría semilla, verificado) y `comercios_genericos`.
- `reglas_comercio`: estado, coincidencias_humanas, quién la creó y la confirmó.
- `categorias`: 11 de la semilla + «Reembolsable empresa». Estados `activa` | `propuesta` | `inactiva`.
- `tarjetas`: nombre, banco, clase, tipo, ultimos_4, persona_default.
- `config`: modo_preguntas, umbral_reclasificacion = 5, destino_grupo, destino_miguel, destino_katerine.
- `bitacora`: actor, instruido_por, acción, antes/después, modelo, fecha. Propuesto: `operacion_id` con índice único parcial.
- `trm` (caché), `recordatorios_pendientes`, `tablero_intentos`.

## Seguridad
- Hook de OpenClaw: token propio (`hooks.token`), ruta no adivinable (`/hooks-<hex>`), `allowedAgentIds=["finanzas"]`, `allowRequestSessionKey=false`. Está exento del basic auth de nginx (replicado en `init-shield` y en la fila de Coolify). Vercel solo envía el `movimiento_id`.
- Texto del correo: nunca llega al prompt. Solo lo lee el extractor en cuarentena, y su salida pasa por validación determinista.
- API de herramientas: `FINANZAS_API_TOKEN` (Bearer), guardado solo en el archivo `token` del MCP (chmod 600) y en Vercel. Crons con `CRON_SECRET`.
- Privacidad entre agentes: `main` y `lexia` no ven `finanzas__*`. Solo Miguel y Katerine reciben información de gastos.
- Permisos de dueño del bot: `commands.ownerAllowFrom` = solo Miguel (desde el 7 nov). Solo un dueño puede usar `/new`, `/config` y `/restart`; con esos permisos se puede cambiar la configuración de OpenClaw, incluida la del agente `finanzas`.
- Bitácora: todo cambio queda registrado con quién lo hizo y quién lo pidió.

## Operación
- Desplegar código: push a `main` (Vercel publica). Antes, aplicar en Neon las migraciones nuevas con `psql` (cadena directa en `volcano/neon.env`, chmod 600, fuera de git): el código nuevo puede leer columnas que aún no existen.
- MCP:
  1. `npm run build:mcp`;
  2. copiar `mcp/dist/finanzas-mcp.cjs` al contenedor;
  3. `pm2 restart openclaw-gateway`;
  4. revisar que quede un solo gateway, hijo de PM2.
- AGENTS.md: copiar al workspace (respaldo `.pre-*` antes). El bloque de finanzas sale de `openclaw/reglas-finanzas.md`: bajar el AGENTS.md del servidor, correr `node scripts/reglas-finanzas.mjs` sobre él, revisar con `--check` y subirlo, en los dos agentes en el mismo paso. Las reglas nuevas solo las toman las sesiones nuevas: `/new` escrito por Miguel (dueño). En el grupo, el `/new` debe mencionar al bot, porque sin mención el mensaje no llega al agente. También sirve archivar la sesión.
- Respaldos: `vault-backup.sh` antes de tocar OpenClaw. Respaldo nocturno del servidor a las 03:00 UTC.
- Rotación del token de la API: actualizar el archivo `tools/finanzas/token` del contenedor y la variable de Vercel.
- Paso a paso del último despliegue: documento interno.

## Límites del agente (no negociables)
- No mueve dinero ni entra al banco.
- Solo escribe por el MCP `finanzas`.
- Solo habla con Miguel y Katerine.
- Todo cambio queda en la bitácora.

Dónde se hace cumplir cada límite:

| Límite | Lo hace cumplir |
|---|---|
| No mueve dinero | No existe ninguna herramienta que lo haga |
| Solo escribe por el MCP | Perfil de herramientas `minimal` + `finanzas__*` en OpenClaw |
| Solo habla con Miguel y Katerine | `groupAllowFrom` del grupo y destinos fijos en `config`; el servidor elige el destino |
| Todo cambio queda en la bitácora | Las rutas de Vercel escriben la bitácora en la misma transacción del cambio |

## Cambios frente a la v5
| v5 (borrador) | Hoy | Motivo |
|---|---|---|
| Volcano: funciones, funciones duraderas, base y tablero | Vercel (Next.js) + Neon | El plan de Volcano no permitía schedulers. Se migró el 6 nov |
| Recordatorio con función duradera (`ctx.wait` 4 h) | Tabla `recordatorios_pendientes` + cron de Vercel cada 15 min | No hay funciones duraderas en Vercel |
| Respaldo cada 5 min como comando de OpenClaw | Cron de Vercel cada 30 min | Menos carga sobre Neon Free |
| Grupo nuevo «Gastos casa» | Grupo existente «Cosas Familia», con mención obligatoria y `groupAllowFrom` con los dos números | Decisión de Miguel |
| `personal` hace triaje y delega a `finanzas` con `sessions_send` | `personal` atiende los privados directamente con `finanzas__*` | Más simple. Se mantiene (revisión del 7 nov) |
| El agente redacta la pregunta | El servidor arma «¿De qué fue?» con categorías numeradas | Una sola pregunta, sin depender del modelo |
| `clasificar(movimiento_id, categoria_id, persona, reembolsable)` | `referencia` en texto libre, `categoria` como número, nombre o texto, persona por `numero_remitente`, `reembolsable` opcional | El modelo pedía ids y confundía compras |
| Duplicada a criterio del agente | Solo con gemela real (valor, fecha, tarjeta) | Se descartó una compra que no era duplicada |
| Haiku para el agente | Sonnet 5.5 en el agente y Haiku en los turnos del hook | Mejores respuestas en las conversaciones |
| Tablero del mes + explorador VISA aparte | Tablero único con estados | Pedido de Miguel (7 nov) |
| Conciliación ±2 días | Regla provisional ±3 días, la misma en el tablero y en `resumen` | Una sola constante, `VENTANA_DIAS`. Aprobado por Miguel (7 nov) |
| Subagente lector de PDF | Propuesto: llamada única sin herramientas | Mismo patrón del extractor de correos |
