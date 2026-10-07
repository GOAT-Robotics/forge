import React, { useEffect, useRef, useState } from 'react';
import { Grid2x2, Download, Play, RefreshCw, AlertTriangle, LoaderCircle } from 'lucide-react';
import { Modal } from './components';
import { Progress } from './shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
  const [gap, setGap] = useState(''), [margin, setMargin] = useState(10), [rotate, setRotate] = useState(true), [square, setSquare] = useState(true);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const timer = useRef(0);
  const load = () => api(`/job-orders/${jo.id}/nesting`).then((s: Any) => {
    setSt(s);
    if (s.options && !editing) { setW(s.options.sheet_w); setH(s.options.sheet_h); setGap(s.options.gap ? String(s.options.gap) : ''); setMargin(s.options.margin); setRotate(s.options.rotate); setSquare(s.options.square ?? true); setPreset(SHEETS.find(x => x[1] === s.options.sheet_w && x[2] === s.options.sheet_h)?.[0] || 'custom'); }
    window.clearTimeout(timer.current);
    if (s.state === 'running') timer.current = window.setTimeout(load, 1500);
  }).catch(e => setErr(e.message));
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, [jo.id]);
  const start = async () => {
    setErr(''); setEditing(false);
    try { setSt(await api(`/job-orders/${jo.id}/nesting`, 'POST', { sheet_w: w, sheet_h: h, gap: Number(gap) || 0, margin, rotate, square })); window.setTimeout(load, 800); }
    catch (e: unknown) { setErr((e as Error).message); }
  };
  const res = st?.state === 'ready' ? st.result : null;
  const showForm = !st || st.state === 'missing' || st.state === 'failed' || editing;
  const field = 'grid gap-1.5 text-xs leading-snug';
  return (
    <Modal title="Nesting" subtitle={`JO-${String(jo.number).padStart(3, '0')} · sheet-metal parts on stock sheets, per material and thickness`} wide close={close}>
      <div className="flex flex-col gap-3">
        {showForm && canRun && <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] items-end gap-x-3.5 gap-y-2.5 rounded-lg border bg-subtle p-3">
          <Label className={field}>Sheet<Select value={preset} onChange={v => { setPreset(v); const s = SHEETS.find(x => x[0] === v); if (s) { setW(s[1]); setH(s[2]); } }} options={[...SHEETS.map(s => ({ value: s[0], label: s[0] + ' mm' })), { value: 'custom', label: 'Custom size' }]} /></Label>
          {preset === 'custom' && <><Label className={field}>Width (mm)<Input type="number" min={200} max={12000} value={w} onChange={e => setW(Number(e.target.value))} /></Label>
            <Label className={field}>Height (mm)<Input type="number" min={200} max={6000} value={h} onChange={e => setH(Number(e.target.value))} /></Label></>}
          <Label className={field}>Part spacing (mm)<Input type="number" min={0} max={50} step={.5} value={gap} placeholder="Auto: 2 × t, min 3" onChange={e => setGap(e.target.value)} /></Label>
          <Label className={field}>Sheet margin (mm)<Input type="number" min={0} max={200} value={margin} onChange={e => setMargin(Number(e.target.value))} /></Label>
          <Label className="col-span-full flex items-start gap-2 text-sm font-normal leading-snug"><Checkbox className="mt-0.5" checked={rotate} onCheckedChange={v => setRotate(v === true)} />Turn parts (0 / 90 / 180 / 270°) — off for brushed or grained sheet</Label>
          <Label className="col-span-full flex items-start gap-2 text-sm font-normal leading-snug"><Checkbox className="mt-0.5" checked={square} onCheckedChange={v => setSquare(v === true)} />Keep parts square to the sheet — straight edges run along X / Y, no diagonal angles (faster laser cutting; laser time usually costs more than the sheet saved)</Label>
          <div className="col-span-full flex justify-end gap-2">{editing && <Button type="button" variant="outline" onClick={() => setEditing(false)}>Back to result</Button>}<Button type="button" onClick={start}><Play />Nest parts</Button></div>
        </div>}
        {err && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">{err}</div>}
        {st?.state === 'failed' && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">Nesting failed: {st.error}</div>}
        {st?.state === 'running' && <div className="flex items-center gap-2.5 text-sm"><LoaderCircle className="size-4 animate-spin text-primary" /><span className="tabular-nums">Nesting… {st.progress || 0}%</span><div className="flex-1"><Progress value={st.progress || 0} /></div></div>}
        {(st?.missing || []).length > 0 && <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{st.missing.length} part{st.missing.length === 1 ? ' has' : 's have'} no flat pattern yet and {st.missing.length === 1 ? 'is' : 'are'} not nested: {st.missing.slice(0, 6).map((m: Any) => m.label).join(', ')}{st.missing.length > 6 ? '…' : ''}. Generate their documents first.</span></div>}
        {res && !editing && <>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground"><span className="font-medium text-foreground">{res.sheets} sheet{res.sheets === 1 ? '' : 's'}</span> · {st.options.sheet_w} × {st.options.sheet_h} mm · by {st.by}</span>
            <span className="flex-1" />
            {canRun && <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}><RefreshCw />Change and re-nest</Button>}
            {canDownload && <Button type="button" size="sm" onClick={() => download(`/job-orders/${jo.id}/nesting.zip`, `JO-${String(jo.number).padStart(3, '0')}-nesting.zip`).catch(e => setErr(e.message))}><Download />DXF + PDF (ZIP)</Button>}
          </div>
          {res.groups.map((g: Any) => (
            <section key={g.material + g.thickness} className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5">
              <header className="flex flex-wrap items-baseline gap-2.5"><span className="text-sm font-medium">{g.material || 'Material not set'} · {g.thickness} mm</span><small className="text-xs text-muted-foreground tabular-nums">{g.sheets.length} sheet{g.sheets.length === 1 ? '' : 's'} · {g.placed}/{g.parts} parts · spacing {g.gap} mm · average use {Math.round(g.utilization)} %</small></header>
              {g.unplaced.length > 0 && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">Not placed: {Object.entries(g.unplaced.reduce((m: Any, u: Any) => ({ ...m, [`${u.label} (${u.reason})`]: (m[`${u.label} (${u.reason})`] || 0) + 1 }), {})).map(([k, n]) => `${n} × ${k}`).join(' · ')}</div>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">{g.sheets.map((s: Any) => (
                <figure key={s.n} className="m-0 flex flex-col gap-1">
                  <svg viewBox={`0 0 ${g.sheet[0]} ${g.sheet[1]}`} preserveAspectRatio="xMidYMid meet" className="h-auto w-full rounded-md bg-subtle">
                    <rect x={0} y={0} width={g.sheet[0]} height={g.sheet[1]} className="fill-muted stroke-faint [stroke-width:4]" />
                    {s.remnant && <line x1={s.length} y1={0} x2={s.length} y2={g.sheet[1]} className="stroke-warning [stroke-dasharray:18_12] [stroke-width:3] [vector-effect:non-scaling-stroke]" />}
                    <g transform={`translate(0 ${g.sheet[1]}) scale(1 -1)`}>{s.preview.map((p: Any, i: number) => <path key={i} d={p.d} className="fill-primary/20 stroke-primary [fill-rule:evenodd] [stroke-width:1.6] [vector-effect:non-scaling-stroke] hover:fill-primary/45"><title>{p.label}</title></path>)}</g>
                  </svg>
                  <figcaption className="text-xs text-muted-foreground tabular-nums"><span className="font-medium text-foreground">Sheet {s.n}</span> · {Object.values(s.parts).reduce((a: number, b: Any) => a + Number(b), 0) as number} parts · {s.utilization} % of the sheet{s.length ? <> · uses {Math.round(s.length)} mm ({Math.round(s.dense)} % dense)</> : null}{s.remnant ? <> · remnant {Math.round(s.remnant[0])} × {Math.round(s.remnant[1])}</> : null}</figcaption>
                </figure>
              ))}</div>
            </section>
          ))}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Grid2x2 className="size-3.5 shrink-0" /> True-shape nesting: several part orders and turns are tried, the layout with the fewest sheets and the shortest used length (largest remnant) wins. Lead-ins, common-line cutting and grain are for your laser CAM; check spacing against your machine.</p>
        </>}
        {!canRun && !res && st?.state !== 'running' && <p className="text-sm text-muted-foreground">No nesting yet.</p>}
      </div>
    </Modal>
  );
}
