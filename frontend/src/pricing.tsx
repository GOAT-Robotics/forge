import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Calculator, ChevronDown, ChevronRight, Copy, Download, IndianRupee, Plus, RefreshCw, Save, Scale, Store, Trash2 } from 'lucide-react';
import { api, download } from './api';
import { Badge, Modal, ask } from './components';
import { Select } from './controls';
import type { Any } from './constants';
import { PageHeader, Empty } from './shell';

type Ctx = { busy: boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void };

export function money(v: number | null | undefined, currency = 'INR', digits = 0) {
  if (v == null || !isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); }
  catch { return `${currency} ${v.toFixed(digits)}`; }
}

// ============================================================================ estimate views
function Breakdown({ e }: { e: Any }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (e.error) return <div className="notice warn"><AlertTriangle size={16} />{e.error}</div>;
  return (
    <div className="est-breakdown">
      <table className="v-table compact est-sum">
        <tbody>
          {e.by_process.map((x: Any) => <tr key={x.process}><td>{x.process}</td><td className="tabular right">{money(x.amount, e.currency)}</td></tr>)}
          <tr className="sub"><td>Subtotal</td><td className="tabular right">{money(e.subtotal, e.currency)}</td></tr>
          {e.margin > 0 && <tr><td>Vendor margin {e.margin_pct}%</td><td className="tabular right">{money(e.margin, e.currency)}</td></tr>}
          <tr><td>GST {e.gst_pct}%</td><td className="tabular right">{money(e.gst, e.currency)}</td></tr>
          <tr className="total"><td>Estimated total</td><td className="tabular right">{money(e.total, e.currency)}</td></tr>
        </tbody>
      </table>
      <div className="est-parts">
        {e.parts.map((p: Any) => (
          <div key={p.part_id} className="est-part">
            <button type="button" className="est-part-head" onClick={() => setOpen({ ...open, [p.part_id]: !open[p.part_id] })}>
              {open[p.part_id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span><b>{p.part}</b><small>{p.material} · {p.qty} pcs · {money(p.unit_cost, e.currency, 2)} each{p.setup ? ` + ${money(p.setup, e.currency)} setup` : ''}</small></span>
              <b className="tabular">{money(p.total, e.currency)}</b>
            </button>
            {open[p.part_id] && <table className="v-table compact"><thead><tr><th>Process</th><th>Basis</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr></thead>
              <tbody>{p.lines.map((l: Any, i: number) => <tr key={i}><td>{l.process}{l.per_job && <small>per job</small>}</td><td>{l.basis}{l.note && <small>{l.note}</small>}</td><td className="tabular right">{l.qty} {l.unit}</td><td className="tabular right">{money(l.rate, e.currency, 2)}</td><td className="tabular right">{money(l.amount, e.currency, 2)}</td></tr>)}</tbody></table>}
          </div>
        ))}
        {e.welds.length > 0 && <div className="est-part"><div className="est-part-head static"><span><b>Welding</b><small>{e.welds.length} weld{e.welds.length === 1 ? '' : 's'}{e.weld_setup ? ` + ${money(e.weld_setup, e.currency)} setup` : ''}</small></span><b className="tabular">{money(e.welds.reduce((n: number, w: Any) => n + w.total, 0) + e.weld_setup, e.currency)}</b></div>
          <table className="v-table compact"><tbody>{e.welds.map((w: Any) => <tr key={w.weld}><td><b>{w.weld}</b><small>{w.parts}</small></td><td>{w.process} · {w.basis}</td><td className="tabular right">× {w.qty}</td><td className="tabular right">{money(w.total, e.currency)}</td></tr>)}</tbody></table></div>}
      </div>
      {e.warnings.length > 0 && <details className="est-warn"><summary><AlertTriangle size={14} />{e.warnings.length} item{e.warnings.length === 1 ? '' : 's'} to check</summary><ul>{e.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></details>}
      <small className="muted">Estimate from the {e.rate_card} rate card, for planning — not a vendor quotation. Bought-in parts are not priced.</small>
    </div>
  );
}

/** Job-order dialog: compare vendors live and choose one. `body` is the job-order request without the vendor. */
export function EstimatePanel({ pid, body, vendorId, setVendorId }: { pid: string; body: Any | null; vendorId: string; setVendorId: (v: string) => void }) {
  const [pricing, setPricing] = useState<Any | null | false>(null);
  const [est, setEst] = useState<Any[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => { api('/pricing').then(setPricing).catch(() => setPricing(false)); }, []);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!pricing || !body || !pid) return;
    const n = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      api(`/projects/${pid}/job-orders/estimate`, 'POST', { ...body, title: body.title || 'Estimate', vendor_ids: ['', ...pricing.vendors.map((v: Any) => v.id)] })
        .then(r => { if (n === seq.current) { setEst(r.estimates); setErr(''); } })
        .catch(e => { if (n === seq.current) setErr(e.message); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 450);
    return () => window.clearTimeout(t);
  }, [key, pid, !!pricing]);
  if (pricing === false) return null;
  const cheapest = est?.length ? Math.min(...est.map(e => e.total)) : null;
  const chosen = est?.find(e => (e.vendor_id || '') === vendorId) || est?.[0];
  return (
    <div className="jo-estimate">
      <div className="jo-scope-head"><b><IndianRupee size={14} />Vendor &amp; cost estimate</b><small>{busy ? 'Pricing…' : pricing?.vendors?.length ? 'Choose who makes it' : 'Add vendors under Pricing to compare'}</small></div>
      {err && <p className="muted">{err}</p>}
      {est && <div className="est-vendors">{est.map(e => (
        <label key={e.vendor_id || 'base'} className={'est-vendor' + ((e.vendor_id || '') === vendorId ? ' on' : '')}>
          <input type="radio" name="vendor" checked={(e.vendor_id || '') === vendorId} onChange={() => setVendorId(e.vendor_id || '')} />
          <span><b>{e.vendor}</b><small>{e.rate_card}{e.warnings.length ? ` · ${e.warnings.length} to check` : ''}</small></span>
          {e.total === cheapest && est.length > 1 && <Badge kind="success">Lowest</Badge>}
          <b className="tabular">{money(e.total, e.currency)}</b>
        </label>
      ))}</div>}
      {chosen && <Breakdown e={chosen} />}
    </div>
  );
}

/** Job-order page: the kept estimate, change vendor, re-price, compare. */
export function EstimateCard({ jo, canManage, reload, ctx }: { jo: Any; canManage: boolean; reload: () => void; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [vendors, setVendors] = useState<Any[]>([]);
  const [cmp, setCmp] = useState<Any[] | null>(null);
  useEffect(() => { if (canManage) api('/pricing').then(p => setVendors(p.vendors)).catch(() => {}); }, [canManage]);
  if (!('estimate' in jo)) return null;
  const e = jo.estimate;
  const run = (vendor_id?: string) => ctx.action(async () => { await api(`/job-orders/${jo.id}/estimate`, 'POST', vendor_id === undefined ? {} : { vendor_id }); setCmp(null); reload(); });
  return (
    <div className="v-card est-card">
      <header>
        <h3><IndianRupee size={15} />Cost estimate {e && !e.error && <span className="est-total">{money(e.total, e.currency)}</span>}</h3>
        <div className="flex">
          {canManage && <Select size="sm" value={jo.vendor_id || ''} onChange={v => run(v)} options={[{ value: '', label: 'Base rates' }, ...vendors.map(v => ({ value: v.id, label: v.name }))]} />}
          {canManage && <button type="button" onClick={() => run()} title="Price again with the current rate card"><RefreshCw size={14} />Re-price</button>}
          {canManage && <button type="button" onClick={() => api(`/job-orders/${jo.id}/estimate/compare`).then(setCmp).catch(err => ctx.notify(err.message))}><Scale size={14} />Compare vendors</button>}
          {e && <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'Hide breakdown' : 'Breakdown'}</button>}
        </div>
      </header>
      {!e ? <p className="muted">Not priced yet{canManage ? ' — choose a vendor or Re-price.' : '.'}</p>
        : <p className="muted">{jo.vendor_name || 'Base rates'} · {e.pieces} pieces · priced {new Date(e.computed).toLocaleDateString()} from “{e.rate_card}”{e.warnings?.length ? ` · ${e.warnings.length} item(s) to check` : ''}</p>}
      {cmp && <table className="v-table compact"><thead><tr><th>Vendor</th><th className="right">Subtotal</th><th className="right">Total incl. GST</th><th /></tr></thead>
        <tbody>{cmp.map((c, i) => <tr key={c.vendor_id || 'base'}><td><b>{c.vendor}</b>{i === 0 && <Badge kind="success">Lowest</Badge>}{c.warnings ? <small>{c.warnings} to check</small> : null}</td><td className="tabular right">{money(c.subtotal)}</td><td className="tabular right">{money(c.total)}</td>
          <td className="right">{canManage && (c.vendor_id || '') !== (jo.vendor_id || '') && <button type="button" className="link" onClick={() => run(c.vendor_id)}>Use</button>}</td></tr>)}</tbody></table>}
      {open && e && <Breakdown e={e} />}
    </div>
  );
}

// ============================================================================ pricing page
type Col = [string, string, string];
const COLS: Record<string, Col[]> = {
  materials: [['name', 'Material', 'text'], ['group', 'Group', 'select:ms,gi,ss,al,brass,plastic'], ['form', 'Form', 'select:sheet,plate,bar'], ['density', 'Density kg/m³', 'num'], ['price_kg', '₹ / kg', 'num'], ['match', 'Words that identify it in the part spec', 'text']],
  laser: [['thickness', 'Thickness up to (mm)', 'num'], ['per_m', '₹ / m of cut', 'num'], ['pierce', '₹ / pierce', 'num']],
  bending: [['thickness', 'Thickness up to (mm)', 'num'], ['per_stroke', '₹ / stroke', 'num']],
  drilling: [['diameter', 'Hole Ø up to (mm)', 'num'], ['per_hole', '₹ / hole', 'num']],
  tapping: [['diameter', 'Thread Ø up to (mm)', 'num'], ['per_hole', '₹ / hole', 'num']],
  hardware: [['type', 'Type', 'select:nut,flush_nut,stud,standoff,rivnut,weld_nut'], ['thread', 'Threads (M3-M5, M6 or *)', 'text'], ['price', '₹ / piece', 'num']],
  welding: [['process', 'Process (MIG/MAG, TIG, Spot, *)', 'text'], ['group', 'Material', 'select:*,ms,gi,ss,al'], ['per_m', '₹ / m of weld', 'num'], ['per_tack', '₹ / tack', 'num']],
  finishes: [['name', 'Finish', 'text'], ['basis', 'Charged per', 'select:sqft,kg,part'], ['rate', 'Rate', 'num'], ['per_part', '+ ₹ / part', 'num'], ['min_part', 'Min ₹ / part', 'num'], ['setup', 'Setup ₹ / job & colour', 'num'], ['match', 'Words that identify it (finish / paint)', 'text']],
  colours: [['code', 'Colour code (RAL … or *)', 'text'], ['name', 'Name', 'text'], ['extra_sqft', 'Extra ₹ / sq ft', 'num']],
  qty_breaks: [['min_qty', 'From quantity', 'num'], ['discount_pct', 'Labour discount %', 'num']],
};
const TABS: [string, string, string[]][] = [
  ['materials', 'Materials', ['materials']], ['cutting', 'Laser cutting', ['laser']], ['forming', 'Bending & rolling', ['bending']],
  ['holes', 'Machining & holes', ['drilling', 'tapping']], ['hardware', 'Hardware', ['hardware']], ['welding', 'Welding', ['welding']],
  ['finish', 'Finishes & colours', ['finishes', 'colours']], ['overheads', 'Quantity & overheads', ['qty_breaks']],
];
const SECTION_TITLES: Record<string, string> = { materials: 'Material prices', laser: 'Laser cutting (mild steel; other materials use the multipliers below)', bending: 'Press brake, per stroke', drilling: 'Drilling (machined parts)', tapping: 'Tapping', hardware: 'Hardware price', welding: 'Welding', finishes: 'Finishes', colours: 'Powder / paint colour extras', qty_breaks: 'Quantity breaks' };

function NumField({ label, value, onChange, disabled, hint }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; hint?: string }) {
  return <label className="rc-num"><span>{label}</span><input type="number" step="any" value={value ?? 0} disabled={disabled} onChange={e => onChange(Number(e.target.value))} />{hint && <small>{hint}</small>}</label>;
}

