'use client';
// Configuración de medios de pago y sus orígenes (crédito, débito, efectivo…).
// Un ORIGEN dice de dónde sale la plata y si sus gastos se registran por chat (crédito no: llega
// por correo o extracto). Un MEDIO es con qué se paga: VISA Bancolombia, Débito Bancolombia, PSE,
// Efectivo. Los alias son como lo nombran en el chat ("nu kate"). Misma sesión que el tablero.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MODO_DEMO, datosMedios, guardarMedio, guardarOrigen, sesionActual } from '@/lib/api';
import '../explorador.css';
import './medios.css';

interface Origen { id: string; nombre: string; registro_chat: boolean; activo: boolean; medios: number }
interface MedioPago {
  id: string; nombre: string; banco: string | null; origen: string; tipo: 'individual' | 'compartida';
  persona_default: 'miguel' | 'katerine' | null; ultimos_4: string | null; alias: string[]; canal: string;
  dia_corte: number | null; activa: boolean; movimientos: number;
}
type Datos = { origenes: Origen[]; medios: MedioPago[]; canales: string[] };

const CANAL: Record<string, string> = {
  tarjeta: 'Tarjeta o cuenta', efectivo: 'Efectivo', pse: 'PSE', bre_b: 'Bre-B', transferencia: 'Transferencia', otro: 'Otro',
};
const PERSONA: Record<string, string> = { miguel: 'Miguel', katerine: 'Katerine' };

const DEMO: Datos = {
  canales: Object.keys(CANAL),
  origenes: [
    { id: 'credito', nombre: 'Crédito', registro_chat: false, activo: true, medios: 2 },
    { id: 'debito', nombre: 'Débito', registro_chat: true, activo: true, medios: 2 },
    { id: 'efectivo', nombre: 'Efectivo', registro_chat: true, activo: true, medios: 1 },
  ],
  medios: [
    { id: 'visa-bancolombia', nombre: 'VISA', banco: 'Bancolombia', origen: 'credito', tipo: 'compartida', persona_default: null, ultimos_4: '1111', alias: ['visa bancolombia', 'visa'], canal: 'tarjeta', dia_corte: 15, activa: true, movimientos: 40 },
    { id: 'bancolombia-debito', nombre: 'Bancolombia débito', banco: 'Bancolombia', origen: 'debito', tipo: 'compartida', persona_default: null, ultimos_4: null, alias: ['debito bancolombia'], canal: 'tarjeta', dia_corte: null, activa: true, movimientos: 6 },
    { id: 'pse', nombre: 'PSE', banco: null, origen: 'debito', tipo: 'compartida', persona_default: null, ultimos_4: null, alias: ['pse'], canal: 'pse', dia_corte: null, activa: true, movimientos: 1 },
    { id: 'efectivo', nombre: 'Efectivo', banco: null, origen: 'efectivo', tipo: 'compartida', persona_default: null, ultimos_4: null, alias: ['efectivo'], canal: 'efectivo', dia_corte: null, activa: true, movimientos: 3 },
  ],
};

export default function PaginaMedios() {
  const [estado, setEstado] = useState<'cargando' | 'sin_sesion' | 'listo' | 'error'>('cargando');
  const [datos, setDatos] = useState<Datos | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  const cargar = useCallback(async () => {
    if (MODO_DEMO) { setDatos(structuredClone(DEMO)); setEstado('listo'); return; }
    try {
      const s = await sesionActual();
      if (s.status !== 200) { setEstado('sin_sesion'); return; }
      const r = await datosMedios();
      if (r.status === 401) { setEstado('sin_sesion'); return; }
      if (r.status !== 200) { setEstado('error'); return; }
      setDatos(r.json); setEstado('listo');
    } catch { setEstado('error'); }
  }, []);
  useEffect(() => { void cargar(); }, [cargar]);

  const guardar = useCallback(async (que: 'origen' | 'medio', cuerpo: Record<string, unknown>, listo: string) => {
    if (MODO_DEMO) { setAviso({ tipo: 'ok', texto: `${listo} (demo: no se guarda)` }); return true; }
    try {
      const r = que === 'origen' ? await guardarOrigen(cuerpo) : await guardarMedio(cuerpo);
      if (r.status === 401) { setEstado('sin_sesion'); return false; }
      if (r.status !== 200) { setAviso({ tipo: 'error', texto: r.json.error || 'No se pudo guardar.' }); return false; }
      setAviso({ tipo: 'ok', texto: listo });
      await cargar();
      return true;
    } catch { setAviso({ tipo: 'error', texto: 'Sin conexión: no se guardó.' }); return false; }
  }, [cargar]);

  return (
    <div className="explorador">
      <link rel="stylesheet" precedence="default" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;500&display=swap" />
      <div className="wrap">
        <header className="top">
          <div>
            <h1>Medios de pago</h1>
            <p className="sub">Cada medio tiene un origen: crédito, débito o efectivo. Los de crédito llegan por correo o extracto; los demás se pueden registrar por chat. Los alias son las palabras con que los nombran en WhatsApp.</p>
          </div>
          <div className="head-actions"><a className="btn" href="/">← Volver al tablero</a></div>
        </header>

        <p role="status" aria-live="polite" className={`medios-aviso ${aviso?.tipo ?? ''}`}>{aviso?.texto ?? ''}</p>

        {estado === 'cargando' && <div className="loading">Cargando…</div>}
        {estado === 'error' && <div className="panel"><p>No se pudieron leer los medios de pago.</p><button className="btn" type="button" onClick={cargar}>Reintentar</button></div>}
        {estado === 'sin_sesion' && <div className="panel"><p>Tu sesión terminó.</p><a className="btn primary" href="/">Entrar</a></div>}
        {estado === 'listo' && datos && (
          <>
            <Origenes origenes={datos.origenes} guardar={guardar} />
            <Medios datos={datos} guardar={guardar} />
          </>
        )}
      </div>
    </div>
  );
}

