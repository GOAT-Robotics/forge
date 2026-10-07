import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Calculator, ChevronDown, ChevronRight, Copy, Download, IndianRupee, Plus, RefreshCw, Save, Scale, Store, Trash2 } from 'lucide-react';
import { api, download } from './api';
import { Badge, Modal, ModalFooter, ask } from './components';
import { Select } from './controls';
import type { Any } from './constants';
import { PageHeader, Empty } from './shell';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Ctx = { busy: boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void };

export function money(v: number | null | undefined, currency = 'INR', digits = 0) {
  if (v == null || !isFinite(v)) return '—';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v); }
  catch { return `${currency} ${v.toFixed(digits)}`; }
}

// ---------------------------------------------------------------------------- shared bits
const EYEBROW = 'text-2xs font-medium uppercase tracking-wider text-muted-foreground';
const TH = 'h-8 px-2 text-xs font-medium text-muted-foreground';
const TD = 'px-2 py-1.5';
const NOTE = 'block text-xs text-muted-foreground whitespace-normal';
const DANGER_GHOST = 'text-destructive hover:bg-danger-soft hover:text-destructive';

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"><AlertTriangle className="size-4 shrink-0" />{children}</div>;
}

function Warnings({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <details className={cn('text-sm text-warning', className)}>
      <summary className="inline-flex cursor-pointer items-center gap-1.5"><AlertTriangle className="size-3.5" />{items.length} item{items.length === 1 ? '' : 's'} to check</summary>
      <ul className="mt-1.5 ml-5 list-disc text-foreground">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </details>
  );
}

/** Label above a control. */
function Field({ label, htmlFor, hint, className, children }: { label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs font-normal leading-tight text-muted-foreground">{label}</Label>
      {children}
      {hint && <small className="text-2xs text-faint">{hint}</small>}
    </div>
  );
}

// ============================================================================ estimate views
function Breakdown({ e }: { e: Any }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (e.error) return <Notice>{e.error}</Notice>;
  return (
    <div className="mt-2 grid items-start gap-4 md:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]">
      <Table>
        <TableBody>
          {e.by_process.map((x: Any) => <TableRow key={x.process}><TableCell className={TD}>{x.process}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(x.amount, e.currency)}</TableCell></TableRow>)}
          <TableRow className="border-t border-t-foreground/20 font-medium"><TableCell className={TD}>Subtotal</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(e.subtotal, e.currency)}</TableCell></TableRow>
          {e.margin > 0 && <TableRow><TableCell className={TD}>Vendor margin {e.margin_pct}%</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(e.margin, e.currency)}</TableCell></TableRow>}
          <TableRow><TableCell className={TD}>GST {e.gst_pct}%</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(e.gst, e.currency)}</TableCell></TableRow>
          <TableRow className="text-base font-semibold text-foreground"><TableCell className={TD}>Estimated total</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(e.total, e.currency)}</TableCell></TableRow>
        </TableBody>
      </Table>
      <div className="grid min-w-0 gap-1">
        {e.parts.map((p: Any) => (
          <div key={p.part_id} className="overflow-hidden rounded-md border">
            <Button type="button" variant="ghost" className="grid h-auto w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-none px-2.5 py-1.5 text-left font-normal whitespace-normal" onClick={() => setOpen({ ...open, [p.part_id]: !open[p.part_id] })}>
              {open[p.part_id] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              <span className="flex min-w-0 flex-col"><span className="font-medium">{p.part}</span><small className="text-xs text-muted-foreground">{p.material} · {p.qty} pcs · {money(p.unit_cost, e.currency, 2)} each{p.setup ? ` + ${money(p.setup, e.currency)} setup` : ''}</small></span>
              <span className="font-medium tabular-nums">{money(p.total, e.currency)}</span>
            </Button>
            {open[p.part_id] && <Table className="border-t"><TableHeader><TableRow><TableHead className={TH}>Process</TableHead><TableHead className={TH}>Basis</TableHead><TableHead className={cn(TH, 'text-right')}>Qty</TableHead><TableHead className={cn(TH, 'text-right')}>Rate</TableHead><TableHead className={cn(TH, 'text-right')}>Amount</TableHead></TableRow></TableHeader>
              <TableBody>{p.lines.map((l: Any, i: number) => <TableRow key={i}><TableCell className={TD}>{l.process}{l.per_job && <small className={NOTE}>per job</small>}</TableCell><TableCell className={TD}>{l.basis}{l.note && <small className={NOTE}>{l.note}</small>}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{l.qty} {l.unit}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(l.rate, e.currency, 2)}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(l.amount, e.currency, 2)}</TableCell></TableRow>)}</TableBody></Table>}
          </div>
        ))}
        {e.welds.length > 0 && <div className="overflow-hidden rounded-md border"><div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5"><span className="flex min-w-0 flex-col"><span className="font-medium">Welding</span><small className="text-xs text-muted-foreground">{e.welds.length} weld{e.welds.length === 1 ? '' : 's'}{e.weld_setup ? ` + ${money(e.weld_setup, e.currency)} setup` : ''}</small></span><span className="font-medium tabular-nums">{money(e.welds.reduce((n: number, w: Any) => n + w.total, 0) + e.weld_setup, e.currency)}</span></div>
          <Table className="border-t"><TableBody>{e.welds.map((w: Any) => <TableRow key={w.weld}><TableCell className={TD}><span className="font-medium">{w.weld}</span><small className={NOTE}>{w.parts}</small></TableCell><TableCell className={TD}>{w.process} · {w.basis}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>× {w.qty}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(w.total, e.currency)}</TableCell></TableRow>)}</TableBody></Table></div>}
      </div>
      <Warnings items={e.warnings} className="col-span-full" />
      <small className="col-span-full text-xs text-muted-foreground">Estimate from the {e.rate_card} rate card, for planning — not a vendor quotation. Bought-in parts are not priced.</small>
    </div>
  );
}

