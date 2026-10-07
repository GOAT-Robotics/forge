import React, { useEffect, useMemo, useState } from 'react';
import {
  Grid2x2,
  Plus, ArrowUp, ArrowDown, Trash2, Check, AlertTriangle, CheckCircle2, ChevronRight, ChevronDown, ClipboardList, Factory, Flame, Clock,
  Pause, Play, X, Users, Library, FileText, ShieldCheck, Layers, Box, MessageSquareWarning, Link2, Crosshair,
} from 'lucide-react';
import { api } from './api';
import NestingDialog from './nesting';
import { EstimatePanel, EstimateCard } from './pricing';
import { Badge, Modal, ModalFooter, ask } from './components';
import { Select } from './controls';
import { categories, date, fmt } from './constants';
import type { Any } from './constants';
import { PageHeader, Progress, Empty, Avatar } from './shell';
import { weldability, WeldStudio, fmtLen } from './welding';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
const TONE_TEXT: Record<string, string> = { danger: 'text-destructive', warning: 'text-warning', success: 'text-success', neutral: 'text-foreground', muted: 'font-normal text-muted-foreground' };
export function DeadlineCell({ j }: { j: Any }) {
  const d = deadline(j);
  if (!j.due) return <span className="text-muted-foreground">—</span>;
  return <><span className={cn('text-sm font-medium whitespace-nowrap', TONE_TEXT[d.tone])}>{d.label}</span><small className={sub}>{date(j.due)}{d.pace.startsWith('Behind') ? ' · behind schedule' : ''}</small></>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={STATUS_TONE[status] || 'neutral'}>{status.replace('_', ' ')}</Badge>;
}
const splitList = (v: Any) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x: string) => x.trim()).filter(Boolean);
const joinList = (v: Any) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

type Ctx = { busy: boolean; action: (fn: () => Promise<void>) => void; notify: (s: string) => void };

// ============================================================================ Layout pieces (Tailwind)
const eyebrow = 'text-2xs font-medium uppercase tracking-wider text-muted-foreground';
/** Secondary line under a value (table cells, list rows). */
const sub = 'mt-px block text-xs font-normal text-muted-foreground';
/** Label → control. */
const field = 'grid gap-1.5 text-xs leading-snug';
const formGrid = 'grid gap-x-4 gap-y-3 sm:grid-cols-2';
/** Checkbox + sentence. */
const checkLabel = 'items-start text-sm font-normal leading-snug [&>button]:mt-0.5';
const notice = 'flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0';
const card = 'min-w-0 rounded-lg border bg-card p-4';
const flushCard = 'min-w-0 overflow-hidden rounded-lg border bg-card';
const aliasChip = 'mr-1.5 inline-block rounded-[5px] bg-selection px-1.5 align-[1px] text-2xs leading-[17px] font-medium tracking-wide text-selection-foreground';
const dangerGhost = 'text-destructive hover:bg-danger-soft hover:text-destructive';
const loading = 'p-5 text-sm text-muted-foreground';