type Guardar = (que: 'origen' | 'medio', cuerpo: Record<string, unknown>, listo: string) => Promise<boolean>;

function Origenes({ origenes, guardar }: { origenes: Origen[]; guardar: Guardar }) {
  const [nuevo, setNuevo] = useState('');
  return (
    <section className="panel" aria-labelledby="t-origenes">
      <h2 id="t-origenes">Orígenes</h2>
      <p className="note">De dónde sale la plata. Si un origen no se registra por chat, el asistente no anota a mano sus gastos (llegan por correo o por el extracto).</p>
      <ul className="medios-lista">
        {origenes.map((o) => <FilaOrigen key={o.id} o={o} guardar={guardar} />)}
      </ul>
      <form className="medios-nuevo" onSubmit={async (e) => { e.preventDefault(); if (await guardar('origen', { nombre: nuevo.trim() }, `Origen «${nuevo.trim()}» creado.`)) setNuevo(''); }}>
        <label>Nuevo origen<input type="text" value={nuevo} onChange={(e) => setNuevo(e.target.value)} minLength={2} maxLength={40} required placeholder="Ej.: Billetera digital" /></label>
        <button className="btn primary" type="submit">Agregar origen</button>
      </form>
    </section>
  );
}

function FilaOrigen({ o, guardar }: { o: Origen; guardar: Guardar }) {
  const [nombre, setNombre] = useState(o.nombre);
  const [chat, setChat] = useState(o.registro_chat);
  const [activo, setActivo] = useState(o.activo);
  const cambiado = nombre.trim() !== o.nombre || chat !== o.registro_chat || activo !== o.activo;
  return (
    <li>
      <form className="medios-fila" onSubmit={(e) => { e.preventDefault(); void guardar('origen', { id: o.id, nombre: nombre.trim(), registro_chat: chat, activo }, `Origen «${nombre.trim()}» guardado.`); }}>
        <label className="medios-nombre">Nombre<input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} minLength={2} maxLength={40} required /></label>
        <label className="medios-check"><input type="checkbox" checked={chat} onChange={(e) => setChat(e.target.checked)} /> Se registra por chat</label>
        <label className="medios-check"><input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} /> Activo</label>
        <span className="note">{o.medios} {o.medios === 1 ? 'medio' : 'medios'}</span>
        <button className="btn mini" type="submit" disabled={!cambiado}>Guardar</button>
      </form>
    </li>
  );
}

function Medios({ datos, guardar }: { datos: Datos; guardar: Guardar }) {
  const porOrigen = useMemo(() => datos.origenes.map((o) => ({ o, medios: datos.medios.filter((m) => m.origen === o.id) })), [datos]);
  const sueltos = datos.medios.filter((m) => !datos.origenes.some((o) => o.id === m.origen));
  return (
    <section className="panel" aria-labelledby="t-medios">
      <h2 id="t-medios">Medios de pago</h2>
      <p className="note">Con qué se paga. Un medio individual siempre queda a nombre de su dueña o dueño; uno compartido, a nombre de quien registra el gasto.</p>
      {porOrigen.map(({ o, medios }) => (
        <div key={o.id} className="medios-grupo">
          <h3>{o.nombre}{!o.activo && <span className="tag">inactivo</span>}</h3>
          {medios.length ? <ul className="medios-lista">{medios.map((m) => <li key={m.id}><FormMedio m={m} datos={datos} guardar={guardar} /></li>)}</ul> : <p className="note">Sin medios.</p>}
        </div>
      ))}
      {sueltos.length > 0 && <ul className="medios-lista">{sueltos.map((m) => <li key={m.id}><FormMedio m={m} datos={datos} guardar={guardar} /></li>)}</ul>}
      <details className="medios-agregar">
        <summary className="btn primary">Agregar medio de pago</summary>
        <FormMedio datos={datos} guardar={guardar} />
      </details>
    </section>
  );
}

