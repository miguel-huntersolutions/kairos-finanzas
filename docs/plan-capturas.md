# Plan: revisar capturas o reportes de la app de Bancolombia

**Estado:** implementado y probado con datos sintéticos en la rama `capturas-20261108` (8 nov 2026). Sin desplegar. Falta la prueba con archivos reales (lista K1–K6 al final).

## Qué se quiere

Algunas compras no llegan por correo. Hoy Miguel o Katerine las ven en la app de Bancolombia, pero el sistema no se entera.

La idea es mandarle al agente un pantallazo (o un reporte en PDF) por WhatsApp. El agente responde cuáles de esas compras **no están cargadas**. Con la autorización de quien la mandó, las carga.

## Decisión de diseño: el modelo del chat no lee la captura

Se sigue la misma regla que con los correos y el extracto.

- El agente nunca interpreta la imagen. Solo pasa al MCP la ruta del archivo que recibió.
- La lectura la hace Vercel con una sola llamada a Haiku: sin herramientas, con salida JSON obligatoria. Es el mismo patrón del lector de extractos (`src/lib/extracto.ts`).
- Después, el servidor valida y compara **sin modelo**.
- El texto de la respuesta lo arma el servidor y el agente lo publica tal cual.

Por qué:

- Un nombre de comercio en la captura podría traer instrucciones, y el modelo del chat no debe recibirlas.
- Las cifras no pasan por el modelo del chat.
- El agente `finanzas` no tiene `exec` ni la herramienta `image`. Con este diseño no hace falta dárselas.

## Flujo

1. **La persona envía** la captura (o varias, o el PDF) con «revisa esto» o «¿cuáles faltan?», en su privado o en el grupo.
2. **El agente llama** `finanzas__revisar_captura(archivo, numero_remitente, canal)`. `archivo` es la ruta que OpenClaw le muestra del adjunto.
3. **El MCP lee el archivo**, con cuatro guardas:
   - solo acepta rutas dentro de `/root/.openclaw/media/inbound/`;
   - solo `jpg`, `png`, `webp` o `pdf`;
   - máximo 5 MB;
   - lo envía en base64 a `POST /api/revisar-captura`.
4. **Vercel lee la imagen**: Haiku devuelve líneas `{fecha, hora?, descripcion, valor, moneda, tipo (compra | abono | otro), tarjeta_ultimos_4?, estado_app (pendiente | aplicada)?}`.
5. **Validación sin modelo:**
   - valor mayor que 0;
   - fecha dentro de los últimos 90 días y no futura;
   - descripción de 80 caracteres o menos, con caracteres seguros;
   - se descartan abonos y pagos;
   - la tarjeta debe existir (si la captura no la muestra, ver la pregunta 2).
6. **Comparación con la base**, con la misma regla de la conciliación: misma tarjeta, mismo valor, ±3 días, uno a uno. Cada línea queda en uno de tres estados:
   - **ya cargada**: existe la compra (por correo, del extracto o manual), en cualquier estado salvo descartada;
   - **falta**: no hay ninguna parecida;
   - **dudosa**: el mismo valor en otra tarjeta, o una diferencia de valor menor al 1 % (por ejemplo, TRM en compras USD).
