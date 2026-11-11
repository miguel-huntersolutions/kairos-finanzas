CREATE TABLE IF NOT EXISTS tablero_intentos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('correo', 'ip')),
  clave text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
)
