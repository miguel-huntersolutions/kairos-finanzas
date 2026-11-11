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
