import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Download, Eye, FileText, Hexagon, PenTool, RefreshCw, Save, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { Badge, ask } from './components';
import { date } from './constants';
import type { Any } from './constants';
import { Select } from './controls';
import { Empty, PageHeader } from './shell';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const EYEBROW = 'text-2xs font-medium tracking-wider text-muted-foreground uppercase';
const SUB = 'block truncate text-xs text-muted-foreground';
const TH = 'h-9 text-xs font-medium text-muted-foreground';
const Notice = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) =>
  <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning [&>svg]:size-4 [&>svg]:shrink-0">{icon}{children}</div>;
const InlineEmpty = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) =>
  <div className="grid place-items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground [&>svg]:size-7 [&>svg]:text-faint">{icon}<p className="max-w-md">{children}</p></div>;
const BalloonNo = ({ kc, children }: { kc?: boolean; children: React.ReactNode }) =>
  <span className={cn('inline-grid h-5.5 min-w-6.5 place-items-center border-[1.5px] px-1 text-2xs font-semibold tabular-nums', kc ? 'rounded border-destructive text-destructive' : 'rounded-full border-primary text-primary')}>{children}</span>;

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
    <section className="mx-auto w-full max-w-7xl px-6 py-6">
      <PageHeader title="Quality" description="Ballooned drawings, critical characteristics, first-article and production inspection, nonconformances."
        actions={<Button variant="outline" onClick={() => doc(`/revisions/${rev.id}/measurements.csv`, `inspection-rev${rev.number}.csv`)}><Download />Export measurements</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {([['Parts to inspect', totals.parts, ''], ['With inspection plan', totals.planned, ''], ['Critical characteristics', totals.critical, ''], ['First article passed', totals.fai, 'text-success'], ['Open nonconformances', totals.ncr, totals.ncr ? 'text-destructive' : '']] as const).map(([l, v, tone]) => (
          <div key={l} className="rounded-lg border bg-card p-4"><span className={EYEBROW}>{l}</span><span className={cn('mt-1.5 block text-2xl font-semibold tabular-nums', tone)}>{v}</span></div>
        ))}
      </div>
      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(380px,460px)_minmax(0,1fr)] min-[1700px]:grid-cols-[minmax(420px,560px)_minmax(0,1fr)]">
        <div className="max-h-[calc(100vh-330px)] overflow-auto rounded-lg border bg-card">
          <div className="p-2"><Input className="h-7 text-xs" placeholder="Filter parts…" value={filter} onChange={e => setFilter(e.target.value)} /></div>
          <Table className="table-fixed">
            <colgroup><col /><col style={{ width: 92 }} /><col style={{ width: 112 }} /><col style={{ width: 66 }} /></colgroup>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className={TH}>Part</TableHead><TableHead className={cn(TH, 'text-right')} title="Characteristics on the inspection plan / measurable on the drawing">Plan</TableHead><TableHead className={TH} title="First-article inspection">FAI</TableHead><TableHead className={cn(TH, 'text-right')} title="Serials fully inspected">Done</TableHead></TableRow></TableHeader>
            <TableBody>{shown.map(r => (
              <TableRow key={r.part_id} className={cn('cursor-pointer', sel === r.part_id && 'bg-selection hover:bg-selection')} onClick={() => setSel(r.part_id)}>
                <TableCell className="overflow-hidden"><span className="block truncate font-medium" title={r.name}>{r.name}</span><span className={SUB}>{r.category.replace('_', ' ')} · qty {r.quantity}{r.open_ncr ? <span className="font-medium text-destructive"> · {r.open_ncr} NCR</span> : null}</span></TableCell>
                <TableCell className="overflow-hidden text-right tabular-nums">{r.characteristics}<span className={SUB}>of {r.candidates}{r.critical ? ` · ${r.critical} KC` : ''}</span></TableCell>
                <TableCell className="overflow-hidden"><Badge kind={FAI_TONE[r.fai] || ''}>{r.fai}</Badge></TableCell>
                <TableCell className="overflow-hidden text-right tabular-nums">{r.serials.filter((s: Any) => s.status === 'complete').length}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
          {!rows.length && <InlineEmpty icon={<ClipboardCheck />}>No machined or sheet-metal parts in this revision.</InlineEmpty>}
        </div>
        {sel ? <PartInspection key={sel} partId={sel} rev={rev} vendor={vendor} can={can} action={action} notify={notify} doc={doc} onPlan={onPlan} onChange={load} />
          : <Empty icon={<ShieldCheck />} title="Select a part"><p className="max-w-[520px]">Each generated drawing is ballooned automatically: every dimension and note is a numbered characteristic with limits from your title block (decimal tolerances, H7 / h7 fits, position tolerance). Mark the critical ones — they are checked on every part; the rest on the first article.</p></Empty>}
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
  if (err) return <div className="grid min-w-0 gap-3"><Notice icon={<ShieldAlert />}>{err}</Notice></div>;
  if (!plan || !summary) return <div className="grid min-w-0 gap-3"><p className="text-sm text-muted-foreground">Loading inspection plan…</p></div>;
  const ncrs = (meas?.latest || []).filter((m: Any) => m.result !== 'PASS');
  return (
    <div className="grid min-w-0 gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h3 className="text-base font-semibold">{name}</h3><p className="text-xs text-muted-foreground">{summary.characteristics} of {summary.candidates} dimensions inspected · {summary.balloons} balloons · {summary.critical} critical · first article <span className="font-medium text-foreground">{summary.fai}</span></p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => doc(`/parts/${partId}/inspection.pdf`, name + '_inspection.pdf', 'Inspection drawing — ' + name)}><Eye />Inspection drawing</Button>
          <Button variant="outline" size="sm" onClick={() => doc(`/parts/${partId}/characteristics.csv`, name + '_characteristics.csv')}><Download />CSV</Button>
          {!vendor && <Button variant="outline" size="sm" onClick={() => onPlan(partId)} title="Open the drawing with balloons: move balloons, mark critical characteristics, set limits"><PenTool />Balloons on drawing</Button>}
        </div>
      </header>
      <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
        <TabsList>{([['record', 'Record measurements'], ['plan', 'Inspection plan'], ['serials', `Serials (${summary.serials.length})${summary.open_ncr ? ` · ${summary.open_ncr} NCR` : ''}`]] as const).map(([k, l]) => <TabsTrigger key={k} value={k} className="px-3 text-xs">{l}</TabsTrigger>)}</TabsList>
      </Tabs>

      {tab === 'record' && <>
        {!canRecord && <Notice icon={<ShieldCheck />}>{vendor ? 'Vendor links are read-only: send your readings or the filled report to the team.' : rev.status === 'processing' ? 'Wait for processing to finish.' : 'You need the Record inspections permission.'}</Notice>}
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="grid gap-1.5"><Label htmlFor="q-serial">Serial / batch</Label><Input id="q-serial" className="w-44" value={serial} list="known-serials" placeholder="e.g. SN-001" disabled={!canRecord} onChange={e => setSerial(e.target.value)} /></div>
          <datalist id="known-serials">{summary.serials.map((s: Any) => <option key={s.serial} value={s.serial} />)}</datalist>
          <div className="grid gap-1.5"><Label htmlFor="q-instrument">Instrument</Label><Input id="q-instrument" className="w-56" value={instrument} placeholder="e.g. Caliper 0-150 #C12" disabled={!canRecord} onChange={e => setInstrument(e.target.value)} /></div>
          <Label className="h-8 font-normal"><Checkbox checked={fa} disabled={!canRecord} onCheckedChange={v => setFa(v === true)} />First article (all characteristics)</Label>
          {!fa && <Label className="h-8 font-normal"><Checkbox checked={showAll} onCheckedChange={v => setShowAll(v === true)} />Show non-critical</Label>}
          <Button className="ml-auto" disabled={!canRecord} onClick={save}><Save />Save readings</Button>
        </div>
        <div className="overflow-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className={TH}>No.</TableHead><TableHead className={TH}>Zone</TableHead><TableHead className={TH}>Characteristic</TableHead><TableHead className={cn(TH, 'text-right')}>Limits</TableHead><TableHead className={TH}>Measured</TableHead><TableHead className={TH}>Result</TableHead><TableHead className={TH}>Last reading</TableHead></TableRow></TableHeader>
            <TableBody>{required.map(q => { const r = evaluate(q, values[q.key] ?? ''); const last = latestBySerial[serial.trim()]?.[q.key];
              return <TableRow key={q.key} className={cn(q.critical && 'bg-destructive/5 hover:bg-destructive/5')}>
                <TableCell><BalloonNo kc={q.critical}>{q.no}</BalloonNo></TableCell><TableCell>{q.zone}</TableCell>
                <TableCell className="whitespace-normal">{q.label}{q.qty > 1 && <span className="block text-xs text-muted-foreground">{q.qty}× · {q.text}</span>}{q.qty <= 1 && <span className="block text-xs text-muted-foreground">{q.text}</span>}</TableCell>
                <TableCell className="text-right tabular-nums">{q.nominal === null ? <span className="text-muted-foreground">pass / fail</span> : <>{num(q.lower, q.decimals)}<span className="mx-1 text-muted-foreground">–</span>{num(q.upper, q.decimals)}</>}</TableCell>
                <TableCell>{q.nominal === null
                  ? <Select size="sm" className="w-24" aria-label="Result" value={values[q.key] ?? ''} disabled={!canRecord} onChange={v => setValues({ ...values, [q.key]: v })} options={[{ value: '', label: '—' }, { value: 'PASS', label: 'PASS' }, { value: 'FAIL', label: 'FAIL' }]} />
                  : <Input className="h-7 w-24 text-xs tabular-nums" inputMode="decimal" value={values[q.key] ?? ''} disabled={!canRecord} onChange={e => setValues({ ...values, [q.key]: e.target.value.replace(',', '.') })} placeholder={num(q.nominal, q.decimals)} />}</TableCell>
                <TableCell>{r && <Badge kind={r === 'PASS' ? 'success' : 'danger'}>{r}</Badge>}</TableCell>
                <TableCell>{last ? <><Badge kind={last.result === 'PASS' ? 'success' : 'danger'}>{last.attr || last.value}</Badge><span className="block text-xs text-muted-foreground">{last.actor} · {date(last.created)}</span></> : <span className="text-muted-foreground">—</span>}</TableCell>
              </TableRow>; })}</TableBody>
          </Table>
          {!required.length && <InlineEmpty icon={<Hexagon />}>{chars.length ? 'No critical characteristics yet. Tick “First article”, or mark critical ones in the inspection plan.' : 'Nothing is selected for inspection yet. Choose the dimensions to check under “Inspection plan” or with Balloons on the drawing.'}</InlineEmpty>}
        </div>
      </>}

      {tab === 'plan' && <>
        {!plan.editable && <Notice icon={<ShieldCheck />}>Read only — planning needs the “Plan inspection” permission.</Notice>}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="text-xs text-muted-foreground">Inspect only what matters: tick dimensions to balloon them. Critical ones are checked on every part.</span>
          <Input className="h-7 max-w-[260px] text-xs" placeholder="Filter…" value={pick} onChange={e => setPick(e.target.value)} />
          {plan.editable && <div className="flex flex-wrap gap-1.5">{PRESETS.map(([l, f]) => { const keys = all.filter(f).map(q => q.key); return <Button key={l} type="button" variant="outline" size="xs" className="rounded-full font-normal" disabled={!keys.length} title={`Add every ${l.toLowerCase()} to the inspection`} onClick={() => select(keys, true)}>+ {l} ({keys.length})</Button>; })}
            <Button type="button" variant="outline" size="xs" className="rounded-full font-normal" onClick={() => select(all.map(q => q.key), true)}>All</Button>
            <Button type="button" variant="outline" size="xs" className="rounded-full font-normal" disabled={!chars.length} onClick={() => select(chars.filter(q => !q.critical).map(q => q.key), false)}>Clear (keep critical)</Button></div>}
        </div>
        <div className="overflow-auto rounded-lg border bg-card"><Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead className={TH}>Inspect</TableHead><TableHead className={TH}>No.</TableHead><TableHead className={TH}>Zone</TableHead><TableHead className={TH}>Characteristic</TableHead><TableHead className={TH}>Limits (lower – upper)</TableHead><TableHead className={TH}>Critical</TableHead><TableHead className={TH}>Method</TableHead></TableRow></TableHeader>
          <TableBody>{all.filter(q => !pick || (q.label + ' ' + q.text + ' ' + q.zone).toLowerCase().includes(pick.toLowerCase())).map(q => <TableRow key={q.key} className={cn(q.critical && 'bg-destructive/5 hover:bg-destructive/5', !q.inspect && '[&>td:not(:first-child)]:opacity-55')}>
            <TableCell><Checkbox aria-label="Inspect" checked={!!q.inspect} disabled={!plan.editable} onCheckedChange={v => setChar(q, { inspect: v === true })} /></TableCell>
            <TableCell>{q.no ? <BalloonNo kc={q.critical}>{q.no}</BalloonNo> : <span className="text-muted-foreground">—</span>}</TableCell><TableCell>{q.zone}</TableCell><TableCell className="whitespace-normal">{q.label}<span className="block text-xs text-muted-foreground">{q.text}</span></TableCell>
            <TableCell>{q.nominal === null ? <span className="text-muted-foreground">pass / fail</span> : <span className="inline-flex items-center gap-1">
              <Input className="h-7 w-20 text-xs tabular-nums" aria-label="Lower limit" key={'l' + q.lower} defaultValue={num(q.lower, q.decimals)} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== q.lower) setChar(q, { lower: v, upper: q.upper }); }} /><span className="text-muted-foreground">–</span>
              <Input className="h-7 w-20 text-xs tabular-nums" aria-label="Upper limit" key={'u' + q.upper} defaultValue={num(q.upper, q.decimals)} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== q.upper) setChar(q, { lower: q.lower, upper: v }); }} /></span>}
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">{q.basis}{q.basis === 'specified' && plan.editable && <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setChar(q, { reset_limits: true })}><RefreshCw />use general</Button>}</span></TableCell>
            <TableCell><Label className="font-normal"><Checkbox checked={!!q.critical} disabled={!plan.editable} onCheckedChange={v => setChar(q, { critical: v === true })} />KC</Label></TableCell>
            <TableCell><Input className="h-7 min-w-36 text-xs" key={'m' + q.method} defaultValue={q.method} placeholder="e.g. CMM, pin gauge" disabled={!plan.editable} onBlur={e => { if (e.target.value !== (q.method || '')) setChar(q, { method: e.target.value }); }} /></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>
      </>}

      {tab === 'serials' && <>
        <div className="overflow-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className={TH}>Serial / batch</TableHead><TableHead className={TH}>Type</TableHead><TableHead className={cn(TH, 'text-right')}>Measured</TableHead><TableHead className={TH}>Status</TableHead><TableHead className={cn(TH, 'text-right')}>Nonconforming</TableHead><TableHead className={TH}>Last reading</TableHead><TableHead className={TH} /></TableRow></TableHeader>
            <TableBody>{[...summary.serials].reverse().map((s: Any) => <TableRow key={s.serial}>
              <TableCell className="font-medium">{s.serial}</TableCell><TableCell>{s.first_article ? 'First article' : 'Production'}</TableCell><TableCell className="text-right tabular-nums">{s.measured} / {s.required}</TableCell>
              <TableCell><Badge kind={FAI_TONE[s.status] || ''}>{s.status}</Badge></TableCell><TableCell className="text-right tabular-nums">{s.failures ? <span className="font-medium text-destructive">{s.failures}</span> : 0}{s.open_ncr ? <span className="block text-xs text-muted-foreground">{s.open_ncr} open</span> : null}</TableCell>
              <TableCell>{date(s.last)}</TableCell>
              <TableCell className="text-right"><Button variant="outline" size="xs" className="ml-1" onClick={() => doc(`/parts/${partId}/report.pdf?serial=${encodeURIComponent(s.serial)}`, `${name}_${s.serial}_report.pdf`, `${s.first_article ? 'First article' : 'Inspection'} report ${s.serial}`)}><FileText />Report</Button>
                {canRecord && <Button variant="outline" size="xs" className="ml-1" onClick={() => { setSerial(s.serial); setFa(s.first_article); setTab('record'); }}>Measure</Button>}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {!summary.serials.length && <InlineEmpty icon={<ClipboardCheck />}>No serial inspected yet. The first one you record is the first article.</InlineEmpty>}
        </div>
        {ncrs.length > 0 && <><h4 className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-destructive"><ShieldAlert className="size-4" />Nonconformances</h4>
          <div className="overflow-auto rounded-lg border bg-card"><Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead className={TH}>Serial</TableHead><TableHead className={TH}>No.</TableHead><TableHead className={TH}>Characteristic</TableHead><TableHead className={TH}>Limits</TableHead><TableHead className={TH}>Measured</TableHead><TableHead className={TH}>Disposition</TableHead><TableHead className={TH} /></TableRow></TableHeader>
            <TableBody>{ncrs.map((m: Any) => <TableRow key={m.id}>
              <TableCell>{m.serial}</TableCell><TableCell><span className="inline-flex items-center gap-1.5">{m.char_no}{m.critical ? <Badge kind="danger">KC</Badge> : null}</span></TableCell><TableCell className="whitespace-normal">{m.label}<span className="block text-xs text-muted-foreground">{m.actor} · {date(m.created)}</span></TableCell>
              <TableCell className="tabular-nums">{m.lower_limit ?? ''} … {m.upper_limit ?? ''}</TableCell><TableCell className="font-medium text-destructive tabular-nums">{m.attr || m.value}</TableCell>
              <TableCell className="whitespace-normal">{m.disposition ? <><Badge kind={m.disposition === 'scrap' ? 'danger' : 'success'}>{m.disposition}</Badge><span className="block text-xs text-muted-foreground">{m.disposition_note} — {m.disposition_by}</span></> : <Badge kind="warning">open</Badge>}</TableCell>
              <TableCell className="text-right">{!vendor && plan.editable && !m.disposition && <Button variant="outline" size="xs" className="ml-1" onClick={() => dispose(m)}>Disposition…</Button>}</TableCell>
            </TableRow>)}</TableBody>
          </Table></div></>}
      </>}
    </div>
  );
}
