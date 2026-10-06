import React from 'react';
import type { Any } from './constants';
import { api } from './api';

/**
 * All seams between the given parts. The server searches pair by pair within a time budget per call; a large
 * selection (covers with hundreds of edges) takes several calls — keep calling with the finished pairs until
 * none are left. `onProgress` gets the seams so far, so they appear while the rest is searched.
 */
export async function findAllSeams(revision: string, parts: string[], onProgress?: (r: Any) => void, alive: () => boolean = () => true) {
  let done: string[] = [], seams: Any[] = [], r: Any = {}, notes: string[] = [];
  for (let call = 0; call < 40 && alive(); call++) {
    r = await api(`/revisions/${revision}/weld-seams`, 'POST', { parts, done });
    const keys = new Set(seams.map(s => s.key));
    seams = [...seams, ...(r.seams || []).filter((s: Any) => !keys.has(s.key))];
    if (r.message && r.partial) notes.push(r.message);
    if (!r.partial) break;
    done = r.done || [];
    onProgress?.({ ...r, seams, searched: (r.total || 0) - (r.pending || 0) });
  }
  const message = [...new Set([...notes, r.message].filter(Boolean))].join(' ');
  return { ...r, seams, partial: false, message: seams.length || message ? message : r.message };
}

export type Weldability = { level: 'good' | 'review' | 'blocked'; label: string; reason: string };

const metal = /steel|stainless|ss\b|alumin|iron|titan|inconel|copper|brass|bronze|nickel/i;
const nonMetal = /plastic|abs\b|nylon|pom\b|delrin|rubber|wood|frp|glass|carbon\s*fib/i;

export function weldability(part: Any): Weldability {
  const material = String(part?.spec?.material || '');
  if (part?.excluded) return { level: 'blocked', label: 'Not in production', reason: 'Restore this component before adding a production weld.' };
  if (nonMetal.test(material)) return { level: 'blocked', label: 'Not weldable', reason: `${material} is not compatible with the available metal-welding processes.` };
  if (metal.test(material)) return { level: 'good', label: 'Weldable', reason: `${material} is a recognised weldable metal; confirm grade and filler before release.` };
  if (part?.category === 'sheet_metal') return { level: 'review', label: 'Likely weldable', reason: 'Sheet-metal geometry detected, but material must be confirmed.' };
  if (part?.category === 'machining') return { level: 'review', label: 'Check material', reason: 'Machined components may be weldable; confirm alloy, heat treatment and distortion risk.' };
  return { level: 'review', label: 'Engineering check', reason: 'Material and joint preparation are not known yet.' };
}

function family(part: Any) {
  const m = String(part?.spec?.material || '').toLowerCase();
  if (/stainless|ss\b/.test(m)) return 'stainless steel';
  if (/alumin/.test(m)) return 'aluminium';
  if (/steel|iron/.test(m)) return 'carbon steel';
  if (/titan/.test(m)) return 'titanium';
  if (/copper|brass|bronze/.test(m)) return 'copper alloy';
  return m ? 'other metal' : 'unknown';
}

export function recommendWeld(parts: Any[], faces: Any[] = []) {
  const selected = parts.filter(Boolean);
  const thicknesses = selected.map(p => Number(p?.geometry?.thickness || 0)).filter(n => n > 0);
  const thin = thicknesses.length > 0 && Math.max(...thicknesses) <= 3;
  const largeFace = faces.some(f => Number(f.area || 0) > 20000);
  const type = thin && largeFace ? 'stitch' : 'linear';
  const process = thin ? 'Laser (52)' : 'MIG/MAG (135)';
  const families = new Set(selected.map(family).filter(x => x !== 'unknown'));
  const compatible = families.size <= 1;
  const typeReason = type === 'stitch'
    ? 'Thin sheet and a large selected area: intermittent beads reduce heat and distortion.'
    : 'Best starting point for a continuous structural seam or a closed bent-part seam.';
  const processReason = process === 'Laser (52)'
    ? 'Thin material detected: laser can minimise heat input when fit-up and access are controlled.'
    : 'General fabrication choice for thicker material and normal production fit-up.';
  return { type, process, typeReason, processReason, compatible, familyText: [...families].join(' + ') || 'material not confirmed' };
}