7. **El servidor guarda la revisión** con un código (por ejemplo `#R4`). Guarda las líneas y la huella de la imagen, **no la imagen**. Responde con un texto ya armado:
   > Revisé 12 movimientos: 10 ya están cargados. Faltan 2:
   > 1. 03/11 · RAPPI · $45.900 · VISA
   > 2. 05/11 · PARQUEADERO X · $8.000 · VISA
   > ¿Las cargo? Responde «sí», «solo la 1» o «no». (#R4)
8. **Autorización**, por ejemplo «sí, cárgalas»: el agente llama `finanzas__cargar_faltantes(codigo, numeros?, numero_remitente)`.
   - Solo vale si quien autoriza es Miguel o Katerine. Propuesto: la misma persona que envió la captura, o cualquiera de los dos.
   - Usa `operacion_id`, así que repetir la llamada no carga dos veces.
   - Cada línea cargada pasa a `cargada` en la revisión y no se vuelve a cargar.
9. **Cómo nacen las compras:** como filas nuevas de fuente `captura` y siguen el camino normal.
   - Si el comercio tiene una regla confirmada, quedan confirmadas solas.
   - Si no, quedan `por_preguntar` y llega la pregunta de siempre («¿De qué fue…?»).
   - Opción: si la persona ya dice la categoría al autorizar («sí, la 1 es mercado»), se clasifican de una vez.
10. **Cuando llegue el extracto:** las filas `captura` se concilian igual que las de correo. Así no cuentan dos veces.

## Cambios técnicos

| Pieza | Cambio |
|---|---|
| Migración | `movimientos.fuente` acepta `captura`. Tablas nuevas `revisiones_captura` (código, quién, canal, huella, creado_en, estado) y `revisiones_captura_lineas` (línea, fecha, descripción, valor, tarjeta, resultado, movimiento_id) |
| `src/lib/captura.ts` | Lector (Haiku con imagen o PDF, salida forzada), validación, comparación (reutiliza `emparejar` de `conciliacion.ts`), texto de respuesta y carga |
| Vercel | Rutas `/api/revisar-captura` y `/api/cargar-faltantes` (herramientas con token, como las demás) |
| MCP | `revisar_captura`: lee el archivo con las guardas y lo envía. `cargar_faltantes`: normal |
| Conciliación | `captura` se trata igual que `correo` en `posiblesDuplicados`, `idsQueNoSuman` y `conciliarExtracto` |
| Tablero | La fuente «Captura» en Movimientos y en el filtro de estado. Opcional: «Cargar captura» en el tablero, sin pasar por WhatsApp |
| Reglas del agente | Un bloque nuevo en `reglas-finanzas.md`: cuándo llamar, que publique el texto tal cual y que solo cargue con un «sí» explícito |
| Pruebas | Lector falso, no la API. Casos: todas cargadas, dos faltan, dudosa por TRM, la misma captura dos veces, autorizar dos veces, ruta fuera de `inbound` rechazada, archivo grande rechazado, alguien que no es Miguel ni Katerine |

Esfuerzo estimado: un día de trabajo más las pruebas con capturas reales.

## Lo que verifico yo antes de empezar

- **Cómo ve el agente el adjunto.** Las fotos de WhatsApp llegan a `media/inbound/` con nombres como `file_68---<uuid>.jpg`. Falta confirmar que el agente `finanzas` (perfil `minimal`) recibe la **ruta** en el mensaje, como pasa con el agente `main`. Si no la recibe, la alternativa es que el MCP tome «el último adjunto de esa persona» de `inbound`.
- **Si Haiku 5.5 lee bien una captura real de la app** (números con puntos, «pendiente» frente a «aplicada»). Se prueba con tus capturas antes de cerrar el diseño del JSON.

## Lo que necesito de ti

1. **Dos o tres capturas reales** de la lista de movimientos en la app, de lo que quieres revisar. También un reporte exportado, si la app lo genera (PDF o Excel). Con eso ajusto qué campos leer. Las uso solo para probar el lector y luego se borran.
2. **Qué productos.** ¿Solo tarjetas de crédito (VISA y cuáles más) o también la cuenta de ahorros o débito? La cuenta incluye transferencias, PSE y pagos. ¿Esas cuentan como gastos? Y si la captura no muestra los últimos 4 de la tarjeta, ¿asumo la tarjeta que tengas abierta en la app, o el agente pregunta cuál es?
3. **Quién autoriza la carga.** ¿Solo quien envió la captura, o cualquiera de los dos?
4. **Dónde.** ¿Solo en el privado (lo recomiendo, porque las capturas pueden mostrar saldos) o también en el grupo?
5. **Compras «pendientes» en la app.** ¿Se cargan ya, o se espera a que salgan «aplicadas»? Propuesta: cargarlas, porque el extracto las concilia después.
6. **Categoría al cargar.** ¿Siempre pregunta el agente como hoy, o aceptas que se clasifiquen en la misma respuesta («sí, la 1 es mercado»)?

---

## Decisiones del 8 nov (respuestas de Miguel y lo visto en los archivos)

**Lo que traen los archivos reales** (reporte «Movimientos de tus tarjetas», 1 a 7 nov, 31 filas):

- El **Excel** tiene las columnas Fecha (número de serie de Excel), Descripción, Fecha de corte, Valor, Tipo de moneda y Cuotas. **No trae la tarjeta ni el estado** (en proceso o verificado). Los abonos y pagos vienen con valor negativo.
- La **captura y el PDF** sí muestran el estado («En proceso» o «Verificado») y tampoco muestran la tarjeta.
- Los valores pueden traer decimales (`93663.75`) y la descripción puede ser solo un número (`807000000000`).
- Dos o más compras iguales el mismo día son normales (por ejemplo, varias de FLYPASS).

**Decisiones:**

1. **Tres lectores, según el archivo:**
   - Excel (`xlsx`) o `csv`: lector **sin modelo**, con detección de encabezados. Si los encabezados no se reconocen, se le manda el contenido como texto a Haiku, igual que a las imágenes.
   - Imagen y PDF: una llamada a Haiku, sin herramientas, con salida forzada.
   - Los formatos pueden variar, por eso el lector no depende de columnas fijas.
2. **Productos:** cualquiera. Si el reporte no trae tarjeta, se asigna así:
   1. la que dice el mensaje («de la VISA»);
   2. la de la compra ya cargada que empareja;
   3. para las que faltan, la tarjeta con la que más se ha comprado en ese comercio;
   4. si no hay nada de eso, la respuesta pregunta «¿de qué tarjeta?» con opciones numeradas.
3. **Autoriza** cualquiera de los dos (Miguel o Katerine). **Dónde:** el privado o el grupo.
4. **Estado «En proceso»:** se carga igual. Los abonos, pagos y valores negativos se ignoran y se informa.
5. **Categoría:** el servidor propone una para cada compra que falta, con la misma lógica de siempre: regla del comercio, historial, semilla y palabras asociadas. Se muestra en la lista. Con «sí» se cargan con esa categoría, y con «la 2 es salud» se corrige esa línea. Cuando no hay propuesta razonable, queda por preguntar.
6. **Aprendizaje de reglas:** una autorización en lote **no** cuenta como respuesta humana para las reglas de comercio. Si una regla pudiera nacer de un «sí a todo», una propuesta equivocada del servidor la envenenaría.
7. **Compras en otra moneda:** en esta primera versión no se cargan solas. Quedan en la lista como «para revisar».

---

## Lo que quedó hecho (rama `capturas-20261108`)

**Base (al final de `db/cambios.sql`):**
- `captura_fuente_movimientos`: `movimientos.fuente` acepta `captura`.
- `captura_tabla_revisiones`: `revisiones_captura` (código `R10`, `R11`…, quién, canal, tipo de archivo, lector, tarjeta del mensaje, estado). La huella sha256 del archivo es **única en toda la base**: el mismo archivo, lo mande quien lo mande, devuelve la misma revisión sin volver a leerlo. El archivo no se guarda.
- `captura_tabla_lineas`: `revisiones_captura_lineas` (posición en el archivo, número en la lista, fecha, descripción, valor, moneda, cuotas, estado en la app, resultado, movimiento que empareja o que se creó, tarjeta y categoría propuestas con su origen, motivo).

**Código:**
- `src/lib/captura.ts`: lectores, validación, comparación, propuestas, texto y carga.
- Herramientas `revisar_captura` y `cargar_faltantes` (`src/lib/esquemas.ts`, `registro.ts`, `src/functions/`, rutas `/api/revisar-captura` con `maxDuration = 60` y `/api/cargar-faltantes`).
- `mcp/servidor.ts`: el modelo pasa solo la ruta del adjunto; el MCP lo lee con guardas y lo manda en base64.
- `captura` se trata igual que `correo` en la conciliación, las cifras y el tablero (docs/conciliacion.md).
- Bloque nuevo en `openclaw/reglas-finanzas.md` («Capturas o reportes del banco»), ya copiado a `openclaw/finanzas-AGENTS.md`.

### Cómo funciona

1. **Lectura.**
   - Excel (`xlsx`) o `csv` (`,`, `;` o tabulador): sin modelo. Busca la fila de encabezados en las primeras 15 (fecha, descripción y valor; también reconoce moneda o tipo de moneda, cuotas, fecha de corte y estado, con o sin tildes y en cualquier orden). La fecha puede ser número de serie de Excel o texto. Si no reconoce los encabezados, manda las primeras 300 filas como texto a Haiku.
   - Imagen (`jpg`, `png`, `webp`) o PDF: una llamada a Haiku (`claude-haiku-5-5`), sin razonamiento, con salida forzada. El archivo es dato, no instrucciones.
   - El servidor revisa que los primeros bytes correspondan al tipo declarado.
2. **Validación sin modelo** (por línea, no rechaza el archivo entero):
   - valor finito y de máximo 1.000 millones, redondeado a pesos;
   - fecha válida, no futura (se tolera un día) y de máximo 120 días atrás;
   - descripción segura de 80 caracteres o menos (números de 13 dígitos o más se enmascaran);
   - negativos y ceros quedan `ignorada` (abono o pago);
   - otra moneda o dato ilegible queda `revision` (para revisar a mano; no se carga);
   - dos compras iguales el mismo día son dos compras: no se juntan;
   - máximo 300 líneas por archivo.
3. **Comparación** con los movimientos no descartados de cualquier fuente (correo, extracto, manual, captura), sin los que no suman (una compra por correo con su fila del extracto cuenta una vez). Usa `emparejar`: mismo valor, ±3 días, uno a uno en todo el archivo.
   - Si el mensaje dice la tarjeta (o el archivo muestra sus últimos 4), se exige la misma tarjeta. Si no, se compara sin mirar la tarjeta.
   - Lo que no empareja y tiene el mismo valor en otra tarjeta, o un valor a 1 % o menos, queda **dudosa**.
4. **Tarjeta de las que faltan:** la del mensaje → la más usada en ese comercio → la única tarjeta de crédito activa, si hay una sola → si no, «¿tarjeta?» y la respuesta pregunta «¿De qué tarjeta…?» con opciones numeradas.
5. **Categoría propuesta** (no se aplica hasta el «sí»): regla confirmada del comercio → historial → semilla del comercio verificado → palabras de la descripción (solo si apuntan a una sola). Los comercios genéricos quedan «por preguntar».
6. **Respuesta** armada por el servidor: conteos, lista numerada de las que faltan (fecha · comercio · valor · tarjeta · categoría (origen)), las dudosas numeradas después, y la pregunta con el código. Lista hasta 25 y luego «y N más».
7. **Carga** (`cargar_faltantes`), solo si autoriza Miguel o Katerine:
   - «sí» carga todas las que faltan; «solo la 1,3» carga esas; una dudosa solo se carga si se nombra;
   - correcciones por número («la 2 es salud», «la 3 es de la Mastercard») o una tarjeta para todas;
   - antes de cargar vuelve a comparar con la base: si otra captura (o un correo) ya la cargó, no la repite;
   - nacen con fuente `captura`, `confirmado` con la categoría propuesta o corregida, o `por_preguntar` sin ella (avisa al hook y la pregunta de siempre llega como con un correo; el respaldo reintenta);
   - persona: la dueña si la tarjeta es individual; si no, quien autoriza. `clasificado_por` = quien autoriza (solo en las confirmadas);
   - bitácora `cargar_captura` por compra; **no** toca `reglas_comercio`;
   - idempotente: una línea `cargada` nunca se vuelve a cargar.

### Cómo se usa

En el privado o en el grupo, Miguel o Katerine mandan la captura, el PDF o el Excel con «revisa esto» o «¿cuáles faltan?». Kairos publica la revisión (#R..). Se responde «sí», «solo la 1,3», «no», o con correcciones. Si el reporte no trae la tarjeta y hay varias de crédito, conviene decirla al mandar el archivo («son de la VISA»).

### Decisiones de implementación

- **Huella global**, no por persona: el mismo archivo enviado por Katerine después de Miguel devuelve la revisión de Miguel, con lo que ya se cargó.
- **Códigos `R10` en adelante** (dos dígitos o más): los códigos de pregunta tienen un solo dígito (`T3`), así que nunca chocan con `resolver_respuesta`.
- **Líneas dudosas numeradas después de las que faltan:** el «sí» no las carga; hay que nombrarlas.
- **`tarjeta` para todas** en `cargar_faltantes` (además de la corrección por número), para contestar «¿de qué tarjeta?» con una sola palabra.
- **Revalidación al cargar:** cubre dos capturas que se solapan.
- **Tamaño:** 3,3 MB en el MCP y en el servidor (en base64 debe caber en el cuerpo de Vercel de ~4,5 MB).
- **Sin llave de Anthropic:** imagen, PDF o Excel no reconocido responden 503; un Excel o CSV reconocido funciona igual.

### Limitaciones

- El lector de imagen y PDF con Haiku **no se ha probado con la API real** (solo con un lector falso). Falta K2 y K3.
- Compras en otra moneda: no se cargan (quedan «para revisar a mano»).
- No hay botón «Cargar captura» en el tablero (solo por WhatsApp).
- Un archivo de más de 300 movimientos se revisa solo en sus primeras 300 líneas.
- El mismo archivo con otro nombre es el mismo archivo (huella); una captura recortada distinta es otro archivo.

### Despliegue (en orden)

1. Respaldo de Neon (rama o `pg_dump`) y migraciones en orden: `captura_fuente_movimientos`, `captura_tabla_revisiones`, `captura_tabla_lineas` (`db/migrations/041`–`043`).
2. Vercel: `ANTHROPIC_API_KEY` ya existe (la usa el extracto); no hay variables nuevas. Desplegar `web/`.
3. MCP: `npm run build:mcp` y copiar `mcp/dist/finanzas-mcp.cjs` a `/root/.openclaw/tools/finanzas/` (con `pm2 stop/start openclaw-gateway`, revisar un solo proceso). Opcional: `FINANZAS_MEDIA_DIR` (por omisión `/root/.openclaw/media/inbound`). `urls.json`: las rutas nuevas se derivan solas de las existentes.
4. Reglas: `node scripts/reglas-finanzas.mjs <AGENTS.md>` en `workspace-finanzas/AGENTS.md` **y** en `workspace-personal/AGENTS.md` (el agente `personal` debe tener el mismo bloque; el script de despliegue lo hace). Revisar que sigan bajo 10.000 bytes.
5. Confirmar que el agente `finanzas` recibe la ruta del adjunto en el mensaje (`[media attached: …]`). Mandar `/new` en cada chat.

### Prueba de aceptación (Miguel)

| # | Prueba | Qué se espera |
|---|---|---|
| K1 | Mandar el **Excel real** «Movimientos de tus tarjetas» con «¿cuáles faltan? son de la VISA» | Conteos correctos (abonos ignorados), las que faltan con fecha, comercio, valor, tarjeta y categoría propuesta |
| K2 | Mandar una **captura real** de la app | Las mismas líneas que se ven, valores exactos (puntos de miles), «En proceso» incluido |
| K3 | Mandar el **PDF real** del mismo reporte | El mismo resultado que el Excel |
| K4 | Responder «sí» a una revisión; luego mandar **el mismo archivo otra vez** | Carga todas; la segunda vez responde «Este archivo ya lo había revisado» y nada se duplica. Las sin categoría llegan como pregunta |
| K5 | En otra revisión: «solo la 1,3» y «la 2 es salud», «la 3 es de la Mastercard» | Carga solo esas, con la categoría y tarjeta corregidas; las demás siguen pendientes |
| K6 | Repetir en el **grupo** y en el **privado de Katerine** | Funciona en los dos; autoriza cualquiera de los dos; un tercero no puede cargar |

Después de cada prueba, revisar en el tablero que las compras aparezcan como «Captura · …» con «Por conciliar», y que con el extracto del mes queden conciliadas.
