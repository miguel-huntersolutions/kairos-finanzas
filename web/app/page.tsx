'use client';
// Tablero único de gastos del hogar (antes había un tablero del mes y un explorador
// VISA aparte): todas las tarjetas y fuentes, con estado por compra. Ingreso con correo +
// código; la sesión es una cookie HttpOnly que maneja la función `tablero`.
import { useCallback, useEffect, useState } from 'react';
import { MODO_DEMO, borrarCategoria, borrarMovimiento, renombrarCategoria, cambiarFecha, cargarExtracto, crearCategoria, editarMovimiento, datosExplorador, confirmar, detalle, ingresar, reclasificar, resolverEnvio, revision, salir, sesionActual } from '@/lib/api';
import { montarExplorador } from '@/lib/explorador/app';
import { demoDetalle, demoExplorador, demoReclasificar } from '@/lib/explorador/demo';
import './explorador.css';

export default function Pagina() {
  const [correo, setCorreo] = useState<string | null>(MODO_DEMO ? 'demo (datos sintéticos)' : null);
  const [cargandoSesion, setCargandoSesion] = useState(!MODO_DEMO);
  const cerrarSesion = useCallback(() => setCorreo(null), []);

  useEffect(() => {
    if (MODO_DEMO) return;
    sesionActual()
      .then((r) => setCorreo(r.status === 200 ? r.json.correo : null))
      .catch(() => setCorreo(null))
      .finally(() => setCargandoSesion(false));
  }, []);

  if (cargandoSesion) return <main className="centro"><p role="status">Cargando…</p></main>;
  if (!correo) return <Ingreso alEntrar={setCorreo} />;
  return <Tablero email={correo} alSalir={cerrarSesion} />;
}

