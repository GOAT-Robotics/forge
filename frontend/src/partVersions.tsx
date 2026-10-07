import React, { useEffect, useRef, useState } from 'react';
import { Upload, FileUp, History, Check, AlertTriangle, LoaderCircle, Download, Eye, RotateCcw, Crosshair, RefreshCw, Layers3, X } from 'lucide-react';
import { api, headers } from './api';
import { date, fmt, flatReason } from './constants';
import type { Any } from './constants';
import { Modal, ModalFooter, Badge } from './components';
import { Progress } from './shell';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

/** One flat-pattern problem located on the part (backend unfold.py `issue()`). */
export type FlatIssue = { kind: string; title: string; detail: string; fix: string; point: number[] | null; outlines: number[][][] };

const CAD_ACCEPT = '.step,.stp,.igs,.iges,.brep,.brp';

/** Chunked, resumable upload of a replacement file for one part (same transport as revision uploads). */
async function uploadReplacement(projectId: string, partId: string, file: File, note: string, onProgress: (p: number) => void) {
  const errorOf = async (r: Response) => {
    const t = await r.text().catch(() => '');
    try { const j = JSON.parse(t); if (typeof j.detail === 'string') return j.detail; } catch { /* proxy HTML */ }
    return r.status === 413 ? 'The server or proxy rejected the upload size (HTTP 413)' : `Upload failed (HTTP ${r.status})`;
  };
  const start = await api(`/projects/${projectId}/uploads`, 'POST', { filename: file.name, size: file.size, notes: note, part_id: partId });
  const { upload_id: id, chunk_size: size, chunks } = start;
  let sent = 0;
  for (let i = 0; i < chunks; i++) {
    const blob = file.slice(i * size, Math.min(file.size, (i + 1) * size));
    for (let attempt = 1; ; attempt++) {
      let r: Response | null = null;
      try { r = await fetch(`/api/uploads/${id}/chunks/${i}`, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: blob }); } catch { r = null; }
      if (r && r.ok) break;
      if (r && r.status < 500 && ![408, 429].includes(r.status)) throw new Error(await errorOf(r));
      if (attempt >= 5) throw new Error(r ? await errorOf(r) : 'Upload failed: the connection keeps dropping. Check the network and try again.');
      await new Promise(res => setTimeout(res, 1000 * 2 ** (attempt - 1)));
    }
    sent += blob.size; onProgress(Math.round(sent / file.size * 100));
  }
  return api(`/uploads/${id}/complete`, 'POST');
}

