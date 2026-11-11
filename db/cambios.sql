-- Cambios posteriores a la Fase 1. Van DESPUÉS de semilla.sql y nunca se
-- editan los archivos ya generados: cada cambio nuevo se agrega al final.
-- Todo es re-ejecutable (las migraciones se pueden volver a aplicar sin daño).

-- @@ movimientos_moneda_usd
-- `valor` sigue siendo el equivalente en COP (resumen, reglas y repaso no cambian).
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS moneda text NOT NULL DEFAULT 'COP' CHECK (moneda IN ('COP', 'USD')),
  ADD COLUMN IF NOT EXISTS valor_original numeric CHECK (valor_original > 0),
  ADD COLUMN IF NOT EXISTS trm numeric CHECK (trm > 0),
  ADD COLUMN IF NOT EXISTS trm_fecha date

-- @@ movimientos_estado_requiere_trm
-- Estado nuevo: compra en USD sin TRM todavía (la API falló). Nunca se inventa una TRM.
ALTER TABLE movimientos
  DROP CONSTRAINT IF EXISTS movimientos_estado_check,
  ADD CONSTRAINT movimientos_estado_check CHECK (estado IN (
    'requiere_interpretacion', 'provisional', 'requiere_revision', 'requiere_trm', 'por_preguntar',
    'en_proceso', 'esperando_respuesta', 'confirmado', 'descartado'))

-- @@ tabla_trm
-- Caché de la TRM vigente por fecha (Superfinanciera, datos.gov.co 32sa-8pi3).
CREATE TABLE IF NOT EXISTS trm (
  fecha date PRIMARY KEY,
  valor numeric NOT NULL CHECK (valor > 0),
  fuente text NOT NULL,
  obtenida_en timestamptz NOT NULL DEFAULT now()
)

-- @@ movimientos_fallos_preguntar
-- Visibilidad de fallos: último error de `preguntar` (texto propio del servidor,
-- nunca del correo) y cuántas veces el agente tomó el movimiento.
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS ultimo_error text,
  ADD COLUMN IF NOT EXISTS intentos_preguntar integer NOT NULL DEFAULT 0

-- @@ tabla_tablero_intentos
-- Intentos FALLIDOS de ingreso al tablero (para el bloqueo por correo y por IP).
-- Nunca se guarda el código probado.
CREATE TABLE IF NOT EXISTS tablero_intentos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('correo', 'ip')),
  clave text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
)

-- @@ indice_tablero_intentos
CREATE INDEX IF NOT EXISTS tablero_intentos_clave_idx ON tablero_intentos (tipo, clave, creado_en)

-- @@ tabla_recordatorios_pendientes
-- Recordatorio de una pregunta sin respuesta (lo atiende un cron).
-- Lo procesa el cron /api/cron/recordatorios. estado y en_proceso_hasta evitan que
-- dos ejecuciones tomen la misma fila; la clave única evita duplicados.
CREATE TABLE IF NOT EXISTS recordatorios_pendientes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movimiento_id uuid NOT NULL REFERENCES movimientos(id),
  pregunta_codigo text NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en_proceso', 'hecho', 'fallido')),
  paso text NOT NULL DEFAULT 'leer_estado' CHECK (paso IN ('leer_estado', 'marcar', 'avisar')),
  datos jsonb NOT NULL DEFAULT '{}',
  proxima_revision timestamptz NOT NULL,
  en_proceso_hasta timestamptz,
  intentos integer NOT NULL DEFAULT 0,
  ultimo_error text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movimiento_id, pregunta_codigo)
)

-- @@ indice_recordatorios_vencidos
CREATE INDEX IF NOT EXISTS recordatorios_vencidos_idx ON recordatorios_pendientes (estado, proxima_revision)

-- @@ columna_categorias_sugeridas
-- Categorías que se ofrecieron numeradas en la pregunta ("1. Salud…"), para entender
-- respuestas como "1" o "la 2". Aditiva: el código anterior la ignora.
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS categorias_sugeridas integer[]

-- @@ columnas_conciliacion
-- Fase de conciliación (aún sin lógica): la fila de correo apuntará a su fila del
-- extracto y cuándo se emparejó. Aditiva: el código anterior la ignora.
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS conciliado_con uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conciliado_en timestamptz

-- @@ recordatorio_con_recibo
-- El recordatorio queda hecho solo con el recibo del envío; mientras tanto la fila
-- espera en el paso nuevo 'esperando_recibo' y el cron vuelve a avisar.
ALTER TABLE recordatorios_pendientes
  DROP CONSTRAINT IF EXISTS recordatorios_pendientes_paso_check,
  ADD CONSTRAINT recordatorios_pendientes_paso_check CHECK (paso IN ('leer_estado', 'marcar', 'avisar', 'esperando_recibo'))

