import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleHelp, X, FileText, ShieldCheck, Sparkles } from 'lucide-react';
import { categories, suggestions, RAL } from './constants';
import { Combo } from './controls';
import { Progress } from './shell';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { Any } from './constants';

/**
 * "Make production ready": a guided walkthrough for one part. Each step asks one question in plain words,
 * explains what it means for the shop, offers the usual answers as one-click choices and saves as you go.
 * Steps cover exactly what the release check needs: specification fields, bend allowance, the six
 * engineering verifications, accepted warnings, design review and drawing review.
 */
type Step = {
  id: string; title: string; question: string; help: string;
  done: (s: Any, p: Any) => boolean; show?: (p: Any, s: Any) => boolean;
};

export const MANUAL: Record<string, { title: string; help: string; answers: string[] }> = {
  load_strength: { title: 'Strength & loads', help: 'Will the part survive its loads (static, fatigue, impact) with margin? Geometry alone cannot tell; an engineer confirms it.', answers: ['Verified: proven carry-over design, same loads as the previous revision', 'Verified: hand calculation / FEA attached to the design record', 'Not applicable: non-structural cover / bracket, no significant load'] },
  functional_gdt: { title: 'Functional dimensions & fits', help: 'Are the dimensions that matter for assembly (hole positions, mating faces, fits) toleranced and taken from the right datums?', answers: ['Verified: critical dimensions and fits toleranced on the drawing', 'Verified: general tolerance is sufficient, no functional fits', 'Not applicable: no mating features'] },
  threads: { title: 'Threads', help: 'Threads are never guessed from geometry. Confirm thread size, pitch, depth and which holes are tapped.', answers: ['Verified: all tapped holes called out with size, pitch and depth', 'Not applicable: no threaded features', 'Verified: threads come from inserts / PEM hardware, called out'] },
  process_tooling: { title: 'Process & tooling', help: 'Can the shop make it with normal tools: tool access, minimum radii, stock size, fixturing, deburring?', answers: ['Verified: standard tooling, checked with the vendor', 'Verified: same process as similar released parts', 'Verified: special tooling noted on the drawing'] },
  assembly: { title: 'Assembly', help: 'Fasteners, torque, sequence and how this part mates with its neighbours have been checked in the assembly.', answers: ['Verified in the CAD assembly: fasteners and clearances checked', 'Verified: assembly sequence and torque in the job order', 'Not applicable: stand-alone part'] },
  coating: { title: 'Coating effects', help: 'Coating adds thickness. Confirm fits, threads and contact faces are masked or allowed for.', answers: ['Verified: threads and bores masked, fits allow coating thickness', 'Not applicable: uncoated part', 'Verified: coating thickness within tolerance stack'] },
};

export const DATUMS = [
  'A = bottom face, B = left edge, C = front edge (as drawn)',
  'A = mounting face, B = locating hole, C = second locating hole',
  'A = bend face (flat side), B/C = outer edges',
  'Not applicable: general tolerance only',
];

export const procFor = (cat: string) => cat === 'sheet_metal' ? ['Laser cutting + CNC bending', 'Laser cutting', 'Sheet metal fabrication + welding', 'Waterjet cutting'] : cat === 'machining' ? ['CNC milling (3-axis)', 'CNC turning', 'Turn-mill', 'CNC milling (5-axis)', 'Wire EDM'] : suggestions.process.slice(0, 6);
export const matFor = (cat: string) => cat === 'sheet_metal' ? ['Mild steel IS 513 CR2 (CRCA)', 'Stainless steel SS304 (X5CrNi18-10)', 'Aluminium 5052-H32', 'Mild steel HR IS 1079'] : ['Aluminium 6061-T6', 'Mild steel IS 2062 E250 BR', 'Alloy steel EN8 (080M40)', 'Stainless steel SS304 (X5CrNi18-10)', 'Alloy steel EN24 (817M40)'];

/** Outlined answer button; selected → accent outline and tint. */
const choiceCls = (on: boolean) => cn('h-auto min-h-8 justify-start py-1.5 text-left font-normal whitespace-normal', on && 'border-primary bg-selection text-selection-foreground ring-1 ring-primary ring-inset hover:bg-selection hover:text-selection-foreground');
const fieldCls = 'mb-3 grid gap-1.5 text-xs leading-snug';
const note = 'my-2 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0';
const noteWarn = cn(note, 'border-warning/30 bg-warning-soft text-warning');
const noteOk = cn(note, 'border-success/30 bg-success-soft text-success');
const noteInfo = cn(note, 'bg-subtle text-foreground');

