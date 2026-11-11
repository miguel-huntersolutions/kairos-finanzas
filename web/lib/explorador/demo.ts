// Datos SINTÉTICOS del tablero unificado para la vista previa local (NEXT_PUBLIC_TABLERO_DEMO=1).
import { OTROS } from './calculos';

const categorias = ['Transporte y viajes', 'Supermercado y mercado', 'Restaurantes y domicilios', 'Salud y bienestar', 'Servicios y telefonía',
  'Suscripciones digitales', 'Hogar y tecnología', 'Ropa y compras personales', 'Vehículo', 'Entretenimiento', OTROS, 'Reembolsable empresa']
  .map((nombre, i) => ({ id: i + 1, nombre }));
const comercios: Array<[string, number]> = [['Tienda Ejemplo', 2], ['Café Demo', 3], ['Taxi Demo', 1], ['PasarelaPago', 11], ['Streaming Demo', 6], ['Ferretería Ficticia', 7], ['Kiosco Demo', 11]];

const tarjetas = [{ id: 'visa-bancolombia', nombre: 'VISA' }, { id: 'mastercard-bancolombia', nombre: 'Mastercard' }, { id: 'plata-pay-katerine', nombre: 'Plata Pay Katerine' }];

/** Filas del extracto (Conciliado) de ene–oct y compras por correo de nov en varios estados. */
export function demoExplorador() {
  const base = (i: number, mes: string, fuente: string, estado: string, tarjeta = tarjetas[i % 3]) => {
    const [comercio, cat] = comercios[i % comercios.length];
    const nombre = categorias[cat - 1].nombre;
    const pendiente = estado !== 'confirmado';
    return {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      fecha: `${mes}-${String(1 + ((i * 7) % 27)).padStart(2, '0')}`,
      mes, desc: fuente === 'extracto' ? `${comercio.toUpperCase()} ${1000 + i}` : comercio, comercio,
      valor: 5000 + ((i * 48_271) % 310_000), cuotas: i % 13 === 0 ? 3 : 1,
      categoria_id: pendiente ? null : cat, categoria: pendiente ? 'Sin clasificar' : nombre, categoria_inicial: pendiente ? 'Sin clasificar' : nombre,
      tarjeta_id: tarjeta.id, tarjeta: tarjeta.nombre, fuente, estado,
      estado_vista: fuente === 'extracto' ? 'Conciliado' : estado === 'confirmado' ? 'Confirmado' : 'Esperando respuesta',
      grupo: fuente === 'extracto' ? 'conciliado' : pendiente ? 'pendiente' : 'por_conciliar',
      por_conciliar: fuente === 'correo', duplicado_de: null as string | null, cuenta: true, reclasificable: !pendiente, persona: null,
    };
  };
  const movimientos = Array.from({ length: 160 }, (_, i) => base(i, `2026-${String(1 + (i % 10)).padStart(2, '0')}`, 'extracto', 'confirmado'));
  movimientos.push(base(200, '2026-11', 'correo', 'confirmado'), base(201, '2026-11', 'correo', 'esperando_respuesta'));
  // Un correo de octubre que coincide con su fila del extracto: posible duplicado, no suma.
  const ext = movimientos[9];
  movimientos.push({ ...base(202, ext.mes, 'correo', 'confirmado', tarjetas[9 % 3]), fecha: ext.fecha, valor: ext.valor, comercio: ext.comercio, desc: ext.comercio,
    categoria_id: ext.categoria_id, categoria: ext.categoria, categoria_inicial: ext.categoria, duplicado_de: ext.id, cuenta: false });
  const etq = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov'];
  const por_atender = [
    { id: movimientos[161].id, fecha: movimientos[161].fecha, comercio: movimientos[161].comercio, valor_texto: '$' + movimientos[161].valor.toLocaleString('es-CO'), tarjeta: movimientos[161].tarjeta, estado: 'Esperando respuesta', motivo: 'falta que respondan de qué fue' },
    { id: '00000000-0000-4000-8000-00000000d3e0', fecha: '2026-11-05', comercio: 'Compra sin interpretar', valor_texto: 'valor pendiente', tarjeta: 'Sin tarjeta', estado: 'Requiere revisión', motivo: 'tarjeta desconocida', accion: 'revision' },
  ];
  const usos = (id: number) => movimientos.filter((m) => m.categoria_id === id).length;
  const categorias_gestion = [
    ...categorias.map((c) => ({ id: c.id, nombre: c.nombre, estado: 'activa', compras: usos(c.id), reglas: 0, comercios: 0, capturas: 0, base: true })),
    { id: 100, nombre: 'Mascotas', estado: 'activa', compras: 0, reglas: 0, comercios: 0, capturas: 0, base: false },
    { id: 101, nombre: 'Créditos', estado: 'activa', compras: 3, reglas: 0, comercios: 0, capturas: 0, base: false },
  ];
  return { titulo: 'Gastos del hogar', categorias, categorias_gestion, tarjetas, meses: etq.map((e, i) => ({ mes: `2026-${String(i + 1).padStart(2, '0')}`, etiqueta: `${e} 26` })), movimientos, por_atender };
}

/** Reclasificación en memoria para la vista previa (misma forma de respuesta que la API). */
export function demoReclasificar(datos: ReturnType<typeof demoExplorador>, pedido: any) {
  const objetivo: Array<{ movimiento_id: string; categoria_id: number }> = pedido.cambios
    ?? (pedido.movimiento_id ? [pedido] : datos.movimientos.filter((m) => m.comercio === pedido.comercio).map((m) => ({ movimiento_id: m.id, categoria_id: pedido.categoria_id })));
  const cambios = objetivo
    .map((o) => ({ m: datos.movimientos.find((x) => x.id === o.movimiento_id)!, o }))
    .filter(({ m, o }) => m && m.categoria_id !== o.categoria_id)
    .map(({ m, o }) => {
      const cambio = { movimiento_id: m.id, antes: m.categoria_id, despues: o.categoria_id };
      m.categoria_id = o.categoria_id; // estado "del servidor" en la simulación
      return cambio;
    });
  return { status: 200, json: { actualizados: cambios.length, cambios } };
}

/** Detalle simulado para la vista previa: mensaje original sintético. */
export function demoDetalle(id: string) {
  return {
    status: 200,
    json: {
      movimiento_id: id, fuente: 'correo', estado: 'requiere_revision', fecha: null, valor_texto: 'valor pendiente', comercio: null,
      descripcion_original: 'COMPRA FICTICIA', tarjeta: null, categoria: null, persona: null, nota: 'tarjeta desconocida',
      correo: {
        asunto: 'Alerta de compra (demo)', remitente: 'alertas@banco-ficticio.example', fecha: '2026-11-05T10:22:00',
        texto: 'Hola,\nRealizaste una compra por $58.900 en TIENDA FICTICIA con tu tarjeta terminada en •••• 9999 el 05/11/2026 a las 10:21.\n\nSi no reconoces esta compra, llama a la línea de atención.',
      },
    },
  };
}
