import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, LoaderCircle, Settings2, Sparkles } from 'lucide-react';
import { api } from './api';
import { Modal, ModalFooter } from './components';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { categories, suggestions, type Any } from './constants';
import { MANUAL, matFor, procFor } from './readiness';

const fields = [
  ['material', 'Material'], ['process', 'How should it be made?'], ['finish', 'Surface finish'],
  ['general_tolerance', 'General tolerance'], ['datums', 'Measurement reference'],
];
const blank = (v: unknown) => !String(v ?? '').trim();
const makePart = (p: Any) => !p.excluded && !['purchased', 'other'].includes(p.category);
const openBlockers = (p: Any) => (p.findings || []).filter((f: Any) => f.severity === 'blocker' && (!f.waiver || f.code === 'GEO001'));
const ready = (p: Any) => p.reviewed && p.doc_reviewed && !openBlockers(p).length;

export default function Prepare({ revision, parts, selection, busyJob, canDesign, canDrawing, canRelease, suspended, close, done, openPart, openDrawing, advanced, release }: {
  revision: string; parts: Any[]; selection: string[]; busyJob: boolean; canDesign: boolean; canDrawing: boolean; canRelease: boolean; suspended: boolean;
  close: () => void; done: () => Promise<void>; openPart: (id: string) => void; openDrawing: (id: string) => Promise<void>; advanced: () => void; release: () => void;
}) {
  const make = parts.filter(p => makePart(p) && (!selection.length || selection.includes(p.id)));
  const ids = make.map(p => p.id);
  const [answers, setAnswers] = useState<Record<string, Any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState(false);
  const started = useRef(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reviewNote, setReviewNote] = useState('');
  const [approveK, setApproveK] = useState(false);
  const [opened, setOpened] = useState<string[]>([]);
  const [showPrepared, setShowPrepared] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, Any>();
    for (const p of make) {
      // Keep different materials and manufacturing families separate; only fill empty fields.
      const key = JSON.stringify([p.category, p.spec?.material || '']);
      if (!by.has(key)) by.set(key, { key, category: p.category, material: p.spec?.material, parts: [] });
      by.get(key).parts.push(p);
    }
    return [...by.values()].map(g => ({ ...g, missing: fields.filter(([key]) => g.parts.some((p: Any) => blank(p.spec?.[key]))) })).filter(g => g.missing.length);
  }, [parts, selection.join()]);
  const complete = make.filter(ready);
  const essentials = make.filter(p => fields.some(([k]) => blank(p.spec?.[k])));
  const exceptions = make.filter(p => openBlockers(p).some((f: Any) => !f.code.startsWith('REVIEW_') && f.code !== 'BEND_K' && !f.code.startsWith('SPEC_'))
    || (p.findings || []).some((f: Any) => f.severity === 'warning' && !f.waiver));
  const bent = make.filter(p => p.geometry?.bends?.length && !p.spec?.k_factor_approved);
  const design = make.filter(p => !p.reviewed && !essentials.includes(p) && !exceptions.includes(p)
    && !openBlockers(p).some((f: Any) => !f.code.startsWith('REVIEW_') && f.code !== 'BEND_K'));
  const drawings = make.filter(p => p.reviewed && !p.doc_reviewed);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); await done(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const prepare = () => run(async () => {
    await api(`/revisions/${revision}/prepare`, 'POST', { ids, groups: groups.map(g => ({ ids: g.parts.map((p: Any) => p.id), fill: answers[g.key] || {} })) });
    setPrepared(true);
  });
  const review = () => run(async () => {
    const note = `Engineering review: ${reviewNote.trim()}`;
    await api(`/revisions/${revision}/parts/bulk-ready`, 'POST', {
      ids: design.map(p => p.id), manual_checks: Object.fromEntries(Object.keys(MANUAL).map(k => [k, note])),
      approve_k: approveK, design_review: true, regenerate: true,
    });
    setReviewNote(''); setApproveK(false);
  });
  useEffect(() => {
    if (started.current || busyJob || !ids.length) return;
    started.current = true;
    void prepare();
  }, [busyJob]);
  useEffect(() => { if (busyJob) setOpened([]); }, [busyJob]);
  const acceptWarnings = (p: Any) => run(async () => {
    await api(`/revisions/${revision}/parts/bulk-ready`, 'POST', { ids: [p.id], waive_warnings: reasons[p.id], regenerate: true });
  });
  const reviewDrawing = (id: string) => run(async () => {
    await api(`/parts/${id}/doc-review`, 'POST', { reviewed: true });
  });
  if (suspended) return null;
  return <Modal title="Prepare for manufacturing" subtitle={selection.length ? `${make.length} selected parts` : 'Forge handles the preparation. You make the decisions.'} wide close={close}>
    <div className="grid gap-5">
      <div className="rounded-xl border bg-subtle p-4" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="size-5 text-primary" />{!make.length ? 'Nothing to prepare' : complete.length === make.length ? 'Everything is ready to release' : `${make.length - essentials.length} of ${make.length} parts prepared`}</div>
        <p className="mt-1 text-sm text-muted-foreground">{busyJob ? 'Preparing drawings… This screen updates when they are ready.' : !make.length ? 'Purchased and excluded parts need no manufacturing preparation.' : essentials.length ? `${essentials.length} ${essentials.length === 1 ? "part needs" : "parts need"} manufacturing details. Set shared answers below.` : design.length ? `${design.length} ${design.length === 1 ? "part is" : "parts are"} prepared for your design review.` : drawings.length ? `${drawings.length} ${drawings.length === 1 ? "drawing needs" : "drawings need"} your review.` : exceptions.length ? `${exceptions.length} parts need a decision below.` : 'Release the revision when you are ready to send it to the shop.'}</p>
      </div>
      {groups.length > 0 && <div className="grid gap-4">
        <div><h3 className="font-medium">Set once for similar parts</h3><p className="text-sm text-muted-foreground">Existing CAD details and your saved choices are kept. Leave an answer blank to decide later.</p></div>
        {groups.map((g, i) => <section key={g.key} className="grid gap-3 rounded-lg border p-4">
          <div><h4 className="text-sm font-medium">{categories[g.category]}{g.material ? ` · ${g.material}` : ''} <span className="font-normal text-muted-foreground">· {g.parts.length} {g.parts.length === 1 ? 'part' : 'parts'}</span></h4><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Which parts?</summary><p className="mt-1">{g.parts.map((p: Any) => p.name).join(', ')}</p></details></div>
          <div className="grid gap-3 sm:grid-cols-2">{g.missing.map(([key, label]: string[]) => {
            const options = key === 'material' ? matFor(g.category) : key === 'process' ? procFor(g.category) : key === 'finish' ? suggestions.finish : [];
            return <Label key={key} className="grid gap-1.5 text-xs">{label}<Input list={`prepare-${i}-${key}`} value={answers[g.key]?.[key] || ''} placeholder={key === 'datums' ? 'e.g. A = mounting face, B/C = locating edges' : 'Choose or type an answer'} onChange={e => setAnswers(a => ({ ...a, [g.key]: { ...a[g.key], [key]: e.target.value } }))} /><datalist id={`prepare-${i}-${key}`}>{options.map((v: string) => <option key={v} value={v} />)}</datalist></Label>;
          })}</div>
        </section>)}
      </div>}
      {exceptions.length > 0 && <section className="grid gap-2"><h3 className="font-medium">Needs your attention</h3>{exceptions.map(p => {
        const blockers = openBlockers(p).filter((f: Any) => !f.code.startsWith('REVIEW_') && !f.code.startsWith('SPEC_') && f.code !== 'BEND_K');
        const warnings = (p.findings || []).filter((f: Any) => f.severity === 'warning' && !f.waiver);
        return <div className="grid gap-2 rounded-lg border p-3" key={p.id}><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-medium">{p.alias || p.name}</p><Button variant="outline" size="sm" onClick={() => openPart(p.id)}>Show part</Button></div>
          {[...blockers, ...warnings].map((f: Any) => <div key={f.code + f.feature} className="text-sm"><p>{f.title}{f.feature ? ` · ${f.feature}` : ''}</p><p className="text-xs text-muted-foreground">{f.detail}</p></div>)}
          {!blockers.length && warnings.length > 0 && <div className="flex flex-wrap gap-2"><Input aria-label={`Decision for ${p.name}`} className="min-w-40 flex-1" placeholder="If acceptable, explain why (or fix the source CAD)" value={reasons[p.id] || ''} onChange={e => setReasons(r => ({ ...r, [p.id]: e.target.value }))} /><Button size="sm" variant="outline" disabled={busy || busyJob || (reasons[p.id] || '').trim().length < 10} onClick={() => acceptWarnings(p)}>Accept with reason</Button></div>}
        </div>;
      })}</section>}
      {!essentials.length && design.length > 0 && <section className="grid gap-3 rounded-lg border p-4">
        <div><h3 className="font-medium">One engineering review · {design.length} {design.length === 1 ? 'part' : 'parts'}</h3><p className="mt-1 text-sm text-muted-foreground">Confirm the design covers loads, dimensions and fits, threads, tooling, assembly and coating. Your note records this review for each part.</p></div>
        <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">View prepared details</summary><div className="mt-2 grid gap-3">{design.map(p => <div key={p.id} className="rounded-md bg-subtle p-3"><p className="mb-2 font-medium">{p.alias || p.name}</p><dl className="grid gap-1 text-xs">{fields.map(([key, label]) => <div key={key} className="grid grid-cols-[140px_1fr] gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{p.spec?.[key] || '—'}</dd></div>)}</dl></div>)}</div></details>
        <Label className="grid gap-1.5 text-xs">Review note<Textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="What was checked, and how? Include any exceptions or supporting records." /></Label>
        {bent.some(p => design.includes(p)) && <Label className="text-sm font-normal"><Checkbox checked={approveK} onCheckedChange={v => setApproveK(v === true)} />The bend allowances for these parts are confirmed with the press shop.</Label>}
        <Button disabled={busy || busyJob || !canDesign || reviewNote.trim().length < 10 || (bent.some(p => design.includes(p)) && !approveK)} onClick={review}><CheckCircle2 />{design.length === 1 ? 'Approve design' : 'Approve these designs'}</Button>
        {!canDesign && <p className="text-xs text-muted-foreground">A design reviewer completes this step.</p>}
      </section>}
      {drawings.length > 0 && <section className="grid gap-2"><h3 className="font-medium">Review drawings</h3>{drawings.map(p => <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><span className="min-w-0 flex-1 truncate text-sm">{p.alias || p.name}</span><Button variant="outline" size="sm" disabled={busyJob || !p.assets?.includes('drawing.pdf')} onClick={() => run(async () => { await openDrawing(p.id); setOpened(a => [...new Set([...a, p.id])]); })}><FileText />Open drawing</Button><Button size="sm" disabled={busy || busyJob || !canDrawing || !opened.includes(p.id) || !p.assets?.includes('drawing.pdf')} onClick={() => reviewDrawing(p.id)}><CheckCircle2 />Approve drawing</Button></div>)}</section>}
      {complete.length > 0 && <details open={showPrepared} onToggle={e => setShowPrepared(e.currentTarget.open)} className="text-sm text-muted-foreground"><summary className="cursor-pointer">{complete.length} ready {complete.length === 1 ? 'part' : 'parts'}</summary><p className="mt-2">{complete.map(p => p.alias || p.name).join(', ')}</p></details>}
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-destructive">{error}</p>}
    </div>
    <ModalFooter><Button variant="ghost" onClick={advanced}><Settings2 />Advanced</Button><span className="flex-1" /><Button variant="outline" onClick={close}>Close</Button>{canRelease && parts.filter(makePart).every(ready) && <Button disabled={busy || busyJob} onClick={release}><CheckCircle2 />Review & release</Button>}{make.length > 0 && (groups.length > 0 || !prepared || drawings.some(p => !p.assets?.includes('drawing.pdf'))) && <Button disabled={busy || busyJob} onClick={prepare}>{busy || busyJob ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{prepared ? 'Save & prepare' : 'Prepare automatically'}</Button>}</ModalFooter>
  </Modal>;
}
