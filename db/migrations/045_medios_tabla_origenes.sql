CREATE TABLE IF NOT EXISTS origenes_pago (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  nombre text NOT NULL UNIQUE,
  registro_chat boolean NOT NULL DEFAULT true,
  activo boolean NOT NULL DEFAULT true,
  orden integer NOT NULL DEFAULT 100,
  creado_en timestamptz NOT NULL DEFAULT now()
)
