import React, { useMemo, useState } from 'react';
import { Sparkles, AlertTriangle, CheckCircle2, RefreshCw, LoaderCircle } from 'lucide-react';
import { Modal, ModalFooter } from './components';
import { Select } from './controls';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
const sectionCls = 'flex flex-col gap-2 border-t pt-3';
const headCls = 'mb-0.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground';
const rowCls = 'grid items-center gap-1 md:grid-cols-[220px_minmax(0,1fr)] md:gap-3';
const labelCls = 'flex flex-col text-sm font-medium text-foreground';
const checkCls = 'font-normal leading-snug';
const tag = (n: number) => cn('text-xs font-normal', n ? 'text-warning' : 'text-success');

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
        <div className="flex flex-col gap-3">
          {result.job && <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"><RefreshCw className="mt-0.5 size-4 shrink-0" />Out-of-date drawings are being regenerated. When that finishes, open this again and tick “Mark drawings reviewed”.</div>}
          <Table className="text-xs">
            <TableHeader><TableRow className="hover:bg-transparent">{['Part', 'Design', 'Drawing', 'Still open'].map(h => <TableHead key={h} className="h-8 text-2xs font-medium uppercase tracking-wider text-muted-foreground">{h}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{rows.map((r: Any) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-[280px] align-top" title={r.name}><span className="flex items-center gap-1.5 overflow-hidden"><span className="shrink-0">{r.ready ? <CheckCircle2 className="size-3.5 text-success" /> : <AlertTriangle className="size-3.5 text-warning" />}</span><span className="truncate">{r.name}</span></span></TableCell>
                <TableCell className="align-top">{r.design ? 'Signed off' : '—'}</TableCell>
                <TableCell className="align-top">{r.drawing === 'reviewed' ? 'Reviewed' : r.drawing === 'current' ? 'To review' : 'Regenerate'}</TableCell>
                <TableCell className="align-top whitespace-normal text-warning" title={(r.open || []).join('\n')}>{(() => { const o = (r.open || []).filter((x: string) => !x.endsWith('(warning)')); return o.length ? `${o.length} open: ${o.slice(0, 3).join(' · ')}${o.length > 3 ? ` +${o.length - 3} more` : ''}` : (r.open || []).length ? 'Warnings only' : ''; })()}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
        </div>
        <ModalFooter><Button type="button" variant="outline" onClick={() => setResult(null)}>Back</Button><Button type="button" onClick={close}>Done</Button></ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal title="Make production ready" subtitle="Fill what is missing for many parts at once — values a part already has are kept" wide close={close}>
      <div className="flex flex-col gap-3.5">
        <ToggleGroup type="single" variant="outline" size="sm" spacing={1.5} className="flex-wrap" value={scope} onValueChange={v => { if (v) setScope(v); }}>{scopes.map(s => <ToggleGroupItem key={s.id} value={s.id} className="rounded-full px-3 text-xs font-normal data-[state=on]:border-primary/40 data-[state=on]:bg-selection data-[state=on]:text-selection-foreground">{s.label}</ToggleGroupItem>)}</ToggleGroup>
        <div className="flex items-baseline gap-2.5 text-sm text-muted-foreground"><span className="text-base font-medium text-foreground tabular-nums">{list.length} parts</span><span className="tabular-nums">{designOpen} without design sign-off · {drawingOpen} without drawing review</span></div>

        <section className={sectionCls}><h4 className={headCls}>Specification</h4>
          {FIELDS.map(f => { const n = missing(f.key); return (
            <div className={rowCls} key={f.key}>
              <span className={labelCls}>{f.label}<small className={tag(n)}>{n ? `${n} missing` : 'all set'}</small></span>
              {/* Native suggestions: the Combo popover lives outside the dialog and Modal treats a click there as "outside". */}
              <Input aria-label={f.label} list={'br-' + f.key} value={fill[f.key] || ''} placeholder={n ? `Value for the ${n} part${n === 1 ? '' : 's'} without one` : 'Leave empty to keep'} onChange={e => setFill(x => ({ ...x, [f.key]: e.target.value }))} />
              <datalist id={'br-' + f.key}>{f.options(cat || 'machining').map(o => <option key={o} value={o} />)}</datalist>
            </div>); })}
          <Label className={cn(checkCls, 'text-xs text-muted-foreground')}><Checkbox checked={overwrite} onCheckedChange={v => setOverwrite(v === true)} />Also replace values parts already have</Label>
        </section>

        <section className={sectionCls}><h4 className={headCls}>Engineering verifications</h4>
          {Object.entries(MANUAL).map(([k, m]) => { const n = missingCheck(k); return (
            <div className={rowCls} key={k}>
              <span className={labelCls} title={m.help}>{m.title}<small className={tag(n)}>{n ? `${n} missing` : 'all set'}</small></span>
              <Select aria-label={m.title} value={checks[k] || ''} onChange={v => setChecks(x => ({ ...x, [k]: v }))}
                options={[{ value: '', label: n ? 'Choose the verification…' : 'Keep' }, ...m.answers.map(a => ({ value: a, label: a }))]} />
            </div>); })}
        </section>

        {(kOpen > 0 || warnOpen > 0) && <section className={sectionCls}><h4 className={headCls}>Checks</h4>
          {kOpen > 0 && <Label className={checkCls}><Checkbox checked={approveK} onCheckedChange={v => setApproveK(v === true)} />Approve the K-factor of {kOpen} bent part{kOpen === 1 ? '' : 's'} (confirmed with the press shop)</Label>}
          {warnOpen > 0 && <div className={rowCls}><span className={labelCls}>Accept warnings<small className={tag(1)}>{warnOpen} part{warnOpen === 1 ? '' : 's'}</small></span>
            <Input aria-label="Accept warnings" value={waive} placeholder="Reason, e.g. reviewed with the vendor; acceptable for this design" onChange={e => setWaive(e.target.value)} /></div>}
        </section>}

        <section className={sectionCls}><h4 className={headCls}>Sign-off</h4>
          <Label className={checkCls}><Checkbox checked={signDesign} disabled={!canDesign} onCheckedChange={v => setSignDesign(v === true)} />Sign off the design of every part with nothing open{!canDesign && ' (needs the design-review permission)'}</Label>
          <Label className={checkCls}><Checkbox checked={regen} onCheckedChange={v => setRegen(v === true)} />Regenerate drawings that are out of date</Label>
          <Label className={checkCls}><Checkbox checked={signDrawing} disabled={!canDrawing} onCheckedChange={v => setSignDrawing(v === true)} />Mark current drawings reviewed — I have checked the drawings of these parts{!canDrawing && ' (needs the drawing-review permission)'}</Label>
        </section>
        {err && <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">{err}</div>}
      </div>
      <ModalFooter><Button type="button" variant="outline" onClick={close}>Cancel</Button>
        <Button type="button" disabled={busy || !list.length} onClick={apply}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Apply to {list.length} part{list.length === 1 ? '' : 's'}</Button></ModalFooter>
    </Modal>
  );
}