-- @@ tabla_operaciones
-- Idempotencia de las escrituras del MCP: cada llamada trae un operacion_id. Repetida con
-- el mismo contenido devuelve la respuesta guardada; con otro contenido se rechaza.
-- status NULL = en curso. El respaldo borra las de más de 7 días.
CREATE TABLE IF NOT EXISTS operaciones (
  id uuid PRIMARY KEY,
  herramienta text NOT NULL,
  huella text NOT NULL,
  status integer,
  respuesta jsonb,
  creado_en timestamptz NOT NULL DEFAULT now()
)

-- @@ tarjetas_dia_corte
-- Día de corte de cada tarjeta de crédito (1–31; NULL = sin aviso). Ese día, desde las 8 a. m.
-- de Bogotá, el respaldo pide el extracto una vez por mes (tabla avisos_corte).
ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS dia_corte integer CHECK (dia_corte BETWEEN 1 AND 31)

-- @@ tabla_avisos_corte
CREATE TABLE IF NOT EXISTS avisos_corte (
  tarjeta_id text NOT NULL REFERENCES tarjetas(id),
  mes text NOT NULL CHECK (mes ~ '^[0-9]{4}-[0-9]{2}$'),
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'fallido')),
  intentos integer NOT NULL DEFAULT 0,
  creado_en timestamptz NOT NULL DEFAULT now(),
  enviado_en timestamptz,
  PRIMARY KEY (tarjeta_id, mes)
)

-- @@ extracto_tabla_extractos
-- Fase 2: un extracto de tarjeta leído del PDF (el PDF NO se guarda, solo su huella
-- sha256 para que el mismo archivo subido dos veces no se duplique). `procesado` =
-- pasó la validación determinista y se puede conciliar; `en_revision` = algo no cuadró
-- (motivo) y no se concilia nada. tarjeta_id es NULL si los últimos 4 no existen.
CREATE TABLE IF NOT EXISTS extractos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash_pdf text NOT NULL UNIQUE CHECK (hash_pdf ~ '^[0-9a-f]{64}$'),
  tarjeta_id text REFERENCES tarjetas(id),
  ultimos_4 text,
  fecha_corte date,
  total_compras bigint,
  intereses bigint,
  saldo_total bigint,
  lineas integer NOT NULL DEFAULT 0,
  estado text NOT NULL CHECK (estado IN ('procesado', 'en_revision')),
  motivo text,
  creado_por text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  conciliado_en timestamptz
)

-- @@ extracto_indice_extractos_tarjeta
CREATE INDEX IF NOT EXISTS extractos_tarjeta_corte_idx ON extractos (tarjeta_id, fecha_corte)

-- @@ extracto_columnas_movimientos
-- extracto_id: la fila de fuente `extracto` la creó (o la adoptó) la conciliación de ese
-- extracto; la regla provisional de posible duplicado ya no se le aplica.
-- no_aparece_en_extracto: compra por correo del periodo del corte que no está en el
-- extracto (va a «Por atender»). Aditivas: el código anterior las ignora.
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS extracto_id uuid REFERENCES extractos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_aparece_en_extracto uuid REFERENCES extractos(id) ON DELETE SET NULL

-- @@ extracto_indice_no_aparece
CREATE INDEX IF NOT EXISTS movimientos_no_aparece_idx ON movimientos (no_aparece_en_extracto)
  WHERE no_aparece_en_extracto IS NOT NULL

-- @@ extracto_conciliaciones_lineas
-- Las líneas del extracto van en la tabla `conciliaciones` (creada vacía en la Fase 1 con
-- esta forma: extracto_id + linea únicos, fecha, descripción, valor, cuota, movimiento y
-- resultado). Se reutiliza en vez de crear otra tabla: una línea y su resultado son una
-- sola fila. movimiento_id = fila de fuente `extracto` que representa la línea;
-- movimiento_correo_id = compra por correo emparejada (o la compra en USD a revisar).
-- resultado: NULL pendiente, `emparejado`, `faltante` (sin correo: se creó la fila del
-- extracto), `revision` (cuotas, abonos/reversos, posible USD: a mano). `sobrante` se
-- conserva por compatibilidad, pero las compras sobrantes se marcan en movimientos.
ALTER TABLE conciliaciones
  ADD COLUMN IF NOT EXISTS movimiento_correo_id uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cuotas_total integer,
  DROP CONSTRAINT IF EXISTS conciliaciones_resultado_check,
  ADD CONSTRAINT conciliaciones_resultado_check CHECK (resultado IN ('emparejado', 'faltante', 'sobrante', 'revision'))

