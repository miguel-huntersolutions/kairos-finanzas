CREATE TABLE IF NOT EXISTS trm (
  fecha date PRIMARY KEY,
  valor numeric NOT NULL CHECK (valor > 0),
  fuente text NOT NULL,
  obtenida_en timestamptz NOT NULL DEFAULT now()
)
