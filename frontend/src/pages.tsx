import React, { useEffect, useMemo, useState } from 'react';
import {
  Grid2x2,
  Plus, ArrowUp, ArrowDown, Trash2, Check, AlertTriangle, CheckCircle2, ChevronRight, ChevronDown, ClipboardList, Factory, Flame, Clock,
  Pause, Play, X, Users, Library, FileText, ShieldCheck, Layers, Box, MessageSquareWarning, Link2, Crosshair,
} from 'lucide-react';
import { api } from './api';
import NestingDialog from './nesting';
import { Badge, Modal, ask } from './components';
import { Select } from './controls';
import { categories, date, fmt } from './constants';
import type { Any } from './constants';
import { PageHeader, Progress, Empty, Avatar } from './shell';
import { weldability, WeldStudio, fmtLen } from './welding';

const when = (s: string) => s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
export const joNumber = (j: Any) => `${j.project_code ? j.project_code + '-' : ''}JO-${String(j.number).padStart(3, '0')}`;
const STATUS_TONE: Record<string, string> = { open: 'neutral', in_progress: 'accent', on_hold: 'warning', completed: 'success', cancelled: 'neutral', pending: 'neutral', blocked: 'danger', done: 'success' };
// ============================================================================ Deadlines
const dayNo = (s: string) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const todayNo = () => { const t = new Date(); return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 86400000; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Days to the deadline, finished early / late, and whether progress keeps pace with the time used. */
export function deadline(j: Any) {
  if (!j?.due) return { label: 'No deadline', tone: 'muted', days: null as number | null, pace: '' };
  const due = dayNo(j.due);
  if (j.status === 'cancelled') return { label: 'Cancelled', tone: 'muted', days: null, pace: '' };
  if (j.status === 'completed') {
    const late = (j.closed ? dayNo(j.closed) : todayNo()) - due;
    return { label: late > 0 ? `Finished ${plural(late, 'day')} late` : late < 0 ? `Finished ${plural(-late, 'day')} early` : 'Finished on the due date', tone: late > 0 ? 'danger' : 'success', days: null, pace: '' };
  }
  const days = due - todayNo();
  const label = days < 0 ? `${plural(-days, 'day')} overdue` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `${days} days left`;
  const tone = days < 0 ? 'danger' : days <= 3 ? 'warning' : 'neutral';
  let pace = '';
  if (j.created && days >= 0) {
    const start = dayNo(j.created), total = Math.max(1, due - start), used = Math.min(total, Math.max(0, todayNo() - start));
    const expected = Math.round(100 * used / total);
    pace = j.progress + 10 < expected ? `Behind schedule — ${expected}% of the time used, ${Math.round(j.progress)}% done` : used > 0 ? 'On track' : '';
  }
  return { label, tone, days, pace };
}
export function DeadlineCell({ j }: { j: Any }) {
  const d = deadline(j);
  if (!j.due) return <span className="muted">—</span>;
  return <><span className={'deadline ' + d.tone}>{d.label}</span><small>{date(j.due)}{d.pace.startsWith('Behind') ? ' · behind schedule' : ''}</small></>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={STATUS_TONE[status] || 'neutral'}>{status.replace('_', ' ')}</Badge>;
}
const splitList = (v: Any) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x: string) => x.trim()).filter(Boolean);
const joinList = (v: Any) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

type Ctx = { busy: boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void };

