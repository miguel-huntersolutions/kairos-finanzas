CREATE TABLE IF NOT EXISTS tokens_reclasificacion (
  token text PRIMARY KEY,
  huella text NOT NULL,
  cantidad integer NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  usado_en timestamptz
)