-- @@ captura_fuente_movimientos
-- Revisión de capturas o reportes de la app del banco: las compras que faltaban y se
-- cargan con autorización de Miguel o Katerine nacen con fuente `captura`. Se tratan
-- igual que las de `correo` en la conciliación con el extracto (no cuentan dos veces).
ALTER TABLE movimientos
  DROP CONSTRAINT IF EXISTS movimientos_fuente_check,
  ADD CONSTRAINT movimientos_fuente_check CHECK (fuente IN ('correo', 'extracto', 'manual', 'captura'))

-- @@ captura_tabla_revisiones
-- Una revisión por archivo (captura, PDF, Excel o CSV). El archivo NO se guarda: solo su
-- huella sha256, única en toda la base (el mismo archivo enviado dos veces, por quien
-- sea, devuelve la misma revisión sin volver a leerlo). codigo = «R10», «R11»… (dos o
-- más dígitos: nunca choca con los códigos de pregunta, que tienen uno solo).
CREATE TABLE IF NOT EXISTS revisiones_captura (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^R[0-9]{2,6}$'),
  huella text NOT NULL UNIQUE CHECK (huella ~ '^[0-9a-f]{64}$'),
  solicitada_por text NOT NULL CHECK (solicitada_por IN ('miguel', 'katerine')),
  canal text NOT NULL CHECK (canal IN ('grupo', 'privado')),
  archivo_tipo text NOT NULL CHECK (archivo_tipo IN ('imagen', 'pdf', 'xlsx', 'csv')),
  lector text NOT NULL CHECK (lector IN ('reporte', 'modelo', 'modelo_texto')),
  tarjeta_hint text REFERENCES tarjetas(id),
  estado text NOT NULL DEFAULT 'revisada' CHECK (estado IN ('revisada', 'cargada_parcial', 'cargada', 'sin_faltantes')),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
)

-- @@ captura_tabla_lineas
-- Cada línea leída del archivo y su resultado. n = posición en el archivo; numero = el
-- número con que se muestra en la lista («solo la 1,3»), solo para faltantes y dudosas.
-- resultado: ya_cargada (movimiento_id = la compra que empareja), falta, dudosa,
-- ignorada (abono, pago, valor cero), revision (otra moneda o dato inválido: a mano),
-- cargada (movimiento_id = la compra creada al autorizar).
CREATE TABLE IF NOT EXISTS revisiones_captura_lineas (
  revision_id integer NOT NULL REFERENCES revisiones_captura(id) ON DELETE CASCADE,
  n integer NOT NULL CHECK (n >= 1),
  numero integer CHECK (numero >= 1),
  fecha date,
  descripcion text,
  valor bigint,
  moneda text,
  cuotas integer,
  estado_app text CHECK (estado_app IN ('en_proceso', 'verificado')),
  resultado text NOT NULL CHECK (resultado IN ('ya_cargada', 'falta', 'dudosa', 'ignorada', 'revision', 'cargada')),
  movimiento_id uuid REFERENCES movimientos(id) ON DELETE SET NULL,
  tarjeta_id text REFERENCES tarjetas(id),
  categoria_id integer REFERENCES categorias(id),
  categoria_origen text CHECK (categoria_origen IN ('regla', 'historial', 'semilla', 'palabras', 'correccion')),
  motivo text,
  PRIMARY KEY (revision_id, n),
  UNIQUE (revision_id, numero)
)

-- @@ gastos_manuales
-- Gastos registrados desde el chat (fuente = manual): efectivo, PSE, Bre-B, transferencia o tarjeta
-- débito. medio_pago dice cómo se pagó; tarjeta_id solo se llena con tarjeta débito.
ALTER TABLE movimientos
  ADD COLUMN IF NOT EXISTS medio_pago text CHECK (medio_pago IN ('efectivo', 'pse', 'bre_b', 'transferencia', 'tarjeta_debito', 'otro'));

-- @@ medios_tabla_origenes
-- Origen de un medio de pago: crédito, débito, efectivo (configurable en el tablero).
-- registro_chat = false: sus compras llegan por correo o extracto; el chat no las registra a mano.
CREATE TABLE IF NOT EXISTS origenes_pago (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  nombre text NOT NULL UNIQUE,
  registro_chat boolean NOT NULL DEFAULT true,
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 100,
  creado_en timestamptz NOT NULL DEFAULT now()
)

-- @@ medios_semilla_origenes
INSERT INTO origenes_pago (id, nombre, registro_chat, orden) VALUES
  ('credito', 'Crédito', false, 1),
  ('debito', 'Débito', true, 2),
  ('efectivo', 'Efectivo', true, 3)