const BASE = '__base__';

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
    <div className="mt-3 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-baseline gap-2"><span className="inline-flex items-center gap-1.5 font-medium"><IndianRupee className="size-3.5" />Vendor &amp; cost estimate</span><small className="text-xs text-muted-foreground">{busy ? 'Pricing…' : pricing?.vendors?.length ? 'Choose who makes it' : 'Add vendors under Pricing to compare'}</small></div>
      {err && <p className="mt-1 text-sm text-muted-foreground">{err}</p>}
      {est && <RadioGroup name="vendor" value={vendorId || BASE} onValueChange={v => setVendorId(v === BASE ? '' : v)} className="my-2 gap-1.5">{est.map(e => {
        const on = (e.vendor_id || '') === vendorId;
        return (
          <Label key={e.vendor_id || 'base'} className={cn('grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-md border px-2.5 py-2 font-normal leading-normal transition-colors hover:bg-accent', on && 'border-primary/50 bg-selection hover:bg-selection')}>
            <RadioGroupItem value={e.vendor_id || BASE} />
            <span className="flex min-w-0 flex-col"><span className="font-medium">{e.vendor}</span><small className="text-xs text-muted-foreground">{e.rate_card}{e.warnings.length ? ` · ${e.warnings.length} to check` : ''}</small></span>
            {e.total === cheapest && est.length > 1 ? <Badge kind="success">Lowest</Badge> : <span />}
            <span className="text-base font-semibold tabular-nums">{money(e.total, e.currency)}</span>
          </Label>
        );
      })}</RadioGroup>}
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
    <div className="grid gap-2 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold"><IndianRupee className="size-4" />Cost estimate {e && !e.error && <span className="ml-2 text-primary tabular-nums">{money(e.total, e.currency)}</span>}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && <div className="w-44"><Select size="sm" value={jo.vendor_id || ''} onChange={v => run(v)} options={[{ value: '', label: 'Base rates' }, ...vendors.map(v => ({ value: v.id, label: v.name }))]} /></div>}
          {canManage && <Button type="button" variant="outline" size="sm" onClick={() => run()} title="Price again with the current rate card"><RefreshCw />Re-price</Button>}
          {canManage && <Button type="button" variant="outline" size="sm" onClick={() => api(`/job-orders/${jo.id}/estimate/compare`).then(setCmp).catch(err => ctx.notify(err.message))}><Scale />Compare vendors</Button>}
          {e && <Button type="button" variant="link" size="sm" onClick={() => setOpen(!open)}>{open ? 'Hide breakdown' : 'Breakdown'}</Button>}
        </div>
      </header>
      {!e ? <p className="text-sm text-muted-foreground">Not priced yet{canManage ? ' — choose a vendor or Re-price.' : '.'}</p>
        : <p className="text-sm text-muted-foreground">{jo.vendor_name || 'Base rates'} · {e.pieces} pieces · priced {new Date(e.computed).toLocaleDateString()} from “{e.rate_card}”{e.warnings?.length ? ` · ${e.warnings.length} item(s) to check` : ''}</p>}
      {cmp && <Table className="mt-1"><TableHeader><TableRow><TableHead className={TH}>Vendor</TableHead><TableHead className={cn(TH, 'text-right')}>Subtotal</TableHead><TableHead className={cn(TH, 'text-right')}>Total incl. GST</TableHead><TableHead className={TH} /></TableRow></TableHeader>
        <TableBody>{cmp.map((c, i) => <TableRow key={c.vendor_id || 'base'}><TableCell className={TD}><span className="inline-flex items-center gap-2"><span className="font-medium">{c.vendor}</span>{i === 0 && <Badge kind="success">Lowest</Badge>}</span>{c.warnings ? <small className={NOTE}>{c.warnings} to check</small> : null}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(c.subtotal)}</TableCell><TableCell className={cn(TD, 'text-right tabular-nums')}>{money(c.total)}</TableCell>
          <TableCell className={cn(TD, 'text-right')}>{canManage && (c.vendor_id || '') !== (jo.vendor_id || '') && <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => run(c.vendor_id)}>Use</Button>}</TableCell></TableRow>)}</TableBody></Table>}
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
  const id = useId();
  return <Field label={label} htmlFor={id} hint={hint}><Input id={id} type="number" step="any" className="tabular-nums" value={value ?? 0} disabled={disabled} onChange={e => onChange(Number(e.target.value))} /></Field>;
}

