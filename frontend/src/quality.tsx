import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Download, Eye, FileText, Hexagon, PenTool, RefreshCw, Save, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { Badge, ask } from './components';
import { date } from './constants';
import type { Any } from './constants';

/** One requirement of a ballooned line ("12.1 Hole Ø"), with the line's number and zone. */
export const flatChars = (chars: Any[]) => chars.flatMap((c: Any) => c.reqs.map((q: Any) => ({ ...q, number: c.number, line: c.id, zone: c.zone, page: c.page, text: c.text, source: c.source })));
const num = (v: number | null | undefined, dec = 2) => v === null || v === undefined ? '' : v.toFixed(Math.max(dec, (String(v).split('.')[1] || '').length > dec ? Math.min(4, (String(v).split('.')[1] || '').length) : dec));
const evaluate = (q: Any, raw: string): '' | 'PASS' | 'FAIL' => {
  if (raw === '') return '';
  if (q.nominal === null) return ['PASS', 'FAIL'].includes(raw) ? raw as Any : '';
  const v = Number(raw); if (!Number.isFinite(v)) return '';
  return (q.lower === null || v >= q.lower - 1e-9) && (q.upper === null || v <= q.upper + 1e-9) ? 'PASS' : 'FAIL';
};
const FAI_TONE: Record<string, string> = { passed: 'success', nonconforming: 'danger', incomplete: 'warning', complete: 'success', 'not started': '' };

/** Quality page: inspection plan per part (balloons, critical characteristics, limits), measurement entry per
 * serial (first article = every characteristic, production = critical ones), reports and nonconformances. */
export function QualityPage({ rev, vendor, can, action, notify, doc, onPlan }: { rev: Any; vendor: boolean; can: (p: string) => boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void; doc: (path: string, name: string, title?: string) => void; onPlan: (partId: string) => void }) {
  const [rows, setRows] = useState<Any[]>([]);
  const [sel, setSel] = useState<string>('');
  const [filter, setFilter] = useState('');
  const load = () => api(`/revisions/${rev.id}/inspection`).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [rev.id]);
  const shown = rows.filter(r => !filter || r.name.toLowerCase().includes(filter.toLowerCase()));
  const totals = useMemo(() => ({
    parts: rows.length, planned: rows.filter(r => r.characteristics).length, critical: rows.reduce((n, r) => n + r.critical, 0),
    fai: rows.filter(r => r.fai === 'passed').length, ncr: rows.reduce((n, r) => n + r.open_ncr, 0),
  }), [rows]);
  return (
    <section className="content-page quality-page">
      <div className="page-title">
        <div><h2>Quality</h2><p>Ballooned drawings, critical characteristics, first-article and production inspection, nonconformances.</p></div>
        <div className="flex"><button onClick={() => doc(`/revisions/${rev.id}/measurements.csv`, `inspection-rev${rev.number}.csv`)}><Download size={16} />Export measurements</button></div>
      </div>
      <div className="summary-cards">
        <div><span>PARTS TO INSPECT</span><b>{totals.parts}</b></div>
        <div><span>WITH INSPECTION PLAN</span><b>{totals.planned}</b></div>
        <div><span>CRITICAL CHARACTERISTICS</span><b>{totals.critical}</b></div>
        <div><span>FIRST ARTICLE PASSED</span><b className="green">{totals.fai}</b></div>
        <div><span>OPEN NONCONFORMANCES</span><b className={totals.ncr ? 'red' : ''}>{totals.ncr}</b></div>
      </div>
      <div className="quality-grid">
        <div className="table-wrap quality-parts">
          <input className="v-filter" placeholder="Filter parts…" value={filter} onChange={e => setFilter(e.target.value)} />
          <table>
            <colgroup><col /><col style={{ width: 92 }} /><col style={{ width: 112 }} /><col style={{ width: 66 }} /></colgroup>
            <thead><tr><th>Part</th><th className="num" title="Characteristics on the inspection plan / measurable on the drawing">Plan</th><th title="First-article inspection">FAI</th><th className="num" title="Serials fully inspected">Done</th></tr></thead>
            <tbody>{shown.map(r => (
              <tr key={r.part_id} className={sel === r.part_id ? 'selected' : ''} onClick={() => setSel(r.part_id)} style={{ cursor: 'pointer' }}>
                <td><span className="q-name" title={r.name}>{r.name}</span><small>{r.category.replace('_', ' ')} · qty {r.quantity}{r.open_ncr ? <b className="red"> · {r.open_ncr} NCR</b> : null}</small></td>
                <td className="num">{r.characteristics}<small>of {r.candidates}{r.critical ? ` · ${r.critical} KC` : ''}</small></td>
                <td><Badge kind={FAI_TONE[r.fai] || ''}>{r.fai}</Badge></td>
                <td className="num">{r.serials.filter((s: Any) => s.status === 'complete').length}</td>
              </tr>))}</tbody>
          </table>
          {!rows.length && <div className="empty-inline"><ClipboardCheck size={30} /><p>No machined or sheet-metal parts in this revision.</p></div>}
        </div>
        {sel ? <PartInspection key={sel} partId={sel} rev={rev} vendor={vendor} can={can} action={action} notify={notify} doc={doc} onPlan={onPlan} onChange={load} />
          : <div className="quality-empty"><ShieldCheck size={34} /><h3>Select a part</h3><p>Each generated drawing is ballooned automatically: every dimension and note is a numbered characteristic with limits from your title block (decimal tolerances, H7 / h7 fits, position tolerance). Mark the critical ones — they are checked on every part; the rest on the first article.</p></div>}
      </div>
    </section>
  );
}