function RowsEditor({ sec, rows, set, ro }: { sec: string; rows: Any[]; set: (rows: Any[]) => void; ro: boolean }) {
  const cols = COLS[sec];
  const blank = () => Object.fromEntries(cols.map(([k, , t]) => [k, t === 'num' ? 0 : t.startsWith('select:') ? t.slice(7).split(',')[0] : '']));
  return (
    <div className="rc-section">
      <h4>{SECTION_TITLES[sec]}</h4>
      <div className="rc-table-wrap"><table className="v-table compact rc-table">
        <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}{!ro && <th />}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>{cols.map(([k, , t]) => (
            <td key={k} className={t === 'num' ? 'num' : t === 'text' && k === 'match' ? 'wide' : ''}>
              {t.startsWith('select:') ? <select value={r[k] ?? ''} disabled={ro} onChange={e => set(rows.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))}>{t.slice(7).split(',').map(o => <option key={o} value={o}>{o}</option>)}</select>
                : <input type={t === 'num' ? 'number' : 'text'} step="any" value={r[k] ?? ''} disabled={ro} onChange={e => set(rows.map((x, j) => j === i ? { ...x, [k]: t === 'num' ? Number(e.target.value) : e.target.value } : x))} />}
            </td>))}
            {!ro && <td><button type="button" className="icon" title="Remove row" onClick={() => set(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>}
          </tr>))}</tbody>
      </table></div>
      {!ro && <button type="button" className="link" onClick={() => set([...rows, { ...blank(), ...(sec === 'materials' ? { key: 'm' + Date.now().toString(36), density: 7850 } : {}) }])}><Plus size={13} />Add row</button>}
    </div>
  );
}