function RowsEditor({ sec, rows, set, ro }: { sec: string; rows: Any[]; set: (rows: Any[]) => void; ro: boolean }) {
  const cols = COLS[sec];
  const blank = () => Object.fromEntries(cols.map(([k, , t]) => [k, t === 'num' ? 0 : t.startsWith('select:') ? t.slice(7).split(',')[0] : '']));
  return (
    <div className="grid gap-1.5">
      <h4 className="text-sm font-medium">{SECTION_TITLES[sec]}</h4>
      <Table>
        <TableHeader><TableRow className="hover:bg-transparent">{cols.map(([k, l, t]) => <TableHead key={k} className={cn(TH, t === 'num' && 'text-right')}>{l}</TableHead>)}{!ro && <TableHead className={cn(TH, 'w-8')} />}</TableRow></TableHeader>
        <TableBody>{rows.map((r, i) => (
          <TableRow key={i} className="hover:bg-transparent">{cols.map(([k, , t]) => (
            <TableCell key={k} className="px-1 py-0.5">
              {t.startsWith('select:') ? <Select size="sm" className="min-w-[90px]" value={r[k] ?? ''} disabled={ro} onChange={v => set(rows.map((x, j) => j === i ? { ...x, [k]: v } : x))} options={t.slice(7).split(',').map(o => ({ value: o, label: o }))} />
                : <Input type={t === 'num' ? 'number' : 'text'} step="any" value={r[k] ?? ''} disabled={ro}
                  className={cn('h-7 min-w-[70px] px-2', t === 'num' && 'ml-auto max-w-[120px] text-right tabular-nums', t === 'text' && k === 'match' && 'min-w-[260px]')}
                  onChange={e => set(rows.map((x, j) => j === i ? { ...x, [k]: t === 'num' ? Number(e.target.value) : e.target.value } : x))} />}
            </TableCell>))}
            {!ro && <TableCell className="px-1 py-0.5"><Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" title="Remove row" onClick={() => set(rows.filter((_, j) => j !== i))}><Trash2 /></Button></TableCell>}
          </TableRow>))}</TableBody>
      </Table>
      {!ro && <Button type="button" variant="ghost" size="sm" className="justify-self-start text-primary hover:text-primary" onClick={() => set([...rows, { ...blank(), ...(sec === 'materials' ? { key: 'm' + Date.now().toString(36), density: 7850 } : {}) }])}><Plus />Add row</Button>}
    </div>
  );
}

function CardEditor({ card, ro, onSaved, ctx, vendor }: { card: Any; ro: boolean; onSaved: (c: Any) => void; ctx: Ctx; vendor?: Any }) {
  const [d, setD] = useState<Any>(card.data);
  const [name, setName] = useState(card.name);
  const [tab, setTab] = useState('materials');
  const uid = useId();
  useEffect(() => { setD(card.data); setName(card.name); }, [card.id, card.updated]);
  const dirty = JSON.stringify(d) !== JSON.stringify(card.data) || name !== card.name;
  const set = (k: string, v: Any) => setD({ ...d, [k]: v });
  const sub = (k: string, f: string, v: number) => setD({ ...d, [k]: { ...d[k], [f]: v } });
  const groups = ['ms', 'gi', 'ss', 'al', 'brass', 'plastic'];
  const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3';
  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {vendor ? <h3 className="flex flex-col text-lg font-semibold">{vendor.name}<small className="text-xs font-normal text-muted-foreground">{vendor.services?.join(' · ') || 'No services listed'}</small></h3>
          : <Input aria-label="Rate card name" className="h-9 max-w-md min-w-[280px] border-transparent bg-transparent px-1.5 text-lg font-semibold shadow-none hover:border-input focus-visible:border-ring disabled:opacity-100 dark:bg-transparent" value={name} disabled={ro} onChange={e => setName(e.target.value)} />}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => download(`/rate-cards/${card.id}/export.csv`, `${card.name}.csv`).catch(e => ctx.notify(e.message))}><Download />CSV</Button>
          {!ro && <Button type="button" disabled={!dirty || ctx.busy} onClick={() => ctx.action(async () => { onSaved(await api('/rate-cards/' + card.id, 'PUT', { name, data: d })); ctx.notify('Rates saved'); })}><Save />Save rates</Button>}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[repeat(3,minmax(120px,180px))_minmax(0,1fr)]">
        <Field label="Region" htmlFor={uid + 'region'}><Input id={uid + 'region'} value={d.region} disabled={ro} onChange={e => set('region', e.target.value)} /></Field>
        <Field label="As of" htmlFor={uid + 'asof'}><Input id={uid + 'asof'} value={d.as_of} disabled={ro} onChange={e => set('as_of', e.target.value)} /></Field>
        <Field label="Currency" htmlFor={uid + 'cur'}><Input id={uid + 'cur'} value={d.currency} disabled={ro} onChange={e => set('currency', e.target.value.toUpperCase())} maxLength={3} /></Field>
        <Field label="Notes" htmlFor={uid + 'notes'}><Input id={uid + 'notes'} value={d.notes} disabled={ro} onChange={e => set('notes', e.target.value)} /></Field>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">{TABS.map(([k, l]) => <TabsTrigger key={k} value={k} className="h-7 flex-none px-2.5 text-xs">{l}</TabsTrigger>)}</TabsList>
      </Tabs>
      {TABS.find(t => t[0] === tab)![2].map(sec => <RowsEditor key={sec} sec={sec} rows={d[sec]} ro={ro} set={rows => set(sec, rows)} />)}
      {tab === 'materials' && <div className={GRID}>
        <Field label="Default sheet material" hint="when the part spec names none on this card"><Select aria-label="Default sheet material" value={d.defaults.sheet} disabled={ro} onChange={v => set('defaults', { ...d.defaults, sheet: v })} options={d.materials.map((m: Any) => ({ value: m.key, label: m.name }))} /></Field>
        <Field label="Default bar / block material"><Select aria-label="Default bar / block material" value={d.defaults.bar} disabled={ro} onChange={v => set('defaults', { ...d.defaults, bar: v })} options={d.materials.map((m: Any) => ({ value: m.key, label: m.name }))} /></Field>
        <NumField label="Sheet scrap / nesting allowance %" value={d.overheads.scrap_pct} disabled={ro} onChange={v => sub('overheads', 'scrap_pct', v)} />
        <NumField label="Bar stock allowance per side (mm)" value={d.machining.stock_mm} disabled={ro} onChange={v => sub('machining', 'stock_mm', v)} />
      </div>}
      {tab === 'cutting' && <div className={GRID}>
        {groups.map(g => <NumField key={g} label={`Multiplier · ${g.toUpperCase()}`} value={d.laser_group[g]} disabled={ro} onChange={v => sub('laser_group', g, v)} />)}
        <NumField label="Minimum laser charge per part (₹)" value={d.laser_min_part} disabled={ro} onChange={v => set('laser_min_part', v)} />
        <NumField label="Deburring per part (₹)" value={d.deburr_per_part} disabled={ro} onChange={v => set('deburr_per_part', v)} />
      </div>}
      {tab === 'forming' && <div className={GRID}>
        <NumField label="Bend setup per part number, per job (₹)" value={d.bend_setup} disabled={ro} onChange={v => set('bend_setup', v)} />
        <NumField label="Long bend from (mm)" value={d.bend_long_mm} disabled={ro} onChange={v => set('bend_long_mm', v)} />
        <NumField label="Long bend factor (×)" value={d.bend_long_factor} disabled={ro} onChange={v => set('bend_long_factor', v)} />
        <NumField label="Rolling ₹ / kg" value={d.rolling.per_kg} disabled={ro} onChange={v => sub('rolling', 'per_kg', v)} />
        <NumField label="Rolling minimum per part (₹)" value={d.rolling.min_part} disabled={ro} onChange={v => sub('rolling', 'min_part', v)} />
        <NumField label="Rolling setup per job (₹)" value={d.rolling.setup} disabled={ro} onChange={v => sub('rolling', 'setup', v)} />
      </div>}
      {tab === 'holes' && <div className={GRID}>
        <NumField label="Machining ₹ / hour" value={d.machining.per_hour} disabled={ro} onChange={v => sub('machining', 'per_hour', v)} />
        <NumField label="Setup hours per part number" value={d.machining.setup_hours} disabled={ro} onChange={v => sub('machining', 'setup_hours', v)} />
        <NumField label="Handling minutes per part" value={d.machining.handling_min} disabled={ro} onChange={v => sub('machining', 'handling_min', v)} />
        <NumField label="Minutes per hole / feature" value={d.machining.per_feature_min} disabled={ro} onChange={v => sub('machining', 'per_feature_min', v)} />
        {groups.map(g => <NumField key={g} label={`Removal rate cm³/min · ${g.toUpperCase()}`} value={d.machining.mrr[g]} disabled={ro} onChange={v => set('machining', { ...d.machining, mrr: { ...d.machining.mrr, [g]: v } })} />)}
        <NumField label="Countersink ₹ / hole" value={d.countersink_per_hole} disabled={ro} onChange={v => set('countersink_per_hole', v)} />
        <NumField label="Tapping setup per job (₹)" value={d.tap_setup} disabled={ro} onChange={v => set('tap_setup', v)} />
      </div>}
      {tab === 'hardware' && <div className={GRID}>
        <NumField label="Press-in insertion ₹ / pc" value={d.insertion.press} disabled={ro} onChange={v => sub('insertion', 'press', v)} hint="nuts, studs, standoffs" />
        <NumField label="Rivnut setting ₹ / pc" value={d.insertion.rivnut} disabled={ro} onChange={v => sub('insertion', 'rivnut', v)} />
        <NumField label="Weld nut projection welding ₹ / pc" value={d.insertion.weld_nut} disabled={ro} onChange={v => sub('insertion', 'weld_nut', v)} />
        <NumField label="Hardware setup per job (₹)" value={d.hardware_setup} disabled={ro} onChange={v => set('hardware_setup', v)} />
      </div>}
      {tab === 'welding' && <div className={GRID}>
        <NumField label="Grinding / dressing ₹ / m" value={d.weld_grind_per_m} disabled={ro} onChange={v => set('weld_grind_per_m', v)} hint="welds marked Ground" />
        <NumField label="Welding setup per job (₹)" value={d.weld_setup} disabled={ro} onChange={v => set('weld_setup', v)} />
        <NumField label="Minimum per weld (₹)" value={d.weld_min} disabled={ro} onChange={v => set('weld_min', v)} />
      </div>}
      {tab === 'overheads' && <div className={GRID}>
        <NumField label="Vendor margin %" value={d.overheads.margin_pct} disabled={ro} onChange={v => sub('overheads', 'margin_pct', v)} />
        <NumField label="GST %" value={d.overheads.gst_pct} disabled={ro} onChange={v => sub('overheads', 'gst_pct', v)} />
        <NumField label="Minimum order value (₹)" value={d.overheads.min_job} disabled={ro} onChange={v => sub('overheads', 'min_job', v)} />
        <NumField label="Transport per job (₹)" value={d.overheads.transport} disabled={ro} onChange={v => sub('overheads', 'transport', v)} />
      </div>}
    </div>
  );
}

