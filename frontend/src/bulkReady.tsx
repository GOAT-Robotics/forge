import React, { useMemo, useState } from 'react';
import { Sparkles, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import { api } from './api';
import { categories, suggestions } from './constants';
import type { Any } from './constants';
import { MANUAL, DATUMS, procFor, matFor } from './readiness';

type Scope = { id: string; label: string; ids: string[] };
const FIELDS: { key: string; label: string; options: (cat: string) => string[] }[] = [
  { key: 'material', label: 'Material', options: matFor },
  { key: 'process', label: 'Process', options: procFor },
  { key: 'finish', label: 'Finish & coating', options: () => (suggestions.finish || []).slice(0, 8) },
  { key: 'general_tolerance', label: 'General tolerance', options: () => ['ISO 2768-mK', 'ISO 2768-fH', 'ISO 2768-cL'] },
  { key: 'datums', label: 'Datums', options: () => DATUMS },
];
const blank = (v: unknown) => !String(v ?? '').trim();

/**
 * Make many parts production ready at once — all sheet metal, all machining, or the selection. Shows what is still
 * missing across the parts, fills it where it is empty (never overwriting what a part already has unless asked),
 * records the engineering verifications, accepts warnings with one reason, then signs off designs (only parts with
 * nothing open) and drawings (only current drawings). Each part reports what is left.
 */
export default function BulkReady({ revision, parts, selection, canDesign, canDrawing, close, done }: {
  revision: string; parts: Any[]; selection: string[]; canDesign: boolean; canDrawing: boolean; close: () => void; done: () => Promise<void>;
}) {
  const make = parts.filter(p => !p.excluded && p.category !== 'purchased');
  const ready = (p: Any) => !!p.reviewed && !!p.doc_reviewed;
  const scopes: Scope[] = [
    ...(selection.length ? [{ id: 'sel', label: `Selected (${selection.filter(id => make.some(p => p.id === id)).length})`, ids: selection.filter(id => make.some(p => p.id === id)) }] : []),
    { id: 'sheet_metal', label: `All ${categories.sheet_metal.toLowerCase()} (${make.filter(p => p.category === 'sheet_metal').length})`, ids: make.filter(p => p.category === 'sheet_metal').map(p => p.id) },
    { id: 'machining', label: `All ${categories.machining.toLowerCase()} (${make.filter(p => p.category === 'machining').length})`, ids: make.filter(p => p.category === 'machining').map(p => p.id) },
    { id: 'open', label: `Everything not ready (${make.filter(p => !ready(p)).length})`, ids: make.filter(p => !ready(p)).map(p => p.id) },
  ].filter(s => s.ids.length);
  const [scope, setScope] = useState(scopes[0]?.id || 'open');
  const ids = scopes.find(s => s.id === scope)?.ids || [];
  const list = useMemo(() => make.filter(p => ids.includes(p.id)), [ids.join()]);
  const cat = list.every(p => p.category === list[0]?.category) ? list[0]?.category : '';

  const [fill, setFill] = useState<Record<string, string>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [approveK, setApproveK] = useState(false);
  const [waive, setWaive] = useState('');
  const [signDesign, setSignDesign] = useState(canDesign);
  const [signDrawing, setSignDrawing] = useState(false);
  const [regen, setRegen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<Any | null>(null);

  const missing = (key: string) => list.filter(p => blank(p.spec?.[key])).length;
  const missingCheck = (k: string) => list.filter(p => String(p.spec?.manual_checks?.[k] || '').trim().length < 10).length;
  const kOpen = list.filter(p => (p.geometry?.bends || []).length && !p.spec?.k_factor_approved).length;
  const warnOpen = list.filter(p => (p.findings || []).some((f: Any) => f.severity === 'warning' && !f.waiver)).length;
  const designOpen = list.filter(p => !p.reviewed).length, drawingOpen = list.filter(p => !p.doc_reviewed).length;

  const apply = async () => {
    setBusy(true); setErr('');
    try {
      const body = {
        ids, overwrite, approve_k: approveK, waive_warnings: waive.trim(), design_review: signDesign, drawing_review: signDrawing, regenerate: regen,
        fill: Object.fromEntries(Object.entries(fill).filter(([, v]) => v.trim())),
        manual_checks: Object.fromEntries(Object.entries(checks).filter(([, v]) => v.trim())),
      };
      const r = await api(`/revisions/${revision}/parts/bulk-ready`, 'POST', body);
      setResult(r); await done();
    } catch (e: unknown) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (result) {
    const rows = (result.results || []).filter((r: Any) => !r.skipped);
    const nReady = rows.filter((r: Any) => r.ready).length;
    return (
      <Modal title="Production readiness" subtitle={`${nReady} of ${rows.length} parts production ready`} wide close={close}>
        <div className="br-result">
          {result.job && <div className="notice"><RefreshCw size={16} />Out-of-date drawings are being regenerated. When that finishes, open this again and tick “Mark drawings reviewed”.</div>}
          <table className="br-table">
            <thead><tr><th>Part</th><th>Design</th><th>Drawing</th><th>Still open</th></tr></thead>
            <tbody>{rows.map((r: Any) => (
              <tr key={r.id} className={r.ready ? 'ok' : ''}>
                <td title={r.name}><span className="br-name">{r.ready ? <CheckCircle2 size={14} className="green" /> : <AlertTriangle size={14} className="amber" />}{r.name}</span></td>
                <td>{r.design ? 'Signed off' : '—'}</td>
                <td>{r.drawing === 'reviewed' ? 'Reviewed' : r.drawing === 'current' ? 'To review' : 'Regenerate'}</td>
                <td className="br-open" title={(r.open || []).join('\n')}>{(() => { const o = (r.open || []).filter((x: string) => !x.endsWith('(warning)')); return o.length ? `${o.length} open: ${o.slice(0, 3).join(' · ')}${o.length > 3 ? ` +${o.length - 3} more` : ''}` : (r.open || []).length ? 'Warnings only' : ''; })()}</td>
              </tr>))}</tbody>
          </table>
          <div className="modal-actions"><button type="button" onClick={() => setResult(null)}>Back</button><button type="button" className="primary" onClick={close}>Done</button></div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Make production ready" subtitle="Fill what is missing for many parts at once — values a part already has are kept" wide close={close}>
      <div className="br">
        <div className="br-scope">{scopes.map(s => <button type="button" key={s.id} className={scope === s.id ? 'on' : ''} onClick={() => setScope(s.id)}>{s.label}</button>)}</div>
        <div className="br-summary"><b>{list.length} parts</b><span>{designOpen} without design sign-off · {drawingOpen} without drawing review</span></div>

        <section><h4>Specification</h4>
          {FIELDS.map(f => { const n = missing(f.key); return (
            <div className="br-row" key={f.key}>
              <span className="br-label">{f.label}<small className={n ? 'amber' : 'green'}>{n ? `${n} missing` : 'all set'}</small></span>
              <input list={'br-' + f.key} value={fill[f.key] || ''} placeholder={n ? `Value for the ${n} part${n === 1 ? '' : 's'} without one` : 'Leave empty to keep'} onChange={e => setFill(x => ({ ...x, [f.key]: e.target.value }))} />
              <datalist id={'br-' + f.key}>{f.options(cat || 'machining').map(o => <option key={o} value={o} />)}</datalist>
            </div>); })}
          <label className="check br-over"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />Also replace values parts already have</label>
        </section>

        <section><h4>Engineering verifications</h4>
          {Object.entries(MANUAL).map(([k, m]) => { const n = missingCheck(k); return (
            <div className="br-row" key={k}>
              <span className="br-label" title={m.help}>{m.title}<small className={n ? 'amber' : 'green'}>{n ? `${n} missing` : 'all set'}</small></span>
              <select value={checks[k] || ''} onChange={e => setChecks(x => ({ ...x, [k]: e.target.value }))}>
                <option value="">{n ? 'Choose the verification…' : 'Keep'}</option>{m.answers.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>); })}
        </section>

        {(kOpen > 0 || warnOpen > 0) && <section><h4>Checks</h4>
          {kOpen > 0 && <label className="check"><input type="checkbox" checked={approveK} onChange={e => setApproveK(e.target.checked)} />Approve the K-factor of {kOpen} bent part{kOpen === 1 ? '' : 's'} (confirmed with the press shop)</label>}
          {warnOpen > 0 && <div className="br-row"><span className="br-label">Accept warnings<small className="amber">{warnOpen} part{warnOpen === 1 ? '' : 's'}</small></span>
            <input value={waive} placeholder="Reason, e.g. reviewed with the vendor; acceptable for this design" onChange={e => setWaive(e.target.value)} /></div>}
        </section>}

        <section><h4>Sign-off</h4>
          <label className="check"><input type="checkbox" checked={signDesign} disabled={!canDesign} onChange={e => setSignDesign(e.target.checked)} />Sign off the design of every part with nothing open{!canDesign && ' (needs the design-review permission)'}</label>
          <label className="check"><input type="checkbox" checked={regen} onChange={e => setRegen(e.target.checked)} />Regenerate drawings that are out of date</label>
          <label className="check"><input type="checkbox" checked={signDrawing} disabled={!canDrawing} onChange={e => setSignDrawing(e.target.checked)} />Mark current drawings reviewed — I have checked the drawings of these parts{!canDrawing && ' (needs the drawing-review permission)'}</label>
        </section>
        {err && <div className="cfg-error">{err}</div>}
        <div className="modal-actions"><button type="button" onClick={close}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !list.length} onClick={apply}>{busy ? <span className="spinner" /> : <Sparkles size={15} />}Apply to {list.length} part{list.length === 1 ? '' : 's'}</button></div>
      </div>
    </Modal>
  );
}