function Choice({ options, value, onPick, hint }: { options: string[]; value: string; onPick: (v: string) => void; hint?: string }) {
  return <div className="mb-3 flex flex-wrap gap-2">{options.map(o => <Button type="button" variant="outline" key={o} className={choiceCls(value === o)} onClick={() => onPick(o)}>{value === o && <Check className="size-3.5" />}{o}{hint === o && <em className="rounded-full bg-success-soft px-1.5 py-px text-2xs font-medium not-italic text-success">from CAD</em>}</Button>)}</div>;
}

export function ReadinessWizard({ part, settings, editable, canReview, onSave, onDocReview, onOpenDrawing, onClose }: {
  part: Any; settings: Any; editable: boolean; canReview: boolean;
  onSave: (spec: Any, category: string, reviewed: boolean) => Promise<void>;
  onDocReview: () => Promise<void>; onOpenDrawing: () => void; onClose: () => void;
}) {
  const [spec, setSpec] = useState<Any>(() => JSON.parse(JSON.stringify(part.spec)));
  const [category, setCategory] = useState<string>(part.category);
  const [reviewed, setReviewed] = useState<boolean>(!!part.reviewed);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: string, v: Any) => setSpec((s: Any) => ({ ...s, [k]: v }));
  const warnings = (part.findings || []).filter((f: Any) => f.severity === 'warning');
  const tol = settings?.conventions?.general_tolerance || 'ISO 2768-mK';
  const stepMat = part.geometry?.step?.material;

  const steps: Step[] = useMemo((): Step[] => ([
    { id: 'type', title: 'Part type', question: 'How is this part sourced and made?', help: 'The type decides the checks, the drawing style and the job-order routing. Purchased parts are bought complete and skip manufacturing release.', done: () => !!category },
    { id: 'material', title: 'Material', question: 'What is it made of?', help: 'The exact grade goes on the drawing and purchase order. A material read from the STEP file is only a hint until you confirm it.', done: (s: Any) => !!String(s.material || '').trim() },
    { id: 'process', title: 'Process', question: 'How will the shop make it?', help: 'The main manufacturing route. Detailed operations (deburr, tap, coat…) can come from a process template.', done: (s: Any) => !!String(s.process || '').trim() },
    { id: 'finish', title: 'Finish & coating', question: 'What surface finish does it need?', help: 'Finish affects corrosion, appearance and fit. Powder coat adds 60–100 µm; mask threads and bores.', done: (s: Any) => !!String(s.finish || '').trim() },
    { id: 'tolerance', title: 'General tolerance', question: 'Which tolerance applies where nothing else is stated?', help: `Every dimension without its own tolerance follows this standard. Your project default is ${tol}.`, done: (s: Any) => !!String(s.general_tolerance || '').trim() },
    { id: 'datums', title: 'Datums', question: 'Which faces does the shop measure from?', help: 'Datums are the reference faces / holes for measuring. Pick the faces that locate the part in its assembly.', done: (s: Any) => !!String(s.datums || '').trim() },
    { id: 'kfactor', title: 'Bend allowance', question: 'Is the K-factor right for this material and press brake?', help: 'The flat blank length depends on the K-factor (where the neutral axis sits in the bend). Confirm it with the bending vendor for this material and thickness.', done: (s: Any) => !!s.k_factor_approved, show: () => (part.geometry?.bends || []).length > 0 },
    ...Object.entries(MANUAL).map(([k, m]) => ({ id: 'check:' + k, title: m.title, question: m.title + ' — verified?', help: m.help, done: (s: Any) => String(s.manual_checks?.[k] || '').trim().length >= 10 })),
    { id: 'warnings', title: 'Warnings', question: 'Accept or fix these manufacturability warnings', help: 'Warnings do not block release, but each one should be a conscious decision with a short reason.', done: (s: Any) => warnings.every((f: Any) => String(s.rule_waivers?.[f.code + (f.feature ? ':' + f.feature : '')] || '').trim().length >= 10), show: () => warnings.length > 0 },
    { id: 'design', title: 'Design review', question: 'Sign off the design', help: 'You confirm the specification above is complete and correct for production.', done: () => reviewed },
    { id: 'drawing', title: 'Drawing review', question: 'Check the drawing and sign it off', help: 'Open the drawing, check views, dimensions, hole table and notes, then mark it reviewed.', done: () => !!part.doc_reviewed },
  ] as Step[]).filter(s => !s.show || s.show(part, spec)), [part, spec, category, reviewed, warnings.length]);

  const firstOpen = steps.findIndex(s => !s.done(spec, part));
  const [at, setAt] = useState(Math.max(0, firstOpen));
  useEffect(() => { if (at >= steps.length) setAt(steps.length - 1); }, [steps.length]);
  const step = steps[at];
  const doneCount = steps.filter(s => s.done(spec, part)).length;
  const purchased = category === 'purchased';

  const save = async (next = true) => {
    setErr(''); setSaving(true);
    try {
      await onSave(spec, category, reviewed);
      if (next) setAt(i => Math.min(steps.length - 1, i + 1));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const check = (k: string, v: string) => set('manual_checks', { ...(spec.manual_checks || {}), [k]: v });
  const waive = (key: string, v: string) => set('rule_waivers', { ...(spec.rule_waivers || {}), [key]: v });

  const body = () => {
    if (!step) return null;
    if (step.id === 'type') return <>
      <Choice options={Object.values(categories)} value={categories[category]} onPick={v => setCategory(Object.entries(categories).find(([, l]) => l === v)?.[0] || category)} />
      {purchased && <p className={noteInfo}><ShieldCheck />Purchased parts are bought complete: they are left out of release checks, drawing sets and the assembly drawing. Save to finish.</p>}
    </>;
    if (step.id === 'material') return <>
      <Choice options={[...new Set([...(stepMat ? [stepMat] : []), ...matFor(category)])]} value={spec.material} onPick={v => set('material', v)} hint={stepMat} />
      <div className={fieldCls}><span className="font-medium">Or type the grade</span><Combo aria-label="Or type the grade" value={spec.material || ''} suggestions={suggestions.material} onChange={v => set('material', v)} placeholder="e.g. Aluminium 6082-T6" /></div>
      <div className={fieldCls}><span className="font-medium">Stock (optional)</span><Combo aria-label="Stock (optional)" value={spec.stock || ''} suggestions={suggestions.stock} onChange={v => set('stock', v)} placeholder={part.geometry?.thickness ? `Sheet ${part.geometry.thickness} mm` : 'Plate / bar size'} /></div>
    </>;
    if (step.id === 'process') return <>
      <Choice options={procFor(category)} value={spec.process} onPick={v => set('process', v)} />
      <div className={fieldCls}><span className="font-medium">Or describe it</span><Combo aria-label="Or describe it" value={spec.process || ''} suggestions={suggestions.process} onChange={v => set('process', v)} /></div>
    </>;
    if (step.id === 'finish') return <>
      <Choice options={suggestions.finish} value={spec.finish} onPick={v => set('finish', v)} />
      {/powder|paint/i.test(spec.finish || '') && <>
        <p className="mt-1 mb-2 text-xs text-muted-foreground">Which colour?</p>
        <div className="mb-1 grid grid-cols-[repeat(12,28px)] gap-1.5">{RAL.slice(0, 24).map(c => <Button type="button" variant="ghost" size="icon-sm" key={c.code} title={`${c.code} ${c.name}`} aria-label={`${c.code} ${c.name}`} className={cn('ring-1 ring-black/10 ring-inset dark:ring-white/15', spec.coating_color === c.code && 'outline-2 outline-offset-2 outline-primary')} style={{ background: c.hex }} onClick={() => setSpec((s: Any) => ({ ...s, coating_color: c.code, coating_hex: c.hex }))} />)}</div>
        <p className="mt-1 mb-2 text-xs text-muted-foreground">{spec.coating_color ? `${spec.coating_color} · ${RAL.find(c => c.code === spec.coating_color)?.name || ''}` : 'Pick a RAL colour'}</p>
        <Choice options={suggestions.coatingThickness.slice(0, 3)} value={spec.coating_thickness} onPick={v => set('coating_thickness', v)} />
        <Choice options={suggestions.masking} value={spec.masking} onPick={v => set('masking', v)} />
      </>}
    </>;
    if (step.id === 'tolerance') return <Choice options={[...new Set([tol, ...suggestions.tolerance])]} value={spec.general_tolerance} onPick={v => set('general_tolerance', v)} />;
    if (step.id === 'datums') return <>
      <Choice options={DATUMS} value={spec.datums} onPick={v => set('datums', v)} />
      <Label className={fieldCls}>Or describe them<Input value={spec.datums || ''} onChange={e => set('datums', e.target.value)} placeholder="A = …, B = …, C = …" /></Label>
    </>;
    if (step.id === 'kfactor') return <>
      <div className="flex flex-wrap items-end gap-3.5"><Label className={cn(fieldCls, 'w-32')}>K-factor<Input type="number" min={0.2} max={0.5} step={0.01} className="tabular-nums" value={spec.k_factor ?? 0.4} onChange={e => set('k_factor', Number(e.target.value))} /></Label>
        <div className="mb-3 flex gap-2">{[[0.33, 'Soft, tight bend'], [0.4, 'Typical mild steel'], [0.44, 'Stainless / large radius']].map(([v, l]) => <Button type="button" variant="outline" key={v as number} className={cn(choiceCls(spec.k_factor === v), 'flex-col items-start gap-0')} onClick={() => set('k_factor', v)}><span className="font-medium tabular-nums">{v as number}</span><small className="text-2xs text-muted-foreground">{l as string}</small></Button>)}</div></div>
      <p className="mt-1 mb-2 text-xs text-muted-foreground">{(part.geometry?.bends || []).length} bend(s) · thickness {part.geometry?.thickness || '?'} mm · inside radius {part.geometry?.bends?.[0]?.radius?.toFixed?.(2) || '?'} mm</p>
      <Label className="my-2 font-normal leading-snug"><Checkbox checked={!!spec.k_factor_approved} onCheckedChange={v => set('k_factor_approved', v === true)} />I confirmed this K-factor with the material, thickness and press tooling</Label>
    </>;
    if (step.id.startsWith('check:')) {
      const k = step.id.slice(6);
      return <>
        <div className="mb-3 flex flex-col gap-2">{MANUAL[k].answers.map(a => <Button type="button" variant="outline" key={a} className={choiceCls(spec.manual_checks?.[k] === a)} onClick={() => check(k, a)}>{spec.manual_checks?.[k] === a && <Check className="size-3.5" />}{a}</Button>)}</div>
        <Label className={fieldCls}>Verification note (who / how)<Textarea rows={2} className="min-h-0 text-sm text-foreground" value={spec.manual_checks?.[k] || ''} onChange={e => check(k, e.target.value)} placeholder="At least a short sentence: what was checked and how" /></Label>
      </>;
    }
    if (step.id === 'warnings') return <div className="flex flex-col gap-2.5">{warnings.map((f: Any) => {
      const key = f.code + (f.feature ? ':' + f.feature : '');
      return <div key={key} className="rounded-lg border bg-card px-3 py-2.5"><div className="text-sm font-medium">{f.title}{f.feature ? ` · ${f.feature}` : ''}</div><small className="mt-0.5 block text-xs text-muted-foreground">{f.detail}</small>
        <div className="my-2 flex flex-wrap gap-2">{['Accepted: vendor confirmed capability', 'Accepted: matches proven released part', 'Will change the CAD in the next revision'].map(a => <Button type="button" variant="outline" size="sm" key={a} className={choiceCls(spec.rule_waivers?.[key] === a)} onClick={() => waive(key, a)}>{a}</Button>)}</div>
        <Input value={spec.rule_waivers?.[key] || ''} onChange={e => waive(key, e.target.value)} placeholder="Reason (min. 10 characters)" /></div>;
    })}</div>;
    if (step.id === 'design') {
      const missing = steps.filter(s => !['design', 'drawing'].includes(s.id) && !s.done(spec, part));
      return <>
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-card px-3.5 py-3">{[['Type', categories[category]], ['Material', spec.material], ['Process', spec.process], ['Finish', spec.finish + (spec.coating_color ? ` · ${spec.coating_color}` : '')], ['Tolerance', spec.general_tolerance], ['Datums', spec.datums]].map(([l, v]) => <div key={l} className="min-w-0"><span className="block text-2xs font-medium uppercase tracking-wider text-faint">{l}</span><span className="text-sm text-foreground">{v || '—'}</span></div>)}</div>
        {missing.length ? <p className={noteWarn}>Still open: {missing.map(s => s.title).join(', ')}. Complete them before signing off.</p>
          : canReview ? <Label className="rounded-lg border px-3.5 py-3 text-base font-medium leading-snug hover:bg-accent/50"><Checkbox checked={reviewed} onCheckedChange={v => setReviewed(v === true)} />I reviewed this design and it is complete for production</Label>
            : <p className={noteInfo}>A reviewer signs this off (your role cannot).</p>}
      </>;
    }
    if (step.id === 'drawing') return <>
      <Button type="button" variant="outline" className="mb-3 h-auto w-full justify-start gap-3 bg-subtle px-4 py-3.5 text-left whitespace-normal" onClick={onOpenDrawing}><FileText className="size-[18px] text-primary" /><span><span className="block text-base font-medium">Open the drawing</span><small className="block text-xs font-normal text-muted-foreground">Check views, dimensions, hole table, notes and title block.</small></span></Button>
      {part.doc_reviewed ? <p className={noteOk}><Check />Drawing reviewed{part.doc_reviewed_by ? ` by ${part.doc_reviewed_by}` : ''}.</p>
        : <Button type="button" disabled={!canReview || saving} onClick={async () => { setSaving(true); try { await onDocReview(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); } }}><Check />Mark drawing reviewed</Button>}
    </>;
    return null;
  };

  const allDone = doneCount === steps.length;
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent aria-modal="true" aria-label="Make production ready" showCloseButton={false}
        onInteractOutside={e => { const t = e.target as HTMLElement; if (t?.closest?.('#popover-root, [data-sonner-toaster]')) e.preventDefault(); }}
        className="grid h-[min(680px,calc(100vh-40px))] w-[min(980px,calc(100vw-32px))] max-w-none grid-cols-[250px_1fr] gap-0 overflow-hidden rounded-xl bg-card p-0 shadow-pop sm:max-w-none">
        <DialogTitle className="sr-only">Make production ready</DialogTitle>
        <DialogDescription className="sr-only">{part.name}</DialogDescription>
        <aside className="flex min-h-0 flex-col border-r bg-subtle px-3 py-4">
          <header className="flex items-start gap-2.5 px-1 pb-3"><Sparkles className="mt-0.5 size-4 shrink-0 text-primary" /><span className="min-w-0"><span className="block text-base font-semibold">Production ready</span><small className="block text-xs [overflow-wrap:anywhere] text-muted-foreground">{part.name}</small></span></header>
          <div className="px-1"><Progress value={Math.round(100 * doneCount / steps.length)} tone="success" /></div>
          <small className="mx-1 mt-1.5 mb-2.5 text-xs text-muted-foreground tabular-nums">{doneCount} of {steps.length} done</small>
          <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">{steps.map((s, i) => { const d = s.done(spec, part); const on = i === at; return <li key={s.id}><Button type="button" variant="ghost" aria-current={on ? 'step' : undefined} className={cn('h-auto w-full justify-start gap-2.5 px-2 py-1.5 text-left font-normal whitespace-normal', on && 'bg-selection font-medium text-selection-foreground hover:bg-selection hover:text-selection-foreground')} onClick={() => setAt(i)}><span className={cn('grid size-5 shrink-0 place-items-center rounded-full border text-2xs font-medium tabular-nums', d ? 'border-success bg-success text-white' : on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>{d ? <Check className="size-3" /> : i + 1}</span>{s.title}</Button></li>; })}</ol>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col px-6 pt-4 pb-4">
          <header className="flex items-center justify-between"><span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Step {at + 1} of {steps.length} · {step?.title}</span><Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}><X /></Button></header>
          <h2 className="mt-1.5 mb-1.5 text-xl font-semibold tracking-tight">{step?.question}</h2>
          <p className="mb-3.5 flex items-start gap-2 rounded-md bg-selection px-3 py-2.5 text-sm leading-relaxed text-foreground"><CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" />{step?.help}</p>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">{body()}</div>
          {err && <p className={noteWarn}>{err}</p>}
          {allDone && <p className={noteOk}><ShieldCheck />This part is production ready. Release the revision from Overview once every part is.</p>}
          <footer className="mt-2 flex items-center gap-2 border-t pt-3">
            <Button type="button" variant="outline" disabled={at === 0} onClick={() => setAt(at - 1)}><ChevronLeft />Back</Button>
            <span className="flex-1" />
            {step && step.id !== 'drawing' && <Button type="button" variant="ghost" disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>Skip</Button>}
            {step && step.id !== 'drawing' ? <Button type="button" disabled={!editable || saving} onClick={() => save(true)}>{saving ? 'Saving…' : purchased && step.id === 'type' ? 'Save' : 'Save & next'}<ChevronRight /></Button>
              : <Button type="button" onClick={onClose}>Done</Button>}
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