/** Scrolling page column with the standard content width. */
function PageShell({ header, children, wide = false }: { header: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={cn('mx-auto w-full px-6 py-6', wide ? 'max-w-7xl' : 'max-w-6xl')}>
        {header}
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

function CardHead({ icon, title, meta, children, bordered = false }: { icon?: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; bordered?: boolean }) {
  return (
    <header className={cn('flex items-center justify-between gap-2', bordered ? 'border-b px-4 py-2.5' : 'mb-2')}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold [&>svg]:size-4 [&>svg]:text-muted-foreground">{icon}{title}</h3>
      {meta && <small className="text-xs text-faint">{meta}</small>}
      {children}
    </header>
  );
}

function Stat({ label, tone, action, extra, children }: { label: React.ReactNode; tone?: string; action?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2"><span className={eyebrow}>{label}</span>{action}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-destructive', tone === 'warning' && 'text-warning')}>{children}</div>
      {extra}
    </div>
  );
}
const Of = ({ n }: { n: React.ReactNode }) => <span className="text-sm font-normal text-muted-foreground"> / {n}</span>;
const statGrid = 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3';

function ProgressRow({ value, tone, className }: { value: number; tone?: string; className?: string }) {
  return <div className={cn('flex items-center gap-2', className)}><div className="min-w-0 flex-1"><Progress value={value} tone={tone} /></div><span className="min-w-9 text-right text-xs text-muted-foreground tabular-nums">{Math.round(value)}%</span></div>;
}

const Th = ({ className, ...p }: React.ComponentProps<typeof TableHead>) => <TableHead className={cn('h-8 bg-subtle px-3 text-2xs font-medium tracking-wider text-muted-foreground uppercase', className)} {...p} />;
const Td = ({ className, ...p }: React.ComponentProps<typeof TableCell>) => <TableCell className={cn('px-3 py-2 align-top whitespace-normal', className)} {...p} />;
const HeadRow = ({ children }: { children: React.ReactNode }) => <TableHeader><TableRow className="hover:bg-transparent">{children}</TableRow></TableHeader>;
const Strong = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-foreground">{children}</span>;

/** Activity line: avatar, sentence, time. */
function FeedRow({ actor, note, time, children }: { actor: string; note?: string; time: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border-b py-2 text-xs last:border-b-0">
      <Avatar name={actor} size={22} />
      <span className="min-w-0 flex-1"><Strong>{actor}</Strong> {children}{note && <small className={sub}>{note}</small>}</span>
      <time className="text-2xs whitespace-nowrap text-faint">{time}</time>
    </div>
  );
}

/** Segmented filter (one of a few). */
function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, React.ReactNode][] }) {
  return (
    <ToggleGroup type="single" spacing={0.5} className="flex-wrap rounded-md bg-muted p-0.5" value={value} onValueChange={v => { if (v) onChange(v as T); }}>
      {items.map(([k, l]) => <ToggleGroupItem key={k} value={k} size="sm" className="h-6 gap-1 rounded-[5px] px-2.5 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs">{l}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

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
  if (!d) return <PageShell wide header={<PageHeader title="Dashboard" />}><p className={loading}>Loading…</p></PageShell>;
  const s = d.summary;
  const active = d.job_orders.filter((j: Any) => ['open', 'in_progress', 'on_hold'].includes(j.status));
  const listRow = 'h-auto w-full justify-start gap-2.5 rounded-none border-b px-4 py-2.5 text-left font-normal whitespace-normal last:border-b-0 hover:bg-subtle';
  return (
    <PageShell wide header={<PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${d.user.name.split(' ')[0]}`} description="Design readiness and shop-floor progress across projects." />}>
      <div className={statGrid}>
        <Stat label="Active job orders">{s.active}</Stat>
        <Stat label="Overdue" tone={s.overdue ? 'danger' : ''}>{s.overdue}</Stat>
        <Stat label="On hold">{s.on_hold}</Stat>
        <Stat label="Units recorded today">{s.done_today}</Stat>
        <Stat label="Completed (30 days)">{s.completed_30d}</Stat>
        <Stat label="Open shop-floor issues" tone={s.open_issues ? 'warning' : ''}>{s.open_issues}</Stat>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={cn(flushCard, 'lg:col-span-2')}>
          <CardHead bordered title="Job order progress" meta={`${active.length} active`} />
          {active.length ? (
            <Table>
              <HeadRow><Th>Job order</Th><Th>Project</Th><Th>Qty</Th><Th>Due</Th><Th>Status</Th><Th style={{ width: '28%' }}>Progress</Th></HeadRow>
              <TableBody>{active.map((j: Any) => (
                <TableRow key={j.id} className="cursor-pointer" onClick={() => openJobOrder(j.id)}>
                  <Td><Strong>{joNumber(j)}</Strong><small className={sub}>{j.title}</small></Td>
                  <Td>{j.project_name}<small className={sub}>Rev {j.revision_number}</small></Td>
                  <Td className="tabular-nums">{j.quantity}</Td>
                  <Td><DeadlineCell j={j} /></Td>
                  <Td><div className="flex flex-wrap gap-1"><StatusBadge status={j.status} />{j.priority !== 'normal' && <Badge kind={j.priority === 'urgent' ? 'danger' : j.priority === 'high' ? 'warning' : 'neutral'}>{j.priority}</Badge>}</div></Td>
                  <Td><ProgressRow value={j.progress} tone={j.overdue ? 'danger' : ''} /><small className={sub}>{j.parts_done}/{j.parts_total} parts finished{j.rejected ? ` · ${j.rejected} rejected` : ''}</small></Td>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : <div className="p-4"><Empty icon={<ClipboardList />} title="No active job orders">Create one from a production-ready project.</Empty></div>}
        </section>
        <section className={flushCard}>
          <CardHead bordered title="Design readiness" meta="Active revisions" />
          {d.design.map((p: Any) => {
            const total = Math.max(1, p.parts);
            return (
              <Button key={p.id} variant="ghost" className={listRow} onClick={() => openProject(p.id)}>
                <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{p.code ? p.code + ' · ' : ''}{p.name}</span><small className={sub}>Rev {p.number} · {p.status === 'released' ? 'Production ready' : p.status.replace('_', ' ')}{p.open_comments ? ` · ${p.open_comments} open comments` : ''}</small></span>
                <span className="flex w-[150px] shrink-0 flex-col gap-1"><span title="Design review"><Progress value={100 * p.reviewed / total} /><small className="mt-0.5 block text-2xs text-muted-foreground tabular-nums">{p.reviewed}/{p.parts} design</small></span><span title="Drawing review"><Progress value={100 * p.docs_reviewed / total} /><small className="mt-0.5 block text-2xs text-muted-foreground tabular-nums">{p.docs_reviewed}/{p.parts} drawings</small></span></span>
              </Button>
            );
          })}
          {!d.design.length && <p className={loading}>No projects yet.</p>}
        </section>
        <section className={flushCard}>
          <CardHead bordered title="Shop-floor issues" meta="Raised from job orders → design review" />
          {d.issues.map((c: Any) => (
            <Button key={c.id} variant="ghost" className={cn(listRow, 'items-start')} onClick={() => openProject(c.project_id, 'review')}>
              <MessageSquareWarning className="mt-0.5 text-warning" /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{c.part_name || 'Assembly'}</span><small className={sub}>{c.body}</small><small className={cn(sub, 'text-faint')}>{c.author} · {when(c.created)}</small></span>
            </Button>
          ))}
          {!d.issues.length && <p className={loading}>No open issues.</p>}
        </section>
        <section className={cn(card, 'lg:col-span-2')}>
          <CardHead title="Recent shop-floor activity" />
          <div>
            {d.events.map((e: Any) => (
              <FeedRow key={e.id} actor={e.actor} note={e.note} time={when(e.created)}>{e.action.startsWith('status:') ? `set JO-${String(e.number).padStart(3, '0')} to ${e.action.slice(7).replace('_', ' ')}` : e.action === 'created' ? `created JO-${String(e.number).padStart(3, '0')} · ${e.title}` : e.action === 'issue' ? `raised an issue on JO-${String(e.number).padStart(3, '0')}` : `recorded ${e.quantity > 0 ? '+' : ''}${e.quantity} on JO-${String(e.number).padStart(3, '0')} (${e.action.replace('_', ' ')})`}</FeedRow>
            ))}
            {!d.events.length && <p className={loading}>Nothing recorded yet.</p>}
          </div>
        </section>
      </div>
    </PageShell>
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
  const [vendorId, setVendorId] = useState('');
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
  const requestBody = () => {
    const custom = mode !== 'all' || Object.keys(qty).length > 0;
    return { ...form, quantity: Number(form.quantity), revision_id: rev.id, include_purchased: mode === 'all' ? form.include_purchased : false,
      parts: custom ? scoped.map((p: Any) => ({ part_id: p.id, quantity: per(p) })).filter((x: Any) => x.quantity > 0) : null };
  };
  const estimateBody = rev && scoped.length ? (({ title, due, priority, customer, requirement, ...b }: Any) => b)(requestBody()) : null;
  const list = mode === 'custom' ? make.filter((p: Any) => !filter || (p.name + ' ' + (p.alias || '')).toLowerCase().includes(filter.toLowerCase())) : scoped;
  return (
    <Modal title="New job order" subtitle="Creates the production and process checklists from the production-ready revision" wide close={close}>
      <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); ctx.action(async () => {
        const jo = await api(`/projects/${pid}/job-orders`, 'POST', { ...requestBody(), vendor_id: vendorId }); onCreated(jo);
      }); }}>
        <div className={formGrid}>
          <Label className={field}>Project<Select value={pid} onChange={setPid} options={projects.map(p => ({ value: p.id, label: (p.code ? p.code + ' · ' : '') + p.name, hint: p.active_status === 'released' ? 'ready' : 'not ready' }))} /></Label>
          <Label className={field}>Title<Input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Lifter batch 3 — customer trial" /></Label>
          <Label className={field}>Build quantity (assemblies)<Input type="number" min={1} required className="tabular-nums" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></Label>
          <Label className={field}>Due date<Input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} /></Label>
          <Label className={field}>Priority<Select value={form.priority} onChange={v => setForm({ ...form, priority: v })} options={['low', 'normal', 'high', 'urgent'].map(v => ({ value: v, label: v }))} /></Label>
          <Label className={field}>Customer / reference<Input value={form.customer} onChange={e => setForm({ ...form, customer: e.target.value })} /></Label>
        </div>
        <Label className={field}>Requirement<Textarea value={form.requirement} onChange={e => setForm({ ...form, requirement: e.target.value })} placeholder="What this order must deliver: variants, finish, packing, inspection level, delivery…" /></Label>
        {!project ? <p className="text-sm text-muted-foreground">Loading project…</p> : !rev ? (
          <div className={notice}><ShieldCheck />{project.name} has no production-ready revision. Complete the design checks and drawing reviews, then release the revision.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2"><span className="text-sm font-medium">What to make</span><small className="text-xs text-muted-foreground">Revision {rev.number}</small></div>
            <Segmented value={mode} onChange={setMode} items={scopes.map(([k, l]) => [k, <>{l} <small className="text-muted-foreground tabular-nums">{count(k)}</small></>])} />
            {mode === 'selected' && missed > 0 && <p className="text-sm text-muted-foreground">{missed} selected part{missed === 1 ? ' is' : 's are'} not in the released revision (or purchased / not for production) and left out.</p>}
            {mode === 'all' && <Label className={checkLabel}><Checkbox checked={form.include_purchased} onCheckedChange={v => setForm({ ...form, include_purchased: v === true })} />Include procurement lines for purchased parts, and assembly / welding lines</Label>}
            {mode === 'custom' && <Input className="max-w-xs" placeholder="Find a part or alias…" value={filter} onChange={e => setFilter(e.target.value)} />}
            <div className="max-h-[280px] overflow-y-auto rounded-md border">{list.map((p: Any) => (
              <Label key={p.id} className="gap-2.5 border-b px-2.5 py-1.5 font-normal last:border-b-0">
                {mode === 'custom' && <Checkbox checked={picked.has(p.id)} onCheckedChange={v => setPicked(x => { const y = new Set(x); if (v === true) y.add(p.id); else y.delete(p.id); return y; })} />}
                <span className="min-w-0 flex-1 leading-snug"><span className="block text-xs font-medium">{p.alias && <span className={aliasChip}>{p.alias}</span>}{p.name}</span><small className={sub}>{categories[p.category]} · {p.quantity} per assembly</small></span>
                <Input type="number" min={0} className="h-7 w-20 tabular-nums" value={per(p)} disabled={mode === 'custom' && !picked.has(p.id)} onChange={e => setQty({ ...qty, [p.id]: Number(e.target.value) })} />
              </Label>
            ))}{!list.length && <p className={loading}>No parts in this scope.</p>}</div>
            <small className="text-xs text-muted-foreground tabular-nums">{scoped.length} part{scoped.length === 1 ? '' : 's'} · {scoped.reduce((n: number, p: Any) => n + per(p), 0)} pieces{mode !== 'all' ? ' · assembly / welding lines only for welds inside these parts' : ''}</small>
          </div>
        )}
        {rev && <EstimatePanel pid={pid} body={estimateBody} vendorId={vendorId} setVendorId={setVendorId} />}
        <ModalFooter className="mt-1"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button disabled={ctx.busy || !rev || !scoped.length}><Plus />Create job order</Button></ModalFooter>
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
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Segmented value={status} onChange={setStatus} items={[['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']]} />
        {perms.has('joborder.create') && <Button onClick={() => setCreating(true)}><Plus />New job order</Button>}
      </div>
      {rows === null ? <p className={loading}>Loading…</p> : shown.length ? (
        <div className={flushCard}>
          <Table>
            <HeadRow><Th>Job order</Th>{!projectId && <Th>Project</Th>}<Th>Qty</Th><Th>Due</Th><Th>Status</Th><Th style={{ width: '30%' }}>Progress</Th><Th>Created</Th></HeadRow>
            <TableBody>{shown.map(j => (
              <TableRow key={j.id} className="cursor-pointer" onClick={() => openJobOrder(j.id)}>
                <Td><Strong>{joNumber(j)}</Strong><small className={sub}>{j.title}</small></Td>
                {!projectId && <Td>{j.project_name}<small className={sub}>Rev {j.revision_number}</small></Td>}
                <Td className="tabular-nums">{j.quantity}</Td>
                <Td><DeadlineCell j={j} /></Td>
                <Td><StatusBadge status={j.status} /></Td>
                <Td><ProgressRow value={j.progress} /><small className={sub}>{j.items_done}/{j.items_total} checklist lines</small></Td>
                <Td>{date(j.created)}<small className={sub}>{j.created_by}</small></Td>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      ) : <Empty icon={<ClipboardList />} title="No job orders">Job orders are created on production-ready (released) revisions and generate the process checklists for the shop floor.</Empty>}
      {creating && <JobOrderDialog projects={projects} projectId={projectId} ctx={ctx} close={() => setCreating(false)} onCreated={jo => { setCreating(false); load(); openJobOrder(jo.id); }} />}
    </>
  );
  if (projectId) return <section className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-6">{body}</section>;
  return <PageShell wide header={<PageHeader title="Job orders" description="Production and process checklists with timestamps, per job order." />}>{body}</PageShell>;
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
  if (!jo) return <PageShell wide header={<PageHeader title="Job order" />}><p className={loading}>Loading…</p></PageShell>;
  const perms = new Set<string>(jo.permissions || []);
  const canUpdate = perms.has('joborder.update') && ['open', 'in_progress'].includes(jo.status);
  /** Counts recorded by mistake can always be taken back (a completed order reopens). */
  const canCorrect = perms.has('joborder.update') && ['open', 'in_progress', 'completed'].includes(jo.status);
  const canManage = perms.has('joborder.create');
  const post = (item: Any, body: Any) => ctx.action(async () => { await api(`/job-orders/${id}/items/${item.id}`, 'POST', body); await load(); });
  const setStatus = (status: string, note = '') => ctx.action(async () => { await api('/job-orders/' + id, 'PATCH', { status, note }); await load(); });
  const matches = (items: Any[]) => !q || items.some(i => (i.part_name + ' ' + (i.alias || '') + ' ' + i.step).toLowerCase().includes(q.toLowerCase()));
  const crumb = 'h-auto p-0 text-xs font-normal';
  return (
    <PageShell wide header={
      <PageHeader
        breadcrumb={<><Button variant="link" className={crumb} onClick={back}>Job orders</Button> <ChevronRight className="size-3" /> <Button variant="link" className={crumb} onClick={() => openProject(jo.project_id)}>{jo.project_name}</Button> · Rev {jo.revision_number}</>}
        title={<span className="inline-flex flex-wrap items-center gap-2">{joNumber(jo)} · {jo.title} <StatusBadge status={jo.status} /></span>}
        description={<>{jo.quantity} assemblies{jo.due && <> · due {date(jo.due)} ({deadline(jo).label.toLowerCase()})</>}{jo.customer && <> · {jo.customer}</>} · created by {jo.created_by} {when(jo.created)}</>}
        actions={<>
          {jo.items.some((i: Any) => i.category === 'sheet_metal') && <Button variant="outline" onClick={() => setNesting(true)}><Grid2x2 />Nesting</Button>}
          {canManage && <>
          {jo.status === 'on_hold' && <Button variant="outline" onClick={() => setStatus('in_progress')}><Play />Resume</Button>}
          {['open', 'in_progress'].includes(jo.status) && <Button variant="outline" onClick={async () => {
            const why = await ask({ title: 'Put job order on hold', message: 'Counts cannot be recorded while it is on hold. The reason is logged in Activity.', confirm: 'Put on hold',
              input: { label: 'Reason', placeholder: 'e.g. waiting for material', required: true, choices: ['Waiting for material', 'Machine down', 'Design query', 'Customer request', 'Quality issue'] } });
            if (why !== null) setStatus('on_hold', why);
          }}><Pause />Hold</Button>}
          {!['completed', 'cancelled'].includes(jo.status) && <Button variant="outline" onClick={() => setStatus('completed')}><Check />Close</Button>}
          {!['completed', 'cancelled'].includes(jo.status) && <Button variant="ghost" className={dangerGhost} onClick={async () => {
            const why = await ask({ title: 'Cancel job order?', message: 'A cancelled job order cannot record progress again. Recorded counts stay in its history.', confirm: 'Cancel job order', cancel: 'Keep it', danger: true,
              input: { label: 'Reason (optional)', placeholder: 'Why is it cancelled?' } });
            if (why !== null) setStatus('cancelled', why);
          }}><X />Cancel</Button>}
          </>}
        </>}
      />}>
      {nesting && <NestingDialog jo={jo} canRun={perms.has('joborder.create') || perms.has('joborder.update')} canDownload={perms.has('cad.download')} close={() => setNesting(false)} />}
      <div className={statGrid}>
        <Stat label="Progress" extra={<Progress value={jo.progress} />}>{Math.round(jo.progress)}%</Stat>
        <Stat label="Parts finished">{jo.parts_done}<Of n={jo.parts_total} /></Stat>
        <Stat label="Checklist lines done">{jo.items_done}<Of n={jo.items_total} /></Stat>
        <Stat label="Rejected" tone={jo.rejected ? 'warning' : ''}>{jo.rejected}</Stat>
        {(() => { const d = deadline(jo); return (
          <Stat label="Deadline" tone={d.tone === 'danger' ? 'danger' : d.tone === 'warning' ? 'warning' : ''}
            action={canManage && !['completed', 'cancelled'].includes(jo.status) && <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={async () => {
              const v = await ask({ title: jo.due ? 'Change deadline' : 'Set a deadline', message: 'The date this job order must be finished. Everyone on the job order sees the days remaining.', confirm: 'Save deadline',
                input: { label: 'Due date', type: 'date', initial: jo.due ? jo.due.slice(0, 10) : '', required: true } });
              if (v) ctx.action(async () => { await api('/job-orders/' + id, 'PATCH', { due: v, note: `Deadline ${jo.due ? 'moved to' : 'set to'} ${v}` }); await load(); });
            }}>{jo.due ? 'Change' : 'Set'}</Button>}
            extra={<small className="text-xs leading-snug text-muted-foreground">{jo.due ? date(jo.due) : 'No deadline set'}{d.pace ? ' · ' + d.pace : ''}</small>}>
            <span className="text-base">{jo.due ? d.label : '—'}</span>
          </Stat>); })()}
      </div>
      <EstimateCard jo={jo} canManage={canManage} reload={load} ctx={ctx} />
      {jo.requirement && <div className={card}><CardHead title="Requirement" /><p className="text-sm whitespace-pre-wrap">{jo.requirement}</p></div>}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Tabs value={view} onValueChange={v => setView(v as Any)}>
          <TabsList>{[['parts', 'Process checklist'], ['stations', 'By process'], ['activity', 'Activity']].map(([k, l]) => <TabsTrigger key={k} value={k} className="px-3 text-xs">{l}</TabsTrigger>)}</TabsList>
        </Tabs>
        {view === 'parts' && <Input className="h-7 max-w-[260px] text-xs" placeholder="Filter parts or steps…" value={q} onChange={e => setQ(e.target.value)} />}
      </div>
      {view === 'parts' && groups.filter(([, items]) => matches(items)).map(([key, items]) => {
        const req = items.reduce((n, i) => n + i.required, 0), done = items.reduce((n, i) => n + Math.min(i.done, i.required), 0);
        const title = key === 'assembly' ? 'Assembly & welding' : key === 'procurement' ? 'Purchased parts' : items[0].part_name;
        const isOpen = open[key] ?? (done < req);
        const finished = key !== 'assembly' && key !== 'procurement' ? Math.min(...items.map(i => i.done)) : null;
        return (
          <section className={flushCard} key={key}>
            <Button variant="ghost" className="h-auto w-full justify-start gap-2 rounded-none px-3.5 py-2.5 font-normal hover:bg-subtle [&_svg]:text-muted-foreground" onClick={() => setOpen({ ...open, [key]: !isOpen })}>
              {isOpen ? <ChevronDown /> : <ChevronRight />}
              {key === 'assembly' ? <Flame /> : key === 'procurement' ? <Box /> : <Layers />}
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{items[0].alias && key !== 'assembly' && key !== 'procurement' && <span className={aliasChip}>{items[0].alias}</span>}{title}</span>
              {finished !== null && <small className="text-xs text-muted-foreground tabular-nums">{finished}/{items[0].required} finished</small>}
              {jo.qc?.[key] && (() => { const qc = jo.qc[key]; return <span className="inline-flex items-center gap-1.5 text-xs" title={`Inspection: first article ${qc.fai}; ${qc.inspected} serial(s) inspected; ${qc.critical} critical characteristic(s)`}>
                <Badge kind={qc.fai === 'passed' ? 'success' : qc.fai === 'nonconforming' ? 'danger' : qc.fai === 'incomplete' ? 'warning' : ''}>FAI {qc.fai}</Badge>
                {qc.inspected > 0 && <small className="text-muted-foreground">{qc.inspected} inspected</small>}{qc.open_ncr > 0 && <Badge kind="danger">{qc.open_ncr} NCR</Badge>}</span>; })()}
              <ProgressRow className="w-[180px]" value={100 * done / Math.max(1, req)} />
            </Button>
            {isOpen && (
              <div className="border-t">
                <Table>
                  <HeadRow><Th style={{ width: 36 }}>#</Th><Th>{key === 'assembly' ? 'Joint' : 'Process step'}</Th><Th>Status</Th><Th className="text-right">Done</Th><Th>Last update</Th><Th /></HeadRow>
                  <TableBody>{items.map((i, n) => (
                    <TableRow key={i.id} className={cn(i.status === 'blocked' && 'bg-danger-soft hover:bg-danger-soft')}>
                      <Td className="py-1.5 text-muted-foreground tabular-nums">{n + 1}</Td>
                      <Td className="py-1.5"><Strong>{i.step}</Strong>{key === 'assembly' || key === 'procurement' ? <small className={sub}>{i.part_name}</small> : <small className={sub}>{i.kind !== 'process' ? i.kind : ''}</small>}</Td>
                      <Td className="py-1.5"><div className="flex flex-wrap gap-1"><StatusBadge status={i.status} />{i.rejected > 0 && <Badge kind="danger">{i.rejected} rejected</Badge>}</div></Td>
                      <Td className="py-1.5 text-right tabular-nums"><Strong>{i.done}</Strong> / {i.required}<div className="mt-1"><Progress value={100 * i.done / i.required} tone={i.done >= i.required ? 'success' : ''} /></div></Td>
                      <Td className="py-1.5">{i.updated ? <>{when(i.updated)}<small className={sub}>{i.updated_by}</small></> : <span className="text-muted-foreground">—</span>}</Td>
                      <Td className="space-x-1 py-1.5 text-right whitespace-nowrap">{canCorrect && !canUpdate && i.done > 0 && <>
                        <Button variant="outline" size="xs" title="Take back one count — reopens this job order" onClick={() => post(i, { add: -1, note: 'Correction' })}>−1</Button>
                        <Button variant="outline" size="xs" title="Set the count to any value — reopens this job order" onClick={() => setRecord({ item: i, done: i.done, rejected: 0, note: '', at: '' })}>Correct…</Button>
                      </>}{canUpdate && <>
                        <Button variant="outline" size="xs" title="Take back one count recorded by mistake" disabled={ctx.busy || i.done <= 0} onClick={() => post(i, { add: -1, note: 'Correction' })}>−1</Button>
                        <Button variant="outline" size="xs" disabled={ctx.busy || i.done >= i.required} onClick={() => post(i, { add: 1 })}>+1</Button>
                        <Button variant="outline" size="xs" disabled={ctx.busy || i.done >= i.required} onClick={() => post(i, { done: i.required })}><Check />All</Button>
                        <Button variant="outline" size="xs" onClick={() => setRecord({ item: i, done: i.done, rejected: 0, note: '', at: '' })}>Record…</Button>
                        <Button variant="outline" size="icon-xs" title="Report a problem to the design team" aria-label="Report a problem to the design team" onClick={() => setIssue({ item: i, body: '' })}><AlertTriangle /></Button>
                      </>}</Td>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </div>
            )}
          </section>
        );
      })}
      {view === 'stations' && (
        <div className={flushCard}>
          <Table>
            <HeadRow><Th>Process</Th><Th>Kind</Th><Th className="text-right">Done / required</Th><Th style={{ width: '35%' }}>Progress</Th></HeadRow>
            <TableBody>{jo.stations.map((s: Any) => (
              <TableRow key={s.step}><Td><Strong>{s.step}</Strong></Td><Td>{s.kind}</Td><Td className="text-right tabular-nums">{s.done} / {s.required}</Td><Td><ProgressRow value={100 * s.done / Math.max(1, s.required)} /></Td></TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}
      {view === 'activity' && (
        <div className={card}><div>
          {jo.events.map((e: Any) => {
            const it = jo.items.find((i: Any) => i.id === e.item_id);
            return <FeedRow key={e.id} actor={e.actor} note={e.note} time={new Date(e.created).toLocaleString()}>{e.action === 'created' ? 'created the job order' : e.action.startsWith('status:') ? `set status to ${e.action.slice(7).replace('_', ' ')}` : e.action === 'issue' ? `raised an issue on ${it?.part_name} · ${it?.step}` : `${e.quantity >= 0 ? '+' : ''}${e.quantity} on ${it?.part_name} · ${it?.step} (${e.action.replace('_', ' ')})`}</FeedRow>;
          })}
        </div></div>
      )}
      {record && (
        <Modal title="Record progress" subtitle={`${record.item.part_name} · ${record.item.step}`} close={() => setRecord(null)}>
          <form onSubmit={e => { e.preventDefault(); ctx.action(async () => { await api(`/job-orders/${id}/items/${record.item.id}`, 'POST', { done: Number(record.done), rejected: Number(record.rejected), note: record.note, at: record.at ? new Date(record.at).toISOString() : '' }); setRecord(null); await load(); }); }}>
            <div className={formGrid}>
              <Label className={field}>Total completed at this step<Input type="number" min={0} max={record.item.required} className="tabular-nums" value={record.done} onChange={e => setRecord({ ...record, done: e.target.value })} /><small className="font-normal text-muted-foreground">of {record.item.required} required</small></Label>
              <Label className={field}>Rejected in this update<Input type="number" min={0} className="tabular-nums" value={record.rejected} onChange={e => setRecord({ ...record, rejected: e.target.value })} /></Label>
              <Label className={field}>When (leave empty for now)<Input type="datetime-local" value={record.at} max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={e => setRecord({ ...record, at: e.target.value })} /></Label>
              <Label className={field}>Batch / operator note<Input value={record.note} onChange={e => setRecord({ ...record, note: e.target.value })} /></Label>
            </div>
            <ModalFooter><Button type="button" variant="outline" onClick={() => setRecord(null)}>Cancel</Button><Button disabled={ctx.busy}><Check />Save</Button></ModalFooter>
          </form>
        </Modal>
      )}
      {issue && (
        <Modal title="Report a production issue" subtitle={`${issue.item.part_name} · ${issue.item.step} — sent to the design review of revision ${jo.revision_number}`} close={() => setIssue(null)}>
          <form onSubmit={e => { e.preventDefault(); ctx.action(async () => { await api(`/job-orders/${id}/items/${issue.item.id}/issue`, 'POST', { body: issue.body }); setIssue(null); ctx.notify('Issue sent to the design team; the step is marked blocked.'); await load(); }); }}>
            <Label className={field}>What is wrong?<Textarea required minLength={3} autoFocus value={issue.body} onChange={e => setIssue({ ...issue, body: e.target.value })} placeholder="e.g. Hole H003 clashes with the weld nut; flange cracks at B001…" /></Label>
            <ModalFooter><Button type="button" variant="outline" onClick={() => setIssue(null)}>Cancel</Button><Button disabled={ctx.busy}><MessageSquareWarning />Send to design</Button></ModalFooter>
          </form>
        </Modal>
      )}
    </PageShell>
  );
}

// ============================================================================ Templates
const STEP_KINDS = [{ value: 'process', label: 'Process' }, { value: 'inspection', label: 'Inspection' }, { value: 'outsourced', label: 'Outsourced' }, { value: 'assembly', label: 'Assembly' }];
const STEP_CHIP: Record<string, string> = { inspection: 'bg-success-soft text-success', outsourced: 'bg-warning-soft text-warning', assembly: 'bg-selection text-selection-foreground' };
export function StepsEditor({ steps, setSteps }: { steps: Any[]; setSteps: (s: Any[]) => void }) {
  const upd = (i: number, patch: Any) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setSteps(n); };
  const cell = 'h-7 text-xs';
  return (
    <div className="flex flex-col gap-1.5">
      {steps.map((s, i) => (
        <div className="grid grid-cols-[22px_1.6fr_130px_1fr_64px_28px_28px_28px] items-center gap-1.5" key={i}>
          <span className="text-center text-xs text-faint tabular-nums">{i + 1}</span>
          <Input className={cell} placeholder="Step name, e.g. Laser cut" value={s.name} onChange={e => upd(i, { name: e.target.value })} required />
          <Select size="sm" value={s.kind || 'process'} onChange={v => upd(i, { kind: v })} options={STEP_KINDS} />
          <Input className={cell} placeholder="Station / vendor" value={s.station || ''} onChange={e => upd(i, { station: e.target.value })} />
          <Input className={cn(cell, 'tabular-nums')} placeholder="min" type="number" min={0} value={s.minutes || ''} onChange={e => upd(i, { minutes: Number(e.target.value) })} title="Standard minutes per piece" />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Move step up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Move step down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove step" className={dangerGhost} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setSteps([...steps, { name: '', kind: 'process' }])}><Plus />Add step</Button>
    </div>
  );
}

export function TemplateDialog({ tpl, close, onSaved, ctx }: { tpl: Any; close: () => void; onSaved: () => void; ctx: Ctx }) {
  const [t, setT] = useState<Any>(tpl);
  return (
    <Modal title={(t.id ? 'Edit ' : 'New ') + (t.kind === 'process' ? 'process template' : 'drawing template')} subtitle={t.kind === 'process' ? 'A routing like Laser cut → Bend → Powder coat → Inspect. A part follows exactly one template.' : 'Sheet size and hole-table convention applied to the parts you assign it to.'} wide close={close}>
      <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); ctx.action(async () => {
        const body = { kind: t.kind, name: t.name, description: t.description || '', data: t.data, project_id: t.project_id || null };
        if (t.id) await api('/templates/' + t.id, 'PUT', body); else await api('/templates', 'POST', body);
        onSaved();
      }); }}>
        <div className={formGrid}>
          <Label className={field}>Name<Input required value={t.name} onChange={e => setT({ ...t, name: e.target.value })} /></Label>
          <Label className={field}>Description<Input value={t.description || ''} onChange={e => setT({ ...t, description: e.target.value })} /></Label>
        </div>
        {t.kind === 'process' ? (
          <div className="flex flex-col gap-2.5">
            <h4 className={eyebrow}>Steps</h4>
            <StepsEditor steps={t.data.steps || []} setSteps={steps => setT({ ...t, data: { ...t.data, steps } })} />
          </div>
        ) : (
          <div className={formGrid}>
            <Label className={field}>Sheet size<Select value={t.data.size || 'auto'} onChange={v => setT({ ...t, data: { ...t.data, size: v } })} options={[{ value: 'auto', label: 'Automatic (smallest that fits)' }, { value: 'A4', label: 'A4 landscape' }, { value: 'A3', label: 'A3 landscape' }, { value: 'A2', label: 'A2 landscape' }]} /></Label>
            <Label className={field}>Hole dimensioning<Select value={t.data.hole_table || 'auto'} onChange={v => setT({ ...t, data: { ...t.data, hole_table: v } })} options={[{ value: 'auto', label: 'Automatic (hole table when crowded)' }, { value: 'always', label: 'Always hole table (tagged)' }, { value: 'never', label: 'Always callouts' }]} /></Label>
          </div>
        )}
        <div className={field} role="group" aria-label="Suggested for"><span className="font-medium">Suggested for</span><div className="flex flex-wrap gap-1.5">{Object.entries(categories).map(([k, v]) => { const on = (t.data.categories || []).includes(k); return <Button type="button" variant="outline" size="xs" key={k} aria-pressed={on} className={cn('rounded-full px-2.5 font-normal', on && 'border-primary/40 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground')} onClick={() => setT({ ...t, data: { ...t.data, categories: on ? t.data.categories.filter((x: string) => x !== k) : [...(t.data.categories || []), k] } })}>{v}</Button>; })}</div></div>
        <ModalFooter className="mt-1"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button disabled={ctx.busy}><Check />Save template</Button></ModalFooter>
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
    <section className={flushCard}>
      <CardHead bordered icon={icon} title={title}>{can && <Button size="sm" onClick={() => setEditing({ kind, name: '', data: blank })}><Plus />New</Button>}</CardHead>
      <Table>
        <HeadRow><Th>Name</Th><Th>{kind === 'process' ? 'Routing' : 'Convention'}</Th><Th>Used by</Th><Th>Updated</Th><Th /></HeadRow>
        <TableBody>{rows.filter(r => r.kind === kind).map(r => (
          <TableRow key={r.id}>
            <Td><Strong>{r.name}</Strong><small className={sub}>{r.description}</small></Td>
            <Td>{kind === 'process' ? <span className="inline-flex flex-wrap items-center gap-[3px] text-faint">{r.data.steps.map((s: Any, i: number) => <React.Fragment key={i}>{i > 0 && <ChevronRight className="size-3" />}<span className={cn('rounded-full px-[7px] py-px text-2xs', STEP_CHIP[s.kind] || 'bg-muted text-foreground')}>{s.name}</span></React.Fragment>)}</span> : <>{r.data.size === 'auto' ? 'Auto size' : r.data.size} · hole table {r.data.hole_table}</>}</Td>
            <Td className="tabular-nums">{r.usage} parts</Td>
            <Td>{date(r.updated)}<small className={sub}>{r.author}</small></Td>
            <Td className="space-x-1 text-right whitespace-nowrap">{can && <><Button variant="outline" size="xs" onClick={() => setEditing(JSON.parse(JSON.stringify(r)))}>Edit</Button><Button variant="outline" size="xs" onClick={() => setEditing({ ...JSON.parse(JSON.stringify(r)), id: undefined, name: r.name + ' (copy)' })}>Duplicate</Button><Button variant="ghost" size="xs" className={dangerGhost} onClick={async () => { if (await ask({ title: 'Archive this template?', message: 'Parts keep their current routing.', confirm: 'Archive' }) !== null) ctx.action(async () => { await api('/templates/' + r.id, 'DELETE'); await load(); }); }}>Archive</Button></>}</Td>
          </TableRow>
        ))}</TableBody>
      </Table>
      {!rows.some(r => r.kind === kind) && <p className={loading}>No templates yet.</p>}
    </section>
  );
  return (
    <PageShell header={<PageHeader title="Templates" description="Reusable process routings and drawing sheet templates. Assign them per part, or set project defaults per part type." />}>
      {section('process', 'Process templates', <Factory />, { steps: [{ name: 'Laser cut', kind: 'process' }, { name: 'Inspect', kind: 'inspection' }] })}
      {section('drawing', 'Drawing templates', <FileText />, { size: 'A3', hole_table: 'auto' })}
      {editing && <TemplateDialog tpl={editing} ctx={ctx} close={() => setEditing(null)} onSaved={() => { setEditing(null); load(); ctx.notify('Template saved'); }} />}
    </PageShell>
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
    <PageShell wide header={<PageHeader title="Administration" description="People and roles. Sign-in is Microsoft Entra ID for your organisation's accounts; new people get the default role on first sign-in." actions={<Button onClick={() => setAdding(true)}><Plus />Add person</Button>} />}>
      <section className={flushCard}>
        <CardHead bordered icon={<Users />} title="People" meta={users.length} />
        <Table>
          <HeadRow><Th>Name</Th><Th>Role</Th><Th>Sign-in</Th><Th>Last sign-in</Th><Th>Status</Th></HeadRow>
          <TableBody>{users.map(u => (
            <TableRow key={u.id} className={cn(!u.active && '[&>td]:opacity-55')}>
              <Td><span className="flex items-center gap-2.5"><Avatar name={u.name} /><span className="min-w-0"><Strong>{u.name}</Strong><small className={sub}>{u.email}</small></span></span></Td>
              <Td style={{ width: 220 }}><Select size="sm" value={u.role} disabled={ctx.busy} onChange={v => patch(u, { role: v })} options={(roles?.roles || []).map((r: Any) => ({ value: r.id, label: r.label }))} /></Td>
              <Td>{u.provider === 'entra' ? 'Microsoft' : 'Password'}</Td>
              <Td>{u.last_login ? when(u.last_login) : <span className="text-muted-foreground">Never</span>}</Td>
              <Td>{u.id === me.id ? <Badge kind="success">You</Badge> : <Button variant="outline" size="xs" onClick={() => patch(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</Button>}</Td>
            </TableRow>
          ))}</TableBody>
        </Table>
      </section>
      {roles && (
        <section className={flushCard}>
          <CardHead bordered icon={<ShieldCheck />} title="Role permissions" meta="Project members can be given a different role inside a project (Project settings → Team)." />
          <Table>
            <HeadRow><Th>Permission</Th>{roles.roles.map((r: Any) => <Th key={r.id} className="text-center">{r.label}</Th>)}</HeadRow>
            <TableBody>{Object.entries(roles.permissions).map(([k, label]: Any) => (
              <TableRow key={k}><Td>{label}<small className={sub}><code className="font-mono text-2xs">{k}</code></small></Td>{roles.roles.map((r: Any) => <Td key={r.id} className="text-center">{r.permissions.includes(k) ? <Check className="inline size-3.5 text-success" /> : <span className="text-faint">—</span>}</Td>)}</TableRow>
            ))}</TableBody>
          </Table>
        </section>
      )}
      {adding && (
        <Modal title="Add a person" subtitle="They sign in with their organisation Microsoft account; this sets their role in advance." close={() => setAdding(false)}>
          <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); ctx.action(async () => { await api('/users', 'POST', f); setAdding(false); load(); ctx.notify('Person added'); }); }}>
            <Label className={field}>Name<Input name="name" required /></Label>
            <Label className={field}>E-mail<Input name="email" type="email" required placeholder="name@company.com" /></Label>
            <Label className={field}>Role<Select name="role" defaultValue="viewer" options={(roles?.roles || []).map((r: Any) => ({ value: r.id, label: r.label }))} /></Label>
            <ModalFooter className="mt-2"><Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={ctx.busy}>Add</Button></ModalFooter>
          </form>
        </Modal>
      )}
    </PageShell>
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
  const muted = 'text-sm text-muted-foreground';
  return (
    <Modal title={create ? 'New project' : 'Project settings'} subtitle={create ? 'Set the conventions once; every upload and drawing in this project follows them.' : g.name} wide close={close}>
      <div className="grid min-h-[380px] gap-5 md:grid-cols-[190px_1fr]">
        <nav className="flex flex-col gap-0.5 md:border-r md:pr-3">{SECTIONS.map(([k, l], i) => { const on = section === k; return <Button key={k} type="button" variant="ghost" size="sm" aria-current={on ? 'step' : undefined} className={cn('justify-start gap-2 px-2 font-normal text-muted-foreground', on && 'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground')} onClick={() => setSection(k)}><span className={cn('grid size-[18px] shrink-0 place-items-center rounded-full text-2xs font-medium tabular-nums', on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{i + 1}</span>{l}</Button>; })}</nav>
        <div className="flex min-w-0 flex-col gap-3">
          {section === 'general' && <>
            <div className={formGrid}>
              <Label className={field}>Project name<Input required autoFocus value={g.name} onChange={e => setG({ ...g, name: e.target.value })} placeholder="e.g. Delivery robot — Chassis" /></Label>
              <Label className={field}>Project code<Input value={g.code} maxLength={24} onChange={e => setG({ ...g, code: e.target.value.toUpperCase() })} placeholder="e.g. DR1" /><small className="font-normal text-muted-foreground">Prefixes job-order numbers (DR1-JO-001)</small></Label>
            </div>
            <Label className={field}>Description<Textarea value={g.description} onChange={e => setG({ ...g, description: e.target.value })} placeholder="Product, customer, or manufacturing context" /></Label>
          </>}
          {section === 'naming' && <>
            <p className={muted}>Part names starting with these prefixes are classified without guessing. Comma-separated, case-insensitive.</p>
            <div className={formGrid}>
              <Label className={field}>Sheet metal<Input value={joinList(s.sheet_prefixes)} placeholder="GT-SM, SM-" onChange={e => setS({ ...s, sheet_prefixes: e.target.value })} /></Label>
              <Label className={field}>Machining<Input value={joinList(s.machining_prefixes)} placeholder="GT-MC, MC-" onChange={e => setS({ ...s, machining_prefixes: e.target.value })} /></Label>
              <Label className={field}>Purchased (optional)<Input value={joinList(s.purchased_prefixes)} placeholder="PUR-, BO-" onChange={e => setS({ ...s, purchased_prefixes: e.target.value })} /></Label>
            </div>
            <Label className={checkLabel}><Checkbox checked={!!s.prefix_strict} onCheckedChange={v => setS({ ...s, prefix_strict: v === true })} />Anything matching no prefix is a purchased item (strict), unless it is named like a made part (plate, bracket, cover …)</Label>
            <Label className={checkLabel}><Checkbox checked={!!s.hide_purchased_by_default} onCheckedChange={v => setS({ ...s, hide_purchased_by_default: v === true })} />Hide small bought-in items in the 3D viewer by default</Label>
            <Label className={checkLabel}><Checkbox checked={!!s.assembly_show_purchased} onCheckedChange={v => setS({ ...s, assembly_show_purchased: v === true })} />Show purchased components on the complete assembly drawing (otherwise only per-part overrides are shown)</Label>
            <Label className={checkLabel}><Checkbox checked={s.bend_simulation !== false} onCheckedChange={v => setS({ ...s, bend_simulation: v === true })} />Share the press-brake bending simulation of formed sheet-metal parts with vendors and the shop floor (each part can override this)</Label>
            <Label className={checkLabel}><Checkbox checked={!!s.carry_over_specs} onCheckedChange={v => setS({ ...s, carry_over_specs: v === true })} />Carry specifications from the previous revision (never approvals)</Label>
          </>}
          {section === 'drawing' && <>
            <h4 className={eyebrow}>Drawing conventions</h4>
            <div className={formGrid}>
              <Label className={field}>Standard<Select value={conv.standard || 'ISO'} onChange={v => setConv('standard', v)} options={[{ value: 'ISO', label: 'ISO (128, 129, 5457, 7200)' }, { value: 'ASME', label: 'ASME Y14.5 / Y14.3' }]} /></Label>
              <Label className={field}>Projection<Select value={conv.projection || 'third'} onChange={v => setConv('projection', v)} options={[{ value: 'first', label: 'First angle' }, { value: 'third', label: 'Third angle' }]} /></Label>
              <Label className={field}>Default sheet<Select value={conv.sheet_size || 'auto'} onChange={v => setConv('sheet_size', v)} options={[{ value: 'auto', label: 'Automatic (A4 → A3 → A2)' }, { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'A2', label: 'A2' }]} /></Label>
              <Label className={field}>Hole dimensioning<Select value={conv.hole_table || 'auto'} onChange={v => setConv('hole_table', v)} options={[{ value: 'auto', label: 'Hole table when crowded' }, { value: 'always', label: 'Always hole table' }, { value: 'never', label: 'Always callouts' }]} /></Label>
              <Label className={field}>General tolerance<Input value={conv.general_tolerance || ''} onChange={e => setConv('general_tolerance', e.target.value)} placeholder="ISO 2768-mK" /></Label>
            </div>
            <h4 className={cn(eyebrow, 'mt-3')}>Title block</h4>
            <div className={formGrid}>
              {TITLE_FIELDS.map(([k, label]) => <Label key={k} className={field}>{label}<Input value={s.drawing?.[k] ?? ''} maxLength={80} onChange={e => setS({ ...s, drawing: { ...(s.drawing || {}), [k]: e.target.value } })} /></Label>)}
            </div>
          </>}
          {section === 'rules' && <>
            <p className={muted}>Workshop rules are configurable starting values; each revision keeps the snapshot it was checked with.</p>
            <div className={formGrid}>{Object.entries(rules).map(([k, v]) => <Label key={k} className={field}>{RULE_LABELS[k] || k}<Input type="number" step="any" className="tabular-nums" value={String(v)} onChange={e => setRules({ ...rules, [k]: e.target.value })} /></Label>)}</div>
          </>}
          {section === 'templates' && <>
            <p className={muted}>Applied to parts of each type on import (parts carried over from a previous revision keep their routing). Manage templates under <span className="font-medium text-foreground">Templates</span>.</p>
            <div className={flushCard}>
              <Table>
                <HeadRow><Th>Part type</Th><Th>Process template</Th><Th>Drawing template</Th></HeadRow>
                <TableBody>{Object.entries(categories).filter(([k]) => k !== 'purchased').map(([k, v]) => (
                  <TableRow key={k}><Td className="py-1.5 align-middle"><Badge kind={k}>{v}</Badge></Td>
                    <Td className="py-1.5"><Select size="sm" value={s.process_templates?.[k] || ''} onChange={x => setS({ ...s, process_templates: { ...(s.process_templates || {}), [k]: x } })} options={[{ value: '', label: 'None' }, ...templates.filter(t => t.kind === 'process').map(t => ({ value: t.id, label: t.name }))]} /></Td>
                    <Td className="py-1.5"><Select size="sm" value={s.drawing_templates?.[k] || ''} onChange={x => setS({ ...s, drawing_templates: { ...(s.drawing_templates || {}), [k]: x } })} options={[{ value: '', label: 'Project default' }, ...templates.filter(t => t.kind === 'drawing').map(t => ({ value: t.id, label: t.name }))]} /></Td>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          </>}
          {section === 'team' && <>
            <p className={muted}>Members get this role inside the project (overrides their workspace role here). Everyone else uses their workspace role.</p>
            <div>{members.map((m, i) => (
              <div className="flex items-center gap-2.5 border-b py-1.5" key={m.user_id}><Avatar name={m.name} /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{m.name}</span><small className={sub}>{m.email}</small></span>
                <Select size="sm" className="w-[170px]" value={m.role} onChange={v => setMembers(members.map((x, j) => (j === i ? { ...x, role: v } : x)))} options={(roles?.project_roles || []).map((r: string) => ({ value: r, label: roles.roles.find((x: Any) => x.id === r)?.label || r }))} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => setMembers(members.filter((_, j) => j !== i))}><X className="size-3.5" /></Button></div>
            ))}</div>
            <Label className={field}>Add member<Select value="" placeholder="Choose a person…" onChange={v => { const u = users.find(x => x.id === v); if (u && !members.some(m => m.user_id === v)) setMembers([...members, { user_id: u.id, name: u.name, email: u.email || '', role: 'engineer' }]); }} options={users.map(u => ({ value: u.id, label: u.name }))} /></Label>
          </>}
        </div>
      </div>
      <ModalFooter>
        {idx > 0 && <Button type="button" variant="outline" onClick={() => setSection(SECTIONS[idx - 1][0])}>Back</Button>}
        <span className="flex-1" />
        {create && idx < SECTIONS.length - 1 && <Button type="button" variant="outline" onClick={() => setSection(SECTIONS[idx + 1][0])} disabled={!g.name.trim()}>Next</Button>}
        <Button type="button" disabled={ctx.busy || !g.name.trim()} onClick={save}><Check />{create ? 'Create project' : 'Save settings'}</Button>
      </ModalFooter>
    </Modal>
  );
}

// ============================================================================ Design checks grouped by part
export function DesignChecks({ parts, onOpen, onRules, onWizard }: { parts: Any[]; onOpen: (id: string) => void; onRules: () => void; onWizard?: (id: string) => void }) {
  const [openOnly, setOpenOnly] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = parts.filter((p: Any) => p.category !== 'purchased' && p.category !== 'other' && !p.excluded).map((p: Any) => {
    const open = p.findings.filter((f: Any) => !f.waiver);
    return { p, blockers: open.filter((f: Any) => f.severity === 'blocker').length, warnings: open.filter((f: Any) => f.severity === 'warning').length, done: p.findings.filter((f: Any) => f.waiver).length, open };
  }).sort((a: Any, b: Any) => b.blockers - a.blockers || b.warnings - a.warnings || a.p.name.localeCompare(b.p.name));
  const shown = rows.filter((r: Any) => !openOnly || r.open.length || !r.p.reviewed || !r.p.doc_reviewed);
  const ready = rows.filter((r: Any) => !r.blockers && r.p.reviewed && r.p.doc_reviewed).length;
  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0"><h2 className="text-xl font-semibold tracking-tight">Design checks</h2><p className="mt-1 text-sm text-muted-foreground">Per part: rule findings, design review and drawing review. A revision is production ready when every part is clear.</p></div><Button variant="outline" onClick={onRules}><ShieldCheck />Rule library</Button></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Parts ready">{ready}<Of n={rows.length} /></Stat>
        <Stat label="Open blockers" tone={rows.some((r: Any) => r.blockers) ? 'danger' : ''}>{rows.reduce((n: number, r: Any) => n + r.blockers, 0)}</Stat>
        <Stat label="Design reviewed">{rows.filter((r: Any) => r.p.reviewed).length}<Of n={rows.length} /></Stat>
        <Stat label="Drawings reviewed">{rows.filter((r: Any) => r.p.doc_reviewed).length}<Of n={rows.length} /></Stat>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5"><Label className={checkLabel}><Checkbox checked={openOnly} onCheckedChange={v => setOpenOnly(v === true)} />Only parts that need attention</Label></div>
      <div className="flex flex-col gap-2">
        {shown.map(({ p, blockers, warnings, done, open }: Any) => {
          const isOpen = expanded[p.id] ?? false;
          return (
            <div className={cn(flushCard, blockers && 'border-l-[3px] border-l-destructive')} key={p.id}>
              <Button variant="ghost" className="h-auto w-full flex-wrap justify-start gap-2 rounded-none px-3 py-2.5 text-left font-normal whitespace-normal hover:bg-subtle" onClick={() => setExpanded({ ...expanded, [p.id]: !isOpen })}>
                {isOpen ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />}
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{p.name}</span><small className={sub}>{categories[p.category]} · Qty {p.quantity}{p.spec.material ? ' · ' + p.spec.material : ''}</small></span>
                {blockers > 0 && <Badge kind="danger">{blockers} blocker{blockers > 1 ? 's' : ''}</Badge>}
                {warnings > 0 && <Badge kind="warning">{warnings} warning{warnings > 1 ? 's' : ''}</Badge>}
                {done > 0 && <Badge kind="success">{done} dispositioned</Badge>}
                <Badge kind={p.reviewed ? 'success' : 'neutral'}>{p.reviewed ? 'Design ✓' : 'Design review'}</Badge>
                <Badge kind={p.doc_reviewed ? 'success' : 'neutral'}>{p.doc_reviewed ? 'Drawing ✓' : 'Drawing review'}</Badge>
                {onWizard && <Button type="button" variant="ghost" size="xs" className="bg-selection text-selection-foreground hover:bg-selection/70 hover:text-selection-foreground" onClick={e => { e.stopPropagation(); onWizard(p.id); }}>Walk me through</Button>}
                <span className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline" role="link" onClick={e => { e.stopPropagation(); onOpen(p.id); }}>Open <Crosshair className="size-3" /></span>
              </Button>
              {isOpen && (
                <div className="border-t">
                  <Table>
                    <TableBody>{p.findings.map((f: Any, i: number) => (
                      <TableRow key={i} className={cn(f.waiver && '[&>td]:opacity-55')}>
                        <Td className="py-1.5" style={{ width: 70 }}><code className="font-mono text-2xs">{f.code}</code></Td>
                        <Td className="py-1.5"><Strong>{f.title}</Strong><small className={sub}>{f.detail}</small></Td>
                        <Td className="py-1.5" style={{ width: 80 }}>{f.feature || '—'}</Td>
                        <Td className="py-1.5" style={{ width: 150 }}><Badge kind={f.waiver ? 'success' : f.severity === 'blocker' ? 'danger' : 'warning'}>{f.waiver ? 'Disposition recorded' : f.severity}</Badge></Td>
                      </TableRow>
                    ))}{!p.findings.length && <TableRow><Td colSpan={4} className="py-1.5 text-muted-foreground">No rule findings.</Td></TableRow>}</TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && <Empty icon={<CheckCircle2 className="text-success!" />} title="Every part is clear">All design checks, design reviews and drawing reviews are complete.</Empty>}
      </div>
    </section>
  );
}

// ============================================================================ Joints (mating / welding)
const JOINT_KINDS = [{ value: 'weld', label: 'Weld' }, { value: 'bolted', label: 'Bolted' }, { value: 'pem', label: 'PEM / clinch fastener' }, { value: 'rivet', label: 'Rivet' }, { value: 'press_fit', label: 'Press fit' }, { value: 'adhesive', label: 'Adhesive' }, { value: 'mate', label: 'Mate / locate only' }];
/** Side-panel (inspector) frame: heading block and scrolling body. */
const inspectorTop = 'shrink-0 px-4 pt-3 pb-2.5';
const inspectorTitle = 'mt-1.5 text-base leading-snug font-semibold [overflow-wrap:anywhere]';
const inspectorBody = 'min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5';
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
      <div className={inspectorTop}>
        <div className="flex flex-wrap gap-1.5"><Badge kind="accent">{draft.id ? 'Edit weld' : 'New weld'}</Badge>{draft.kind !== 'weld' && <Badge>{draft.kind}</Badge>}</div>
        <h2 className={inspectorTitle}>{draft.name || (draft.parts.length ? draft.parts.map(named).join(' + ') : 'Weld setup')}</h2>
      </div>
      <div className={inspectorBody}>
        {draft.kind === 'weld' ? (
          <WeldStudio draft={draft} setDraft={setDraft} parts={parts} pickMode={pickMode} setPickMode={setPickMode} previewStatus={previewStatus} {...studio} />
        ) : (
          <div className="flex flex-col gap-3">
            <Label className={field}>Joint type<Select value={draft.kind} onChange={v => { setDraft({ ...draft, kind: v }); setPickMode(v === 'weld' ? 'face' : null); }} options={JOINT_KINDS} /></Label>
            {draft.kind !== 'mate' && <div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5">
              <Label className={field}>Fasteners<Input value={draft.fasteners || ''} onChange={e => setDraft({ ...draft, fasteners: e.target.value })} placeholder="4 × M6×16 ISO 4762 + washers" /></Label>
              <Label className={field}>Torque<Input value={draft.torque || ''} onChange={e => setDraft({ ...draft, torque: e.target.value })} placeholder="10 N·m" /></Label>
            </div>}
            <h4 className={cn(eyebrow, 'mt-2')}>Joint faces ({draft.faces.length})</h4><div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" aria-pressed={pickMode === 'face'} className={cn(pickMode === 'face' && 'border-primary bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground')} onClick={() => setPickMode(pickMode === 'face' ? null : 'face')}><Crosshair />Pick face</Button></div>
          </div>
        )}
        <details className="mt-2.5 rounded-md border px-2.5 py-2"><summary className="cursor-pointer text-sm font-medium text-muted-foreground">Name, sequence & notes</summary><div className="mt-2.5 flex flex-col gap-2.5"><Label className={field}>Name<Input value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Base frame – upright" /></Label><Label className={field}>Sequence<Input type="number" min={0} className="tabular-nums" value={draft.sequence || 0} onChange={e => setDraft({ ...draft, sequence: Number(e.target.value) })} /></Label><Label className={field}>Notes<Textarea value={draft.notes || ''} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="Fixturing, distortion control, inspection…" /></Label></div></details>
        <div className="sticky -bottom-5 z-10 -mx-4 mt-2.5 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t bg-card px-4 py-2.5">{draft.kind === 'weld' && previewStatus && <p className={cn('mb-1.5 basis-full rounded-md px-2.5 py-2 text-xs', previewStatus.valid ? 'bg-success-soft text-success' : 'bg-danger-soft text-destructive')}>{previewStatus.message}</p>}<Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button type="button" disabled={!valid || busy} onClick={onSave}><Check />{draft.id ? 'Update weld' : 'Save weld'}</Button></div>
      </div>
    </>
  );
}

export function ConfiguredWelds({ joints, parts, editable, onEdit, onDelete, onClose }: { joints: Any[]; parts: Any[]; editable: boolean; onEdit: (joint: Any) => void; onDelete: (joint: Any) => void; onClose: () => void }) {
  const welds = joints.filter(j => j.kind === 'weld');
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  return <><div className={inspectorTop}><div className="flex flex-wrap items-center gap-1.5"><Flame className="size-[18px] text-muted-foreground" /><Badge kind="accent">{welds.length} configured</Badge></div><h2 className={inspectorTitle}>Configured welds</h2><p className="mt-1 text-xs text-muted-foreground">Weld locations and settings saved in this revision.</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={onClose}>Back to part</Button></div><div className={inspectorBody}><div className="flex flex-col gap-2">{welds.map((joint, index) => {
    const onePart = joint.data.parts.length === 1 ? parts.find(p => p.id === joint.data.parts[0]) : null;
    return <article key={joint.id} className="rounded-md border bg-subtle p-2.5"><header className="flex justify-between gap-2"><span className="text-sm font-medium">{joint.data.name || `Weld ${index + 1}`}</span><span className="text-xs text-muted-foreground tabular-nums">#{joint.data.sequence || index + 1}</span></header><p className="my-1.5 text-xs">{joint.data.parts.map(named).join(' + ')}</p><small className="block text-2xs text-muted-foreground">{({ linear: 'Continuous', stitch: 'Stitch', tack: 'Tack', patch: 'Patch' } as Record<string, string>)[joint.data.weld.type] || joint.data.weld.type}{joint.data.weld.size || joint.data.weld.thickness ? ` a${joint.data.weld.size || joint.data.weld.thickness}` : ''} · {joint.data.weld.process} · {(() => { const edges = joint.data.faces.filter((f: Any) => f.selection === 'edge'); return edges.length ? `${edges.length} seam${edges.length === 1 ? '' : 's'} · ${fmtLen(edges.reduce((n: number, f: Any) => n + Number(f.length || 0), 0))}` : `${joint.data.faces.length} face(s)`; })()}{joint.data.weld.sides === 'both' ? ' · both sides' : joint.data.weld.sides === 'all_around' ? ' · all around' : ''}</small>{onePart && Number(onePart.quantity) > 1 && <small className="block text-2xs text-muted-foreground">Applies to all {onePart.quantity} identical parts</small>}<div className="mt-2 flex gap-2"><Button type="button" variant="outline" size="sm" className="min-w-0 flex-1" onClick={() => onEdit(joint)}>Open weld</Button>{editable && <Button type="button" variant="ghost" size="sm" className={cn('min-w-0 flex-1', dangerGhost)} onClick={() => onDelete(joint)}>Remove weld</Button>}</div></article>;
  })}{!welds.length && <p className="text-sm text-muted-foreground">No welds configured yet. Select a component and choose “Weld this component,” or add one from Assembly & joints.</p>}</div></div></>;
}

export function JointCards({ joints, parts, editable, onEdit, onDelete }: { joints: Any[]; parts: Any[]; editable: boolean; onEdit: (j: Any) => void; onDelete: (j: Any) => void }) {
  const named = (id: string) => parts.find(p => p.id === id)?.name || id;
  if (!joints.length) return null;
  return (
    <>
      <h3 className="mt-4 mb-2 flex items-center gap-1.5 text-sm font-semibold"><Flame className="size-4 text-muted-foreground" />Joints & welds</h3>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{joints.map(j => (
        <article className={card} key={j.id}>
          <header className="mb-3 flex items-center justify-between gap-2 text-sm"><Badge kind={j.kind === 'weld' ? 'warning' : 'neutral'}>{j.kind.replace('_', ' ')}</Badge><span className="font-medium">{j.data.name || (j.kind === 'weld' ? `W${joints.filter(x => x.kind === 'weld').indexOf(j) + 1}` : '')}</span></header>
          <h3 className="text-sm leading-normal font-medium">{j.data.parts.map(named).join(' + ')}</h3>
          {j.kind === 'weld' && <p className="mt-1 text-sm"><strong>{j.data.weld.process}</strong> · {j.data.weld.type}{j.data.weld.size && ` ${j.data.weld.size}`}{j.data.weld.length && ` × ${j.data.weld.length}`}{j.data.weld.pitch && ` (${j.data.weld.pitch})`} · {j.data.weld.sides?.replace('_', ' ')}{j.data.weld.field ? ' · field' : ''}</p>}
          {j.data.fasteners && <p className="mt-1 text-sm"><strong>Fasteners:</strong> {j.data.fasteners}{j.data.torque && ` · ${j.data.torque}`}</p>}
          <p className="mt-1 text-sm text-muted-foreground">{j.data.faces.length} faces selected{j.data.notes && ` · ${j.data.notes}`}</p>
          {editable && <div className="mt-2.5 flex gap-2"><Button variant="outline" size="sm" className="flex-1" onClick={() => onEdit(j)}>Edit</Button><Button variant="ghost" size="sm" className={cn('flex-1', dangerGhost)} onClick={() => onDelete(j)}><Trash2 />Delete</Button></div>}
        </article>
      ))}</div>
    </>
  );
}

export { Clock };
