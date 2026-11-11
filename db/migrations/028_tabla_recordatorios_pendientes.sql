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