function FormMedio({ m, datos, guardar }: { m?: MedioPago; datos: Datos; guardar: Guardar }) {
  const inicial = () => ({
    nombre: m?.nombre ?? '', origen: m?.origen ?? 'debito', banco: m?.banco ?? '', tipo: m?.tipo ?? 'compartida',
    persona_default: m?.persona_default ?? '', ultimos_4: m?.ultimos_4 ?? '', alias: (m?.alias ?? []).join(', '),
    canal: m?.canal ?? 'tarjeta', dia_corte: m?.dia_corte ? String(m.dia_corte) : '', activa: m?.activa ?? true,
  });
  const [f, setF] = useState(inicial);
  const set = <K extends keyof ReturnType<typeof inicial>>(k: K, v: ReturnType<typeof inicial>[K]) => setF((x) => ({ ...x, [k]: v }));
  const idf = m?.id ?? 'nuevo';
  const origenesActivos = datos.origenes.filter((o) => o.activo || o.id === f.origen);
  const bloqueadoOrigen = !!m && m.movimientos > 0;

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const cuerpo: Record<string, unknown> = {
      ...(m ? { id: m.id } : {}),
      nombre: f.nombre.trim(), origen: f.origen, banco: f.banco.trim() || null, tipo: f.tipo,
      persona_default: f.tipo === 'individual' ? f.persona_default || null : null,
      ultimos_4: f.ultimos_4.trim() || null,
      alias: f.alias.split(',').map((a) => a.trim()).filter(Boolean),
      canal: f.canal, dia_corte: f.origen === 'credito' && f.dia_corte ? Number(f.dia_corte) : null, activa: f.activa,
    };
    const ok = await guardar('medio', cuerpo, `Medio «${f.nombre.trim()}» ${m ? 'guardado' : 'creado'}.`);
    if (ok && !m) setF(inicial());
  };

  return (
    <form className="medios-medio" onSubmit={enviar} aria-label={m ? `Editar ${m.nombre}` : 'Nuevo medio de pago'}>
      {m && (
        <div className="medios-resumen">
          <strong>{m.nombre}</strong>
          <span className="note">
            {m.tipo === 'individual' ? `de ${PERSONA[m.persona_default ?? ''] ?? '—'}` : 'compartido'}
            {m.ultimos_4 ? ` · *${m.ultimos_4}` : ''} · {m.movimientos} {m.movimientos === 1 ? 'movimiento' : 'movimientos'}
            {!m.activa && ' · inactivo'}
          </span>
        </div>
      )}
      <div className="medios-campos">
        <label>Nombre<input type="text" value={f.nombre} onChange={(e) => set('nombre', e.target.value)} minLength={2} maxLength={40} required /></label>
        <label>Origen
          <select value={f.origen} onChange={(e) => set('origen', e.target.value)} disabled={bloqueadoOrigen} title={bloqueadoOrigen ? 'Ya tiene movimientos: crea otro medio para cambiar el origen' : undefined}>
            {origenesActivos.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
          </select>
        </label>
        <label>Banco<input type="text" value={f.banco} onChange={(e) => set('banco', e.target.value)} maxLength={40} placeholder="Opcional" /></label>
        <label>Forma de pago
          <select value={f.canal} onChange={(e) => set('canal', e.target.value)}>
            {datos.canales.map((c) => <option key={c} value={c}>{CANAL[c] ?? c}</option>)}
          </select>
        </label>
        <label>Tipo
          <select value={f.tipo} onChange={(e) => set('tipo', e.target.value as 'individual' | 'compartida')}>
            <option value="compartida">Compartido</option>
            <option value="individual">Individual</option>
          </select>
        </label>
        {f.tipo === 'individual' && (
          <label>Dueña o dueño
            <select value={f.persona_default} onChange={(e) => set('persona_default', e.target.value as any)} required>
              <option value="">Elige…</option>
              <option value="miguel">Miguel</option>
              <option value="katerine">Katerine</option>
            </select>
          </label>
        )}
        <label>Últimos 4<input type="text" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={f.ultimos_4} onChange={(e) => set('ultimos_4', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Opcional" /></label>
        {f.origen === 'credito' && (
          <label>Día de corte<input type="number" min={1} max={31} value={f.dia_corte} onChange={(e) => set('dia_corte', e.target.value)} placeholder="Opcional" /></label>
        )}
        <label className="medios-ancho" htmlFor={`alias-${idf}`}>Alias en el chat (separados por coma)
          <input id={`alias-${idf}`} type="text" value={f.alias} onChange={(e) => set('alias', e.target.value)} maxLength={300} placeholder="nu kate, la nu" />
        </label>
        <label className="medios-check"><input type="checkbox" checked={f.activa} onChange={(e) => set('activa', e.target.checked)} /> Activo</label>
      </div>
      <div className="row-actions"><button className="btn primary mini" type="submit">{m ? 'Guardar' : 'Crear medio'}</button></div>
    </form>
  );
}