/** Replace this part's geometry inside the current revision. */
export function ReplaceDialog({ part, projectId, close, onQueued }: { part: Any; projectId: string; close: () => void; onQueued: (r: Any) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (f?: File | null) => { if (!f) return; setErr(''); if (!/\.(step|stp|igs|iges|brep|brp)$/i.test(f.name)) { setErr('Use a STEP, IGES or BREP file of this one part.'); return; } setFile(f); };
  const go = async () => {
    if (!file) return;
    setErr(''); setPct(0);
    try { onQueued(await uploadReplacement(projectId, part.id, file, note.trim(), setPct)); close(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPct(null); }
  };
  const v = part.version;
  return (
    <Modal title="Replace part geometry" subtitle={`${part.alias ? part.alias + ' — ' : ''}${part.name} · stays in this revision`} close={() => pct === null && close()}>
      <div className="grid gap-4">
        <button type="button" className={cn('grid min-h-[132px] place-items-center rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors', over ? 'border-primary bg-selection' : file ? 'border-success/50 bg-success/5' : 'border-border hover:border-primary/50 hover:bg-accent')}
          onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }} disabled={pct !== null}>
          {file ? <span className="grid justify-items-center gap-1"><FileUp className="size-6 text-success" /><span className="text-sm font-medium [overflow-wrap:anywhere]">{file.name}</span><small className="text-xs text-muted-foreground">{(file.size / 1e6).toFixed(file.size > 1e7 ? 0 : 1)} MB · click to choose another</small></span>
            : <span className="grid justify-items-center gap-1"><Upload className="size-6 text-muted-foreground" /><span className="text-sm font-medium">Drop the part's STEP here, or click to choose</span><small className="text-xs text-muted-foreground">One solid body, exported in the part's own coordinates</small></span>}
        </button>
        <input ref={input} type="file" accept={CAD_ACCEPT} className="hidden" onChange={e => pick(e.target.files?.[0])} />
        <Label className="grid gap-1.5 text-sm">What changed <span className="text-xs font-normal text-muted-foreground">(optional, kept with the version)</span>
          <Textarea rows={2} value={note} maxLength={2000} placeholder="e.g. corner reliefs added at the flange kinks" onChange={e => setNote(e.target.value)} /></Label>
        <ul className="grid gap-1.5 rounded-lg bg-subtle p-3 text-xs leading-relaxed text-muted-foreground">
          <li className="flex gap-2"><Check className="mt-px size-3.5 shrink-0 text-success" />Name, alias, type, material, finish and process stay. Welds and assembly steps stay attached.</li>
          <li className="flex gap-2"><Check className="mt-px size-3.5 shrink-0 text-success" />Features, flat pattern and drawings are rebuilt from the new geometry.</li>
          <li className="flex gap-2"><History className="mt-px size-3.5 shrink-0" />Version {v?.active || 1} and its drawings are kept and can be downloaded or brought back from History.</li>
          <li className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />Design and drawing reviews reset. If the shape changed, per-feature limits and waivers are cleared.</li>
        </ul>
        {pct !== null && <div className="grid gap-1.5"><div className="flex justify-between text-xs text-muted-foreground"><span>Uploading…</span><span className="tabular-nums">{pct}%</span></div><Progress value={pct} /></div>}
        {err && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">{err}</p>}
      </div>
      <ModalFooter><Button type="button" variant="outline" onClick={close} disabled={pct !== null}>Cancel</Button><Button type="button" disabled={!file || pct !== null} onClick={go}>{pct !== null ? <LoaderCircle className="animate-spin" /> : <Upload />}Replace geometry</Button></ModalFooter>
    </Modal>
  );
}

/** Every geometry version of a part: the active one is used everywhere, the others are kept for reference. */
export function VersionsDialog({ part, editable, canCad, busy, close, onActivate, preview }: {
  part: Any; editable: boolean; canCad: boolean; busy: boolean; close: () => void;
  onActivate: (v: Any) => void; preview: (path: string, name: string, title?: string) => void;
}) {
  const [list, setList] = useState<Any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/parts/${part.id}/versions`).then(r => setList(r.versions)).catch(e => setErr(String(e?.message || e))); }, [part.id, part.version?.active, part.version?.count, part.version?.processing]);
  const FILES: [string, string, boolean][] = [['drawing.pdf', 'Drawing PDF', true], ['drawing.dxf', 'Drawing DXF', false], ['flat.dxf', 'Flat DXF', false], ['part.step', 'STEP', false]];
  return (
    <Modal wide title="Geometry versions" subtitle={`${part.alias ? part.alias + ' — ' : ''}${part.name}`} close={close}>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {!list && !err && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading versions…</p>}
      {list && <ol className="grid gap-2">{[...list].reverse().map(v => {
        const reason = v.flat_status && v.flat_status !== 'supported' && v.flat_status !== 'not_applicable' ? flatReason(v.flat_message) : null;
        return (
          <li key={v.id} className={cn('grid gap-2 rounded-lg border p-3', v.active && 'border-primary/40 bg-selection/40')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">v{v.number}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium" title={v.filename}>{v.filename || 'Revision import'}</span>
                <small className="text-xs text-muted-foreground">{v.created ? date(v.created) : ''}{v.author ? ` · ${v.author}` : ''}{v.note ? ` · ${v.note}` : ''}</small></span>
              {v.active ? <Badge kind="success">In use</Badge> : v.status === 'processing' ? <Badge kind="warning">Processing</Badge> : v.status === 'failed' ? <Badge kind="danger">Failed</Badge> : <Badge kind="neutral">Kept</Badge>}
              {!v.active && v.status === 'ready' && editable && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onActivate(v)}><RotateCcw />Use this version</Button>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {v.dimensions && <span>{v.dimensions.map((d: number) => fmt(Math.round(d * 10) / 10)).join(' × ')} mm</span>}
              {v.thickness ? <span>t {fmt(v.thickness)} mm</span> : null}
              {v.mass_kg !== undefined && v.mass_kg !== null && <span>{fmt(v.mass_kg)} kg</span>}
              <span>{v.bends} bends · {v.holes} holes</span>
              {v.flat_status === 'supported' && <span className="text-success">Flat pattern OK</span>}
              {reason && <span className="text-warning" title={v.flat_message}>Flat: {reason.reason}</span>}
            </div>
            {v.status === 'failed' && v.message && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-destructive">{v.message}</p>}
            {(v.warnings || []).map((w: string, i: number) => <p key={i} className="flex gap-1.5 text-xs text-warning"><AlertTriangle className="mt-px size-3.5 shrink-0" />{w}</p>)}
            {!v.active && v.files?.length > 0 && <div className="flex flex-wrap gap-1.5">{FILES.filter(([f]) => v.files.includes(f) && (f === 'drawing.pdf' || canCad)).map(([f, label, pv]) =>
              <Button key={f} type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={() => preview(`/parts/${part.id}/versions/${v.id}/files/${f}`, `${part.name}_v${v.number}_${f}`, pv ? `${label} — ${part.name} (v${v.number})` : undefined)}>{pv ? <Eye /> : <Download />}{label}</Button>)}</div>}
            {v.active && <p className="text-xs text-muted-foreground">Current files are on the Documents tab.</p>}
          </li>
        );
      })}</ol>}
      <ModalFooter note="Earlier versions are kept with their own drawings but never used in packs, job orders or the viewer unless you bring them back."><Button type="button" variant="outline" onClick={close}>Close</Button></ModalFooter>
    </Modal>
  );
}

/** Part panel card: which CAD the part comes from, with replace / history. */
export function CadSourceRow({ part, editable, busy, onReplace, onHistory }: { part: Any; editable: boolean; busy: boolean; onReplace: () => void; onHistory: () => void }) {
  const v = part.version;
  return (
    <div className="grid gap-1.5 px-4 pb-3">
      <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <Layers3 className="size-4 shrink-0 text-muted-foreground" />
        <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate text-xs font-medium">{v ? `Version ${v.active} of ${v.count}` : 'Version 1'}{v?.processing && <span className="ml-1.5 font-normal text-warning">· replacement processing…</span>}</span>
          <small className="truncate text-2xs text-muted-foreground" title={v?.filename}>{v && v.active > 1 ? `${v.filename} · ${v.at ? date(v.at) : ''}${v.by ? ' · ' + v.by : ''}` : 'From the revision import'}</small></span>
        {v && v.count > 1 && <Button type="button" variant="ghost" size="xs" onClick={onHistory} title="All geometry versions of this part"><History />History</Button>}
        {editable && <Button type="button" variant="outline" size="xs" disabled={busy || v?.processing} onClick={onReplace} title="Upload a new STEP for this part — stays in this revision"><Upload />Replace</Button>}
      </div>
      {v?.failed && !v.processing && <p className="flex gap-1.5 text-2xs text-destructive"><X className="mt-px size-3 shrink-0" />Last replacement ({v.failed}) failed — see History.</p>}
    </div>
  );
}

/** Why the flat pattern was not developed: numbered issues that match the markers in the 3D view.
 *  Compact by default (one line + toggle) so the part panel below stays reachable; the list scrolls on its own. */
export function FlatIssuesCard({ part, issues, active, onActive, onPin, pinned, editable, busy, onRecheck, onReplace }: {
  part: Any; issues: FlatIssue[]; active: number | null; onActive: (i: number | null) => void; pinned: number | null; onPin: (i: number | null) => void;
  editable: boolean; busy: boolean; onRecheck: () => void; onReplace: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [part.id]);
  const fallback = flatReason(part.geometry.flat_message || (part.geometry.bends?.length ? '' : 'No bends detected'));
  const kinds = [...new Set(issues.map(i => i.title.replace(/\s*\d+.*$/, '').replace(/ at corner$/, '')))];
  return (
    <div className="mx-4 mb-3 shrink-0 overflow-hidden rounded-lg border border-warning/40">
      <button type="button" className="flex w-full items-start gap-2.5 bg-warning-soft px-3 py-2 text-left text-warning" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">Flat pattern not generated</span>
          <span className="block truncate text-xs text-foreground/75">{issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'} · ${kinds.slice(0, 2).join(', ')}` : fallback?.reason}</span></span>
        <span className="mt-0.5 shrink-0 text-xs font-medium">{open ? 'Hide' : issues.length ? 'Show' : 'Why'}</span>
      </button>
      {open && (issues.length > 0 ? <ol className="max-h-[240px] divide-y overflow-y-auto overscroll-contain" onMouseLeave={() => onActive(null)}>{issues.map((it, i) => {
        const on = active === i || pinned === i;
        return (
          <li key={i} className={cn('cursor-pointer px-3 py-2 transition-colors', on ? 'bg-danger-soft/60' : 'hover:bg-accent')} onMouseEnter={() => onActive(i)} onClick={() => onPin(pinned === i ? null : i)}>
            <div className="flex items-start gap-2.5">
              <span className={cn('mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white tabular-nums', on ? 'bg-destructive' : 'bg-warning')}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">{it.title}{pinned === i && <Crosshair className="size-3.5 text-destructive" />}</div>
                {on ? <><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{it.detail}</p><p className="mt-1 text-xs leading-relaxed text-foreground"><b className="font-medium">Fix:</b> {it.fix}</p></>
                  : <p className="truncate text-xs text-muted-foreground">{it.detail}</p>}
              </div>
            </div>
          </li>);
      })}</ol> : fallback && <p className="px-3 py-2 text-xs leading-relaxed"><b className="font-medium">Fix:</b> {fallback.fix} <span className="mt-1 block font-mono text-2xs text-muted-foreground">{fallback.raw}</span></p>)}
      {open && <div className="flex flex-wrap items-center gap-1.5 border-t bg-subtle px-3 py-1.5">
        {editable && <Button type="button" size="xs" onClick={onReplace} disabled={busy}><Upload />Replace with corrected STEP</Button>}
        <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onRecheck} title="Run the unfolder again"><RefreshCw />Re-check</Button>
      </div>}
    </div>
  );
}
