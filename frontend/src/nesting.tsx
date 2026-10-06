import React, { useEffect, useRef, useState } from 'react';
import { Grid2x2, Download, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import { Modal } from './components';
import { api, download } from './api';
import { Select } from './controls';
import type { Any } from './constants';

const SHEETS: [string, number, number][] = [['2500 × 1250', 2500, 1250], ['3000 × 1500', 3000, 1500], ['2440 × 1220 (8 × 4 ft)', 2440, 1220], ['2000 × 1000', 2000, 1000], ['4000 × 2000', 4000, 2000]];

/**
 * Nesting for a job order: the sheet-metal parts (count from the order) laid out on stock sheets per material and
 * thickness, true shape, small parts inside cut-outs. Runs in the background; result: sheet previews, use per
 * sheet, what did not fit, and a ZIP with one DXF per sheet, a combined DXF per material and a summary PDF.
 */
export default function NestingDialog({ jo, canRun, canDownload, close }: { jo: Any; canRun: boolean; canDownload: boolean; close: () => void }) {
  const [st, setSt] = useState<Any>(null);
  const [preset, setPreset] = useState('2500 × 1250');
  const [w, setW] = useState(2500), [h, setH] = useState(1250);
  const [gap, setGap] = useState(''), [margin, setMargin] = useState(10), [rotate, setRotate] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const timer = useRef(0);
  const load = () => api(`/job-orders/${jo.id}/nesting`).then((s: Any) => {
    setSt(s);
    if (s.options && !editing) { setW(s.options.sheet_w); setH(s.options.sheet_h); setGap(s.options.gap ? String(s.options.gap) : ''); setMargin(s.options.margin); setRotate(s.options.rotate); setPreset(SHEETS.find(x => x[1] === s.options.sheet_w && x[2] === s.options.sheet_h)?.[0] || 'custom'); }
    window.clearTimeout(timer.current);
    if (s.state === 'running') timer.current = window.setTimeout(load, 1500);
  }).catch(e => setErr(e.message));
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, [jo.id]);
  const start = async () => {
    setErr(''); setEditing(false);
    try { setSt(await api(`/job-orders/${jo.id}/nesting`, 'POST', { sheet_w: w, sheet_h: h, gap: Number(gap) || 0, margin, rotate })); window.setTimeout(load, 800); }
    catch (e: unknown) { setErr((e as Error).message); }
  };
  const res = st?.state === 'ready' ? st.result : null;
  const showForm = !st || st.state === 'missing' || st.state === 'failed' || editing;
  return (
    <Modal title="Nesting" subtitle={`JO-${String(jo.number).padStart(3, '0')} · sheet-metal parts on stock sheets, per material and thickness`} wide close={close}>
      <div className="nest">
        {showForm && canRun && <div className="nest-form">
          <label>Sheet<Select value={preset} onChange={v => { setPreset(v); const s = SHEETS.find(x => x[0] === v); if (s) { setW(s[1]); setH(s[2]); } }} options={[...SHEETS.map(s => ({ value: s[0], label: s[0] + ' mm' })), { value: 'custom', label: 'Custom size' }]} /></label>
          {preset === 'custom' && <><label>Width (mm)<input type="number" min={200} max={12000} value={w} onChange={e => setW(Number(e.target.value))} /></label>
            <label>Height (mm)<input type="number" min={200} max={6000} value={h} onChange={e => setH(Number(e.target.value))} /></label></>}
          <label>Part spacing (mm)<input type="number" min={0} max={50} step={.5} value={gap} placeholder="Auto: 2 × t, min 3" onChange={e => setGap(e.target.value)} /></label>
          <label>Sheet margin (mm)<input type="number" min={0} max={200} value={margin} onChange={e => setMargin(Number(e.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={rotate} onChange={e => setRotate(e.target.checked)} />Turn parts (0 / 90 / 180 / 270°) — off for brushed or grained sheet</label>
          <div className="nest-actions">{editing && <button type="button" onClick={() => setEditing(false)}>Back to result</button>}<button type="button" className="primary" onClick={start}><Play size={15} />Nest parts</button></div>
        </div>}
        {err && <div className="cfg-error">{err}</div>}
        {st?.state === 'failed' && <div className="cfg-error">Nesting failed: {st.error}</div>}
        {st?.state === 'running' && <div className="nest-running"><span className="spinner" /><span>Nesting… {st.progress || 0}%</span><progress max={100} value={st.progress || 0} /></div>}
        {(st?.missing || []).length > 0 && <div className="notice"><AlertTriangle size={16} />{st.missing.length} part{st.missing.length === 1 ? ' has' : 's have'} no flat pattern yet and {st.missing.length === 1 ? 'is' : 'are'} not nested: {st.missing.slice(0, 6).map((m: Any) => m.label).join(', ')}{st.missing.length > 6 ? '…' : ''}. Generate their documents first.</div>}
        {res && !editing && <>
          <div className="nest-head">
            <span><b>{res.sheets} sheet{res.sheets === 1 ? '' : 's'}</b> · {st.options.sheet_w} × {st.options.sheet_h} mm · by {st.by}</span>
            <span className="grow" />
            {canRun && <button type="button" onClick={() => setEditing(true)}><RefreshCw size={14} />Change and re-nest</button>}
            {canDownload && <button type="button" className="primary" onClick={() => download(`/job-orders/${jo.id}/nesting.zip`, `JO-${String(jo.number).padStart(3, '0')}-nesting.zip`).catch(e => setErr(e.message))}><Download size={15} />DXF + PDF (ZIP)</button>}
          </div>
          {res.groups.map((g: Any) => (
            <section key={g.material + g.thickness} className="nest-group">
              <header><b>{g.material || 'Material not set'} · {g.thickness} mm</b><small>{g.sheets.length} sheet{g.sheets.length === 1 ? '' : 's'} · {g.placed}/{g.parts} parts · spacing {g.gap} mm · average use {Math.round(g.utilization)} %</small></header>
              {g.unplaced.length > 0 && <div className="cfg-error">Not placed: {Object.entries(g.unplaced.reduce((m: Any, u: Any) => ({ ...m, [`${u.label} (${u.reason})`]: (m[`${u.label} (${u.reason})`] || 0) + 1 }), {})).map(([k, n]) => `${n} × ${k}`).join(' · ')}</div>}
              <div className="nest-sheets">{g.sheets.map((s: Any) => (
                <figure key={s.n} className="nest-sheet">
                  <svg viewBox={`0 0 ${g.sheet[0]} ${g.sheet[1]}`} preserveAspectRatio="xMidYMid meet">
                    <rect x={0} y={0} width={g.sheet[0]} height={g.sheet[1]} className="nest-stock" />
                    {s.remnant && <line x1={s.length} y1={0} x2={s.length} y2={g.sheet[1]} className="nest-cutline" />}
                    <g transform={`translate(0 ${g.sheet[1]}) scale(1 -1)`}>{s.preview.map((p: Any, i: number) => <path key={i} d={p.d} className="nest-part"><title>{p.label}</title></path>)}</g>
                  </svg>
                  <figcaption><b>Sheet {s.n}</b> · {Object.values(s.parts).reduce((a: number, b: Any) => a + Number(b), 0) as number} parts · {s.utilization} % of the sheet{s.length ? <> · uses {Math.round(s.length)} mm ({Math.round(s.dense)} % dense)</> : null}{s.remnant ? <> · remnant {Math.round(s.remnant[0])} × {Math.round(s.remnant[1])}</> : null}</figcaption>
                </figure>
              ))}</div>
            </section>
          ))}
          <p className="muted nest-note"><Grid2x2 size={13} /> True-shape nesting: several part orders and turns are tried, the layout with the fewest sheets and the shortest used length (largest remnant) wins. Lead-ins, common-line cutting and grain are for your laser CAM; check spacing against your machine.</p>
        </>}
        {!canRun && !res && st?.state !== 'running' && <p className="muted">No nesting yet.</p>}
      </div>
    </Modal>
  );
}
