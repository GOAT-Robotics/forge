import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleHelp, X, FileText, ShieldCheck, Sparkles } from 'lucide-react';
import { categories, suggestions, RAL } from './constants';
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

const MANUAL: Record<string, { title: string; help: string; answers: string[] }> = {
  load_strength: { title: 'Strength & loads', help: 'Will the part survive its loads (static, fatigue, impact) with margin? Geometry alone cannot tell; an engineer confirms it.', answers: ['Verified: proven carry-over design, same loads as the previous revision', 'Verified: hand calculation / FEA attached to the design record', 'Not applicable: non-structural cover / bracket, no significant load'] },
  functional_gdt: { title: 'Functional dimensions & fits', help: 'Are the dimensions that matter for assembly (hole positions, mating faces, fits) toleranced and taken from the right datums?', answers: ['Verified: critical dimensions and fits toleranced on the drawing', 'Verified: general tolerance is sufficient, no functional fits', 'Not applicable: no mating features'] },
  threads: { title: 'Threads', help: 'Threads are never guessed from geometry. Confirm thread size, pitch, depth and which holes are tapped.', answers: ['Verified: all tapped holes called out with size, pitch and depth', 'Not applicable: no threaded features', 'Verified: threads come from inserts / PEM hardware, called out'] },
  process_tooling: { title: 'Process & tooling', help: 'Can the shop make it with normal tools: tool access, minimum radii, stock size, fixturing, deburring?', answers: ['Verified: standard tooling, checked with the vendor', 'Verified: same process as similar released parts', 'Verified: special tooling noted on the drawing'] },
  assembly: { title: 'Assembly', help: 'Fasteners, torque, sequence and how this part mates with its neighbours have been checked in the assembly.', answers: ['Verified in the CAD assembly: fasteners and clearances checked', 'Verified: assembly sequence and torque in the job order', 'Not applicable: stand-alone part'] },
  coating: { title: 'Coating effects', help: 'Coating adds thickness. Confirm fits, threads and contact faces are masked or allowed for.', answers: ['Verified: threads and bores masked, fits allow coating thickness', 'Not applicable: uncoated part', 'Verified: coating thickness within tolerance stack'] },
};

const DATUMS = [
  'A = bottom face, B = left edge, C = front edge (as drawn)',
  'A = mounting face, B = locating hole, C = second locating hole',
  'A = bend face (flat side), B/C = outer edges',
  'Not applicable: general tolerance only',
];

const procFor = (cat: string) => cat === 'sheet_metal' ? ['Laser cutting + CNC bending', 'Laser cutting', 'Sheet metal fabrication + welding', 'Waterjet cutting'] : cat === 'machining' ? ['CNC milling (3-axis)', 'CNC turning', 'Turn-mill', 'CNC milling (5-axis)', 'Wire EDM'] : suggestions.process.slice(0, 6);
const matFor = (cat: string) => cat === 'sheet_metal' ? ['Mild steel IS 513 CR2 (CRCA)', 'Stainless steel SS304 (X5CrNi18-10)', 'Aluminium 5052-H32', 'Mild steel HR IS 1079'] : ['Aluminium 6061-T6', 'Mild steel IS 2062 E250 BR', 'Alloy steel EN8 (080M40)', 'Stainless steel SS304 (X5CrNi18-10)', 'Alloy steel EN24 (817M40)'];