function CardEditor({ card, ro, onSaved, ctx, vendor }: { card: Any; ro: boolean; onSaved: (c: Any) => void; ctx: Ctx; vendor?: Any }) {
  const [d, setD] = useState<Any>(card.data);
  const [name, setName] = useState(card.name);
  const [tab, setTab] = useState('materials');
  useEffect(() => { setD(card.data); setName(card.name); }, [card.id, card.updated]);
  const dirty = JSON.stringify(d) !== JSON.stringify(card.data) || name !== card.name;
  const set = (k: string, v: Any) => setD({ ...d, [k]: v });
  const sub = (k: string, f: string, v: number) => setD({ ...d, [k]: { ...d[k], [f]: v } });
  const groups = ['ms', 'gi', 'ss', 'al', 'brass', 'plastic'];
  return (
    <div className="rc-editor">
      <div className="rc-head">
        {vendor ? <h3>{vendor.name}<small>{vendor.services?.join(' · ') || 'No services listed'}</small></h3>
          : <input className="rc-name" value={name} disabled={ro} onChange={e => setName(e.target.value)} />}
        <div className="flex">
          <button type="button" onClick={() => download(`/rate-cards/${card.id}/export.csv`, `${card.name}.csv`).catch(e => ctx.notify(e.message))}><Download size={14} />CSV</button>
          {!ro && <button type="button" className="primary" disabled={!dirty || ctx.busy} onClick={() => ctx.action(async () => { onSaved(await api('/rate-cards/' + card.id, 'PUT', { name, data: d })); ctx.notify('Rates saved'); })}><Save size={14} />Save rates</button>}
        </div>
      </div>
      <div className="rc-meta">
        <label>Region<input value={d.region} disabled={ro} onChange={e => set('region', e.target.value)} /></label>
        <label>As of<input value={d.as_of} disabled={ro} onChange={e => set('as_of', e.target.value)} /></label>
        <label>Currency<input value={d.currency} disabled={ro} onChange={e => set('currency', e.target.value.toUpperCase())} maxLength={3} /></label>
        <label className="wide">Notes<input value={d.notes} disabled={ro} onChange={e => set('notes', e.target.value)} /></label>
      </div>
      <div className="v-segment rc-tabs">{TABS.map(([k, l]) => <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {TABS.find(t => t[0] === tab)![2].map(sec => <RowsEditor key={sec} sec={sec} rows={d[sec]} ro={ro} set={rows => set(sec, rows)} />)}
      {tab === 'materials' && <div className="rc-grid">
        <label className="rc-num"><span>Default sheet material</span><select value={d.defaults.sheet} disabled={ro} onChange={e => set('defaults', { ...d.defaults, sheet: e.target.value })}>{d.materials.map((m: Any) => <option key={m.key} value={m.key}>{m.name}</option>)}</select><small>when the part spec names none on this card</small></label>
        <label className="rc-num"><span>Default bar / block material</span><select value={d.defaults.bar} disabled={ro} onChange={e => set('defaults', { ...d.defaults, bar: e.target.value })}>{d.materials.map((m: Any) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></label>
        <NumField label="Sheet scrap / nesting allowance %" value={d.overheads.scrap_pct} disabled={ro} onChange={v => sub('overheads', 'scrap_pct', v)} />
        <NumField label="Bar stock allowance per side (mm)" value={d.machining.stock_mm} disabled={ro} onChange={v => sub('machining', 'stock_mm', v)} />
      </div>}
      {tab === 'cutting' && <div className="rc-grid">
        {groups.map(g => <NumField key={g} label={`Multiplier · ${g.toUpperCase()}`} value={d.laser_group[g]} disabled={ro} onChange={v => sub('laser_group', g, v)} />)}
        <NumField label="Minimum laser charge per part (₹)" value={d.laser_min_part} disabled={ro} onChange={v => set('laser_min_part', v)} />
        <NumField label="Deburring per part (₹)" value={d.deburr_per_part} disabled={ro} onChange={v => set('deburr_per_part', v)} />
      </div>}
      {tab === 'forming' && <div className="rc-grid">
        <NumField label="Bend setup per part number, per job (₹)" value={d.bend_setup} disabled={ro} onChange={v => set('bend_setup', v)} />
        <NumField label="Long bend from (mm)" value={d.bend_long_mm} disabled={ro} onChange={v => set('bend_long_mm', v)} />
        <NumField label="Long bend factor (×)" value={d.bend_long_factor} disabled={ro} onChange={v => set('bend_long_factor', v)} />
        <NumField label="Rolling ₹ / kg" value={d.rolling.per_kg} disabled={ro} onChange={v => sub('rolling', 'per_kg', v)} />
        <NumField label="Rolling minimum per part (₹)" value={d.rolling.min_part} disabled={ro} onChange={v => sub('rolling', 'min_part', v)} />
        <NumField label="Rolling setup per job (₹)" value={d.rolling.setup} disabled={ro} onChange={v => sub('rolling', 'setup', v)} />
      </div>}
      {tab === 'holes' && <div className="rc-grid">
        <NumField label="Machining ₹ / hour" value={d.machining.per_hour} disabled={ro} onChange={v => sub('machining', 'per_hour', v)} />
        <NumField label="Setup hours per part number" value={d.machining.setup_hours} disabled={ro} onChange={v => sub('machining', 'setup_hours', v)} />
        <NumField label="Handling minutes per part" value={d.machining.handling_min} disabled={ro} onChange={v => sub('machining', 'handling_min', v)} />
        <NumField label="Minutes per hole / feature" value={d.machining.per_feature_min} disabled={ro} onChange={v => sub('machining', 'per_feature_min', v)} />
        {groups.map(g => <NumField key={g} label={`Removal rate cm³/min · ${g.toUpperCase()}`} value={d.machining.mrr[g]} disabled={ro} onChange={v => set('machining', { ...d.machining, mrr: { ...d.machining.mrr, [g]: v } })} />)}
        <NumField label="Countersink ₹ / hole" value={d.countersink_per_hole} disabled={ro} onChange={v => set('countersink_per_hole', v)} />
        <NumField label="Tapping setup per job (₹)" value={d.tap_setup} disabled={ro} onChange={v => set('tap_setup', v)} />
      </div>}
      {tab === 'hardware' && <div className="rc-grid">
        <NumField label="Press-in insertion ₹ / pc" value={d.insertion.press} disabled={ro} onChange={v => sub('insertion', 'press', v)} hint="nuts, studs, standoffs" />
        <NumField label="Rivnut setting ₹ / pc" value={d.insertion.rivnut} disabled={ro} onChange={v => sub('insertion', 'rivnut', v)} />
        <NumField label="Weld nut projection welding ₹ / pc" value={d.insertion.weld_nut} disabled={ro} onChange={v => sub('insertion', 'weld_nut', v)} />
        <NumField label="Hardware setup per job (₹)" value={d.hardware_setup} disabled={ro} onChange={v => set('hardware_setup', v)} />
      </div>}
      {tab === 'welding' && <div className="rc-grid">
        <NumField label="Grinding / dressing ₹ / m" value={d.weld_grind_per_m} disabled={ro} onChange={v => set('weld_grind_per_m', v)} hint="welds marked Ground" />
        <NumField label="Welding setup per job (₹)" value={d.weld_setup} disabled={ro} onChange={v => set('weld_setup', v)} />
        <NumField label="Minimum per weld (₹)" value={d.weld_min} disabled={ro} onChange={v => set('weld_min', v)} />
      </div>}
      {tab === 'overheads' && <div className="rc-grid">
        <NumField label="Vendor margin %" value={d.overheads.margin_pct} disabled={ro} onChange={v => sub('overheads', 'margin_pct', v)} />
        <NumField label="GST %" value={d.overheads.gst_pct} disabled={ro} onChange={v => sub('overheads', 'gst_pct', v)} />
        <NumField label="Minimum order value (₹)" value={d.overheads.min_job} disabled={ro} onChange={v => sub('overheads', 'min_job', v)} />
        <NumField label="Transport per job (₹)" value={d.overheads.transport} disabled={ro} onChange={v => sub('overheads', 'transport', v)} />
      </div>}
    </div>
  );
}

export function PricingPage({ ctx }: { ctx: Ctx }) {
  const [data, setData] = useState<Any>(null);
  const [sel, setSel] = useState<{ kind: 'vendor' | 'base'; id: string } | null>(null);
  const [card, setCard] = useState<Any>(null);
  const [form, setForm] = useState<Any>(null);
  const load = () => api('/pricing').then(d => { setData(d); return d; }).catch(e => { ctx.notify(e.message); setData(false); });
  useEffect(() => { load().then(d => { if (d && !sel) setSel(d.vendors[0] ? { kind: 'vendor', id: d.vendors[0].id } : d.base_cards[0] ? { kind: 'base', id: d.base_cards[0].id } : null); }); }, []);
  const vendor = sel?.kind === 'vendor' ? data?.vendors.find((v: Any) => v.id === sel.id) : null;
  const cardId = vendor ? vendor.rate_card_id : sel?.kind === 'base' ? sel.id : '';
  useEffect(() => { setCard(null); if (cardId) api('/rate-cards/' + cardId).then(setCard).catch(e => ctx.notify(e.message)); }, [cardId]);
  if (data === false) return <div className="v-page"><PageHeader title="Pricing" /><Empty icon={<IndianRupee />} title="Pricing is for job-order planners">Ask an administrator for the Production planner role.</Empty></div>;
  if (!data) return <div className="v-page"><PageHeader title="Pricing" /><p className="muted padded">Loading…</p></div>;
  const ro = !data.can_manage;
  const saveVendor = () => ctx.action(async () => {
    const { id, rate_card, rate_card_id, created, updated, author, archived, ...body } = form;
    const r = form.id ? await api('/vendors/' + form.id, 'PUT', { ...body, copy_from: '' }) : await api('/vendors', 'POST', body);
    setForm(null); await load(); setSel({ kind: 'vendor', id: r.id }); ctx.notify(form.id ? 'Vendor saved' : 'Vendor added with a copy of the base sheet');
  });
  return (
    <div className="v-page">
      <PageHeader title="Vendors & pricing" description="Rate cards per vendor. Job orders are priced with the chosen vendor's rates; base sheets are reference rates you copy for a new vendor."
        actions={!ro && <button className="primary" onClick={() => setForm({ name: '', services: [], contact: '', phone: '', email: '', gstin: '', address: '', notes: '', copy_from: data.base_cards[0]?.id || '' })}><Plus size={15} />Add vendor</button>} />
      <div className="pricing-layout">
        <aside className="pricing-list">
          <h4>Vendors</h4>
          {!data.vendors.length && <p className="muted">No vendors yet. Add one: it starts with a copy of the base sheet.</p>}
          {data.vendors.map((v: Any) => (
            <button key={v.id} type="button" className={'pricing-item' + (sel?.id === v.id ? ' on' : '')} onClick={() => setSel({ kind: 'vendor', id: v.id })}>
              <Store size={15} /><span><b>{v.name}</b><small>{v.services.slice(0, 3).join(' · ') || v.contact || '—'}</small></span>
            </button>))}
          <h4>Base sheets</h4>
          {data.base_cards.map((c: Any) => (
            <button key={c.id} type="button" className={'pricing-item' + (sel?.id === c.id ? ' on' : '')} onClick={() => setSel({ kind: 'base', id: c.id })}>
              <Calculator size={15} /><span><b>{c.name}</b><small>updated {new Date(c.updated).toLocaleDateString()}</small></span>
            </button>))}
        </aside>
        <section className="pricing-main">
          {vendor && <div className="v-card vendor-card">
            <div><b>{vendor.contact || 'No contact'}</b><small>{[vendor.phone, vendor.email, vendor.gstin && 'GSTIN ' + vendor.gstin].filter(Boolean).join(' · ')}</small>{vendor.address && <small>{vendor.address}</small>}</div>
            {!ro && <div className="flex">
              <button type="button" onClick={() => setForm({ ...vendor })}>Edit vendor</button>
              <Select size="sm" value="" placeholder="Reset rates from…" onChange={id => ctx.action(async () => {
                if (await ask({ title: 'Replace these rates?', message: `${vendor.name}'s rates are replaced by a copy of the chosen base sheet.`, confirm: 'Replace rates', danger: true }) === null) return;
                await api(`/rate-cards/${id}/copy`, 'POST', { vendor_id: vendor.id }); await load(); setCard(await api('/rate-cards/' + vendor.rate_card_id));
              })} options={data.base_cards.map((c: Any) => ({ value: c.id, label: c.name }))} />
              <button type="button" className="danger-ghost" onClick={() => ctx.action(async () => {
                if (await ask({ title: `Remove ${vendor.name}?`, message: 'Job orders keep their estimate; the vendor is no longer offered.', confirm: 'Remove vendor', danger: true }) === null) return;
                await api('/vendors/' + vendor.id, 'DELETE'); setSel(null); await load();
              })}><Trash2 size={14} />Remove</button>
            </div>}
          </div>}
          {sel?.kind === 'base' && !ro && <div className="flex end pricing-base-actions">
            <button type="button" onClick={() => ctx.action(async () => {
              const name = await ask({ title: 'Copy base sheet', message: 'A new base sheet starts as a copy; edit it for another city or a new price list.', confirm: 'Copy', input: { label: 'Name', initial: `${card?.name || 'Base sheet'} (copy)`, required: true } });
              if (!name) return; const c = await api(`/rate-cards/${sel.id}/copy`, 'POST', { name }); await load(); setSel({ kind: 'base', id: c.id });
            })}><Copy size={14} />Copy sheet</button>
            {data.base_cards.length > 1 && <button type="button" className="danger-ghost" onClick={() => ctx.action(async () => { await api('/rate-cards/' + sel.id, 'DELETE'); setSel(null); await load(); })}><Trash2 size={14} />Remove sheet</button>}
          </div>}
          {card ? <CardEditor card={card} ro={ro} vendor={vendor} ctx={ctx} onSaved={c => { setCard(c); load(); }} /> : sel ? <p className="muted padded">Loading rates…</p> : <Empty icon={<IndianRupee />} title="Choose a vendor or a base sheet" />}
        </section>
      </div>
      {form && <Modal title={form.id ? 'Edit vendor' : 'Add vendor'} subtitle={form.id ? undefined : 'The vendor gets its own rate card, copied from a base sheet; edit it to their quote.'} close={() => setForm(null)}>
        <form onSubmit={e => { e.preventDefault(); saveVendor(); }}>
          <div className="form-grid">
            <label>Name<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Kovai Laser Works" /></label>
            <label>Contact person<input value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></label>
            <label>Phone<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
            <label>Email<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
            <label>GSTIN<input value={form.gstin} maxLength={15} onChange={e => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></label>
            {!form.id && <label>Start rates from<Select value={form.copy_from} onChange={v => setForm({ ...form, copy_from: v })} options={data.base_cards.map((c: Any) => ({ value: c.id, label: c.name }))} /></label>}
          </div>
          <label>Address<textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></label>
          <div className="svc-chips"><span>Services</span>{data.services.map((s: string) => <button type="button" key={s} className={form.services.includes(s) ? 'on' : ''} onClick={() => setForm({ ...form, services: form.services.includes(s) ? form.services.filter((x: string) => x !== s) : [...form.services, s] })}>{s}</button>)}</div>
          <label>Notes<textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Payment terms, lead times, minimums…" /></label>
          <div className="modal-actions"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary" disabled={ctx.busy}>{form.id ? 'Save vendor' : 'Add vendor'}</button></div>
        </form>
      </Modal>}
    </div>
  );
}

// ============================================================================ part cost (inspector tab)
const SPLIT_COLORS = ['#2F5BFF', '#E8452C', '#F2A93B', '#2BA87A', '#8E5BD9', '#1FA2C4', '#C9567E', '#7B8794', '#B98B2E', '#4C6A92'];

/** Approximate cost of making one part, split by process; quantity, vendor and the quantity curve are live. */
export function PartCost({ part }: { part: Any }) {
  const [qty, setQty] = useState<number>(Math.max(1, part.quantity || 1));
  const [qtyText, setQtyText] = useState(String(Math.max(1, part.quantity || 1)));
  const [vendorId, setVendorId] = useState('');
  const [vendors, setVendors] = useState<Any[]>([]);
  const [e, setE] = useState<Any | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(false);
  const seq = useRef(0);
  useEffect(() => { api('/pricing').then(p => setVendors(p.vendors || [])).catch(() => {}); }, []);
  useEffect(() => { const q = Math.max(1, part.quantity || 1); setQty(q); setQtyText(String(q)); }, [part.id]);
  const key = JSON.stringify([part.id, qty, vendorId, part.category, part.spec, part.drawing_options?.bend_process, part.assets?.length]);
  useEffect(() => {
    const n = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      api(`/parts/${part.id}/cost?qty=${qty}&vendor_id=${encodeURIComponent(vendorId)}&compare=1`)
        .then(r => { if (n === seq.current) { setE(r); setErr(''); } })
        .catch(x => { if (n === seq.current) setErr(x.message); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 250);
    return () => window.clearTimeout(t);
  }, [key]);
  const commitQty = (s: string) => { const v = Math.round(Number(s)); if (v >= 1 && v <= 100000) setQty(v); else setQtyText(String(qty)); };

  if (err) return <div className="notice warn"><AlertTriangle size={16} />{err}</div>;
  if (!e) return <p className="pi-foot">Pricing…</p>;
  if (e.purchased) return <p className="pi-foot">Bought-in part — priced from the supplier's quote, not from geometry.</p>;
  if (e.unpriced) return <p className="pi-foot">This part could not be priced. {(e.warnings || []).join(' ')}</p>;
  const c = e.currency;
  const u = e.unit;
  const margin = e.margin / e.qty, gst = e.gst / e.qty;
  const maxCurve = Math.max(...e.curve.map((x: Any) => x.unit_with_gst));
  return (
    <div className={'pc' + (busy ? ' busy' : '')}>
      <div className="pc-hero">
        <div><span className="eyebrow">APPROX. COST TO MAKE</span><b className="tabular">{money(u.with_gst, c, 2)}</b><small>per piece incl. GST · {money(u.ex_gst, c, 2)} before GST</small></div>
        <div className="pc-for"><small>for {e.qty} pc{e.qty === 1 ? '' : 's'}</small><b className="tabular">{money(e.total, c)}</b></div>
      </div>
      <div className="pi-props compact pc-controls">
        <label><span>Quantity</span><input type="number" min={1} max={100000} value={qtyText} onChange={x => setQtyText(x.target.value)} onBlur={x => commitQty(x.target.value)} onKeyDown={x => { if (x.key === 'Enter') commitQty((x.target as HTMLInputElement).value); }} /></label>
        <label><span>Vendor</span><Select size="sm" value={vendorId} onChange={setVendorId} options={[{ value: '', label: 'Base rates' }, ...vendors.map(v => ({ value: v.id, label: v.name }))]} /></label>
      </div>

      <section className="pi-section">
        <h4>Split per piece</h4>
        <div className="pc-bar">{e.split.map((s: Any, i: number) => <i key={s.process} title={`${s.process} · ${money(s.amount, c, 2)}`} style={{ width: `${s.share * 100}%`, background: SPLIT_COLORS[i % SPLIT_COLORS.length] }} />)}</div>
        {e.split.map((s: Any, i: number) => (
          <div className="pi-kv pc-row" key={s.process}><span><em style={{ background: SPLIT_COLORS[i % SPLIT_COLORS.length] }} />{s.process}</span><b className="tabular">{money(s.amount, c, 2)}<small>{Math.round(s.share * 100)}%</small></b></div>
        ))}
        <div className="pi-kv pc-sum"><span>Making cost</span><b className="tabular">{money(u.make + u.setups, c, 2)}</b></div>
        {margin > 0 && <div className="pi-kv"><span>Vendor margin {e.margin_pct}%</span><b className="tabular">{money(margin, c, 2)}</b></div>}
        <div className="pi-kv"><span>GST {e.gst_pct}%</span><b className="tabular">{money(gst, c, 2)}</b></div>
        <div className="pi-kv pc-sum"><span>Per piece</span><b className="tabular">{money(u.with_gst, c, 2)}</b></div>
      </section>

      <section className="pi-section">
        <h4>Line items<button type="button" className="link" onClick={() => setLines(!lines)}>{lines ? 'Hide' : 'Show'}</button></h4>
        {lines ? e.part.lines.map((l: Any, i: number) => (
          <div className="pc-line" key={i}>
            <div><b>{l.process}</b>{l.per_job && <Badge>per job</Badge>}<span className="tabular">{money(l.amount, c, 2)}</span></div>
            <small>{l.basis}{l.note ? ` · ${l.note}` : ''} · {l.qty} {l.unit} × {money(l.rate, c, 2)}</small>
          </div>
        )) : <p className="pi-foot">{e.part.material} · {e.part.lines.length} lines{e.setups ? ` · ${money(e.setups, c)} of setups per job` : ''}</p>}
        {e.finish_setups.map((f: Any) => <div className="pc-line" key={f.finish + f.colour}><div><b>Finish setup</b><Badge>per job</Badge><span className="tabular">{money(f.amount, c, 2)}</span></div><small>{f.finish}{f.colour ? ` · ${f.colour}` : ''} · colour change, once per job</small></div>)}
      </section>

      <section className="pi-section">
        <h4>Per piece by quantity</h4>
        <div className="pc-curve">{e.curve.map((x: Any) => (
          <button type="button" key={x.qty} className={x.qty === e.qty ? 'on' : ''} onClick={() => { setQty(x.qty); setQtyText(String(x.qty)); }} title={`Price ${x.qty} pieces`}>
            <span className="tabular">{x.qty}</span><i style={{ width: `${(x.unit_with_gst / maxCurve) * 100}%` }} /><b className="tabular">{money(x.unit_with_gst, c, 2)}</b>
          </button>
        ))}</div>
      </section>

      {e.vendors?.length > 1 && <section className="pi-section">
        <h4>At each vendor</h4>
        {e.vendors.map((v: Any, i: number) => (
          <button type="button" key={v.vendor_id || 'base'} className={'pc-vendor' + ((v.vendor_id || '') === vendorId ? ' on' : '')} onClick={() => setVendorId(v.vendor_id || '')}>
            <span>{v.vendor}{i === 0 && <Badge kind="success">Lowest</Badge>}</span><b className="tabular">{money(v.unit_with_gst, c, 2)}<small>/pc</small></b>
          </button>
        ))}
      </section>}

      {e.warnings.length > 0 && <details className="est-warn"><summary><AlertTriangle size={14} />{e.warnings.length} item{e.warnings.length === 1 ? '' : 's'} to check</summary><ul>{e.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></details>}
      <p className="pi-foot">From the “{e.rate_card}” rate card{e.vendor_id ? ` (${e.vendor})` : ''}. An estimate for design decisions — not a quotation. Setups are spread over the quantity; transport and minimum order charges apply per job order.</p>
    </div>
  );
}