// ============================================================================ Dashboard
export function Dashboard({ openJobOrder, openProject, ctx }: { openJobOrder: (id: string) => void; openProject: (id: string, tab?: string) => void; ctx: Ctx }) {
  const [d, setD] = useState<Any>(null);
  useEffect(() => {
    let on = true;
    const load = () => api('/dashboard').then(x => on && setD(x)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => { on = false; clearInterval(t); };
  }, []);
  if (!d) return <div className="v-page"><PageHeader title="Dashboard" /><p className="muted padded">Loading…</p></div>;
  const s = d.summary;
  const active = d.job_orders.filter((j: Any) => ['open', 'in_progress', 'on_hold'].includes(j.status));
  return (
    <div className="v-page">
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${d.user.name.split(' ')[0]}`} description="Design readiness and shop-floor progress across projects." />
      <div className="v-body">
        <div className="v-stats">
          <div><span>Active job orders</span><b>{s.active}</b></div>
          <div className={s.overdue ? 'danger' : ''}><span>Overdue</span><b>{s.overdue}</b></div>
          <div><span>On hold</span><b>{s.on_hold}</b></div>
          <div><span>Units recorded today</span><b>{s.done_today}</b></div>
          <div><span>Completed (30 days)</span><b>{s.completed_30d}</b></div>
          <div className={s.open_issues ? 'warning' : ''}><span>Open shop-floor issues</span><b>{s.open_issues}</b></div>
        </div>
        <div className="v-grid-2">
          <section className="v-card span-2">
            <header><h3>Job order progress</h3><small>{active.length} active</small></header>
            {active.length ? (
              <table className="v-table">
                <thead><tr><th>Job order</th><th>Project</th><th>Qty</th><th>Due</th><th>Status</th><th style={{ width: '28%' }}>Progress</th></tr></thead>
                <tbody>{active.map((j: Any) => (
                  <tr key={j.id} className="click" onClick={() => openJobOrder(j.id)}>
                    <td><b>{joNumber(j)}</b><small>{j.title}</small></td>
                    <td>{j.project_name}<small>Rev {j.revision_number}</small></td>
                    <td className="tabular">{j.quantity}</td>
                    <td><DeadlineCell j={j} /></td>
                    <td><StatusBadge status={j.status} />{j.priority !== 'normal' && <Badge kind={j.priority === 'urgent' ? 'danger' : j.priority === 'high' ? 'warning' : 'neutral'}>{j.priority}</Badge>}</td>
                    <td><div className="v-progress-row"><Progress value={j.progress} tone={j.overdue ? 'danger' : ''} /><span className="tabular">{Math.round(j.progress)}%</span></div><small>{j.parts_done}/{j.parts_total} parts finished{j.rejected ? ` · ${j.rejected} rejected` : ''}</small></td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <Empty icon={<ClipboardList />} title="No active job orders">Create one from a production-ready project.</Empty>}
          </section>
          <section className="v-card">
            <header><h3>Design readiness</h3><small>Active revisions</small></header>
            {d.design.map((p: Any) => {
              const total = Math.max(1, p.parts);
              return (
                <button key={p.id} className="v-list-row" onClick={() => openProject(p.id)}>
                  <span className="grow"><b>{p.code ? p.code + ' · ' : ''}{p.name}</b><small>Rev {p.number} · {p.status === 'released' ? 'Production ready' : p.status.replace('_', ' ')}{p.open_comments ? ` · ${p.open_comments} open comments` : ''}</small></span>
                  <span className="v-mini-bars"><span title="Design review"><Progress value={100 * p.reviewed / total} /><small>{p.reviewed}/{p.parts} design</small></span><span title="Drawing review"><Progress value={100 * p.docs_reviewed / total} /><small>{p.docs_reviewed}/{p.parts} drawings</small></span></span>
                </button>
              );
            })}
            {!d.design.length && <p className="muted padded">No projects yet.</p>}
          </section>
          <section className="v-card">
            <header><h3>Shop-floor issues</h3><small>Raised from job orders → design review</small></header>
            {d.issues.map((c: Any) => (
              <button key={c.id} className="v-list-row" onClick={() => openProject(c.project_id, 'review')}>
                <MessageSquareWarning className="amber" /><span className="grow"><b>{c.part_name || 'Assembly'}</b><small>{c.body}</small><small>{c.author} · {when(c.created)}</small></span>
              </button>
            ))}
            {!d.issues.length && <p className="muted padded">No open issues.</p>}
          </section>
          <section className="v-card span-2">
            <header><h3>Recent shop-floor activity</h3></header>
            <div className="v-feed">
              {d.events.map((e: Any) => (
                <div key={e.id}><Avatar name={e.actor} size={22} /><span><b>{e.actor}</b> {e.action.startsWith('status:') ? `set JO-${String(e.number).padStart(3, '0')} to ${e.action.slice(7).replace('_', ' ')}` : e.action === 'created' ? `created JO-${String(e.number).padStart(3, '0')} · ${e.title}` : e.action === 'issue' ? `raised an issue on JO-${String(e.number).padStart(3, '0')}` : `recorded ${e.quantity > 0 ? '+' : ''}${e.quantity} on JO-${String(e.number).padStart(3, '0')} (${e.action.replace('_', ' ')})`}{e.note && <small>{e.note}</small>}</span><time>{when(e.created)}</time></div>
              ))}
              {!d.events.length && <p className="muted padded">Nothing recorded yet.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ============================================================================ Job orders
type JoScope = 'all' | 'sheet_metal' | 'machining' | 'selected' | 'custom';
export function JobOrderDialog({ projects, projectId, close, onCreated, ctx, selection, title }: { projects: Any[]; projectId?: string; close: () => void; onCreated: (jo: Any) => void; ctx: Ctx; selection?: { id: string; name: string }[]; title?: string }) {
  const [pid, setPid] = useState(projectId || projects.find(p => p.active_status === 'released')?.id || projects[0]?.id || '');
  const [project, setProject] = useState<Any>(null);
  const [rev, setRev] = useState<Any>(null);
  const [form, setForm] = useState<Any>({ title: title || '', quantity: 1, due: '', priority: 'normal', customer: '', requirement: '', include_purchased: true });
  const [mode, setMode] = useState<JoScope>(selection?.length ? 'selected' : 'all');
  const [qty, setQty] = useState<Record<string, number>>({});        // custom quantities (part id → count)
  const [picked, setPicked] = useState<Set<string>>(new Set());       // custom scope: ticked parts
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!pid) return;
    setRev(null);
    api('/projects/' + pid).then(async p => {
      setProject(p);
      const released = p.revisions.find((r: Any) => r.status === 'released');
      if (released) setRev(await api('/revisions/' + released.id));
    }).catch(() => {});
  }, [pid]);
  const make = (rev?.parts || []).filter((p: Any) => !p.excluded && p.category !== 'purchased');
  // parts picked in the model may come from a newer revision: match them to the released one by id, then by name
  const selectedIds = useMemo(() => {
    if (!selection?.length || !rev) return new Set<string>();
    const byName = new Map<string, string>(make.map((p: Any) => [p.name, p.id]));
    return new Set<string>(selection.map(s => make.some((p: Any) => p.id === s.id) ? s.id : byName.get(s.name) || '').filter(Boolean));
  }, [selection, rev]);
  const inScope = (p: Any) => mode === 'all' ? true : mode === 'sheet_metal' || mode === 'machining' ? p.category === mode : mode === 'selected' ? selectedIds.has(p.id) : picked.has(p.id);
  const scoped = make.filter(inScope);
  const per = (p: Any) => qty[p.id] ?? p.quantity * Number(form.quantity || 1);
  const missed = (selection?.length || 0) - selectedIds.size;
  const count = (k: JoScope) => k === 'all' ? make.length : k === 'selected' ? selectedIds.size : k === 'custom' ? picked.size : make.filter((p: Any) => p.category === k).length;
  const scopes: [JoScope, string][] = [['all', 'Everything'], ['sheet_metal', 'Sheet metal'], ['machining', 'Machining'], ...(selection?.length ? [['selected', 'Selected in model'] as [JoScope, string]] : []), ['custom', 'Choose parts']];
  const list = mode === 'custom' ? make.filter((p: Any) => !filter || (p.name + ' ' + (p.alias || '')).toLowerCase().includes(filter.toLowerCase())) : scoped;
  return (
    <Modal title="New job order" subtitle="Creates the production and process checklists from the production-ready revision" wide close={close}>
      <form onSubmit={e => { e.preventDefault(); ctx.action(async () => {
        const custom = mode !== 'all' || Object.keys(qty).length > 0;
        const body = { ...form, quantity: Number(form.quantity), revision_id: rev.id, include_purchased: mode === 'all' ? form.include_purchased : false,
          parts: custom ? scoped.map((p: Any) => ({ part_id: p.id, quantity: per(p) })).filter((x: Any) => x.quantity > 0) : null };
        const jo = await api(`/projects/${pid}/job-orders`, 'POST', body); onCreated(jo);
      }); }}>
        <div className="form-grid">
          <label>Project<Select value={pid} onChange={setPid} options={projects.map(p => ({ value: p.id, label: (p.code ? p.code + ' · ' : '') + p.name, hint: p.active_status === 'released' ? 'ready' : 'not ready' }))} /></label>
          <label>Title<input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Lifter batch 3 — customer trial" /></label>
          <label>Build quantity (assemblies)<input type="number" min={1} required value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></label>
          <label>Due date<input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} /></label>
          <label>Priority<Select value={form.priority} onChange={v => setForm({ ...form, priority: v })} options={['low', 'normal', 'high', 'urgent'].map(v => ({ value: v, label: v }))} /></label>
          <label>Customer / reference<input value={form.customer} onChange={e => setForm({ ...form, customer: e.target.value })} /></label>
        </div>
        <label>Requirement<textarea value={form.requirement} onChange={e => setForm({ ...form, requirement: e.target.value })} placeholder="What this order must deliver: variants, finish, packing, inspection level, delivery…" /></label>
        {!project ? <p className="muted">Loading project…</p> : !rev ? (
          <div className="notice"><ShieldCheck size={17} />{project.name} has no production-ready revision. Complete the design checks and drawing reviews, then release the revision.</div>
        ) : (
          <div className="jo-scope">
            <div className="jo-scope-head"><b>What to make</b><small>Revision {rev.number}</small></div>
            <div className="v-segment">{scopes.map(([k, l]) => <button type="button" key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{l} <small>{count(k)}</small></button>)}</div>
            {mode === 'selected' && missed > 0 && <p className="muted">{missed} selected part{missed === 1 ? ' is' : 's are'} not in the released revision (or purchased / not for production) and left out.</p>}
            {mode === 'all' && <label className="check"><input type="checkbox" checked={form.include_purchased} onChange={e => setForm({ ...form, include_purchased: e.target.checked })} />Include procurement lines for purchased parts, and assembly / welding lines</label>}
            {mode === 'custom' && <input className="jo-scope-search" placeholder="Find a part or alias…" value={filter} onChange={e => setFilter(e.target.value)} />}
            <div className="v-scope">{list.map((p: Any) => (
              <label key={p.id} className="v-scope-row">
                {mode === 'custom' && <input type="checkbox" checked={picked.has(p.id)} onChange={e => setPicked(x => { const y = new Set(x); if (e.target.checked) y.add(p.id); else y.delete(p.id); return y; })} />}
                <span><b>{p.alias && <span className="alias-chip">{p.alias}</span>}{p.name}</b><small>{categories[p.category]} · {p.quantity} per assembly</small></span>
                <input type="number" min={0} value={per(p)} disabled={mode === 'custom' && !picked.has(p.id)} onChange={e => setQty({ ...qty, [p.id]: Number(e.target.value) })} />
              </label>
            ))}{!list.length && <p className="muted padded">No parts in this scope.</p>}</div>
            <small className="muted">{scoped.length} part{scoped.length === 1 ? '' : 's'} · {scoped.reduce((n: number, p: Any) => n + per(p), 0)} pieces{mode !== 'all' ? ' · assembly / welding lines only for welds inside these parts' : ''}</small>
          </div>
        )}
        <div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={ctx.busy || !rev || !scoped.length}><Plus size={15} />Create job order</button></div>
      </form>
    </Modal>
  );
}

export function JobOrdersPage({ projects, openJobOrder, ctx, perms, projectId }: { projects: Any[]; openJobOrder: (id: string) => void; ctx: Ctx; perms: Set<string>; projectId?: string }) {
  const [rows, setRows] = useState<Any[] | null>(null);
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const load = () => api(projectId ? `/projects/${projectId}/job-orders` : '/job-orders').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [projectId]);
  const shown = (rows || []).filter(j => status === 'all' || (status === 'active' ? ['open', 'in_progress', 'on_hold'].includes(j.status) : j.status === status));
  const body = (
    <>
      <div className="v-toolbar">
        <div className="v-segment">{[['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
        {perms.has('joborder.create') && <button className="primary" onClick={() => setCreating(true)}><Plus size={15} />New job order</button>}
      </div>
      {rows === null ? <p className="muted padded">Loading…</p> : shown.length ? (
        <div className="v-card flush">
          <table className="v-table">
            <thead><tr><th>Job order</th>{!projectId && <th>Project</th>}<th>Qty</th><th>Due</th><th>Status</th><th style={{ width: '30%' }}>Progress</th><th>Created</th></tr></thead>
            <tbody>{shown.map(j => (
              <tr key={j.id} className="click" onClick={() => openJobOrder(j.id)}>
                <td><b>{joNumber(j)}</b><small>{j.title}</small></td>
                {!projectId && <td>{j.project_name}<small>Rev {j.revision_number}</small></td>}
                <td className="tabular">{j.quantity}</td>
                <td><DeadlineCell j={j} /></td>
                <td><StatusBadge status={j.status} /></td>
                <td><div className="v-progress-row"><Progress value={j.progress} /><span className="tabular">{Math.round(j.progress)}%</span></div><small>{j.items_done}/{j.items_total} checklist lines</small></td>
                <td>{date(j.created)}<small>{j.created_by}</small></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty icon={<ClipboardList />} title="No job orders">Job orders are created on production-ready (released) revisions and generate the process checklists for the shop floor.</Empty>}
      {creating && <JobOrderDialog projects={projects} projectId={projectId} ctx={ctx} close={() => setCreating(false)} onCreated={jo => { setCreating(false); load(); openJobOrder(jo.id); }} />}
    </>
  );
  if (projectId) return <section className="content-page">{body}</section>;
  return <div className="v-page"><PageHeader title="Job orders" description="Production and process checklists with timestamps, per job order." /><div className="v-body">{body}</div></div>;
}

export function JobOrderDetail({ id, ctx, back, openProject }: { id: string; ctx: Ctx; back: () => void; openProject: (pid: string, tab?: string) => void }) {
  const [jo, setJo] = useState<Any>(null);
  const [view, setView] = useState<'parts' | 'stations' | 'activity'>('parts');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [record, setRecord] = useState<Any>(null);
  const [issue, setIssue] = useState<Any>(null);
  const [nesting, setNesting] = useState(false);
  const [q, setQ] = useState('');
  const load = () => api('/job-orders/' + id).then(setJo).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [id]);
  const groups = useMemo(() => {
    const m = new Map<string, Any[]>();
    for (const i of jo?.items || []) { const k = i.kind === 'assembly' ? 'assembly' : i.kind === 'procurement' ? 'procurement' : i.part_id; m.set(k, [...(m.get(k) || []), i]); }
    return [...m.entries()];
  }, [jo]);
  if (!jo) return <div className="v-page"><PageHeader title="Job order" /><p className="muted padded">Loading…</p></div>;
  const perms = new Set<string>(jo.permissions || []);
  const canUpdate = perms.has('joborder.update') && ['open', 'in_progress'].includes(jo.status);
  /** Counts recorded by mistake can always be taken back (a completed order reopens). */
  const canCorrect = perms.has('joborder.update') && ['open', 'in_progress', 'completed'].includes(jo.status);
  const canManage = perms.has('joborder.create');
  const post = (item: Any, body: Any) => ctx.action(async () => { await api(`/job-orders/${id}/items/${item.id}`, 'POST', body); await load(); });
  const setStatus = (status: string, note = '') => ctx.action(async () => { await api('/job-orders/' + id, 'PATCH', { status, note }); await load(); });
  const matches = (items: Any[]) => !q || items.some(i => (i.part_name + ' ' + (i.alias || '') + ' ' + i.step).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="v-page">
      <PageHeader
        breadcrumb={<><button className="link" onClick={back}>Job orders</button> <ChevronRight size={12} /> <button className="link" onClick={() => openProject(jo.project_id)}>{jo.project_name}</button> · Rev {jo.revision_number}</>}
        title={<>{joNumber(jo)} · {jo.title} <StatusBadge status={jo.status} /></>}
        description={<>{jo.quantity} assemblies{jo.due && <> · due {date(jo.due)} ({deadline(jo).label.toLowerCase()})</>}{jo.customer && <> · {jo.customer}</>} · created by {jo.created_by} {when(jo.created)}</>}
        actions={<>
          {jo.items.some((i: Any) => i.category === 'sheet_metal') && <button onClick={() => setNesting(true)}><Grid2x2 size={14} />Nesting</button>}
          {canManage && <>
          {jo.status === 'on_hold' && <button onClick={() => setStatus('in_progress')}><Play size={14} />Resume</button>}
          {['open', 'in_progress'].includes(jo.status) && <button onClick={async () => {
            const why = await ask({ title: 'Put job order on hold', message: 'Counts cannot be recorded while it is on hold. The reason is logged in Activity.', confirm: 'Put on hold',
              input: { label: 'Reason', placeholder: 'e.g. waiting for material', required: true, choices: ['Waiting for material', 'Machine down', 'Design query', 'Customer request', 'Quality issue'] } });
            if (why !== null) setStatus('on_hold', why);
          }}><Pause size={14} />Hold</button>}
          {!['completed', 'cancelled'].includes(jo.status) && <button onClick={() => setStatus('completed')}><Check size={14} />Close</button>}
          {!['completed', 'cancelled'].includes(jo.status) && <button className="danger-ghost" onClick={async () => {
            const why = await ask({ title: 'Cancel job order?', message: 'A cancelled job order cannot record progress again. Recorded counts stay in its history.', confirm: 'Cancel job order', cancel: 'Keep it', danger: true,
              input: { label: 'Reason (optional)', placeholder: 'Why is it cancelled?' } });
            if (why !== null) setStatus('cancelled', why);
          }}><X size={14} />Cancel</button>}
          </>}
        </>}
      />
      {nesting && <NestingDialog jo={jo} canRun={perms.has('joborder.create') || perms.has('joborder.update')} canDownload={perms.has('cad.download')} close={() => setNesting(false)} />}
      <div className="v-body">
        <div className="v-stats">
          <div><span>Progress</span><b>{Math.round(jo.progress)}%</b><Progress value={jo.progress} /></div>
          <div><span>Parts finished</span><b>{jo.parts_done}<small> / {jo.parts_total}</small></b></div>
          <div><span>Checklist lines done</span><b>{jo.items_done}<small> / {jo.items_total}</small></b></div>
          <div className={jo.rejected ? 'warning' : ''}><span>Rejected</span><b>{jo.rejected}</b></div>
          {(() => { const d = deadline(jo); return (
            <div className={'deadline-stat ' + (d.tone === 'danger' ? 'danger' : d.tone === 'warning' ? 'warning' : '')}>
              <span>Deadline{canManage && !['completed', 'cancelled'].includes(jo.status) && <button type="button" className="link" onClick={async () => {
                const v = await ask({ title: jo.due ? 'Change deadline' : 'Set a deadline', message: 'The date this job order must be finished. Everyone on the job order sees the days remaining.', confirm: 'Save deadline',
                  input: { label: 'Due date', type: 'date', initial: jo.due ? jo.due.slice(0, 10) : '', required: true } });
                if (v) ctx.action(async () => { await api('/job-orders/' + id, 'PATCH', { due: v, note: `Deadline ${jo.due ? 'moved to' : 'set to'} ${v}` }); await load(); });
              }}>{jo.due ? 'Change' : 'Set'}</button>}</span>
              <b className="text-stat">{jo.due ? d.label : '—'}</b>
              <small>{jo.due ? date(jo.due) : 'No deadline set'}{d.pace ? ' · ' + d.pace : ''}</small>
            </div>); })()}
        </div>
        {jo.requirement && <div className="v-card"><header><h3>Requirement</h3></header><p className="pre">{jo.requirement}</p></div>}
        <div className="v-toolbar">
          <div className="v-segment">{[['parts', 'Process checklist'], ['stations', 'By process'], ['activity', 'Activity']].map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k as Any)}>{l}</button>)}</div>
          {view === 'parts' && <input className="v-filter" placeholder="Filter parts or steps…" value={q} onChange={e => setQ(e.target.value)} />}
        </div>
        {view === 'parts' && groups.filter(([, items]) => matches(items)).map(([key, items]) => {
          const req = items.reduce((n, i) => n + i.required, 0), done = items.reduce((n, i) => n + Math.min(i.done, i.required), 0);
          const title = key === 'assembly' ? 'Assembly & welding' : key === 'procurement' ? 'Purchased parts' : items[0].part_name;
          const isOpen = open[key] ?? (done < req);
          const finished = key !== 'assembly' && key !== 'procurement' ? Math.min(...items.map(i => i.done)) : null;
          return (
            <section className="v-card flush jo-group" key={key}>
              <button className="jo-group-head" onClick={() => setOpen({ ...open, [key]: !isOpen })}>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {key === 'assembly' ? <Flame size={15} /> : key === 'procurement' ? <Box size={15} /> : <Layers size={15} />}
                <b className="grow">{items[0].alias && key !== 'assembly' && key !== 'procurement' && <span className="alias-chip">{items[0].alias}</span>}{title}</b>
                {finished !== null && <small>{finished}/{items[0].required} finished</small>}
                {jo.qc?.[key] && (() => { const qc = jo.qc[key]; return <span className="jo-qc" title={`Inspection: first article ${qc.fai}; ${qc.inspected} serial(s) inspected; ${qc.critical} critical characteristic(s)`}>
                  <Badge kind={qc.fai === 'passed' ? 'success' : qc.fai === 'nonconforming' ? 'danger' : qc.fai === 'incomplete' ? 'warning' : ''}>FAI {qc.fai}</Badge>
                  {qc.inspected > 0 && <small>{qc.inspected} inspected</small>}{qc.open_ncr > 0 && <Badge kind="danger">{qc.open_ncr} NCR</Badge>}</span>; })()}
                <span className="v-progress-row narrow"><Progress value={100 * done / Math.max(1, req)} /><span className="tabular">{Math.round(100 * done / Math.max(1, req))}%</span></span>
              </button>
              {isOpen && (
                <table className="v-table compact">
                  <thead><tr><th style={{ width: 36 }}>#</th><th>{key === 'assembly' ? 'Joint' : 'Process step'}</th><th>Status</th><th className="num">Done</th><th>Last update</th><th /></tr></thead>
                  <tbody>{items.map((i, n) => (
                    <tr key={i.id} className={i.status === 'blocked' ? 'blocked' : ''}>
                      <td className="muted tabular">{n + 1}</td>
                      <td><b>{i.step}</b>{key === 'assembly' || key === 'procurement' ? <small>{i.part_name}</small> : <small>{i.kind !== 'process' ? i.kind : ''}</small>}</td>
                      <td><StatusBadge status={i.status} />{i.rejected > 0 && <Badge kind="danger">{i.rejected} rejected</Badge>}</td>
                      <td className="num tabular"><b>{i.done}</b> / {i.required}<Progress value={100 * i.done / i.required} tone={i.done >= i.required ? 'success' : ''} /></td>
                      <td>{i.updated ? <>{when(i.updated)}<small>{i.updated_by}</small></> : <span className="muted">—</span>}</td>
                      <td className="row-actions">{canCorrect && !canUpdate && i.done > 0 && <>
                        <button className="mini" title="Take back one count — reopens this job order" onClick={() => post(i, { add: -1, note: 'Correction' })}>−1</button>
                        <button className="mini" title="Set the count to any value — reopens this job order" onClick={() => setRecord({ item: i, done: i.done, rejected: 0, note: '', at: '' })}>Correct…</button>
                      </>}{canUpdate && <>
                        <button className="mini" title="Take back one count recorded by mistake" disabled={ctx.busy || i.done <= 0} onClick={() => post(i, { add: -1, note: 'Correction' })}>−1</button>
                        <button className="mini" disabled={ctx.busy || i.done >= i.required} onClick={() => post(i, { add: 1 })}>+1</button>
                        <button className="mini" disabled={ctx.busy || i.done >= i.required} onClick={() => post(i, { done: i.required })}><Check size={12} />All</button>
                        <button className="mini" onClick={() => setRecord({ item: i, done: i.done, rejected: 0, note: '', at: '' })}>Record…</button>
                        <button className="mini" title="Report a problem to the design team" onClick={() => setIssue({ item: i, body: '' })}><AlertTriangle size={12} /></button>
                      </>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </section>
          );
        })}
        {view === 'stations' && (
          <div className="v-card flush">
            <table className="v-table">
              <thead><tr><th>Process</th><th>Kind</th><th className="num">Done / required</th><th style={{ width: '35%' }}>Progress</th></tr></thead>
              <tbody>{jo.stations.map((s: Any) => (
                <tr key={s.step}><td><b>{s.step}</b></td><td>{s.kind}</td><td className="num tabular">{s.done} / {s.required}</td><td><div className="v-progress-row"><Progress value={100 * s.done / Math.max(1, s.required)} /><span className="tabular">{Math.round(100 * s.done / Math.max(1, s.required))}%</span></div></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {view === 'activity' && (
          <div className="v-card"><div className="v-feed">
            {jo.events.map((e: Any) => {
              const it = jo.items.find((i: Any) => i.id === e.item_id);
              return <div key={e.id}><Avatar name={e.actor} size={22} /><span><b>{e.actor}</b> {e.action === 'created' ? 'created the job order' : e.action.startsWith('status:') ? `set status to ${e.action.slice(7).replace('_', ' ')}` : e.action === 'issue' ? `raised an issue on ${it?.part_name} · ${it?.step}` : `${e.quantity >= 0 ? '+' : ''}${e.quantity} on ${it?.part_name} · ${it?.step} (${e.action.replace('_', ' ')})`}{e.note && <small>{e.note}</small>}</span><time>{new Date(e.created).toLocaleString()}</time></div>;
            })}
          </div></div>
        )}
      </div>
      {record && (
        <Modal title="Record progress" subtitle={`${record.item.part_name} · ${record.item.step}`} close={() => setRecord(null)}>
          <form onSubmit={e => { e.preventDefault(); ctx.action(async () => { await api(`/job-orders/${id}/items/${record.item.id}`, 'POST', { done: Number(record.done), rejected: Number(record.rejected), note: record.note, at: record.at ? new Date(record.at).toISOString() : '' }); setRecord(null); await load(); }); }}>
            <div className="form-grid">
              <label>Total completed at this step<input type="number" min={0} max={record.item.required} value={record.done} onChange={e => setRecord({ ...record, done: e.target.value })} /><small>of {record.item.required} required</small></label>
              <label>Rejected in this update<input type="number" min={0} value={record.rejected} onChange={e => setRecord({ ...record, rejected: e.target.value })} /></label>
              <label>When (leave empty for now)<input type="datetime-local" value={record.at} max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={e => setRecord({ ...record, at: e.target.value })} /></label>
              <label>Batch / operator note<input value={record.note} onChange={e => setRecord({ ...record, note: e.target.value })} /></label>
            </div>
            <div className="modal-actions"><button type="button" onClick={() => setRecord(null)}>Cancel</button><button className="primary" disabled={ctx.busy}><Check size={15} />Save</button></div>
          </form>
        </Modal>
      )}
      {issue && (
        <Modal title="Report a production issue" subtitle={`${issue.item.part_name} · ${issue.item.step} — sent to the design review of revision ${jo.revision_number}`} close={() => setIssue(null)}>
          <form onSubmit={e => { e.preventDefault(); ctx.action(async () => { await api(`/job-orders/${id}/items/${issue.item.id}/issue`, 'POST', { body: issue.body }); setIssue(null); ctx.notify('Issue sent to the design team; the step is marked blocked.'); await load(); }); }}>
            <label>What is wrong?<textarea required minLength={3} autoFocus value={issue.body} onChange={e => setIssue({ ...issue, body: e.target.value })} placeholder="e.g. Hole H003 clashes with the weld nut; flange cracks at B001…" /></label>
            <div className="modal-actions"><button type="button" onClick={() => setIssue(null)}>Cancel</button><button className="primary" disabled={ctx.busy}><MessageSquareWarning size={15} />Send to design</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ============================================================================ Templates
const STEP_KINDS = [{ value: 'process', label: 'Process' }, { value: 'inspection', label: 'Inspection' }, { value: 'outsourced', label: 'Outsourced' }, { value: 'assembly', label: 'Assembly' }];
export function StepsEditor({ steps, setSteps }: { steps: Any[]; setSteps: (s: Any[]) => void }) {
  const upd = (i: number, patch: Any) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSteps(n); };
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div className="step-row" key={i}>
          <span className="step-no">{i + 1}</span>
          <input placeholder="Step name, e.g. Laser cut" value={s.name} onChange={e => upd(i, { name: e.target.value })} required />
          <Select size="sm" value={s.kind || 'process'} onChange={v => upd(i, { kind: v })} options={STEP_KINDS} />
          <input placeholder="Station / vendor" value={s.station || ''} onChange={e => upd(i, { station: e.target.value })} />
          <input placeholder="min" type="number" min={0} value={s.minutes || ''} onChange={e => upd(i, { minutes: Number(e.target.value) })} title="Standard minutes per piece" />
          <button type="button" className="icon" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
          <button type="button" className="icon" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
          <button type="button" className="icon danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => setSteps([...steps, { name: '', kind: 'process' }])}><Plus size={14} />Add step</button>
    </div>
  );
}

export function TemplateDialog({ tpl, close, onSaved, ctx }: { tpl: Any; close: () => void; onSaved: () => void; ctx: Ctx }) {
  const [t, setT] = useState<Any>(tpl);
  return (
    <Modal title={(t.id ? 'Edit ' : 'New ') + (t.kind === 'process' ? 'process template' : 'drawing template')} subtitle={t.kind === 'process' ? 'A routing like Laser cut → Bend → Powder coat → Inspect. A part follows exactly one template.' : 'Sheet size and hole-table convention applied to the parts you assign it to.'} wide close={close}>
      <form onSubmit={e => { e.preventDefault(); ctx.action(async () => {
        const body = { kind: t.kind, name: t.name, description: t.description || '', data: t.data, project_id: t.project_id || null };
        if (t.id) await api('/templates/' + t.id, 'PUT', body); else await api('/templates', 'POST', body);
        onSaved();
      }); }}>
        <div className="form-grid">
          <label>Name<input required value={t.name} onChange={e => setT({ ...t, name: e.target.value })} /></label>
          <label>Description<input value={t.description || ''} onChange={e => setT({ ...t, description: e.target.value })} /></label>
        </div>
        {t.kind === 'process' ? (
          <>
            <h4>Steps</h4>
            <StepsEditor steps={t.data.steps || []} setSteps={steps => setT({ ...t, data: { ...t.data, steps } })} />
          </>
        ) : (
          <div className="form-grid">
            <label>Sheet size<Select value={t.data.size || 'auto'} onChange={v => setT({ ...t, data: { ...t.data, size: v } })} options={[{ value: 'auto', label: 'Automatic (smallest that fits)' }, { value: 'A4', label: 'A4 landscape' }, { value: 'A3', label: 'A3 landscape' }, { value: 'A2', label: 'A2 landscape' }]} /></label>
            <label>Hole dimensioning<Select value={t.data.hole_table || 'auto'} onChange={v => setT({ ...t, data: { ...t.data, hole_table: v } })} options={[{ value: 'auto', label: 'Automatic (hole table when crowded)' }, { value: 'always', label: 'Always hole table (tagged)' }, { value: 'never', label: 'Always callouts' }]} /></label>
          </div>
        )}
        <label>Suggested for<div className="chips">{Object.entries(categories).map(([k, v]) => { const on = (t.data.categories || []).includes(k); return <button type="button" key={k} className={'chip' + (on ? ' chosen' : '')} onClick={() => setT({ ...t, data: { ...t.data, categories: on ? t.data.categories.filter((x: string) => x !== k) : [...(t.data.categories || []), k] } })}>{v}</button>; })}</div></label>
        <div className="modal-actions"><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={ctx.busy}><Check size={15} />Save template</button></div>
      </form>
    </Modal>
  );
}

export function TemplatesPage({ ctx, perms }: { ctx: Ctx; perms: Set<string> }) {
  const [rows, setRows] = useState<Any[]>([]);
  const [editing, setEditing] = useState<Any>(null);
  const load = () => api('/templates').then(setRows).catch(() => {});
  useEffect(() => { load(); }, []);
  const can = perms.has('templates.manage');
  const section = (kind: string, title: string, icon: React.ReactNode, blank: Any) => (
    <section className="v-card flush">
      <header className="pad"><h3>{icon}{title}</h3>{can && <button className="primary" onClick={() => setEditing({ kind, name: '', data: blank })}><Plus size={14} />New</button>}</header>
      <table className="v-table">
        <thead><tr><th>Name</th><th>{kind === 'process' ? 'Routing' : 'Convention'}</th><th>Used by</th><th>Updated</th><th /></tr></thead>
        <tbody>{rows.filter(r => r.kind === kind).map(r => (
          <tr key={r.id}>
            <td><b>{r.name}</b><small>{r.description}</small></td>
            <td>{kind === 'process' ? <span className="routing">{r.data.steps.map((s: Any, i: number) => <React.Fragment key={i}>{i > 0 && <ChevronRight size={11} />}<span className={'step-chip ' + s.kind}>{s.name}</span></React.Fragment>)}</span> : <>{r.data.size === 'auto' ? 'Auto size' : r.data.size} · hole table {r.data.hole_table}</>}</td>
            <td className="tabular">{r.usage} parts</td>
            <td>{date(r.updated)}<small>{r.author}</small></td>
            <td className="row-actions">{can && <><button className="mini" onClick={() => setEditing(JSON.parse(JSON.stringify(r)))}>Edit</button><button className="mini" onClick={() => setEditing({ ...JSON.parse(JSON.stringify(r)), id: undefined, name: r.name + ' (copy)' })}>Duplicate</button><button className="mini danger-ghost" onClick={async () => { if (await ask({ title: 'Archive this template?', message: 'Parts keep their current routing.', confirm: 'Archive' }) !== null) ctx.action(async () => { await api('/templates/' + r.id, 'DELETE'); await load(); }); }}>Archive</button></>}</td>
          </tr>
        ))}</tbody>
      </table>
      {!rows.some(r => r.kind === kind) && <p className="muted padded">No templates yet.</p>}
    </section>
  );
  return (
    <div className="v-page">
      <PageHeader title="Templates" description="Reusable process routings and drawing sheet templates. Assign them per part, or set project defaults per part type." />
      <div className="v-body">
        {section('process', 'Process templates', <Factory size={15} />, { steps: [{ name: 'Laser cut', kind: 'process' }, { name: 'Inspect', kind: 'inspection' }] })}
        {section('drawing', 'Drawing templates', <FileText size={15} />, { size: 'A3', hole_table: 'auto' })}
      </div>
      {editing && <TemplateDialog tpl={editing} ctx={ctx} close={() => setEditing(null)} onSaved={() => { setEditing(null); load(); ctx.notify('Template saved'); }} />}
    </div>
  );
}

// ============================================================================ Administration
export function AdminPage({ ctx, me }: { ctx: Ctx; me: Any }) {
  const [users, setUsers] = useState<Any[]>([]);
  const [roles, setRoles] = useState<Any>(null);
  const [adding, setAdding] = useState(false);
  const load = () => { api('/users').then(setUsers).catch(() => {}); api('/roles').then(setRoles).catch(() => {}); };
  useEffect(load, []);
  const patch = (u: Any, body: Any) => ctx.action(async () => { await api('/users/' + u.id, 'PATCH', body); load(); });
  return (
    <div className="v-page">
      <PageHeader title="Administration" description="People and roles. Sign-in is Microsoft Entra ID for your organisation's accounts; new people get the default role on first sign-in." actions={<button className="primary" onClick={() => setAdding(true)}><Plus size={15} />Add person</button>} />
      <div className="v-body">
        <section className="v-card flush">
          <header className="pad"><h3><Users size={15} />People</h3><small>{users.length}</small></header>
          <table className="v-table">
            <thead><tr><th>Name</th><th>Role</th><th>Sign-in</th><th>Last sign-in</th><th>Status</th></tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} className={u.active ? '' : 'dim'}>
                <td><span className="flex"><Avatar name={u.name} /><span><b>{u.name}</b><small>{u.email}</small></span></span></td>
                <td style={{ width: 220 }}><Select size="sm" value={u.role} disabled={ctx.busy} onChange={v => patch(u, { role: v })} options={(roles?.roles || []).map((r: Any) => ({ value: r.id, label: r.label }))} /></td>
                <td>{u.provider === 'entra' ? 'Microsoft' : 'Password'}</td>
                <td>{u.last_login ? when(u.last_login) : <span className="muted">Never</span>}</td>
                <td>{u.id === me.id ? <Badge kind="success">You</Badge> : <button className="mini" onClick={() => patch(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
        {roles && (
          <section className="v-card flush">
            <header className="pad"><h3><ShieldCheck size={15} />Role permissions</h3><small>Project members can be given a different role inside a project (Project settings → Team).</small></header>
            <div className="table-scroll">
              <table className="v-table matrix">
                <thead><tr><th>Permission</th>{roles.roles.map((r: Any) => <th key={r.id}>{r.label}</th>)}</tr></thead>
                <tbody>{Object.entries(roles.permissions).map(([k, label]: Any) => (
                  <tr key={k}><td>{label}<small><code>{k}</code></small></td>{roles.roles.map((r: Any) => <td key={r.id} className="center">{r.permissions.includes(k) ? <Check size={14} className="green" /> : <span className="faint">—</span>}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>
      {adding && (
        <Modal title="Add a person" subtitle="They sign in with their organisation Microsoft account; this sets their role in advance." close={() => setAdding(false)}>
          <form onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); ctx.action(async () => { await api('/users', 'POST', f); setAdding(false); load(); ctx.notify('Person added'); }); }}>
            <label>Name<input name="name" required /></label>
            <label>E-mail<input name="email" type="email" required placeholder="name@company.com" /></label>
            <label>Role<Select name="role" defaultValue="viewer" options={(roles?.roles || []).map((r: Any) => ({ value: r.id, label: r.label }))} /></label>
            <div className="modal-actions"><button type="button" onClick={() => setAdding(false)}>Cancel</button><button className="primary" disabled={ctx.busy}>Add</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ============================================================================ Project creation & settings
const TITLE_FIELDS: [string, string][] = [['company', 'Company'], ['drawn_by', 'Drawn by (DRN)'], ['checked_by', 'Checked by (CHK)'], ['approved_by', 'Approved by (APD)'], ['module', 'Module'], ['master', 'Master'], ['note', 'General note'], ['surface_finish', 'Surface finish'], ['tol_1dec', 'Tolerance · 1 decimal'], ['tol_2dec', 'Tolerance · 2 decimals'], ['tol_3dec', 'Tolerance · 3 decimals'], ['hole_fit', 'Fit for holes'], ['shaft_fit', 'Fit for shafts'], ['position_tol', 'Position tolerance']];
const RULE_LABELS: Record<string, string> = { min_hole_diameter: 'Minimum hole Ø (mm)', min_sheet_hole_ratio: 'Sheet: hole Ø ≥ × thickness', min_edge_web_ratio: 'Sheet: edge web ≥ × thickness', min_bend_radius_ratio: 'Sheet: bend radius ≥ × thickness', max_drill_aspect: 'Max drill depth / Ø', k_factor: 'Default K-factor', mesh_deflection: 'Viewer mesh deflection (mm)' };
const SECTIONS = [['general', 'General'], ['naming', 'Part naming'], ['drawing', 'Title block & conventions'], ['rules', 'Rule library'], ['templates', 'Default templates'], ['team', 'Team']];

export function ProjectSettingsDialog({ project, workspace, config, close, onSaved, ctx, create = false }: { project?: Any; workspace: Any; config: Any; close: () => void; onSaved: (p: Any) => void; ctx: Ctx; create?: boolean }) {
  const base = project?.effective_settings || { ...workspace, conventions: { standard: 'ISO', projection: 'third', sheet_size: 'auto', hole_table: 'auto', general_tolerance: 'ISO 2768-mK' }, process_templates: {}, drawing_templates: {} };
  const [section, setSection] = useState('general');
  const [g, setG] = useState<Any>({ name: project?.name || '', code: project?.code || '', description: project?.description || '' });
  const [s, setS] = useState<Any>(JSON.parse(JSON.stringify(base)));
  const [rules, setRules] = useState<Any>({ ...(project?.rules || config?.default_rules || {}) });
  const [templates, setTemplates] = useState<Any[]>([]);
  const [users, setUsers] = useState<Any[]>([]);
  const [members, setMembers] = useState<Any[]>([]);
  const [roles, setRoles] = useState<Any>(null);
  useEffect(() => {
    api('/templates').then(setTemplates).catch(() => {});
    api('/users').then(setUsers).catch(() => {});
    api('/roles').then(setRoles).catch(() => {});
    if (project) api(`/projects/${project.id}/members`).then(setMembers).catch(() => {});
  }, []);
  const conv = s.conventions || {};
  const setConv = (k: string, v: Any) => setS({ ...s, conventions: { ...conv, [k]: v } });
  const settingsBody = () => ({ sheet_prefixes: splitList(s.sheet_prefixes), machining_prefixes: splitList(s.machining_prefixes), purchased_prefixes: splitList(s.purchased_prefixes), prefix_strict: !!s.prefix_strict, hide_purchased_by_default: !!s.hide_purchased_by_default, carry_over_specs: !!s.carry_over_specs, assembly_show_purchased: !!s.assembly_show_purchased, bend_simulation: s.bend_simulation !== false, drawing: s.drawing, conventions: conv, process_templates: s.process_templates || {}, drawing_templates: s.drawing_templates || {} });
  const save = () => ctx.action(async () => {
    const m = members.map(x => ({ user_id: x.user_id, role: x.role }));
    if (create) {
      const p = await api('/projects', 'POST', { ...g, settings: settingsBody(), rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, Number(v)])), members: m });
      onSaved(p);
    } else {
      await api('/projects/' + project.id, 'PATCH', { ...g, settings: settingsBody(), rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, Number(v)])) });
      await api(`/projects/${project.id}/members`, 'PUT', { members: m });
      onSaved(await api('/projects/' + project.id));
    }
  });
  const idx = SECTIONS.findIndex(x => x[0] === section);
  return (
    <Modal title={create ? 'New project' : 'Project settings'} subtitle={create ? 'Set the conventions once; every upload and drawing in this project follows them.' : g.name} wide close={close}>
      <div className="v-settings">
        <nav>{SECTIONS.map(([k, l], i) => <button key={k} type="button" className={section === k ? 'active' : ''} onClick={() => setSection(k)}><span>{i + 1}</span>{l}</button>)}</nav>
        <div className="v-settings-body">
          {section === 'general' && <>
            <div className="form-grid">
              <label>Project name<input required autoFocus value={g.name} onChange={e => setG({ ...g, name: e.target.value })} placeholder="e.g. Delivery robot — Chassis" /></label>
              <label>Project code<input value={g.code} maxLength={24} onChange={e => setG({ ...g, code: e.target.value.toUpperCase() })} placeholder="e.g. DR1" /><small>Prefixes job-order numbers (DR1-JO-001)</small></label>
            </div>
            <label>Description<textarea value={g.description} onChange={e => setG({ ...g, description: e.target.value })} placeholder="Product, customer, or manufacturing context" /></label>
          </>}
          {section === 'naming' && <>
            <p className="muted">Part names starting with these prefixes are classified without guessing. Comma-separated, case-insensitive.</p>
            <div className="form-grid">
              <label>Sheet metal<input value={joinList(s.sheet_prefixes)} placeholder="GT-SM, SM-" onChange={e => setS({ ...s, sheet_prefixes: e.target.value })} /></label>
              <label>Machining<input value={joinList(s.machining_prefixes)} placeholder="GT-MC, MC-" onChange={e => setS({ ...s, machining_prefixes: e.target.value })} /></label>
              <label>Purchased (optional)<input value={joinList(s.purchased_prefixes)} placeholder="PUR-, BO-" onChange={e => setS({ ...s, purchased_prefixes: e.target.value })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={!!s.prefix_strict} onChange={e => setS({ ...s, prefix_strict: e.target.checked })} />Anything matching no prefix is a purchased item (strict), unless it is named like a made part (plate, bracket, cover …)</label>
            <label className="check"><input type="checkbox" checked={!!s.hide_purchased_by_default} onChange={e => setS({ ...s, hide_purchased_by_default: e.target.checked })} />Hide small bought-in items in the 3D viewer by default</label>
            <label className="check"><input type="checkbox" checked={!!s.assembly_show_purchased} onChange={e => setS({ ...s, assembly_show_purchased: e.target.checked })} />Show purchased components on the complete assembly drawing (otherwise only per-part overrides are shown)</label>
            <label className="check"><input type="checkbox" checked={s.bend_simulation !== false} onChange={e => setS({ ...s, bend_simulation: e.target.checked })} />Share the press-brake bending simulation of formed sheet-metal parts with vendors and the shop floor (each part can override this)</label>
            <label className="check"><input type="checkbox" checked={!!s.carry_over_specs} onChange={e => setS({ ...s, carry_over_specs: e.target.checked })} />Carry specifications from the previous revision (never approvals)</label>
          </>}
          {section === 'drawing' && <>
            <h4>Drawing conventions</h4>
            <div className="form-grid">
              <label>Standard<Select value={conv.standard || 'ISO'} onChange={v => setConv('standard', v)} options={[{ value: 'ISO', label: 'ISO (128, 129, 5457, 7200)' }, { value: 'ASME', label: 'ASME Y14.5 / Y14.3' }]} /></label>
              <label>Projection<Select value={conv.projection || 'third'} onChange={v => setConv('projection', v)} options={[{ value: 'first', label: 'First angle' }, { value: 'third', label: 'Third angle' }]} /></label>
              <label>Default sheet<Select value={conv.sheet_size || 'auto'} onChange={v => setConv('sheet_size', v)} options={[{ value: 'auto', label: 'Automatic (A4 → A3 → A2)' }, { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'A2', label: 'A2' }]} /></label>
              <label>Hole dimensioning<Select value={conv.hole_table || 'auto'} onChange={v => setConv('hole_table', v)} options={[{ value: 'auto', label: 'Hole table when crowded' }, { value: 'always', label: 'Always hole table' }, { value: 'never', label: 'Always callouts' }]} /></label>
              <label>General tolerance<input value={conv.general_tolerance || ''} onChange={e => setConv('general_tolerance', e.target.value)} placeholder="ISO 2768-mK" /></label>
            </div>
            <h4>Title block</h4>
            <div className="form-grid">
              {TITLE_FIELDS.map(([k, label]) => <label key={k}>{label}<input value={s.drawing?.[k] ?? ''} maxLength={80} onChange={e => setS({ ...s, drawing: { ...(s.drawing || {}), [k]: e.target.value } })} /></label>)}
            </div>
          </>}
          {section === 'rules' && <>
            <p className="muted">Workshop rules are configurable starting values; each revision keeps the snapshot it was checked with.</p>
            <div className="form-grid">{Object.entries(rules).map(([k, v]) => <label key={k}>{RULE_LABELS[k] || k}<input type="number" step="any" value={String(v)} onChange={e => setRules({ ...rules, [k]: e.target.value })} /></label>)}</div>
          </>}
          {section === 'templates' && <>
            <p className="muted">Applied to parts of each type on import (parts carried over from a previous revision keep their routing). Manage templates under <b>Templates</b>.</p>
            <table className="v-table compact">
              <thead><tr><th>Part type</th><th>Process template</th><th>Drawing template</th></tr></thead>
              <tbody>{Object.entries(categories).filter(([k]) => k !== 'purchased').map(([k, v]) => (
                <tr key={k}><td><Badge kind={k}>{v}</Badge></td>
                  <td><Select size="sm" value={s.process_templates?.[k] || ''} onChange={x => setS({ ...s, process_templates: { ...(s.process_templates || {}), [k]: x } })} options={[{ value: '', label: 'None' }, ...templates.filter(t => t.kind === 'process').map(t => ({ value: t.id, label: t.name }))]} /></td>
                  <td><Select size="sm" value={s.drawing_templates?.[k] || ''} onChange={x => setS({ ...s, drawing_templates: { ...(s.drawing_templates || {}), [k]: x } })} options={[{ value: '', label: 'Project default' }, ...templates.filter(t => t.kind === 'drawing').map(t => ({ value: t.id, label: t.name }))]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </>}
          {section === 'team' && <>
            <p className="muted">Members get this role inside the project (overrides their workspace role here). Everyone else uses their workspace role.</p>
            {members.map((m, i) => (
              <div className="member-row" key={m.user_id}><Avatar name={m.name} /><span className="grow"><b>{m.name}</b><small>{m.email}</small></span>
                <Select size="sm" value={m.role} onChange={v => setMembers(members.map((x, j) => (j === i ? { ...x, role: v } : x)))} options={(roles?.project_roles || []).map((r: string) => ({ value: r, label: roles.roles.find((x: Any) => x.id === r)?.label || r }))} />
                <button type="button" className="icon" onClick={() => setMembers(members.filter((_, j) => j !== i))}><X size={13} /></button></div>
            ))}
            <label>Add member<Select value="" placeholder="Choose a person…" onChange={v => { const u = users.find(x => x.id === v); if (u && !members.some(m => m.user_id === v)) setMembers([...members, { user_id: u.id, name: u.name, email: u.email || '', role: 'engineer' }]); }} options={users.map(u => ({ value: u.id, label: u.name }))} /></label>
          </>}
        </div>
      </div>
      <div className="modal-actions">
        {idx > 0 && <button type="button" onClick={() => setSection(SECTIONS[idx - 1][0])}>Back</button>}
        <span className="grow" />
        {create && idx < SECTIONS.length - 1 && <button type="button" onClick={() => setSection(SECTIONS[idx + 1][0])} disabled={!g.name.trim()}>Next</button>}
        <button type="button" className="primary" disabled={ctx.busy || !g.name.trim()} onClick={save}><Check size={15} />{create ? 'Create project' : 'Save settings'}</button>
      </div>
    </Modal>
  );
}

// ============================================================================ Design checks grouped by part
export function DesignChecks({ parts, onOpen, onRules, onWizard }: { parts: Any[]; onOpen: (id: string) => void; onRules: () => void; onWizard?: (id: string) => void }) {
  const [openOnly, setOpenOnly] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = parts.filter((p: Any) => p.category !== 'purchased' && !p.excluded).map((p: Any) => {
    const open = p.findings.filter((f: Any) => !f.waiver);
    return { p, blockers: open.filter((f: Any) => f.severity === 'blocker').length, warnings: open.filter((f: Any) => f.severity === 'warning').length, done: p.findings.filter((f: Any) => f.waiver).length, open };
  }).sort((a: Any, b: Any) => b.blockers - a.blockers || b.warnings - a.warnings || a.p.name.localeCompare(b.p.name));
  const shown = rows.filter((r: Any) => !openOnly || r.open.length || !r.p.reviewed || !r.p.doc_reviewed);
  const ready = rows.filter((r: Any) => !r.blockers && r.p.reviewed && r.p.doc_reviewed).length;
  return (
    <section className="content-page">
      <div className="page-title"><div><h2>Design checks</h2><p>Per part: rule findings, design review and drawing review. A revision is production ready when every part is clear.</p></div><button onClick={onRules}><ShieldCheck size={16} />Rule library</button></div>
      <div className="summary-cards">
        <div><span>PARTS READY</span><b>{ready}<small> / {rows.length}</small></b></div>
        <div><span>OPEN BLOCKERS</span><b className={rows.some((r: Any) => r.blockers) ? 'red' : ''}>{rows.reduce((n: number, r: Any) => n + r.blockers, 0)}</b></div>
        <div><span>DESIGN REVIEWED</span><b>{rows.filter((r: Any) => r.p.reviewed).length}<small> / {rows.length}</small></b></div>
        <div><span>DRAWINGS REVIEWED</span><b>{rows.filter((r: Any) => r.p.doc_reviewed).length}<small> / {rows.length}</small></b></div>
      </div>
      <div className="v-toolbar"><label className="check"><input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />Only parts that need attention</label></div>
      <div className="check-groups">
        {shown.map(({ p, blockers, warnings, done, open }: Any) => {
          const isOpen = expanded[p.id] ?? false;
          return (
            <div className={'check-group' + (blockers ? ' has-blockers' : '')} key={p.id}>
              <button className="check-head" onClick={() => setExpanded({ ...expanded, [p.id]: !isOpen })}>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <span className="grow"><b>{p.name}</b><small>{categories[p.category]} · Qty {p.quantity}{p.spec.material ? ' · ' + p.spec.material : ''}</small></span>
                {blockers > 0 && <Badge kind="danger">{blockers} blocker{blockers > 1 ? 's' : ''}</Badge>}
                {warnings > 0 && <Badge kind="warning">{warnings} warning{warnings > 1 ? 's' : ''}</Badge>}
                {done > 0 && <Badge kind="success">{done} dispositioned</Badge>}
                <Badge kind={p.reviewed ? 'success' : 'neutral'}>{p.reviewed ? 'Design ✓' : 'Design review'}</Badge>
                <Badge kind={p.doc_reviewed ? 'success' : 'neutral'}>{p.doc_reviewed ? 'Drawing ✓' : 'Drawing review'}</Badge>
                {onWizard && <button type="button" className="mini primary-soft" onClick={e => { e.stopPropagation(); onWizard(p.id); }}>Walk me through</button>}
                <span className="link" role="link" onClick={e => { e.stopPropagation(); onOpen(p.id); }}>Open <Crosshair size={12} /></span>
              </button>
              {isOpen && (
                <table className="v-table compact">
                  <tbody>{p.findings.map((f: Any, i: number) => (
                    <tr key={i} className={f.waiver ? 'dim' : ''}>
                      <td style={{ width: 70 }}><code>{f.code}</code></td>
                      <td><b>{f.title}</b><small>{f.detail}</small></td>
                      <td style={{ width: 80 }}>{f.feature || '—'}</td>
                      <td style={{ width: 150 }}><Badge kind={f.waiver ? 'success' : f.severity === 'blocker' ? 'danger' : 'warning'}>{f.waiver ? 'Disposition recorded' : f.severity}</Badge></td>
                    </tr>
                  ))}{!p.findings.length && <tr><td colSpan={4} className="muted">No rule findings.</td></tr>}</tbody>
                </table>
              )}
            </div>
          );
        })}
        {!shown.length && <Empty icon={<CheckCircle2 className="green" />} title="Every part is clear">All design checks, design reviews and drawing reviews are complete.</Empty>}
      </div>
    </section>
  );
}

// ============================================================================ Joints (mating / welding)
const JOINT_KINDS = [{ value: 'weld', label: 'Weld' }, { value: 'bolted', label: 'Bolted' }, { value: 'pem', label: 'PEM / clinch fastener' }, { value: 'rivet', label: 'Rivet' }, { value: 'press_fit', label: 'Press fit' }, { value: 'adhesive', label: 'Adhesive' }, { value: 'mate', label: 'Mate / locate only' }];
export function JointPanel({ draft, setDraft, parts, pickMode, setPickMode, onSave, onCancel, busy, previewStatus, studio }: { draft: Any; setDraft: (d: Any) => void; parts: Any[]; options: Any; pickMode: 'face' | 'edge' | 'point' | null; setPickMode: (mode: 'face' | 'edge' | 'point' | null) => void; onSave: () => void; onCancel: () => void; busy: boolean; previewStatus?: { valid: boolean; message: string } | null; studio: { seams: Any[]; detecting: boolean; detectMessage: string; onDetect: () => void; hoverSeam: string | null; setHoverSeam: (id: string | null) => void; addingParts: boolean; setAddingParts: (v: boolean) => void; seamSide?: string; setSeamSide?: (v: string) => void } }) {
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  const w = draft.weld || {};
  const type = w.type || 'linear';
  const faceCount = draft.faces.filter((f: Any) => f.selection !== 'edge').length;
  const edgeCount = draft.faces.filter((f: Any) => f.selection === 'edge').length;
  const blocked = draft.parts.map((id: string) => parts.find(p => p.id === id)).filter(Boolean).some((p: Any) => weldability(p).level === 'blocked');
  const geometryReady = type === 'patch' ? faceCount >= 1 : type === 'tack' ? faceCount === 2 && !!w.placement : edgeCount >= 1 || faceCount === 2;
  const valid = draft.kind === 'weld' ? draft.parts.length >= 1 && !blocked && !!w.process && geometryReady && previewStatus?.valid !== false : draft.parts.length >= 2;
  return (
    <>
      <div className="inspector-top compact">
        <div className="flex"><Badge kind="accent">{draft.id ? 'Edit weld' : 'New weld'}</Badge>{draft.kind !== 'weld' && <Badge>{draft.kind}</Badge>}</div>
        <h2>{draft.name || (draft.parts.length ? draft.parts.map(named).join(' + ') : 'Weld setup')}</h2>
      </div>
      <div className="inspector-body">
        {draft.kind === 'weld' ? (
          <WeldStudio draft={draft} setDraft={setDraft} parts={parts} pickMode={pickMode} setPickMode={setPickMode} previewStatus={previewStatus} {...studio} />
        ) : (
          <>
            <label>Joint type<Select value={draft.kind} onChange={v => { setDraft({ ...draft, kind: v }); setPickMode(v === 'weld' ? 'face' : null); }} options={JOINT_KINDS} /></label>
            {draft.kind !== 'mate' && <div className="form-grid tight">
              <label>Fasteners<input value={draft.fasteners || ''} onChange={e => setDraft({ ...draft, fasteners: e.target.value })} placeholder="4 × M6×16 ISO 4762 + washers" /></label>
              <label>Torque<input value={draft.torque || ''} onChange={e => setDraft({ ...draft, torque: e.target.value })} placeholder="10 N·m" /></label>
            </div>}
            <h4>Joint faces ({draft.faces.length})</h4><div className="geometry-picker"><button type="button" className={pickMode === 'face' ? 'selected' : ''} onClick={() => setPickMode(pickMode === 'face' ? null : 'face')}><Crosshair size={14} />Pick face</button></div>
          </>
        )}
        <details className="weld-advanced"><summary>Name, sequence & notes</summary><label>Name<input value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Base frame – upright" /></label><label>Sequence<input type="number" min={0} value={draft.sequence || 0} onChange={e => setDraft({ ...draft, sequence: Number(e.target.value) })} /></label><label>Notes<textarea value={draft.notes || ''} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Fixturing, distortion control, inspection…" /></label></details>
        <div className="modal-actions weld-actions">{draft.kind === 'weld' && previewStatus && <p className={'weld-preview-status ' + (previewStatus.valid ? 'ready' : 'invalid')}>{previewStatus.message}</p>}<button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!valid || busy} onClick={onSave}><Check size={14} />{draft.id ? 'Update weld' : 'Save weld'}</button></div>
      </div>
    </>
  );
}

export function ConfiguredWelds({ joints, parts, editable, onEdit, onDelete, onClose }: { joints: Any[]; parts: Any[]; editable: boolean; onEdit: (joint: Any) => void; onDelete: (joint: Any) => void; onClose: () => void }) {
  const welds = joints.filter(j => j.kind === 'weld');
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  return <><div className="inspector-top"><div className="flex"><Flame size={18} /><Badge kind="accent">{welds.length} configured</Badge></div><h2>Configured welds</h2><p className="muted">Weld locations and settings saved in this revision.</p><button type="button" onClick={onClose}>Back to part</button></div><div className="inspector-body"><div className="configured-weld-list">{welds.map((joint, index) => {
    const onePart = joint.data.parts.length === 1 ? parts.find(p => p.id === joint.data.parts[0]) : null;
    return <article key={joint.id}><header><b>{joint.data.name || `Weld ${index + 1}`}</b><span>#{joint.data.sequence || index + 1}</span></header><p>{joint.data.parts.map(named).join(' + ')}</p><small>{({ linear: 'Continuous', stitch: 'Stitch', tack: 'Tack', patch: 'Patch' } as Record<string, string>)[joint.data.weld.type] || joint.data.weld.type}{joint.data.weld.size || joint.data.weld.thickness ? ` a${joint.data.weld.size || joint.data.weld.thickness}` : ''} · {joint.data.weld.process} · {(() => { const edges = joint.data.faces.filter((f: Any) => f.selection === 'edge'); return edges.length ? `${edges.length} seam${edges.length === 1 ? '' : 's'} · ${fmtLen(edges.reduce((n: number, f: Any) => n + Number(f.length || 0), 0))}` : `${joint.data.faces.length} face(s)`; })()}{joint.data.weld.sides === 'both' ? ' · both sides' : joint.data.weld.sides === 'all_around' ? ' · all around' : ''}</small>{onePart && Number(onePart.quantity) > 1 && <small>Applies to all {onePart.quantity} identical parts</small>}<div className="configured-weld-actions"><button type="button" onClick={() => onEdit(joint)}>Open weld</button>{editable && <button type="button" className="danger-ghost" onClick={() => onDelete(joint)}>Remove weld</button>}</div></article>;
  })}{!welds.length && <p className="muted">No welds configured yet. Select a component and choose “Weld this component,” or add one from Assembly & joints.</p>}</div></div></>;
}

export function JointCards({ joints, parts, editable, onEdit, onDelete }: { joints: Any[]; parts: Any[]; editable: boolean; onEdit: (j: Any) => void; onDelete: (j: Any) => void }) {
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  if (!joints.length) return null;
  return (
    <>
      <h3 className="section-sub"><Flame size={15} />Joints & welds</h3>
      <div className="fit-grid">{joints.map(j => (
        <article className="fit-card" key={j.id}>
          <header><Badge kind={j.kind === 'weld' ? 'warning' : 'neutral'}>{j.kind.replace('_', ' ')}</Badge><b>{j.data.name || (j.kind === 'weld' ? `W${joints.filter(x => x.kind === 'weld').indexOf(j) + 1}` : '')}</b></header>
          <h3>{j.data.parts.map(named).join(' + ')}</h3>
          {j.kind === 'weld' && <p><strong>{j.data.weld.process}</strong> · {j.data.weld.type}{j.data.weld.size && ` ${j.data.weld.size}`}{j.data.weld.length && ` × ${j.data.weld.length}`}{j.data.weld.pitch && ` (${j.data.weld.pitch})`} · {j.data.weld.sides?.replace('_', ' ')}{j.data.weld.field ? ' · field' : ''}</p>}
          {j.data.fasteners && <p><strong>Fasteners:</strong> {j.data.fasteners}{j.data.torque && ` · ${j.data.torque}`}</p>}
          <p className="muted">{j.data.faces.length} faces selected{j.data.notes && ` · ${j.data.notes}`}</p>
          {editable && <div className="flex"><button className="mini" onClick={() => onEdit(j)}>Edit</button><button className="mini danger-ghost" onClick={() => onDelete(j)}><Trash2 size={12} />Delete</button></div>}
        </article>
      ))}</div>
    </>
  );
}

export { Clock };
