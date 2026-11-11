CREATE TABLE IF NOT EXISTS tarjetas (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  banco text NOT NULL,
  clase text NOT NULL DEFAULT 'credito' CHECK (clase IN ('credito', 'debito')),
  tipo text NOT NULL CHECK (tipo IN ('individual', 'compartida')),
  ultimos_4 text UNIQUE CHECK (ultimos_4 ~ '^[0-9]{4}$'),
  persona_default text CHECK (persona_default IN ('miguel', 'katerine')),
  activa boolean NOT NULL DEFAULT true,
  CHECK (tipo = 'compartida' OR persona_default IS NOT NULL)
)