ON CONFLICT (id) DO NOTHING

-- @@ medios_tarjetas_sin_check_clase
-- La tabla `tarjetas` pasa a ser la de MEDIOS DE PAGO; `clase` es su origen (FK a origenes_pago).
ALTER TABLE tarjetas DROP CONSTRAINT IF EXISTS tarjetas_clase_check

-- @@ medios_tarjetas_fk_origen
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tarjetas_origen_fk') THEN
    ALTER TABLE tarjetas ADD CONSTRAINT tarjetas_origen_fk FOREIGN KEY (clase) REFERENCES origenes_pago(id);
  END IF;
END $$

-- @@ medios_tarjetas_columnas
-- alias: cómo lo nombran en el chat ("nu kate", "débito bancolombia").
-- canal: forma de pago por defecto del medio (tarjeta, efectivo, pse…).
ALTER TABLE tarjetas
  ALTER COLUMN banco DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS alias text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'tarjeta' CHECK (canal IN ('tarjeta', 'efectivo', 'pse', 'bre_b', 'transferencia', 'otro')),
  ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS creado_en timestamptz NOT NULL DEFAULT now()

-- @@ medios_semilla
INSERT INTO tarjetas (id, nombre, banco, clase, tipo, persona_default, alias, canal) VALUES
  ('efectivo', 'Efectivo', NULL, 'efectivo', 'compartida', NULL, '{efectivo,"en efectivo",cash}', 'efectivo'),
  ('pse', 'PSE', NULL, 'debito', 'compartida', NULL, '{pse}', 'pse'),
  ('nu-katerine', 'NU Katerine', 'Nu', 'debito', 'individual', 'katerine', '{"nu kate","nu katerine","la nu",nu}', 'tarjeta')
ON CONFLICT (id) DO NOTHING

-- @@ medios_alias_existentes
UPDATE tarjetas SET
  alias = CASE id
    WHEN 'bancolombia-debito' THEN '{"debito bancolombia","bancolombia debito","cuenta bancolombia"}'::text[]
    WHEN 'visa-bancolombia' THEN '{"visa bancolombia",visa}'::text[]
    WHEN 'mastercard-bancolombia' THEN '{mastercard,master}'::text[]
    WHEN 'plata-pay-miguel' THEN '{"plata pay miguel"}'::text[]
    WHEN 'plata-pay-katerine' THEN '{"plata pay katerine","plata pay kate"}'::text[]
    ELSE alias END,
  banco = CASE WHEN id = 'visa-bancolombia' AND banco = 'por confirmar' THEN 'Bancolombia' ELSE banco END
WHERE alias = '{}'

-- @@ medios_movimientos_manuales
-- Los gastos en efectivo o PSE ya registrados quedan con su medio de pago.
UPDATE movimientos SET tarjeta_id = medio_pago
WHERE fuente = 'manual' AND tarjeta_id IS NULL AND medio_pago IN ('efectivo', 'pse')

-- @@ categorias_sin_aprobacion
-- Las categorías nuevas ya no esperan aprobación (solo pasan la validación de similitud).
UPDATE categorias SET estado = 'activa', confirmada_por = COALESCE(confirmada_por, 'sistema') WHERE estado = 'propuesta'

-- @@ ingresos_tabla
-- Lo que entra al hogar, contado por chat: salario, reembolsos de la empresa y otros.
-- No se borra: se descarta (estado). `registrado_por` = quien lo contó; `persona` = quien lo recibió.
CREATE TABLE IF NOT EXISTS ingresos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha date NOT NULL,
  valor bigint NOT NULL CHECK (valor > 0),
  descripcion text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('salario', 'reembolso', 'otro')),
  persona text NOT NULL CHECK (persona IN ('miguel', 'katerine')),
  registrado_por text NOT NULL CHECK (registrado_por IN ('miguel', 'katerine')),
  estado text NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('confirmado', 'descartado')),
  nota text,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
)

-- @@ ingresos_indice_fecha
CREATE INDEX IF NOT EXISTS ingresos_fecha_idx ON ingresos (fecha) WHERE estado = 'confirmado'

-- @@ movimientos_reembolso
-- Compra reembolsable ya pagada por la empresa: apunta al ingreso (reembolso) que la cubrió.
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS reembolso_id uuid REFERENCES ingresos(id)

-- @@ movimientos_indice_reembolso
CREATE INDEX IF NOT EXISTS movimientos_reembolso_pendiente_idx ON movimientos (fecha) WHERE reembolsable AND reembolso_id IS NULL