function Choice({ options, value, onPick, hint }: { options: string[]; value: string; onPick: (v: string) => void; hint?: string }) {
  return <div className="rw-choices">{options.map(o => <button type="button" key={o} className={value === o ? 'selected' : ''} onClick={() => onPick(o)}>{value === o && <Check size={13} />}{o}{hint === o && <em>from CAD</em>}</button>)}</div>;
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
      {purchased && <p className="rw-note"><ShieldCheck size={15} />Purchased parts are bought complete: they are left out of release checks, drawing sets and the assembly drawing. Save to finish.</p>}
    </>;
    if (step.id === 'material') return <>
      <Choice options={[...new Set([...(stepMat ? [stepMat] : []), ...matFor(category)])]} value={spec.material} onPick={v => set('material', v)} hint={stepMat} />
      <label className="rw-field">Or type the grade<input value={spec.material || ''} list="rw-materials" onChange={e => set('material', e.target.value)} placeholder="e.g. Aluminium 6082-T6" /></label>
      <datalist id="rw-materials">{suggestions.material.map(m => <option key={m} value={m} />)}</datalist>
      <label className="rw-field">Stock (optional)<input value={spec.stock || ''} list="rw-stock" onChange={e => set('stock', e.target.value)} placeholder={part.geometry?.thickness ? `Sheet ${part.geometry.thickness} mm` : 'Plate / bar size'} /></label>
      <datalist id="rw-stock">{suggestions.stock.map(m => <option key={m} value={m} />)}</datalist>
    </>;
    if (step.id === 'process') return <>
      <Choice options={procFor(category)} value={spec.process} onPick={v => set('process', v)} />
      <label className="rw-field">Or describe it<input value={spec.process || ''} list="rw-proc" onChange={e => set('process', e.target.value)} /></label>
      <datalist id="rw-proc">{suggestions.process.map(m => <option key={m} value={m} />)}</datalist>
    </>;
    if (step.id === 'finish') return <>
      <Choice options={suggestions.finish} value={spec.finish} onPick={v => set('finish', v)} />
      {/powder|paint/i.test(spec.finish || '') && <>
        <p className="rw-sub">Which colour?</p>
        <div className="rw-ral">{RAL.slice(0, 24).map(c => <button type="button" key={c.code} title={`${c.code} ${c.name}`} className={spec.coating_color === c.code ? 'selected' : ''} style={{ background: c.hex }} onClick={() => setSpec((s: Any) => ({ ...s, coating_color: c.code, coating_hex: c.hex }))} />)}</div>
        <p className="rw-sub">{spec.coating_color ? `${spec.coating_color} · ${RAL.find(c => c.code === spec.coating_color)?.name || ''}` : 'Pick a RAL colour'}</p>
        <Choice options={suggestions.coatingThickness.slice(0, 3)} value={spec.coating_thickness} onPick={v => set('coating_thickness', v)} />
        <Choice options={suggestions.masking} value={spec.masking} onPick={v => set('masking', v)} />
      </>}
    </>;
    if (step.id === 'tolerance') return <Choice options={[...new Set([tol, ...suggestions.tolerance])]} value={spec.general_tolerance} onPick={v => set('general_tolerance', v)} />;
    if (step.id === 'datums') return <>
      <Choice options={DATUMS} value={spec.datums} onPick={v => set('datums', v)} />
      <label className="rw-field">Or describe them<input value={spec.datums || ''} onChange={e => set('datums', e.target.value)} placeholder="A = …, B = …, C = …" /></label>
    </>;
    if (step.id === 'kfactor') return <>
      <div className="rw-row"><label className="rw-field">K-factor<input type="number" min={0.2} max={0.5} step={0.01} value={spec.k_factor ?? 0.4} onChange={e => set('k_factor', Number(e.target.value))} /></label>
        <div className="rw-presets">{[[0.33, 'Soft, tight bend'], [0.4, 'Typical mild steel'], [0.44, 'Stainless / large radius']].map(([v, l]) => <button type="button" key={v as number} className={spec.k_factor === v ? 'selected' : ''} onClick={() => set('k_factor', v)}><b>{v as number}</b><small>{l as string}</small></button>)}</div></div>
      <p className="rw-sub">{(part.geometry?.bends || []).length} bend(s) · thickness {part.geometry?.thickness || '?'} mm · inside radius {part.geometry?.bends?.[0]?.radius?.toFixed?.(2) || '?'} mm</p>
      <label className="rw-check"><input type="checkbox" checked={!!spec.k_factor_approved} onChange={e => set('k_factor_approved', e.target.checked)} />I confirmed this K-factor with the material, thickness and press tooling</label>
    </>;
    if (step.id.startsWith('check:')) {
      const k = step.id.slice(6);
      return <>
        <div className="rw-answers">{MANUAL[k].answers.map(a => <button type="button" key={a} className={spec.manual_checks?.[k] === a ? 'selected' : ''} onClick={() => check(k, a)}>{spec.manual_checks?.[k] === a && <Check size={13} />}{a}</button>)}</div>
        <label className="rw-field">Verification note (who / how)<textarea rows={2} value={spec.manual_checks?.[k] || ''} onChange={e => check(k, e.target.value)} placeholder="At least a short sentence: what was checked and how" /></label>
      </>;
    }
    if (step.id === 'warnings') return <div className="rw-warns">{warnings.map((f: Any) => {
      const key = f.code + (f.feature ? ':' + f.feature : '');
      return <div key={key} className="rw-warn"><b>{f.title}{f.feature ? ` · ${f.feature}` : ''}</b><small>{f.detail}</small>
        <div className="rw-answers inline">{['Accepted: vendor confirmed capability', 'Accepted: matches proven released part', 'Will change the CAD in the next revision'].map(a => <button type="button" key={a} className={spec.rule_waivers?.[key] === a ? 'selected' : ''} onClick={() => waive(key, a)}>{a}</button>)}</div>
        <input value={spec.rule_waivers?.[key] || ''} onChange={e => waive(key, e.target.value)} placeholder="Reason (min. 10 characters)" /></div>;
    })}</div>;
    if (step.id === 'design') {
      const missing = steps.filter(s => !['design', 'drawing'].includes(s.id) && !s.done(spec, part));
      return <>
        <div className="rw-summary">{[['Type', categories[category]], ['Material', spec.material], ['Process', spec.process], ['Finish', spec.finish + (spec.coating_color ? ` · ${spec.coating_color}` : '')], ['Tolerance', spec.general_tolerance], ['Datums', spec.datums]].map(([l, v]) => <div key={l}><span>{l}</span><b>{v || '—'}</b></div>)}</div>
        {missing.length ? <p className="rw-note warn">Still open: {missing.map(s => s.title).join(', ')}. Complete them before signing off.</p>
          : canReview ? <label className="rw-check big"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed this design and it is complete for production</label>
            : <p className="rw-note">A reviewer signs this off (your role cannot).</p>}
      </>;
    }
    if (step.id === 'drawing') return <>
      <button type="button" className="rw-big" onClick={onOpenDrawing}><FileText size={18} /><span><b>Open the drawing</b><small>Check views, dimensions, hole table, notes and title block.</small></span></button>
      {part.doc_reviewed ? <p className="rw-note ok"><Check size={15} />Drawing reviewed{part.doc_reviewed_by ? ` by ${part.doc_reviewed_by}` : ''}.</p>
        : <button type="button" className="primary" disabled={!canReview || saving} onClick={async () => { setSaving(true); try { await onDocReview(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); } }}><Check size={14} />Mark drawing reviewed</button>}
    </>;
    return null;
  };

  const allDone = doneCount === steps.length;
  return (
    <div className="overlay rw-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="rw" role="dialog" aria-modal="true" aria-label="Make production ready">
        <aside className="rw-steps">
          <header><Sparkles size={16} /><span><b>Production ready</b><small>{part.name}</small></span></header>
          <div className="rw-progress"><i style={{ width: `${Math.round(100 * doneCount / steps.length)}%` }} /></div>
          <small className="rw-count">{doneCount} of {steps.length} done</small>
          <ol>{steps.map((s, i) => { const d = s.done(spec, part); return <li key={s.id}><button type="button" className={(i === at ? 'active ' : '') + (d ? 'done' : '')} onClick={() => setAt(i)}><span>{d ? <Check size={12} /> : i + 1}</span>{s.title}</button></li>; })}</ol>
        </aside>
        <div className="rw-main">
          <header><span className="rw-eyebrow">Step {at + 1} of {steps.length} · {step?.title}</span><button type="button" className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
          <h2>{step?.question}</h2>
          <p className="rw-help"><CircleHelp size={15} />{step?.help}</p>
          <div className="rw-body">{body()}</div>
          {err && <p className="rw-note warn">{err}</p>}
          {allDone && <p className="rw-note ok"><ShieldCheck size={15} />This part is production ready. Release the revision from Overview once every part is.</p>}
          <footer>
            <button type="button" disabled={at === 0} onClick={() => setAt(at - 1)}><ChevronLeft size={15} />Back</button>
            <span />
            {step && step.id !== 'drawing' && <button type="button" disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>Skip</button>}
            {step && step.id !== 'drawing' ? <button type="button" className="primary" disabled={!editable || saving} onClick={() => save(true)}>{saving ? 'Saving…' : purchased && step.id === 'type' ? 'Save' : 'Save & next'}<ChevronRight size={15} /></button>
              : <button type="button" className="primary" onClick={onClose}>Done</button>}
          </footer>
        </div>
      </section>
    </div>
  );
}