const PAGE = 'mx-auto w-full max-w-7xl px-6 py-6';
const LIST_ROW = 'grid h-auto w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-left font-normal whitespace-normal';

export function PricingPage({ ctx }: { ctx: Ctx }) {
  const [data, setData] = useState<Any>(null);
  const [sel, setSel] = useState<{ kind: 'vendor' | 'base'; id: string } | null>(null);
  const [card, setCard] = useState<Any>(null);
  const [form, setForm] = useState<Any>(null);
  const fid = useId();
  const load = () => api('/pricing').then(d => { setData(d); return d; }).catch(e => { ctx.notify(e.message); setData(false); });
  useEffect(() => { load().then(d => { if (d && !sel) setSel(d.vendors[0] ? { kind: 'vendor', id: d.vendors[0].id } : d.base_cards[0] ? { kind: 'base', id: d.base_cards[0].id } : null); }); }, []);
  const vendor = sel?.kind === 'vendor' ? data?.vendors.find((v: Any) => v.id === sel.id) : null;
  const cardId = vendor ? vendor.rate_card_id : sel?.kind === 'base' ? sel.id : '';
  useEffect(() => { setCard(null); if (cardId) api('/rate-cards/' + cardId).then(setCard).catch(e => ctx.notify(e.message)); }, [cardId]);
  if (data === false) return <div className={PAGE}><PageHeader title="Pricing" /><Empty icon={<IndianRupee />} title="Pricing is for job-order planners">Ask an administrator for the Production planner role.</Empty></div>;
  if (!data) return <div className={PAGE}><PageHeader title="Pricing" /><p className="py-4 text-sm text-muted-foreground">Loading…</p></div>;
  const ro = !data.can_manage;
  const saveVendor = () => ctx.action(async () => {
    const { id, rate_card, rate_card_id, created, updated, author, archived, ...body } = form;
    const r = form.id ? await api('/vendors/' + form.id, 'PUT', { ...body, copy_from: '' }) : await api('/vendors', 'POST', body);
    setForm(null); await load(); setSel({ kind: 'vendor', id: r.id }); ctx.notify(form.id ? 'Vendor saved' : 'Vendor added with a copy of the base sheet');
  });
  const rowCls = (on: boolean) => cn(LIST_ROW, on && 'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground');
  return (
    <div className={PAGE}>
      <PageHeader title="Vendors & pricing" description="Rate cards per vendor. Job orders are priced with the chosen vendor's rates; base sheets are reference rates you copy for a new vendor."
        actions={!ro && <Button onClick={() => setForm({ name: '', services: [], contact: '', phone: '', email: '', gstin: '', address: '', notes: '', copy_from: data.base_cards[0]?.id || '' })}><Plus />Add vendor</Button>} />
      <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-0.5 lg:sticky lg:top-2">
          <h4 className={cn(EYEBROW, 'mb-1 px-3')}>Vendors</h4>
          {!data.vendors.length && <p className="px-3 py-1 text-sm text-muted-foreground">No vendors yet. Add one: it starts with a copy of the base sheet.</p>}
          {data.vendors.map((v: Any) => (
            <Button key={v.id} type="button" variant="ghost" className={rowCls(sel?.id === v.id)} onClick={() => setSel({ kind: 'vendor', id: v.id })}>
              <Store className="size-4 opacity-70" /><span className="flex min-w-0 flex-col"><span className="truncate font-medium">{v.name}</span><small className="truncate text-xs text-muted-foreground">{v.services.slice(0, 3).join(' · ') || v.contact || '—'}</small></span>
            </Button>))}
          <h4 className={cn(EYEBROW, 'mt-4 mb-1 px-3')}>Base sheets</h4>
          {data.base_cards.map((c: Any) => (
            <Button key={c.id} type="button" variant="ghost" className={rowCls(sel?.id === c.id)} onClick={() => setSel({ kind: 'base', id: c.id })}>
              <Calculator className="size-4 opacity-70" /><span className="flex min-w-0 flex-col"><span className="truncate font-medium">{c.name}</span><small className="truncate text-xs text-muted-foreground">updated {new Date(c.updated).toLocaleDateString()}</small></span>
            </Button>))}
        </aside>
        <section className="flex min-w-0 flex-col gap-3">
          {vendor && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
            <div className="flex min-w-0 flex-col gap-0.5"><span className="font-medium">{vendor.contact || 'No contact'}</span><small className="text-xs text-muted-foreground">{[vendor.phone, vendor.email, vendor.gstin && 'GSTIN ' + vendor.gstin].filter(Boolean).join(' · ')}</small>{vendor.address && <small className="text-xs text-muted-foreground">{vendor.address}</small>}</div>
            {!ro && <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...vendor })}>Edit vendor</Button>
              <div className="w-48"><Select size="sm" value="" placeholder="Reset rates from…" onChange={id => ctx.action(async () => {
                if (await ask({ title: 'Replace these rates?', message: `${vendor.name}'s rates are replaced by a copy of the chosen base sheet.`, confirm: 'Replace rates', danger: true }) === null) return;
                await api(`/rate-cards/${id}/copy`, 'POST', { vendor_id: vendor.id }); await load(); setCard(await api('/rate-cards/' + vendor.rate_card_id));
              })} options={data.base_cards.map((c: Any) => ({ value: c.id, label: c.name }))} /></div>
              <Button type="button" variant="ghost" size="sm" className={DANGER_GHOST} onClick={() => ctx.action(async () => {
                if (await ask({ title: `Remove ${vendor.name}?`, message: 'Job orders keep their estimate; the vendor is no longer offered.', confirm: 'Remove vendor', danger: true }) === null) return;
                await api('/vendors/' + vendor.id, 'DELETE'); setSel(null); await load();
              })}><Trash2 />Remove</Button>
            </div>}
          </div>}
          {sel?.kind === 'base' && !ro && <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => ctx.action(async () => {
              const name = await ask({ title: 'Copy base sheet', message: 'A new base sheet starts as a copy; edit it for another city or a new price list.', confirm: 'Copy', input: { label: 'Name', initial: `${card?.name || 'Base sheet'} (copy)`, required: true } });
              if (!name) return; const c = await api(`/rate-cards/${sel.id}/copy`, 'POST', { name }); await load(); setSel({ kind: 'base', id: c.id });
            })}><Copy />Copy sheet</Button>
            {data.base_cards.length > 1 && <Button type="button" variant="ghost" size="sm" className={DANGER_GHOST} onClick={() => ctx.action(async () => { await api('/rate-cards/' + sel.id, 'DELETE'); setSel(null); await load(); })}><Trash2 />Remove sheet</Button>}
          </div>}
          {card ? <CardEditor card={card} ro={ro} vendor={vendor} ctx={ctx} onSaved={c => { setCard(c); load(); }} /> : sel ? <p className="py-4 text-sm text-muted-foreground">Loading rates…</p> : <Empty icon={<IndianRupee />} title="Choose a vendor or a base sheet" />}
        </section>
      </div>
      {form && <Modal title={form.id ? 'Edit vendor' : 'Add vendor'} subtitle={form.id ? undefined : 'The vendor gets its own rate card, copied from a base sheet; edit it to their quote.'} close={() => setForm(null)}>
        <form className="grid gap-4" onSubmit={e => { e.preventDefault(); saveVendor(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor={fid + 'name'}><Input id={fid + 'name'} required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Kovai Laser Works" /></Field>
            <Field label="Contact person" htmlFor={fid + 'contact'}><Input id={fid + 'contact'} value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} /></Field>
            <Field label="Phone" htmlFor={fid + 'phone'}><Input id={fid + 'phone'} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email" htmlFor={fid + 'email'}><Input id={fid + 'email'} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="GSTIN" htmlFor={fid + 'gstin'}><Input id={fid + 'gstin'} value={form.gstin} maxLength={15} onChange={e => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></Field>
            {!form.id && <Field label="Start rates from"><Select aria-label="Start rates from" value={form.copy_from} onChange={v => setForm({ ...form, copy_from: v })} options={data.base_cards.map((c: Any) => ({ value: c.id, label: c.name }))} /></Field>}
          </div>
          <Field label="Address" htmlFor={fid + 'address'}><Textarea id={fid + 'address'} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
          <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted-foreground">Services</span>{data.services.map((s: string) => { const on = form.services.includes(s); return <Button type="button" key={s} size="xs" variant={on ? 'default' : 'outline'} className="rounded-full px-2.5 font-normal" onClick={() => setForm({ ...form, services: form.services.includes(s) ? form.services.filter((x: string) => x !== s) : [...form.services, s] })}>{s}</Button>; })}</div>
          <Field label="Notes" htmlFor={fid + 'notes'}><Textarea id={fid + 'notes'} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Payment terms, lead times, minimums…" /></Field>
          <ModalFooter><Button type="button" variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button type="submit" disabled={ctx.busy}>{form.id ? 'Save vendor' : 'Add vendor'}</Button></ModalFooter>
        </form>
      </Modal>}
    </div>
  );
}