export function WeldSketch({ type }: { type: string }) {
  const segments = type === 'stitch' ? [[25, 40], [50, 65], [75, 90]] : [[22, 94]];
  return (
    <svg className="weld-sketch" viewBox="0 0 116 58" aria-hidden="true">
      <path d="M10 47 L50 14 L106 14" fill="none" stroke="currentColor" strokeWidth="2" opacity=".42" />
      <path d="M10 47 H106" fill="none" stroke="currentColor" strokeWidth="2" opacity=".42" />
      {(type === 'linear' || type === 'stitch') && segments.map(([a, b], i) => <path key={i} d={`M${a} 45 Q${(a + b) / 2} 34 ${b} 45`} fill="none" stroke="#ffb000" strokeWidth="7" strokeLinecap="round" />)}
      {type === 'patch' && <><rect x="48" y="25" width="28" height="20" rx="5" fill="#ffb000" opacity=".9" /><path d="M52 31h20M52 37h20" stroke="#6b2505" strokeWidth="2" /></>}
      {type === 'tack' && <><circle cx="48" cy="43" r="7" fill="#ffb000" /><circle cx="76" cy="43" r="7" fill="#ffb000" /></>}
    </svg>
  );
}

export const WELD_TYPE_HELP: Record<string, { title: string; use: string }> = {
  linear: { title: 'Continuous seam', use: 'One uninterrupted bead for strength or sealing.' },
  stitch: { title: 'Intermittent seam', use: 'Short repeated beads to reduce heat and distortion.' },
  patch: { title: 'Patch / area weld', use: 'Weld over a selected area; use only when the process specifies it.' },
  tack: { title: 'Tack weld', use: 'Small welds for positioning before the final seam.' },
};

// ============================================================================ Weld studio
/** Key identifying one seam edge on one occurrence. */
export const seamKey = (f: Any) => f.key ? `${f.part}|${f.occurrence || 0}|${f.key}` : `${f.part}|${f.occurrence || 0}|${f.index}`;

/** A detected seam as an edge selection saved on the weld. */
export const seamSelection = (s: Any) => ({
  part: s.part, occurrence: s.occurrence || 0, selection: 'edge', index: s.index, ...(s.key ? { key: s.key } : {}), type: s.type, start: s.start, end: s.end,
  length: s.length, boundaries: s.boundaries, joint: s.joint, legs: s.legs, normal: s.normal, other_part: s.other_part, other_occurrence: s.other_occurrence,
  ...(s.side ? { side: s.side } : {}), ...(s.legs_at ? { legs_at: s.legs_at } : {}), ...(s.access_local ? { access_local: s.access_local } : {}),
});

const seamWeld = (draft: Any, s: Any) => {
  const w = draft.weld || {};
  return { ...w, type: w.type === 'patch' || w.type === 'tack' ? 'linear' : (w.type || 'linear'), size: w.size || String(s?.size || 3), thickness: w.size || String(s?.size || 3) };
};
/** Add or remove one detected seam on a weld draft. */
export function toggleSeamOn(draft: Any, s: Any) {
  const k = seamKey(s);
  const edges = (draft.faces || []).filter((f: Any) => f.selection === 'edge');
  const on = edges.some((f: Any) => seamKey(f) === k);
  const faces = on ? edges.filter((f: Any) => seamKey(f) !== k) : [...edges, seamSelection(s)];
  const parts = [...new Set([...(draft.parts || []), s.part, s.other_part].filter(Boolean))];
  return { ...draft, parts, faces, weld: seamWeld(draft, s) };
}
/** Seams on the same side of the same joint as `s`: same parts, same inside/outside, welder works from the same direction. */
export function sameSide(seams: Any[], s: Any) {
  const a = s.access;
  return seams.filter(t => t.side === s.side
    && [t.part, t.other_part].sort().join() === [s.part, s.other_part].sort().join()
    && (!a || !t.access || a[0] * t.access[0] + a[1] * t.access[1] + a[2] * t.access[2] > 0.5));
}
/** Add seams to the draft (keeping what is already chosen). */
export function addSeams(draft: Any, list: Any[]) {
  const edges = (draft.faces || []).filter((f: Any) => f.selection === 'edge');
  const have = new Set(edges.map(seamKey));
  const extra = list.filter(s => !have.has(seamKey(s)));
  const parts = [...new Set([...(draft.parts || []), ...extra.flatMap(s => [s.part, s.other_part])].filter(Boolean))];
  return { ...draft, parts, faces: [...edges, ...extra.map(seamSelection)], weld: seamWeld(draft, extra[0] || list[0]) };
}
/** Replace the draft's seams with a list of detected seams. */
export function chooseSeams(draft: Any, list: Any[]) {
  const parts = [...new Set([...(draft.parts || []), ...list.flatMap(s => [s.part, s.other_part])].filter(Boolean))];
  return { ...draft, parts, faces: list.map(seamSelection), weld: seamWeld(draft, list[0]) };
}