function Ingreso({ alEntrar }: { alEntrar: (correo: string) => void }) {
  const [email, setEmail] = useState('');
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    setError(null);
    setEnviando(true);
    try {
      const r = await ingresar(email, codigo);
      if (r.status === 200) return alEntrar(r.json.correo);
      setError(r.status === 429 || r.status === 401 ? r.json.error : 'No se pudo entrar. Intenta de nuevo.');
    } catch {
      setError('No se pudo entrar. Revisa tu conexión.');
    } finally {
      setCodigo('');
      setEnviando(false);
    }
  };

  return (
    <main className="centro">
      <form className="tarjeta ingreso" onSubmit={enviar} aria-labelledby="t-ingreso">
        <h1 id="t-ingreso">Gastos del hogar</h1>
        <p className="tenue">Entra con tu correo y el código.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <label htmlFor="correo">Correo</label>
        <input id="correo" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="codigo">Código</label>
        <input
          id="codigo" type="password" inputMode="numeric" autoComplete="one-time-code" required
          pattern="[0-9]{6}" minLength={6} maxLength={6} title="6 dígitos"
          value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button type="submit" disabled={enviando || codigo.length !== 6} aria-busy={enviando}>
          {enviando ? 'Verificando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

function Tablero({ email, alSalir }: { email: string; alSalir: () => void }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const demo = MODO_DEMO ? demoExplorador() : null;
    return montarExplorador({
      datos: async () => (demo ? { status: 200, json: structuredClone(demo) } : datosExplorador()),
      reclasificar: async (p) => (demo ? demoReclasificar(demo, p) : reclasificar(p)),
      sinSesion: alSalir,
      cargarExtracto: demo ? undefined : cargarExtracto,
      resolverEnvio: demo ? undefined : resolverEnvio,
      crearCategoria: demo ? undefined : crearCategoria,
      detalle: demo ? async (id: string) => demoDetalle(id) : detalle,
      revision: demo ? async () => ({ status: 200, json: { aplicado: true, estado: 'por_preguntar' } }) : revision,
      cambiarFecha: demo ? async (id: string, fecha: string) => { const m = demo.movimientos.find((x: any) => x.id === id); if (m) { m.fecha = fecha; m.mes = fecha.slice(0, 7); } return { status: 200, json: { aplicado: true, fecha } }; } : cambiarFecha,
      confirmar: demo ? async () => ({ status: 200, json: { aplicado: true, estado: 'confirmado' } }) : confirmar,
      renombrarCategoria: demo ? async (id: number, nombre: string) => { const c = demo.categorias_gestion?.find((x: any) => x.id === id); if (c) c.nombre = nombre; return { status: 200, json: { aplicado: true, categoria: { id, nombre } } }; } : renombrarCategoria,
      borrarCategoria: demo ? async (id: number) => { if (demo.categorias_gestion) demo.categorias_gestion = demo.categorias_gestion.filter((x: any) => x.id !== id); return { status: 200, json: { aplicado: true, borrada: true } }; } : borrarCategoria,
      borrar: demo ? async () => ({ status: 200, json: { aplicado: true, borrado: true } }) : borrarMovimiento,
      editar: demo ? async (_id: string, cambios: Record<string, unknown>) => ({ status: 200, json: { aplicado: true, cambios: Object.keys(cambios) } }) : editarMovimiento,
    });
  }, [version, alSalir]);
  const recargar = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <div className="explorador">
      <link rel="stylesheet" precedence="default" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;500&display=swap" />
      <div className="wrap">
        <header className="top">
          <div>
            <h1>Gastos del hogar</h1>
            <p className="sub hide-sm">Todas las tarjetas: lo del extracto del banco aparece como «Conciliado»; lo que llega por correo sigue su flujo y queda «Por conciliar» hasta que llegue su fila del extracto. Los cambios de categoría se guardan en la base.</p>
          </div>
          <div className="head-actions">
            <div className="save-state" id="saveState"><i></i><span id="saveText">Cargando…</span></div>
            {!MODO_DEMO && <button className="btn" type="button" id="bExtracto" title="Sube el PDF del extracto de una tarjeta para conciliarlo con las compras que llegaron por correo">Cargar extracto</button>}
            {!MODO_DEMO && <button className="btn" type="button" id="bCategoria" title="Crea una categoría nueva para reclasificar">Nueva categoría</button>}
            <a className="btn" href="/medios" title="Orígenes (crédito, débito, efectivo) y medios de pago">Medios de pago</a>
            {!MODO_DEMO && <input id="fExtracto" type="file" accept="application/pdf,.pdf" hidden aria-hidden="true" tabIndex={-1} />}
            <button className="btn" type="button" onClick={recargar}>Actualizar</button>
            <span className="note usuario" title={email}>{email}</span>
            {!MODO_DEMO && <button className="btn ghost" type="button" onClick={() => salir().finally(alSalir)}>Salir</button>}
          </div>
        </header>

        <div className="bar">
          <nav className="tabs" role="tablist" aria-label="Secciones">
            <button role="tab" id="t-resumen" data-tab="resumen" aria-selected="true">Resumen</button>
            <button role="tab" id="t-mes" data-tab="mes" aria-selected="false">Detalle del mes</button>
            <button role="tab" id="t-comparar" data-tab="comparar" aria-selected="false">Comparar categorías</button>
            <button role="tab" id="t-reclasificar" data-tab="reclasificar" aria-selected="false">Reclasificar</button>
            <button role="tab" id="t-movimientos" data-tab="movimientos" aria-selected="false">Movimientos</button>
            <button role="tab" id="t-categorias" data-tab="categorias" aria-selected="false">Categorías</button>
          </nav>
          <button className="btn ghost solo-movil" id="bFiltros" type="button" aria-expanded="false" aria-controls="filtros">Filtros</button>
          <div className="filters" id="filtros">
            <label>Mes<select id="fMes" defaultValue=""><option value="">Todos</option></select></label>
            <label>Medio de pago<select id="fTarjeta" defaultValue=""><option value="">Todos</option></select></label>
            <label>Estado<select id="fEstado" defaultValue="">
              <option value="">Todos</option><option value="conciliado">Conciliado (extracto)</option><option value="por_conciliar">Por conciliar (correo)</option>
              <option value="pendiente">Pendientes de respuesta o revisión</option><option value="manual">Manual</option><option value="duplicado">Posible duplicado de extracto</option>
            </select></label>
            <label>Categoría<select id="fCat" defaultValue=""><option value="">Todas</option></select></label>
            <label>Monto<select id="fMonto" defaultValue="">
              <option value="">Todos</option><option value="h">Hasta $20.000 (hormiga)</option><option value="p">Hasta $100.000</option><option value="g">Más de $100.000</option>
            </select></label>
            <label>Buscar<input id="fQ" type="search" placeholder="Comercio o descripción" /></label>
            <button className="btn ghost" id="fReset" type="button">Quitar filtros</button>
          </div>
        </div>

        <main id="view"><div className="loading">Cargando movimientos…</div></main>
      </div>
      <dialog id="dlg" aria-labelledby="dlgTitulo"><div id="dlgCuerpo"></div></dialog>
      <div id="tip" hidden></div>
      <div id="toast" hidden><span id="toastText"></span><button type="button" id="toastUndo">Deshacer</button></div>
    </div>
  );
}
