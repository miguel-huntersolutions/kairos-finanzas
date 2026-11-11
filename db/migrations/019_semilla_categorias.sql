INSERT INTO categorias (id, nombre, nombre_normalizado, estado) VALUES
  (1, 'Supermercado y mercado', 'supermercado y mercado', 'activa'),
  (2, 'Restaurantes y domicilios', 'restaurante y domicilio', 'activa'),
  (3, 'Transporte y viajes', 'transporte y viaje', 'activa'),
  (4, 'Servicios y telefonía', 'servicio y telefonia', 'activa'),
  (5, 'Salud y bienestar', 'salud y bienestar', 'activa'),
  (6, 'Suscripciones digitales', 'suscripcion digital', 'activa'),
  (7, 'Entretenimiento', 'entretenimiento', 'activa'),
  (8, 'Hogar y tecnología', 'hogar y tecnologia', 'activa'),
  (9, 'Ropa y compras personales', 'ropa y compra personal', 'activa'),
  (10, 'Vehículo', 'vehiculo', 'activa'),
  (11, 'Otros / pagos a comercios', 'otro y pago a comercio', 'activa'),
  (12, 'Reembolsable empresa', 'reembolsable empresa', 'activa')
ON CONFLICT (id) DO NOTHING