// ============================================================================ part cost (inspector tab)
const SPLIT_COLORS = ['#2F5BFF', '#E8452C', '#F2A93B', '#2BA87A', '#8E5BD9', '#1FA2C4', '#C9567E', '#7B8794', '#B98B2E', '#4C6A92'];

const KV = 'flex min-h-7 items-center justify-between gap-3 py-1 text-sm';
const KV_KEY = 'shrink-0 text-muted-foreground';
const KV_VAL = 'min-w-0 text-right tabular-nums';
const KV_SUM = 'mt-1 border-t border-dashed pt-1.5';
const FOOT = 'm-0 text-xs leading-relaxed text-muted-foreground';
const SECTION_HEAD = cn(EYEBROW, 'mb-1 flex items-center justify-between');

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
  const qid = useId();
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

  if (err) return <Notice>{err}</Notice>;
  if (!e) return <p className={FOOT}>Pricing…</p>;
  if (e.purchased) return <p className={FOOT}>Bought-in part — priced from the supplier's quote, not from geometry.</p>;
  if (e.unpriced) return <p className={FOOT}>This part could not be priced. {(e.warnings || []).join(' ')}</p>;
  const c = e.currency;
  const u = e.unit;
  const margin = e.margin / e.qty, gst = e.gst / e.qty;
  const maxCurve = Math.max(...e.curve.map((x: Any) => x.unit_with_gst));
  return (
    <div className={cn('grid gap-4 transition-opacity', busy && 'opacity-60')}>
      <div className="flex items-end justify-between gap-3 rounded-lg border bg-subtle p-4">
        <div className="grid gap-0.5"><span className={EYEBROW}>Approx. cost to make</span><span className="text-2xl leading-tight font-semibold tracking-tight tabular-nums">{money(u.with_gst, c, 2)}</span><small className="text-xs text-muted-foreground">per piece incl. GST</small><small className="text-xs text-muted-foreground">{money(u.ex_gst, c, 2)} before GST</small></div>
        <div className="grid gap-0.5 text-right"><small className="text-xs text-muted-foreground">for {e.qty} pc{e.qty === 1 ? '' : 's'}</small><span className="text-lg font-semibold tabular-nums">{money(e.total, c)}</span></div>
      </div>
      <div className="grid gap-1.5">
        <div className="grid grid-cols-[74px_minmax(0,1fr)] items-center gap-2 text-sm"><Label htmlFor={qid} className="font-normal text-muted-foreground">Quantity</Label><Input id={qid} type="number" min={1} max={100000} className="h-7 tabular-nums" value={qtyText} onChange={x => setQtyText(x.target.value)} onBlur={x => commitQty(x.target.value)} onKeyDown={x => { if (x.key === 'Enter') commitQty((x.target as HTMLInputElement).value); }} /></div>
        <div className="grid grid-cols-[74px_minmax(0,1fr)] items-center gap-2 text-sm"><span className="text-muted-foreground">Vendor</span><Select size="sm" aria-label="Vendor" value={vendorId} onChange={setVendorId} options={[{ value: '', label: 'Base rates' }, ...vendors.map(v => ({ value: v.id, label: v.name }))]} /></div>
      </div>

      <section className="grid">
        <h4 className={SECTION_HEAD}>Split per piece</h4>
        <div className="mt-1 mb-2.5 flex h-2.5 overflow-hidden rounded-md bg-muted">{e.split.map((s: Any, i: number) => <i key={s.process} className="block h-full min-w-0.5" title={`${s.process} · ${money(s.amount, c, 2)}`} style={{ width: `${s.share * 100}%`, background: SPLIT_COLORS[i % SPLIT_COLORS.length] }} />)}</div>
        {e.split.map((s: Any, i: number) => (
          <div className={KV} key={s.process}><span className="inline-flex items-center gap-2 text-muted-foreground"><em className="inline-block size-[9px] shrink-0 rounded-[3px]" style={{ background: SPLIT_COLORS[i % SPLIT_COLORS.length] }} />{s.process}</span><span className={KV_VAL}>{money(s.amount, c, 2)}<small className="ml-2 inline-block min-w-8 text-right text-xs text-muted-foreground">{Math.round(s.share * 100)}%</small></span></div>
        ))}
        <div className={cn(KV, KV_SUM)}><span className={KV_KEY}>Making cost</span><span className={cn(KV_VAL, 'font-semibold')}>{money(u.make + u.setups, c, 2)}</span></div>
        {margin > 0 && <div className={KV}><span className={KV_KEY}>Vendor margin {e.margin_pct}%</span><span className={KV_VAL}>{money(margin, c, 2)}</span></div>}
        <div className={KV}><span className={KV_KEY}>GST {e.gst_pct}%</span><span className={KV_VAL}>{money(gst, c, 2)}</span></div>
        <div className={cn(KV, KV_SUM)}><span className={KV_KEY}>Per piece</span><span className={cn(KV_VAL, 'font-semibold')}>{money(u.with_gst, c, 2)}</span></div>
      </section>

      <section className="grid">
        <h4 className={SECTION_HEAD}>Line items<Button type="button" variant="link" size="xs" className="h-auto px-0 normal-case tracking-normal" onClick={() => setLines(!lines)}>{lines ? 'Hide' : 'Show'}</Button></h4>
        {lines ? e.part.lines.map((l: Any, i: number) => (
          <div className="grid gap-0.5 border-b py-1.5 last:border-b-0" key={i}>
            <div className="flex items-center gap-1.5 text-sm"><span className="font-medium">{l.process}</span>{l.per_job && <Badge>per job</Badge>}<span className="ml-auto font-medium tabular-nums">{money(l.amount, c, 2)}</span></div>
            <small className="text-xs text-muted-foreground">{l.basis}{l.note ? ` · ${l.note}` : ''} · {l.qty} {l.unit} × {money(l.rate, c, 2)}</small>
          </div>
        )) : <p className={FOOT}>{e.part.material} · {e.part.lines.length} lines{e.setups ? ` · ${money(e.setups, c)} of setups per job` : ''}</p>}
        {e.finish_setups.map((f: Any) => <div className="grid gap-0.5 border-b py-1.5 last:border-b-0" key={f.finish + f.colour}><div className="flex items-center gap-1.5 text-sm"><span className="font-medium">Finish setup</span><Badge>per job</Badge><span className="ml-auto font-medium tabular-nums">{money(f.amount, c, 2)}</span></div><small className="text-xs text-muted-foreground">{f.finish}{f.colour ? ` · ${f.colour}` : ''} · colour change, once per job</small></div>)}
      </section>

      <section className="grid">
        <h4 className={SECTION_HEAD}>Per piece by quantity</h4>
        <div className="grid gap-0.5">{e.curve.map((x: Any) => (
          <Button type="button" variant="ghost" key={x.qty} className={cn('grid h-auto w-full grid-cols-[44px_minmax(0,1fr)_92px] items-center gap-2 px-1.5 py-1 text-left font-normal', x.qty === e.qty && 'bg-selection hover:bg-selection')} onClick={() => { setQty(x.qty); setQtyText(String(x.qty)); }} title={`Price ${x.qty} pieces`}>
            <span className="tabular-nums">{x.qty}</span><i className="block h-1.5 rounded-full bg-primary/75" style={{ width: `${(x.unit_with_gst / maxCurve) * 100}%` }} /><span className="text-right font-medium tabular-nums">{money(x.unit_with_gst, c, 2)}</span>
          </Button>
        ))}</div>
      </section>

      {e.vendors?.length > 1 && <section className="grid gap-0.5">
        <h4 className={SECTION_HEAD}>At each vendor</h4>
        {e.vendors.map((v: Any, i: number) => (
          <Button type="button" variant="ghost" key={v.vendor_id || 'base'} className={cn('h-auto w-full justify-between border border-transparent px-2 py-1.5 font-normal', (v.vendor_id || '') === vendorId && 'border-primary/50 bg-selection hover:bg-selection')} onClick={() => setVendorId(v.vendor_id || '')}>
            <span className="inline-flex items-center gap-1.5">{v.vendor}{i === 0 && <Badge kind="success">Lowest</Badge>}</span><span className="font-medium tabular-nums">{money(v.unit_with_gst, c, 2)}<small className="ml-0.5 font-normal text-muted-foreground">/pc</small></span>
          </Button>
        ))}
      </section>}

      <Warnings items={e.warnings} />
      <p className={FOOT}>From the “{e.rate_card}” rate card{e.vendor_id ? ` (${e.vendor})` : ''}. An estimate for design decisions — not a quotation. Setups are spread over the quantity; transport and minimum order charges apply per job order.</p>
    </div>
  );
}
