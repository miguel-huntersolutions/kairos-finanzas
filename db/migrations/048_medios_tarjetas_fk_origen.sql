DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tarjetas_origen_fk') THEN
    ALTER TABLE tarjetas ADD CONSTRAINT tarjetas_origen_fk FOREIGN KEY (clase) REFERENCES origenes_pago(id);
  END IF;
END $$
