CREATE TABLE IF NOT EXISTS bitacora (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movimiento_id uuid,
  actor text NOT NULL CHECK (actor IN ('sistema', 'agente', 'miguel', 'katerine')),
  instruido_por text,
  accion text NOT NULL,
  antes jsonb,
  despues jsonb,
  modelo text,
  sesion_openclaw text,
  creado_en timestamptz NOT NULL DEFAULT now()
)
