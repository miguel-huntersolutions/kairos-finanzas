UPDATE movimientos SET tarjeta_id = medio_pago
WHERE fuente = 'manual' AND tarjeta_id IS NULL AND medio_pago IN ('efectivo', 'pse')
