CREATE TABLE IF NOT EXISTS operaciones (
  id uuid PRIMARY KEY,
  herramienta text NOT NULL,
  huella text NOT NULL,
  status integer,
  respuesta jsonb,
  creado_en timestamptz NOT NULL DEFAULT now()
)
