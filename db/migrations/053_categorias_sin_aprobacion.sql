UPDATE categorias SET estado = 'activa', confirmada_por = COALESCE(confirmada_por, 'sistema') WHERE estado = 'propuesta'