function PartInspection({ partId, rev, vendor, can, action, notify, doc, onPlan, onChange }: { partId: string; rev: Any; vendor: boolean; can: (p: string) => boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void; doc: (path: string, name: string, title?: string) => void; onPlan: (partId: string) => void; onChange: () => void }) {
  const [plan, setPlan] = useState<Any>(null), [err, setErr] = useState('');
  const [meas, setMeas] = useState<Any>(null);
  const [serial, setSerial] = useState(''), [fa, setFa] = useState(true), [instrument, setInstrument] = useState(''), [values, setValues] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false), [tab, setTab] = useState<'record' | 'plan' | 'serials'>('record');
  const load = async () => {
    try { setPlan(await api(`/parts/${partId}/characteristics`)); setErr(''); } catch (e: Any) { setErr(e.message); setPlan(null); }
    const m = await api(`/parts/${partId}/measurements`).catch(() => null); setMeas(m);
    if (m && !m.summary.serials.some((s: Any) => s.first_article)) setFa(true); else setFa(false);
  };
  useEffect(() => { load(); }, [partId]);
  const all = useMemo(() => plan ? flatChars(plan.chars) : [], [plan]);
  const chars = all.filter(q => q.inspect);
  const [pick, setPick] = useState('');
  const summary = meas?.summary;
  const required = chars.filter(q => fa || showAll || q.critical);
  const select = (keys: string[], inspect: boolean) => keys.length && action(async () => { await api(`/parts/${partId}/characteristics`, 'PUT', { keys, inspect }); await load(); onChange(); });
  const PRESETS: [string, (q: Any) => boolean][] = [
    ['Holes & fits', q => ['hole_dia', 'shaft_dia', 'cbore_dia', 'csk_dia', 'thread', 'depth'].includes(q.type)],
    ['Hole positions', q => q.type === 'position'],
    ['Lengths', q => q.type === 'linear'],
    ['Angles', q => q.unit === 'deg'],
  ];
  const name = summary?.name || '';
  const canRecord = !vendor && plan?.can_record && ['ready', 'released'].includes(rev.status);
  const latestBySerial = useMemo(() => { const m: Record<string, Record<string, Any>> = {}; for (const r of meas?.latest || []) (m[r.serial] ||= {})[r.char_key] = r; return m; }, [meas]);
  // picking an existing serial shows its readings (and lets them be re-measured)
  useEffect(() => { const ex = latestBySerial[serial.trim()]; if (ex) setFa(Object.values(ex).some((r: Any) => r.first_article)); }, [serial]);
  const setChar = (q: Any, body: Any) => action(async () => { await api(`/parts/${partId}/characteristics/${q.key}`, 'PUT', body); await load(); onChange(); });
  async function save() {
    const entries = required.filter(q => values[q.key] !== undefined && values[q.key] !== '').map(q => q.nominal === null ? { key: q.key, attr: values[q.key] } : { key: q.key, value: Number(values[q.key]) });
    if (!serial.trim()) { notify('Enter the serial or batch number first.'); return; }
    if (!entries.length) { notify('Enter at least one measurement.'); return; }
    const missing = required.length - entries.length;
    if (missing > 0 && await ask({ title: `${missing} characteristic${missing > 1 ? 's' : ''} not measured`, message: 'Save the readings you entered? The serial stays incomplete until the rest are recorded.', confirm: 'Save anyway' }) === null) return;
    action(async () => {
      const r = await api(`/revisions/${rev.id}/measurements`, 'POST', { part_id: partId, serial: serial.trim(), first_article: fa, instrument, entries });
      notify(r.nonconforming ? `${r.nonconforming} nonconforming result${r.nonconforming > 1 ? 's' : ''} recorded — disposition them under Serials.` : `${entries.length} measurements recorded, all within limits.`);
      setValues({}); await load(); onChange();
    });
  }
  async function dispose(m: Any) {
    const d = await ask({ title: `Disposition — ${m.char_no} ${m.label}`, message: `Serial ${m.serial}: measured ${m.attr || m.value} against ${m.lower_limit ?? ''} … ${m.upper_limit ?? ''}. Record the decision of the review (MRB).`, confirm: 'Choose note', input: { label: 'Disposition', required: true, choices: ['use as is', 'rework', 'repair', 'scrap', 'return to vendor'] } });
    if (!d) return;
    const note = await ask({ title: `Disposition: ${d}`, message: 'Why, and what was done (at least 5 characters). Logged in the revision history.', confirm: 'Save disposition', input: { label: 'Note', multiline: true, required: true } });
    if (!note) return;
    action(async () => { await api(`/measurements/${m.id}/disposition`, 'POST', { disposition: d, note }); await load(); onChange(); });
  }
  if (err) return <div className="quality-detail"><div className="notice"><ShieldAlert size={16} />{err}</div></div>;
  if (!plan || !summary) return <div className="quality-detail"><p className="muted">Loading inspection plan…</p></div>;
  const ncrs = (meas?.latest || []).filter((m: Any) => m.result !== 'PASS');
  return (
    <div className="quality-detail">
      <header className="quality-head">
        <div><h3>{name}</h3><small>{summary.characteristics} of {summary.candidates} dimensions inspected · {summary.balloons} balloons · {summary.critical} critical · first article <b>{summary.fai}</b></small></div>
        <div className="flex">
          <button onClick={() => doc(`/parts/${partId}/inspection.pdf`, name + '_inspection.pdf', 'Inspection drawing — ' + name)}><Eye size={15} />Inspection drawing</button>
          <button onClick={() => doc(`/parts/${partId}/characteristics.csv`, name + '_characteristics.csv')}><Download size={15} />CSV</button>
          {!vendor && <button onClick={() => onPlan(partId)} title="Open the drawing with balloons: move balloons, mark critical characteristics, set limits"><PenTool size={15} />Balloons on drawing</button>}
        </div>
      </header>
      <div className="v-segment">{([['record', 'Record measurements'], ['plan', 'Inspection plan'], ['serials', `Serials (${summary.serials.length})${summary.open_ncr ? ` · ${summary.open_ncr} NCR` : ''}`]] as const).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'record' && <>
        {!canRecord && <div className="notice"><ShieldCheck size={16} />{vendor ? 'Vendor links are read-only: send your readings or the filled report to the team.' : rev.status === 'processing' ? 'Wait for processing to finish.' : 'You need the Record inspections permission.'}</div>}
        <div className="record-bar">
          <label>Serial / batch<input value={serial} list="known-serials" placeholder="e.g. SN-001" disabled={!canRecord} onChange={e => setSerial(e.target.value)} /></label>
          <datalist id="known-serials">{summary.serials.map((s: Any) => <option key={s.serial} value={s.serial} />)}</datalist>
          <label>Instrument<input value={instrument} placeholder="e.g. Caliper 0-150 #C12" disabled={!canRecord} onChange={e => setInstrument(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={fa} disabled={!canRecord} onChange={e => setFa(e.target.checked)} />First article (all characteristics)</label>
          {!fa && <label className="check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />Show non-critical</label>}
          <button className="primary" disabled={!canRecord} onClick={save}><Save size={15} />Save readings</button>
        </div>
        <div className="table-wrap">
          <table className="char-table">
            <thead><tr><th>No.</th><th>Zone</th><th>Characteristic</th><th className="num">Limits</th><th>Measured</th><th>Result</th><th>Last reading</th></tr></thead>
            <tbody>{required.map(q => { const r = evaluate(q, values[q.key] ?? ''); const last = latestBySerial[serial.trim()]?.[q.key];
              return <tr key={q.key} className={q.critical ? 'kc' : ''}>
                <td><span className={'balloon-no' + (q.critical ? ' kc' : '')}>{q.no}</span></td><td>{q.zone}</td>
                <td>{q.label}{q.qty > 1 && <small>{q.qty}× · {q.text}</small>}{q.qty <= 1 && <small>{q.text}</small>}</td>
                <td className="num lims">{q.nominal === null ? <span className="muted">pass / fail</span> : <>{num(q.lower, q.decimals)}<i>–</i>{num(q.upper, q.decimals)}</>}</td>
                <td>{q.nominal === null
                  ? <select value={values[q.key] ?? ''} disabled={!canRecord} onChange={e => setValues({ ...values, [q.key]: e.target.value })}><option value="">—</option><option>PASS</option><option>FAIL</option></select>
                  : <input className="measure" inputMode="decimal" value={values[q.key] ?? ''} disabled={!canRecord} onChange={e => setValues({ ...values, [q.key]: e.target.value.replace(',', '.') })} placeholder={num(q.nominal, q.decimals)} />}</td>
                <td>{r && <Badge kind={r === 'PASS' ? 'success' : 'danger'}>{r}</Badge>}</td>
                <td>{last ? <><Badge kind={last.result === 'PASS' ? 'success' : 'danger'}>{last.attr || last.value}</Badge><small>{last.actor} · {date(last.created)}</small></> : <span className="muted">—</span>}</td>
              </tr>; })}</tbody>
          </table>
          {!required.length && <div className="empty-inline"><Hexagon size={28} /><p>{chars.length ? 'No critical characteristics yet. Tick “First article”, or mark critical ones in the inspection plan.' : 'Nothing is selected for inspection yet. Choose the dimensions to check under “Inspection plan” or with Balloons on the drawing.'}</p></div>}
        </div>
      </>}

      {tab === 'plan' && <>
        {!plan.editable && <div className="notice"><ShieldCheck size={16} />Read only — planning needs the “Plan inspection” permission.</div>}
        <div className="record-bar plan-bar">
          <span className="muted">Inspect only what matters: tick dimensions to balloon them. Critical ones are checked on every part.</span>
          <input className="v-filter" placeholder="Filter…" value={pick} onChange={e => setPick(e.target.value)} />
          {plan.editable && <div className="chips">{PRESETS.map(([l, f]) => { const keys = all.filter(f).map(q => q.key); return <button key={l} type="button" className="chip" disabled={!keys.length} title={`Add every ${l.toLowerCase()} to the inspection`} onClick={() => select(keys, true)}>+ {l} ({keys.length})</button>; })}
            <button type="button" className="chip" onClick={() => select(all.map(q => q.key), true)}>All</button>
            <button type="button" className="chip" disabled={!chars.length} onClick={() => select(chars.filter(q => !q.critical).map(q => q.key), false)}>Clear (keep critical)</button></div>}
        </div>
        <div className="table-wrap"><table className="char-table">
          <thead><tr><th>Inspect</th><th>No.</th><th>Zone</th><th>Characteristic</th><th>Limits (lower – upper)</th><th>Critical</th><th>Method</th></tr></thead>
          <tbody>{all.filter(q => !pick || (q.label + ' ' + q.text + ' ' + q.zone).toLowerCase().includes(pick.toLowerCase())).map(q => <tr key={q.key} className={(q.critical ? 'kc ' : '') + (q.inspect ? '' : 'off')}>
            <td><input type="checkbox" aria-label="Inspect" checked={!!q.inspect} disabled={!plan.editable} onChange={e => setChar(q, { inspect: e.target.checked })} /></td>
            <td>{q.no ? <span className={'balloon-no' + (q.critical ? ' kc' : '')}>{q.no}</span> : <span className="muted">—</span>}</td><td>{q.zone}</td><td>{q.label}<small>{q.text}</small></td>
            <td className="lim-cell">{q.nominal === null ? <span className="muted">pass / fail</span> : <span className="lim-pair">
              <input className="measure" aria-label="Lower limit" key={'l' + q.lower} defaultValue={num(q.lower, q.decimals)} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== q.lower) setChar(q, { lower: v, upper: q.upper }); }} /><i>–</i>
              <input className="measure" aria-label="Upper limit" key={'u' + q.upper} defaultValue={num(q.upper, q.decimals)} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== q.upper) setChar(q, { lower: q.lower, upper: v }); }} /></span>}
              <small>{q.basis}{q.basis === 'specified' && plan.editable && <button className="link" onClick={() => setChar(q, { reset_limits: true })}><RefreshCw size={11} />use general</button>}</small></td>
            <td><label className="check"><input type="checkbox" checked={!!q.critical} disabled={!plan.editable} onChange={e => setChar(q, { critical: e.target.checked })} />KC</label></td>
            <td><input key={'m' + q.method} defaultValue={q.method} placeholder="e.g. CMM, pin gauge" disabled={!plan.editable} onBlur={e => { if (e.target.value !== (q.method || '')) setChar(q, { method: e.target.value }); }} /></td>
          </tr>)}</tbody>
        </table></div>
      </>}

      {tab === 'serials' && <>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Serial / batch</th><th>Type</th><th className="num">Measured</th><th>Status</th><th className="num">Nonconforming</th><th>Last reading</th><th /></tr></thead>
            <tbody>{[...summary.serials].reverse().map((s: Any) => <tr key={s.serial}>
              <td><b>{s.serial}</b></td><td>{s.first_article ? 'First article' : 'Production'}</td><td className="num">{s.measured} / {s.required}</td>
              <td><Badge kind={FAI_TONE[s.status] || ''}>{s.status}</Badge></td><td className="num">{s.failures ? <b className="red">{s.failures}</b> : 0}{s.open_ncr ? <small>{s.open_ncr} open</small> : null}</td>
              <td>{date(s.last)}</td>
              <td className="row-actions"><button className="mini" onClick={() => doc(`/parts/${partId}/report.pdf?serial=${encodeURIComponent(s.serial)}`, `${name}_${s.serial}_report.pdf`, `${s.first_article ? 'First article' : 'Inspection'} report ${s.serial}`)}><FileText size={12} />Report</button>
                {canRecord && <button className="mini" onClick={() => { setSerial(s.serial); setFa(s.first_article); setTab('record'); }}>Measure</button>}</td>
            </tr>)}</tbody>
          </table>
          {!summary.serials.length && <div className="empty-inline"><ClipboardCheck size={28} /><p>No serial inspected yet. The first one you record is the first article.</p></div>}
        </div>
        {ncrs.length > 0 && <><h4 className="ncr-title"><ShieldAlert size={15} />Nonconformances</h4>
          <div className="table-wrap"><table>
            <thead><tr><th>Serial</th><th>No.</th><th>Characteristic</th><th>Limits</th><th>Measured</th><th>Disposition</th><th /></tr></thead>
            <tbody>{ncrs.map((m: Any) => <tr key={m.id}>
              <td>{m.serial}</td><td>{m.char_no}{m.critical ? <Badge kind="danger">KC</Badge> : null}</td><td>{m.label}<small>{m.actor} · {date(m.created)}</small></td>
              <td>{m.lower_limit ?? ''} … {m.upper_limit ?? ''}</td><td><b className="red">{m.attr || m.value}</b></td>
              <td>{m.disposition ? <><Badge kind={m.disposition === 'scrap' ? 'danger' : 'success'}>{m.disposition}</Badge><small>{m.disposition_note} — {m.disposition_by}</small></> : <Badge kind="warning">open</Badge>}</td>
              <td className="row-actions">{!vendor && plan.editable && !m.disposition && <button className="mini" onClick={() => dispose(m)}>Disposition…</button>}</td>
            </tr>)}</tbody>
          </table></div></>}
      </>}
    </div>
  );
}