const JOINT_LABEL: Record<string, string> = { fillet: 'Fillet (two faces at an angle)', gap: 'Gap seam (weld fills the gap)', corner: 'Outside corner', butt: 'Flush seam' };
const PROCESSES = [
  { id: 'MIG/MAG (135)', label: 'MIG/MAG', code: '135' },
  { id: 'TIG (141)', label: 'TIG', code: '141' },
  { id: 'Laser (52)', label: 'Laser', code: '52' },
  { id: 'MMA (111)', label: 'Stick', code: '111' },
];
export const processCode = (p: string) => (String(p || '').match(/\((\d+)\)/) || [])[1] || '';

/** ISO 2553 weld symbol for the current settings (arrow side, system A). */
export function WeldSymbol({ weld, seams, length }: { weld: Any; seams: Any[]; length: number }) {
  const type = weld.type || 'linear';
  const joint = seams.some(s => s.joint === 'butt') && !seams.some(s => s.joint !== 'butt') ? 'butt' : 'fillet';
  const a = weld.size || weld.thickness || '';
  const both = weld.sides === 'both';
  const around = weld.sides === 'all_around';
  const right = type === 'stitch' ? `${Math.max(1, Math.floor(length / Math.max(1, Number(weld.pitch || 50))))}×${weld.length || 25} (${weld.pitch || 50})` : type === 'tack' ? 'TACK' : type === 'patch' ? 'PATCH' : length ? `${Math.round(length)}` : '';
  const sym = (y: number, flip: boolean) => joint === 'butt'
    ? <path d={`M64 ${y} v${flip ? -9 : 9} M70 ${y} v${flip ? -9 : 9}`} stroke="currentColor" strokeWidth="1.6" />
    : <path d={`M62 ${y} v${flip ? -10 : 10} l10 ${flip ? 10 : -10} z`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />;
  return (
    <svg className="weld-symbol" viewBox="0 0 220 56" role="img" aria-label="ISO 2553 weld symbol">
      <path d="M8 46 L36 28" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 46 l9 -2 l-4 -5 z" fill="currentColor" />
      <path d="M36 28 H170" stroke="currentColor" strokeWidth="1.4" />
      <path d="M36 32 H170" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3" opacity=".45" />
      {around && <circle cx="36" cy="28" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />}
      {weld.field && <path d="M36 28 V12 l10 3 l-10 3" fill="currentColor" stroke="currentColor" strokeWidth="1.2" />}
      {sym(28, false)}
      {both && sym(28, true)}
      <text x="58" y="41" textAnchor="end" className="ws-t">{type === 'linear' || type === 'stitch' ? (joint === 'butt' ? '' : `a${a}`) : ''}</text>
      <text x="78" y="41" className="ws-t">{right}</text>
      {processCode(weld.process) && <><path d="M170 28 l10 -8 M170 28 l10 8" stroke="currentColor" strokeWidth="1.4" /><text x="184" y="32" className="ws-t">{processCode(weld.process)}{weld.quality ? ` / ${String(weld.quality).replace('ISO 5817-', '')}` : ''}</text></>}
    </svg>
  );
}

type StudioProps = {
  draft: Any; setDraft: (d: Any) => void; parts: Any[]; seams: Any[]; detecting: boolean; detectMessage: string;
  onDetect: () => void; hoverSeam: string | null; setHoverSeam: (id: string | null) => void;
  pickMode: string | null; setPickMode: (m: Any) => void; addingParts: boolean; setAddingParts: (v: boolean) => void;
  previewStatus?: { valid: boolean; message: string } | null;
  seamSide?: string; setSeamSide?: (v: string) => void;
};

export function WeldStudio({ draft, setDraft, parts, seams, detecting, detectMessage, onDetect, hoverSeam, setHoverSeam, pickMode, setPickMode, addingParts, setAddingParts, previewStatus, seamSide = 'all', setSeamSide }: StudioProps) {
  const w = draft.weld || {};
  const type = ['linear', 'stitch', 'tack', 'patch'].includes(w.type) ? w.type : 'linear';
  const setW = (patch: Any) => setDraft({ ...draft, weld: { ...w, ...patch } });
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  const chosen = new Set((draft.faces || []).filter((f: Any) => f.selection === 'edge').map(seamKey));
  const edgeFaces = (draft.faces || []).filter((f: Any) => f.selection === 'edge');
  const faceFaces = (draft.faces || []).filter((f: Any) => f.selection !== 'edge');
  const totalLength = edgeFaces.reduce((n: number, f: Any) => n + Number(f.length || 0), 0);
  const a = Number(w.size || w.thickness || 0);
  const sides = w.sides === 'both' ? 2 : 1;
  const welded = type === 'stitch' ? totalLength * Math.min(1, Number(w.length || 25) / Math.max(1, Number(w.pitch || 50))) : totalLength;
  const fillerGrams = a * a * welded * sides * 7.85e-3; // fillet area ≈ a² (mm²) × length × steel density
  const arcMinutes = welded * sides / (String(w.process).startsWith('Laser') ? 1500 : String(w.process).startsWith('TIG') ? 120 : 300);
  const selectedParts = (draft.parts || []).map((id: string) => parts.find(p => p.id === id)).filter(Boolean);
  const checks = selectedParts.map((p: Any) => ({ p, ...weldability(p) }));
  const blocked = checks.some((c: Any) => c.level === 'blocked');

  const toggleSeam = (s: Any) => setDraft(toggleSeamOn(draft, s));
  const setAll = (list: Any[]) => setDraft(chooseSeams(draft, list));
  const sideCount = (v: string) => seams.filter(s => s.side === v).length;
  const hasSides = sideCount('inside') > 0 && sideCount('outside') > 0;
  const shown = seamSide === 'all' || !hasSides ? seams : seams.filter(s => s.side === seamSide || chosen.has(seamKey(s)));
  const sideOnly = seamSide === 'all' || !hasSides ? seams : seams.filter(s => s.side === seamSide);
  const groups = ['fillet', 'gap', 'butt', 'corner'].map(j => ({ joint: j, items: shown.filter(s => s.joint === j) })).filter(g => g.items.length);

  return (
    <div className="weld-studio">
      <section className="ws-block">
        <header><b>1 · Components</b>{!draft.scopeLocked && <button type="button" className={'mini' + (addingParts ? ' selected' : '')} onClick={() => { setAddingParts(!addingParts); setPickMode(null); }}>{addingParts ? 'Done adding' : '+ Add from 3D'}</button>}</header>
        <div className="ws-chips">{checks.map((c: Any) => (
          <span key={c.p.id} className={'ws-chip ' + c.level} title={`${c.label}: ${c.reason}`}><i />{c.p.name}{!draft.scopeLocked && <button type="button" aria-label={'Remove ' + c.p.name} onClick={() => setDraft({ ...draft, parts: draft.parts.filter((x: string) => x !== c.p.id), faces: draft.faces.filter((f: Any) => f.part !== c.p.id && f.other_part !== c.p.id) })}>×</button>}</span>
        ))}{!checks.length && <small className="muted">Click the components to weld in the 3D view.</small>}</div>
        {addingParts && <p className="ws-hint">Click components in the 3D view to add or remove them. Seams are found where they touch.</p>}
        {blocked && <p className="weld-required">{checks.find((c: Any) => c.level === 'blocked')?.reason}</p>}
      </section>

      <section className="ws-block">
        <header><b>2 · Seams</b><span className="flex">{seams.length > 0 && <><button type="button" className="mini" title="Main inside fillets not welded yet" onClick={() => setAll(sideOnly.filter(s => !s.minor && s.joint === 'fillet' && !s.welded_by))}>Main</button><button type="button" className="mini" title={seamSide === 'all' ? 'Every seam not welded yet' : `Every ${seamSide} seam not welded yet`} onClick={() => setAll(sideOnly.filter(s => !s.welded_by))}>All</button><button type="button" className="mini" onClick={() => setAll([])}>None</button></>}<button type="button" className="mini primary-soft" disabled={detecting || (draft.parts || []).length < 1} onClick={onDetect}>{detecting ? 'Finding…' : seams.length ? 'Find all again' : 'Find all seams'}</button></span></header>
        <div className={'ws-pair' + (pickMode === 'face' ? ' on' : '')}>
          <button type="button" className={pickMode === 'face' ? 'selected' : ''} onClick={() => { setAddingParts(false); setPickMode(pickMode === 'face' ? null : 'face'); }}><b>Pick two faces</b><small>Face A, then face B — on any parts, or two faces of one part. Repeat for more seams.</small></button>
        </div>
        {!seams.length && !detecting && detectMessage && <p className="ws-hint">{detectMessage}</p>}
        {hasSides && <div className="ws-side">
          <span>Weld from</span>
          <div className="ws-seg">{[['all', 'Both sides', seams.length], ['inside', 'Inside', sideCount('inside')], ['outside', 'Outside', sideCount('outside')]].map(([v, l, n]) => (
            <button type="button" key={v as string} className={seamSide === v ? 'selected' : ''} title={v === 'inside' ? 'Seams facing the inside of these parts (towards their common centre)' : v === 'outside' ? 'Seams on the outer faces' : 'Seams on every side'} onClick={() => setSeamSide?.(v as string)}>{l}<small>{n}</small></button>
          ))}</div>
        </div>}
        {seams.length > 0 && <p className="ws-legend"><i className="lg-found" />found — click to add<i className="lg-chosen" />will be welded<span>Shift-click a seam in 3D to take its whole side</span></p>}
        {groups.map(g => (
          <div key={g.joint} className="ws-seam-group">
            <small>{JOINT_LABEL[g.joint]} · {g.items.length}</small>
            {g.items.map(s => (
              <label key={s.id} className={'ws-seam' + (hoverSeam === s.id ? ' hot' : '') + (s.minor ? ' minor' : '')} onMouseEnter={() => setHoverSeam(s.id)} onMouseLeave={() => setHoverSeam(null)}>
                <input type="checkbox" checked={chosen.has(seamKey(s))} onChange={() => toggleSeam(s)} />
                <b>{s.id}</b>
                <span title={`${s.part_name || named(s.part)} → ${s.other_name || named(s.other_part)}`}>{hasSides && s.side && <em className={'ws-sidetag ' + s.side}>{s.side === 'inside' ? 'in' : 'out'}</em>}{s.part === s.other_part && s.occurrence === s.other_occurrence ? <><em>{s.part_name || named(s.part)}</em> · closes on itself</> : <><em>{s.part_name || named(s.part)}</em> → {s.other_name || named(s.other_part)}</>}</span>
                <i>{s.gap ? <em className="ws-gap" title="Air gap the weld bridges">{s.gap} mm gap</em> : null}{s.welded_by ? <em className="ws-welded" title={`Already welded in ${s.welded_by}`}>{s.welded_by}</em> : null}{fmtLen(s.length)}</i>
              </label>
            ))}
          </div>
        ))}
        <div className="ws-manual">
          <span>Also:</span>
          <button type="button" className={'mini' + (pickMode === 'edge' ? ' selected' : '')} disabled={type === 'patch' || type === 'tack'} onClick={() => { setAddingParts(false); setPickMode(pickMode === 'edge' ? null : 'edge'); }}>Pick edges</button>

          {(edgeFaces.length > 0 || faceFaces.length > 0) && <button type="button" className="mini" onClick={() => setDraft({ ...draft, faces: [], weld: { ...w, placement: null } })}>Clear</button>}
        </div>
        {faceFaces.length > 0 && (type === 'patch' || type === 'tack') && <p className="ws-hint">{faceFaces.length} face{faceFaces.length === 1 ? '' : 's'} picked.</p>}
      </section>

      <section className="ws-block">
        <header><b>3 · Weld</b></header>
        <div className="ws-seg">{[['linear', 'Continuous'], ['stitch', 'Stitch'], ['tack', 'Tack'], ['patch', 'Patch']].map(([id, label]) => (
          <button type="button" key={id} className={type === id ? 'selected' : ''} title={WELD_TYPE_HELP[id]?.use} onClick={() => {
            const next: Any = { ...draft, weld: { ...w, type: id, length: id === 'stitch' ? (w.length || '25') : id === 'tack' ? (w.length || '6') : w.length, pitch: id === 'stitch' ? (w.pitch || '50') : w.pitch, width: id === 'tack' ? (w.width || '4') : w.width, placement: id === 'tack' ? w.placement : null } };
            if (id === 'tack' || id === 'patch') { next.faces = faceFaces; setPickMode('face'); }
            setDraft(next);
          }}>{label}</button>
        ))}</div>
        <div className="ws-seg ws-proc">{PROCESSES.map(p => <button type="button" key={p.id} className={w.process === p.id ? 'selected' : ''} onClick={() => setW({ process: p.id })}>{p.label}<small>{p.code}</small></button>)}</div>
        <div className="ws-fields">
          {(type === 'linear' || type === 'stitch') && <label>Throat a<span className="ws-num"><input type="number" min="0.5" max="30" step="0.5" placeholder="auto" value={w.size || w.thickness || ''} onChange={e => setW({ size: e.target.value, thickness: e.target.value })} /><i>mm</i></span></label>}
          {type === 'stitch' && <><label>Segment<span className="ws-num"><input type="number" min="5" max="500" step="5" value={w.length || '25'} onChange={e => setW({ length: e.target.value })} /><i>mm</i></span></label><label>Pitch<span className="ws-num"><input type="number" min="10" max="1000" step="5" value={w.pitch || '50'} onChange={e => setW({ pitch: e.target.value })} /><i>mm</i></span></label></>}
          {type === 'tack' && <><label>Width<span className="ws-num"><input type="number" min="1" max="20" step="0.5" value={w.width || '4'} onChange={e => setW({ width: e.target.value })} /><i>mm</i></span></label><label>Length<span className="ws-num"><input type="number" min="1" max="50" step="0.5" value={w.length || '6'} onChange={e => setW({ length: e.target.value })} /><i>mm</i></span></label></>}
          {(type === 'linear' || type === 'stitch') && <label>Sides<select value={w.sides || 'one'} onChange={e => setW({ sides: e.target.value })}><option value="one">Arrow side</option><option value="both">Both sides</option><option value="all_around">All around</option></select></label>}
          <label>Quality<select value={w.quality || ''} onChange={e => setW({ quality: e.target.value })}><option value="">—</option><option value="ISO 5817-B">ISO 5817 B</option><option value="ISO 5817-C">ISO 5817 C</option><option value="ISO 5817-D">ISO 5817 D</option></select></label>
          <label>Filler<input value={w.filler || ''} placeholder="ER70S-6" onChange={e => setW({ filler: e.target.value })} /></label>
        </div>
        <label className="ws-check"><input type="checkbox" checked={!!w.field} onChange={e => setW({ field: e.target.checked })} />Site / field weld</label>
        {type === 'tack' && <p className="ws-hint">{faceFaces.length < 2 ? 'Pick the two mating faces, then click where the tack goes.' : w.placement ? 'Tack placed — click again to move it.' : 'Click on a picked face to place the tack.'} <button type="button" className="mini" disabled={faceFaces.length < 2} onClick={() => setPickMode('point')}>Place tack</button></p>}
        {type === 'patch' && <p className="ws-hint">Pick the faces the patch weld covers.</p>}
      </section>

      <section className="ws-block ws-summary">
        <WeldSymbol weld={{ ...w, type }} seams={edgeFaces} length={totalLength} />
        {(type === 'linear' || type === 'stitch') && edgeFaces.length > 0 && <div className="ws-stats">
          <span><b>{edgeFaces.length}</b>seam{edgeFaces.length === 1 ? '' : 's'}</span>
          <span><b>{fmtLen(welded * sides)}</b>weld length</span>
          {a > 0 && <span><b>{fillerGrams >= 1000 ? (fillerGrams / 1000).toFixed(2) + ' kg' : Math.round(fillerGrams) + ' g'}</b>filler (est.)</span>}
          <span><b>{arcMinutes < 1 ? '<1' : Math.round(arcMinutes)} min</b>arc time</span>
        </div>}
      </section>
    </div>
  );
}

export const fmtLen = (mm: number) => mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`;
