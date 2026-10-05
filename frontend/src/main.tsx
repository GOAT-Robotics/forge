import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MoreHorizontal, Sparkles, ListTree, ListChecks, PanelRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Maximize2, Minimize2, Box, Plus, ArrowUpRight, ArrowUp, ArrowDown, Upload, Folder, ChevronDown, ChevronRight, ChevronLeft, Search, Download, Check, CheckCircle2, AlertTriangle, Clock,
  FileText, Layers, Link, LogOut, Settings, ShieldCheck, MessageSquare, ClipboardCheck, GitBranch, LoaderCircle, ExternalLink, X, Eye,
  Target, Archive, SlidersHorizontal, Users, Send, RefreshCw, Scan, Grid2x2, Palette, EyeOff, Ban, Undo2, Factory, Files, Flame, Droplet, Keyboard,
  CircleDot, FoldVertical, ListOrdered, ListPlus,
} from 'lucide-react';
import Viewer from './Viewer';
import DrawingEditor from './DrawingEditor';
import type { PartAppearance } from './Viewer';
import { api, asset, download, vendorId, headers } from './api';
import { Badge, Modal, DocumentPreview, FlatPattern, SpecEditor, Swatch, ProductionChecklist, GroupPanel, GroupSpecEditor, ExcludeDialog, ask, DialogHost } from './components';
import { Sidebar, TopBar, PageHeader, initTheme, LogoMark, Progress, type Page } from './shell';
import { Dashboard, JobOrdersPage, JobOrderDetail, TemplatesPage, AdminPage, ProjectSettingsDialog, DesignChecks, JointPanel, JointCards, ConfiguredWelds, StatusBadge } from './pages';
import { categories, categoryColors, date, fmt } from './constants';
import type { Any } from './constants';
import { Select } from './controls';
import { weldability, seamKey, chooseSeams, toggleSeamOn, sameSide, addSeams } from './welding';
import { ReadinessWizard } from './readiness';
import { QualityPage } from './quality';
import HoleConfig from './holeConfig';
import WeldConfig from './weldConfig';
import PressBrake from './pressBrake';
import AssemblySteps from './assemblySteps';
import { usePrefs, comboOf, ShortcutsDialog, KeyChip } from './prefs';
import './style.css';
import './cad.css';

type ViewMode = '3d' | 'flat3d' | 'flat2d';
const TABS = ['parts', 'rules', 'assembly', 'steps', 'joborders', 'production', 'review', 'qc', 'audit'];
initTheme();
/** Read a deep link: /projects/{pid}/revisions/{rid}/{tab}?part={id} or /vendor/{rid}?tab=&part= */
function parseRoute() {
  const q = new URLSearchParams(location.search);
  const top = location.pathname.match(/^\/(dashboard|projects|job-orders|templates|admin)\/?(?:([a-f0-9]+))?$/);
  const jo = location.pathname.match(/^\/job-orders\/([a-f0-9]+)/);
  const m = location.pathname.match(/^\/projects\/([a-f0-9]+)(?:\/revisions\/([a-f0-9]+))?(?:\/([a-z]+))?/);
  const page: Page = m ? 'project' : jo ? 'joborder' : top ? ({ dashboard: 'dashboard', projects: 'projects', 'job-orders': 'joborders', templates: 'templates', admin: 'admin' } as Record<string, Page>)[top[1]] : 'dashboard';
  return { page, jo: jo?.[1] || null, project: m?.[1] || null, revision: m?.[2] || null, tab: (m?.[3] && TABS.includes(m[3]) ? m[3] : q.get('tab') && TABS.includes(q.get('tab')!) ? q.get('tab')! : null), part: q.get('part') };
}
const joinList = (v: Any) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const splitList = (v: Any) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x: string) => x.trim()).filter(Boolean);

function App() {
  const [auth, setAuth] = useState<Any>(null);
  const [projects, setProjects] = useState<Any[]>([]);
  const [project, setProject] = useState<Any>(null);
  const [rev, setRev] = useState<Any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState('parts');
  const [detail, setDetail] = useState('details');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [isolate, setIsolate] = useState(false);
  // personal workspace preferences (navigation, display style, shortcuts) and view state
  const prefsApi = usePrefs();
  const { prefs, setPrefs, actionFor, binding } = prefsApi;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [transparentIds, setTransparentIds] = useState<string[]>([]);
  const [viewCmd, setViewCmd] = useState<{ name: string; n: number } | null>(null);
  /** Revision whose 3D workspace was opened: kept mounted behind the other tabs. */
  const modelSeen = useRef<string | null>(null);
  const viewCommand = (name: string) => setViewCmd(c => ({ name, n: (c?.n || 0) + 1 }));
  const [solo, setSolo] = useState<number | null>(null);
  const lastOccurrence = useRef<number | undefined>(undefined);
  const [mode, setMode] = useState<ViewMode>('3d');
  const [modal, setModal] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<Any>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [related, setRelated] = useState<Any[]>([]);
  const [modalRows, setModalRows] = useState<Any[]>([]);
  const [release, setRelease] = useState<Any>(null);
  const [sharePath, setSharePath] = useState('');
  const [editing, setEditing] = useState<Any>(null);
  const [comparison, setComparison] = useState<Any>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [drawingPart, setDrawingPart] = useState<string | null>(null);
  const [balloonMode, setBalloonMode] = useState(false);
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const [partMenu, setPartMenu] = useState(false);
  const [preview, setPreview] = useState<{ blob: Blob; name: string; title: string } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [overview, setOverview] = useState(false);
  const [layout, setLayoutState] = useState<{ left: boolean; right: boolean; focus: boolean }>(() => { try { return { left: true, right: true, ...JSON.parse(localStorage.getItem('forge-layout') || '{}'), focus: false }; } catch { return { left: true, right: true, focus: false }; } });
  const setLayout = (patch: Partial<typeof layout>) => setLayoutState(l => { const n = { ...l, ...patch }; try { localStorage.setItem('forge-layout', JSON.stringify({ left: n.left, right: n.right })); } catch { /* ignore */ } return n; });
  const [treeView, setTreeView] = useState(() => { try { return localStorage.getItem('forge-nav-tree') !== 'list'; } catch { return true; } });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const colorBy = 'coating' as 'coating' | 'type';  // coating colour where specified, otherwise part-type colour
  const [multi, setMulti] = useState<string[]>([]);
  const route = useRef(parseRoute());
  const [settings, setSettings] = useState<Any>(null);
  const [feature, setFeature] = useState<Any>(null);
  const [excluding, setExcluding] = useState<Any[] | null>(null);
  const anchor = useRef<string | null>(null);
  const [page, setPage] = useState<Page>(route.current.page);
  const [joId, setJoId] = useState<string | null>(route.current.jo);
  const [jointDraft, setJointDraft] = useState<Any>(null);
  const [weldListOpen, setWeldListOpen] = useState(false);
  const [holeCfg, setHoleCfg] = useState<string | null>(null);
  const [bendSim, setBendSim] = useState<string | null>(null);
  const [stepsAdd, setStepsAdd] = useState<{ ids: string[]; n: number } | null>(null);
  const addToSteps = (ids: string[]) => { setStepsAdd({ ids, n: Date.now() }); setTab('steps'); };
  /** press-brake simulation: shown where it is shared; editors can preview it on any formed part */
  const canBend = (p: Any) => p?.category === 'sheet_metal' && p.geometry?.bends?.length > 0 && p.geometry?.flat_status === 'supported';
  const showBend = (p: Any) => canBend(p) && (p.bend_sim || editable);
  const [weldCfg, setWeldCfg] = useState<string[] | null>(null);
  const [weldPreviewStatus, setWeldPreviewStatus] = useState<{ valid: boolean; message: string } | null>(null);
  const [hoverGeometry, setHoverGeometry] = useState<Any>(null);
  const hoverRequest = useRef(0);
  const [pickMode, setPickMode] = useState<'face' | 'edge' | 'point' | null>(null);
  const [seamCandidates, setSeamCandidates] = useState<Any[]>([]);
  const [seamSide, setSeamSide] = useState('all');
  const weldOpen = !!jointDraft;
  useEffect(() => { if (!weldOpen) setSeamSide('all'); }, [weldOpen]);
  const [detecting, setDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState('');
  const [hoverSeam, setHoverSeam] = useState<string | null>(null);
  const [addingParts, setAddingParts] = useState(false);
  /** Faces picked for the next seam (face A, then face B). */
  const [pairPick, setPairPick] = useState<Any[]>([]);
  const detectRequest = useRef(0);
  const [jointOptions, setJointOptions] = useState<Any>(null);
  const [templates, setTemplates] = useState<Any[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const fail = (e: Any) => {
    const msg = e?.message || String(e);
    // Safari says "Load failed", Chrome "Failed to fetch": the request never reached Forge (connection or server restart)
    setError(/^(load failed|failed to fetch|networkerror)/i.test(msg) ? 'Couldn’t reach the Forge server — check your connection and try again.' : msg);
  };
  const notify = (s: string) => { setToast(s); setTimeout(() => setToast(''), 5000); };
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const loadProjects = async () => { setProjects(await api('/projects')); setProjectsLoaded(true); };
  const [revLoading, setRevLoading] = useState(false);
  const loadRevision = useCallback(async (id: string) => { setRevLoading(true); try { const r = await api('/revisions/' + id); setRev(r); return r; } finally { setRevLoading(false); } }, []);
  /** Joints only: fast refresh after a weld is saved or removed (a full revision reload evaluates every part). */
  const refreshJoints = useCallback(async (id: string) => { const joints = await api(`/revisions/${id}/joints`); setRev((r: Any) => r && r.id === id ? { ...r, joints } : r); }, []);
  /** Open whatever the URL points at (after sign-in). */
  const openRoute = async () => {
    const r = route.current;
    if (!r.project) return;
    const d = await api('/projects/' + r.project);
    setProject(d); setComparison(null); setPage('project');
    const target = (r.revision && d.revisions.find((x: Any) => x.id === r.revision)) || d.revisions.find((x: Any) => x.state === 'active') || d.revisions[0];
    if (target) await loadRevision(target.id);
    if (r.tab) setTab(r.tab);
    if (r.part) { setSelected(r.part); setMulti([r.part]); anchor.current = r.part; }
  };
  const afterSignIn = async () => {
    await loadProjects();
    api('/settings').then(setSettings).catch(() => {});
    api('/joint-options').then(setJointOptions).catch(() => {});
    api('/templates').then(setTemplates).catch(() => {});
    if (route.current.page === 'project') await openRoute();
  };
  const go = (p: Page) => { setPage(p); if (p === 'projects') loadProjects().catch(fail); if (p !== 'project') { setJointDraft(null); setPickMode(null); } };
  const openJobOrder = (id: string) => { setJoId(id); setPage('joborder'); };
  const openProjectId = (id: string, t?: string) => action(async () => { await openProject({ id }); if (t) setTab(t); });
  const openProject = async (p: Any) => {
    // the same project is still loaded behind the list: just show it again (no reload of the 3D model)
    if (project?.id === p.id && rev) { setPage('project'); return; }
    const d = await api('/projects/' + p.id);
    setProject(d); setRev(null); setSelected(null); setMode('3d'); setIsolate(false); setComparison(null); setTab('parts'); setPage('project'); setJointDraft(null); setPickMode(null);
    const active = d.revisions.find((r: Any) => r.state === 'active') || d.revisions[0];
    if (active) await loadRevision(active.id);
  };

  useEffect(() => {
    api('/config').then(setConfig).catch(fail);
    if (vendorId) { loadRevision(vendorId).catch(fail); setAuth({ user: { name: 'Vendor', role: 'vendor' } }); if (route.current.tab) setTab(route.current.tab); if (route.current.part) setSelected(route.current.part); }
    else api('/auth/status').then(a => { setAuth(a); if (a.user) afterSignIn().catch(fail); }).catch(fail);
  }, []);

  // account-wide preferences (shortcuts, navigation, display) follow the signed-in user
  useEffect(() => { if (!vendorId) prefsApi.adopt(auth?.user?.id ? (auth.user.prefs || {}) : null); }, [auth?.user?.id]);

  // Track project imports even while an older revision or upload dialog is open.
  useEffect(() => {
    if (!project?.id || vendorId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const updated = await api('/projects/' + project.id);
        if (!cancelled) setProject(updated);
      } catch (e) { if (!cancelled) fail(e); }
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [project?.id]);
  const importingRevision = project?.revisions?.find((r: Any) => r.status === 'processing');
  const showImport = () => action(async () => {
    if (!importingRevision) return;
    await loadRevision(importingRevision.id);
    setTab('parts'); setModal(''); setError('');
  });

  useEffect(() => {
    if (!rev) return;
    const active = rev.status === 'processing' || rev.jobs?.some((j: Any) => ['queued', 'running'].includes(j.status));
    if (!active) return;
    const t = setInterval(() => loadRevision(rev.id).catch(fail), 2500);
    return () => clearInterval(t);
  }, [rev?.id, rev?.status, rev?.jobs?.map((j: Any) => j.status).join(',')]);

  useEffect(() => {
    if (!rev) return;
    const endpoint = tab === 'assembly' ? 'fits' : tab === 'review' ? 'comments' : tab === 'audit' ? 'audit' : tab === 'production' ? 'production' : null;
    setRelated([]); // never render one tab with another tab's rows
    if (endpoint) api(`/revisions/${rev.id}/${endpoint}`).then(setRelated).catch(fail);
  }, [rev?.id, tab]);

  useEffect(() => {
    if (multi.length < 2) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal && !preview && !document.querySelector('.overlay') && !document.getElementById('popover-root')?.childElementCount) setMulti(selected ? [selected] : []); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [multi.length, modal, preview, selected]);

  // Keep the navigator row of the selected part in view when it is picked from the 3D scene.
  useEffect(() => {
    if (!selected || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-part="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const parts: Any[] = rev?.parts || [];
  const part = parts.find((p: Any) => p.id === selected);
  const vendor = !!vendorId;
  const perms = useMemo(() => new Set<string>(auth?.user?.permissions || []), [auth?.user?.permissions?.join(',')]);
  const revPerms = useMemo(() => new Set<string>(rev?.permissions || []), [rev?.permissions?.join(',')]);
  const can = (p: string) => revPerms.has(p);
  const editable = !vendor && can('part.edit') && rev?.state === 'active' && rev?.status === 'ready';
  const filtered = parts.filter((p: Any) => (category === 'all' ? (showHidden || !p.hidden) : category === 'hidden' ? p.hidden : category === 'excluded' ? p.excluded : p.category === category && (showHidden || !p.hidden)) && p.name.toLowerCase().includes(query.toLowerCase()));
  const hasTree = parts.some((p: Any) => (p.assembly_path || []).length);
  const tree = useMemo(() => buildTree(filtered), [filtered.map((p: Any) => p.id + (p.assembly_path || []).join('/')).join('|')]);
  if (treeView && hasTree) { const order = new Map(flattenTree(tree).map((p: Any, i: number) => [p.id, i])); filtered.sort((a: Any, b: Any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)); }
  const hiddenIds = parts.filter((p: Any) => p.hidden).map((p: Any) => p.id);
  const purchasedIds = parts.filter((p: Any) => p.category === 'purchased').map((p: Any) => p.id);
  const suppressedIds = [...new Set([...hiddenIds, ...purchasedIds])];
  const categoryFilteredOut = category === 'all' ? [] : parts.filter((p: Any) => category === 'hidden' ? !p.hidden : category === 'excluded' ? !p.excluded : p.category !== category).map((p: Any) => p.id);
  const canvasHiddenIds = [...new Set([...(showHidden ? [] : suppressedIds), ...categoryFilteredOut])];
  const weldFaceCount = jointDraft?.kind === 'weld' ? (jointDraft.faces || []).filter((f: Any) => f.selection !== 'edge').length : 0;
  const weldEdgeCount = jointDraft?.kind === 'weld' ? (jointDraft.faces || []).filter((f: Any) => f.selection === 'edge').length : 0;
  const weldType = jointDraft?.kind === 'weld' ? jointDraft.weld?.type || 'linear' : null;
  // Keep the complete assembly available until enough geometry identifies the weld components.
  // A weld opened from an existing multi-selection can isolate those components immediately.
  // While welding, show only the components being joined (the rest of the assembly stays reachable
  // while adding components).
  const weldFocusIds: string[] = jointDraft?.kind === 'weld' && !addingParts && pickMode !== 'face' && (jointDraft.parts || []).length >= 2
    ? Array.from(new Set<string>([...(jointDraft.parts || []), ...(jointDraft.faces || []).map((f: Any) => f.other_part).filter(Boolean)].map((id: Any) => String(id))))
    : [];
  // A single-component weld (e.g. the closing seam of a bent part) shows one representative of a Qty > 1 part.
  const weldRepresentatives: Record<string, number> = weldFocusIds.length === 1 && weldType && !seamCandidates.length
    ? { [weldFocusIds[0]]: Number((jointDraft.faces || []).find((face: Any) => face.part === weldFocusIds[0])?.occurrence || 0) } : {};
  const seamView = useMemo(() => {
    const chosen = new Set((jointDraft?.faces || []).filter((f: Any) => f.selection === 'edge').map(seamKey));
    const both = seamCandidates.some(s => s.side === 'inside') && seamCandidates.some(s => s.side === 'outside');
    return seamCandidates.map(s => ({ ...s, label: s.id, chosen: chosen.has(seamKey(s)) }))
      .filter(s => seamSide === 'all' || !both || s.chosen || s.side === seamSide);
  }, [seamCandidates, jointDraft?.faces, seamSide]);
  const savedWelds = useMemo(() => (rev?.joints || []).filter((j: Any) => j.kind === 'weld' && j.id !== jointDraft?.id).map((j: Any, i: number) => ({
    id: j.id, faces: j.data.faces || [], weld: j.data.weld,
    label: `W${j.data.sequence || i + 1}${j.data.weld?.size || j.data.weld?.thickness ? ` · a${j.data.weld.size || j.data.weld.thickness}` : ''}`,
  })), [rev?.joints, jointDraft?.id]);
  /** Seams already welded by another configured weld (seam key → weld label). */
  const weldedSeams = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of savedWelds) for (const f of w.faces) if (f.selection === 'edge') m.set(seamKey(f), w.label.split(' ')[0]);
    return m;
  }, [savedWelds]);
  const seamsTagged = useMemo(() => seamCandidates.map(s => weldedSeams.has(seamKey(s)) ? { ...s, welded_by: weldedSeams.get(seamKey(s)) } : s), [seamCandidates, weldedSeams]);
  /** Ask the server for the seams where the weld's components touch; propose the main fillets on a new weld. */
  const detectSeams = async (draft: Any, propose: boolean) => {
    const ids = draft?.parts || [];
    if (!rev || !ids.length) return;
    const request = ++detectRequest.current;
    setDetecting(true); setDetectMessage('');
    try {
      const r = await api(`/revisions/${rev.id}/weld-seams`, 'POST', { parts: ids });
      if (request !== detectRequest.current) return;
      setSeamCandidates(r.seams || []); setDetectMessage(r.message || '');
      const open = (r.seams || []).filter((s: Any) => !s.minor && !weldedSeams.has(seamKey(s)));
      // propose the inside fillets; where parts only meet across a gap, propose the gap seams
      const fillets = open.filter((s: Any) => s.joint === 'fillet');
      const main = fillets.length ? fillets : open.filter((s: Any) => s.joint === 'gap');
      if (propose && main.length) setJointDraft((d: Any) => d && !(d.faces || []).some((f: Any) => f.selection === 'edge') ? chooseSeams(d, main) : d);
      if (r.seams?.length) setAddingParts(false);
    } catch (err) { if (request === detectRequest.current) setDetectMessage(err instanceof Error ? err.message : String(err)); }
    finally { if (request === detectRequest.current) setDetecting(false); }
  };
  const startWeld = (ids: string[], _extra: Any = {}) => {
    if (!ids.length) { notify('Select the part to weld first — Ctrl/⌘-click to weld several parts together.'); return; }
    setWeldCfg([...new Set(ids)]);
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const startWeldStudio = (ids: string[], extra: Any = {}) => {
    const draft = { kind: 'weld', parts: ids, faces: [], weld: { type: 'linear', process: 'MIG/MAG (135)', sides: 'one' }, sequence: (rev?.joints?.length || 0) + 1, ...extra };
    setJointDraft(draft); setPickMode('face'); setPairPick([]); setSeamCandidates([]); setDetectMessage(''); setHoverSeam(null); setWeldPreviewStatus(null);
    // One component: Forge looks for the gaps it closes on itself (bent box corners) and keeps
    // "add from 3D" on so the mating parts can be clicked.
    setAddingParts(false);
    if (ids.length >= 1) detectSeams(draft, true);
  };
  const editWeld = (j: Any) => { setWeldCfg([...new Set<string>(j.data.parts || [])]); };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const editWeldStudio = (j: Any) => {
    const draft = { id: j.id, kind: j.kind, ...j.data };
    setJointDraft(draft); setPickMode('face'); setPairPick([]); setAddingParts(false); setSeamCandidates([]); setHoverSeam(null); setWeldPreviewStatus(null);
    if (j.kind === 'weld' && (j.data.parts || []).length) detectSeams(draft, false);
  };
  const endWeld = () => { setPairPick([]); setJointDraft(null); setPickMode(null); setSeamCandidates([]); setHoverSeam(null); setAddingParts(false); setWeldPreviewStatus(null); detectRequest.current++; };
  const weldDraftPreview = useMemo(() => jointDraft ? { faces: [...jointDraft.faces, ...pairPick], weld: jointDraft.weld } : null, [jointDraft?.faces, jointDraft?.weld, pairPick]);
  const holes = parts.reduce((n: number, p: Any) => n + p.geometry.holes.length, 0);
  const findings = parts.flatMap((p: Any) => (p.category === 'purchased' || p.excluded ? [] : p.findings));
  const selectedFindings = part?.findings || [];
  /** A part is production ready when its spec has no open blocker, its design review and its drawing review are done.
   *  Purchased and not-for-production parts need nothing. */
  const partReady = (p: Any) => p.excluded || p.category === 'purchased' || (!!p.reviewed && !!p.doc_reviewed
    && !(p.findings || []).some((f: Any) => f.severity === 'blocker' && (!f.waiver || ['GEO001', 'FLAT001'].includes(f.code))));
  const releaseParts = (rev?.parts || []).filter((p: Any) => !p.excluded && p.category !== 'purchased');
  const readyCount = releaseParts.filter(partReady).length;
  const blocking = findings.filter((f: Any) => f.severity === 'blocker' && !f.waiver).length;
  const job = rev?.jobs?.find((j: Any) => ['queued', 'running'].includes(j.status));
  const appearance = useMemo<Record<string, PartAppearance>>(() => {
    const out: Record<string, PartAppearance> = {};
    for (const p of parts) out[p.id] = { color: (colorBy === 'coating' && p.spec.coating_hex) || categoryColors[p.category] || categoryColors.other, category: p.category, name: p.name };
    return out;
  }, [rev?.id, colorBy, parts.map((p: Any) => p.spec.coating_hex + p.category).join('|')]);

  // Keep the address bar in sync so any view can be copied and opened by a colleague or vendor.
  useEffect(() => {
    if (!auth?.user) return;
    let path = vendor ? location.pathname : ({ dashboard: '/dashboard', projects: '/projects', joborders: '/job-orders', joborder: '/job-orders/' + joId, templates: '/templates', admin: '/admin', project: '/projects' } as Record<string, string>)[page];
    if (!vendor && page === 'project' && project) { path = `/projects/${project.id}`; if (rev) path += `/revisions/${rev.id}/${tab}`; }
    const q = new URLSearchParams();
    if (vendor && tab !== 'parts') q.set('tab', tab);
    if (page === 'project' && rev && selected && parts.some((p: Any) => p.id === selected)) q.set('part', selected);
    const next = path + (q.toString() ? '?' + q.toString() : '');
    if (next !== location.pathname + location.search) history.replaceState(null, '', next);
  }, [auth?.user, project?.id, rev?.id, tab, selected, vendor, parts.length, page, joId]);
  const copyLink = () => action(async () => { await navigator.clipboard.writeText(location.href); notify(vendor ? 'Link copied. The vendor token stays in this browser; share the original vendor link for access.' : 'Link copied — opens this exact view for signed-in team members.'); });

  const refreshRelated = async (endpoint: string) => setRelated(await api(`/revisions/${rev.id}/${endpoint}`));
  /** PDFs open in a preview first; other formats download directly. */
  const doc = (path: string, name: string, title = name) => action(async () => {
    const drawingMatch = path.match(/^\/parts\/([^/]+)\/assets\/drawing\.pdf$/);
    if (drawingMatch) { setDrawingPart(drawingMatch[1]); return; }
    if (name.toLowerCase().endsWith('.pdf')) setPreview({ blob: await asset(path), name, title });
    else await download(path, name);
  });
  const generate = async (pid?: string) => action(async () => {
    await api(`/revisions/${rev.id}/documents`, 'POST', pid ? { part_id: pid } : {});
    await loadRevision(rev.id);
    notify('Drawing generation queued. You can keep reviewing.');
  });
  const setBendSharing = (ids: string[], mode: 'on' | 'off' | 'inherit') => action(async () => { await api(`/revisions/${rev.id}/parts/bend-simulation`, 'POST', { ids, mode }); await loadRevision(rev.id); });
  const setFlags = (pid: string, flags: Any) => action(async () => { await api('/parts/' + pid + '/flags', 'PATCH', flags); await loadRevision(rev.id); });
  const choosePart = (id: string | null) => { setSelected(id); setMulti(id ? [id] : []); anchor.current = id; if (id) setDetail(d => (d === 'documents' ? d : 'details')); if (!id) { setIsolate(false); } setSolo(null); if (mode !== '3d') setMode('3d'); };
  const stepPart = useCallback((delta: number) => {
    if (!filtered.length) return;
    const current = filtered.findIndex((p: Any) => p.id === selected);
    const next = current < 0 ? (delta > 0 ? 0 : filtered.length - 1) : (current + delta + filtered.length) % filtered.length;
    choosePart(filtered[next].id); setIsolate(true);
  }, [filtered.map((p: Any) => p.id).join('|'), selected, mode]);
  // Personal keyboard shortcuts (Shortcuts & navigation dialog); defaults follow SolidWorks where the browser allows.
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (page !== 'project' || modal || preview || drawingPart || shortcutsOpen || document.querySelector('.overlay')) return;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const hit = actionFor(comboOf(event)); if (!hit) return;
    const id = hit.id;
    const sel = multi.length ? multi : selected ? [selected] : [];
    const run = (fn: () => void) => { event.preventDefault(); fn(); };
    if (id === 'help.shortcuts') return run(() => setShortcutsOpen(true));
    if (tab !== 'parts') return;
    if (id.startsWith('view.') && id !== 'view.planes') {
      const v = id.slice(5);
      return run(() => viewCommand(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].includes(v) ? 'view:' + v : v === 'fit' ? 'fit' : v === 'zoomSelected' ? 'zoomSelected' : v === 'normal' ? 'normal' : v + (hit.big ? ':big' : '')));
    }
    const modes = ['shaded', 'edges', 'wireframe'] as const;
    switch (id) {
      case 'view.planes': return run(() => setPrefs({ showPlanes: !prefs.showPlanes }));
      case 'display.shaded': case 'display.edges': case 'display.wireframe': return run(() => setPrefs({ displayMode: id.slice(8) as Any }));
      case 'display.cycle': return run(() => setPrefs({ displayMode: modes[(modes.indexOf(prefs.displayMode) + 1) % 3] }));
      case 'part.isolate': return run(() => { if (sel.length) { setIsolate(v => !v); setMode('3d'); } });
      case 'part.hide': return run(() => { if (!sel.length || vendor) return; const hide = !parts.filter((p: Any) => sel.includes(p.id)).every((p: Any) => p.hidden); action(async () => { await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: sel, hidden: hide }); await loadRevision(rev.id); }); });
      case 'part.showHidden': return run(() => setShowHidden(v => !v));
      case 'part.transparent': return run(() => { if (!sel.length) return; setTransparentIds(t => sel.every(x => t.includes(x)) ? t.filter(x => !sel.includes(x)) : [...new Set([...t, ...sel])]); });
      case 'part.opaque': return run(() => setTransparentIds([]));
      case 'part.ghost': return run(() => viewCommand('ghost'));
      case 'part.next': return run(() => stepPart(1));
      case 'part.prev': return run(() => stepPart(-1));
      case 'part.selectAll': return run(() => { const ids = filtered.map((p: Any) => p.id); setMulti(ids); setSelected(ids[0] || null); });
      case 'select.clear': return run(() => { if (layout.focus) setLayoutState(l => ({ ...l, focus: false })); else if (!jointDraft) choosePart(null); });
      case 'tool.measure': return run(() => viewCommand('measure'));
      case 'tool.section': return run(() => viewCommand('section'));
      case 'tool.explode': return run(() => viewCommand('explode'));
      case 'layout.focus': return run(() => setLayoutState(l => ({ ...l, focus: !l.focus })));
    }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => shortcutRef.current(e); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  /** Navigator click: plain = select, shift = range from the anchor, ctrl/cmd = toggle. */
  const clickRow = (id: string, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor.current) {
      const order = filtered.map((p: Any) => p.id); const a = order.indexOf(anchor.current), b = order.indexOf(id);
      if (a >= 0 && b >= 0) { const range = order.slice(Math.min(a, b), Math.max(a, b) + 1); setMulti(range); setSelected(id); if (mode !== '3d') setMode('3d'); return; }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = multi.includes(id) ? multi.filter(x => x !== id) : [...multi, id];
      setMulti(next); anchor.current = id; setSelected(next.includes(id) ? id : next[next.length - 1] || null); if (mode !== '3d') setMode('3d'); return;
    }
    choosePart(id);
  };
  const renderRow = (p: Any) => (
                          <div key={p.id} data-part={p.id} className={'part-row ' + (p.id === selected ? 'chosen' : multi.includes(p.id) ? 'multi' : '') + (p.hidden ? ' is-hidden' : '') + (p.excluded ? ' is-excluded' : '')}>
                            <button type="button" className="row-main" onClick={ev => clickRow(p.id, ev)}>
                              <span className={'part-glyph ' + p.category} style={p.spec.coating_hex ? { background: p.spec.coating_hex, color: '#fff' } : undefined}>{p.category === 'sheet_metal' ? <Layers size={17} /> : <Box size={17} />}</span>
                              <span><strong>{p.name}</strong><small>{p.excluded ? <b className="excluded-tag">Not for production</b> : categories[p.category]} <span>· Qty {p.quantity}</span>{p.spec.material && !p.excluded && <span> · {p.spec.material}</span>}</small></span>
                              {jointDraft?.kind === 'weld' && (() => { const check = weldability(p); return <span className={'weld-candidate ' + check.level} title={`${check.label}: ${check.reason}`}><Flame size={12} /></span>; })()}
                              {p.excluded || p.category === 'purchased' ? <span className="ready-mark na" title={p.excluded ? 'Not for production' : 'Purchased — no release needed'} />
                                : partReady(p) ? <CheckCircle2 size={15} className="green" aria-label="Production ready" />
                                : <span className={'ready-mark ' + (p.reviewed || p.doc_reviewed ? 'half' : '')} title={[!p.reviewed && 'design review', !p.doc_reviewed && 'drawing review', p.reviewed && p.doc_reviewed && 'open specification items'].filter(Boolean).join(' + ') + ' still to do'} />}
                            </button>
                            {!vendor && <button type="button" className="icon row-eye" title={p.hidden ? 'Show in viewer' : 'Hide in viewer'} onClick={() => setFlags(p.id, { hidden: !p.hidden })}>{p.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
                          </div>
                        );
  /** STEP assembly tree: sub-assemblies first, then the parts directly in this level. */
  const renderTree = (node: Any, depth: number): React.ReactNode => (
    <React.Fragment key={'n:' + node.key}>
      {node.groups.map((g: Any) => {
        const open = !collapsed.has(g.key);
        const ids = flattenTree(g).map((p: Any) => p.id);
        const cats = [...new Set(flattenTree(g).map((p: Any) => p.category))];
        const allHidden = flattenTree(g).every((p: Any) => p.hidden);
        const chosen = ids.length > 0 && ids.every((id: string) => multi.includes(id));
        return (
          <div key={g.key} className="asm-node" style={{ ['--depth' as Any]: depth }}>
            <div className={'asm-row' + (chosen ? ' chosen' : '')}>
              <button type="button" className="icon asm-toggle" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setCollapsed(c => { const n = new Set(c); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button type="button" className="asm-name" title="Select the whole sub-assembly" onClick={() => { setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; if (mode !== '3d') setMode('3d'); }}>
                <Folder size={15} /><strong>{g.name}</strong><small>{ids.length} part{ids.length === 1 ? '' : 's'} · {cats.length === 1 ? categories[cats[0]] : 'mixed'}</small>
              </button>
              <button type="button" className={'icon row-eye' + (chosen && isolate ? ' selected' : '')} title="Isolate this sub-assembly (show only its parts)" onClick={() => { if (chosen && isolate) { setIsolate(false); return; } setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; setIsolate(true); if (mode !== '3d') setMode('3d'); }}><Target size={14} /></button>
              {!vendor && <button type="button" className="icon row-eye" title={allHidden ? 'Show sub-assembly in viewer' : 'Hide sub-assembly in viewer'} onClick={() => action(async () => { await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids, hidden: !allHidden }); await loadRevision(rev.id); })}>{allHidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
            </div>
            {open && <div className="asm-children">{renderTree(g, depth + 1)}</div>}
          </div>
        );
      })}
      {node.parts.map(renderRow)}
    </React.Fragment>
  );
  const bulk = (body: Any) => action(async () => { const r = await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: multi, ...body }); await loadRevision(rev.id); notify(`${r.updated} parts updated`); });

  /** Chunked upload: proxies and tunnels (Cloudflare caps a request at 100 MB) never see one huge body.
   *  Each chunk is retried on its own, so a dropped connection costs one chunk, not the whole file. */
  const uploadFile = async (file: File, notes: string) => {
    const errorOf = async (r: Response) => {
      const t = await r.text().catch(() => '');
      try { const j = JSON.parse(t); if (typeof j.detail === 'string') return j.detail; } catch { /* proxy HTML */ }
      return r.status === 413 ? 'The server or proxy rejected the upload size (HTTP 413)' : `Upload failed (HTTP ${r.status})`;
    };
    setUploadPercent(0);
    try {
      const start = await api(`/projects/${project.id}/uploads`, 'POST', { filename: file.name, size: file.size, notes });
      const { upload_id: id, chunk_size: size, chunks } = start;
      let sent = 0;
      for (let i = 0; i < chunks; i++) {
        const blob = file.slice(i * size, Math.min(file.size, (i + 1) * size));
        for (let attempt = 1; ; attempt++) {
          let r: Response | null = null;
          try {
            r = await fetch(`/api/uploads/${id}/chunks/${i}`, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: blob });
          } catch { r = null; }
          if (r && r.ok) break;
          // client errors other than a timeout are final; network failures and 5xx/408/429 are retried
          if (r && r.status < 500 && ![408, 429].includes(r.status)) throw new Error(await errorOf(r));
          if (attempt >= 5) throw new Error(r ? await errorOf(r) : 'Upload failed: the connection keeps dropping. Check the network and try again.');
          await new Promise(res => setTimeout(res, 1000 * 2 ** (attempt - 1)));
        }
        sent += blob.size;
        setUploadPercent(Math.round(sent / file.size * 100));
      }
      const r = await api(`/uploads/${id}/complete`, 'POST');
      setUploadPercent(null);
      await loadRevision(r.id);
      setProject(await api('/projects/' + project.id));
      setModal('');
    } finally {
      setUploadPercent(null);
    }
  };

  if (!auth) return <div className="boot"><div className="brand-mark">F</div><span className="spinner" />Opening Forge…{error && <p>{error}</p>}</div>;

  if (!auth.user && !vendor) {
    const providers = auth.providers || { local: true, entra: false, domains: [] };
    const signinError = new URLSearchParams(location.search).get('signin_error');
    const reasons: Record<string, string> = { DomainNotAllowed: `Only ${(providers.domains || []).join(', ')} accounts can use Forge.`, GuestsNotAllowed: 'Guest accounts cannot use Forge.', WrongTenant: 'That account belongs to another organisation.', AccessDisabled: 'Your Forge access is disabled. Ask an administrator.', AccountConflict: 'This e-mail is linked to a different Microsoft account.', SessionExpired: 'The sign-in took too long. Try again.', StateMismatch: 'The sign-in could not be verified. Try again.', TokenInvalid: 'Microsoft sign-in could not be verified. Try again.', EntraError: 'Microsoft sign-in was cancelled or failed.', NoEmail: 'Your Microsoft account has no e-mail address.' };
    return (
      <div className="v-signin">
        <div className="v-signin-card">
          <div className="v-brand big"><LogoMark size={36} /><span><b>Forge</b><small>GOAT Robotics · CAD to shop floor</small></span></div>
          <h1>{auth.configured || providers.entra ? 'Sign in' : 'Set up your workspace'}</h1>
          <p className="muted">Drawings, design reviews, job orders and quality records — one revision-controlled workspace.</p>
          {signinError && <p className="error-text">{reasons[signinError] || 'Sign-in failed.'}</p>}
          {providers.entra && (
            <a className="button primary full ms" href={'/api/auth/entra/login?next=' + encodeURIComponent(location.pathname === '/' ? '/dashboard' : location.pathname + location.search)}>
              <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
              Sign in with Microsoft
            </a>
          )}
          {providers.entra && <small className="center">{(providers.domains || []).join(', ')} accounts only</small>}
          {providers.local && (
            <form onSubmit={e => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              action(async () => {
                const a = Object.fromEntries(f);
                if (!auth.configured) await api('/auth/setup', 'POST', a);
                await api('/auth/login', 'POST', a);
                setAuth(await api('/auth/status'));
                await afterSignIn();
              });
            }}>
              {providers.entra && <div className="v-or"><span>or local account</span></div>}
              {!auth.configured && <label>Your name<input name="name" required autoComplete="name" /></label>}
              <label>E-mail<input type="email" name="email" required autoComplete="username" /></label>
              <label>Password<input name="password" type="password" required minLength={auth.configured ? 1 : 12} autoComplete={auth.configured ? 'current-password' : 'new-password'} /></label>
              {error && <p className="error-text">{error}</p>}
              <button className={providers.entra ? 'full' : 'primary full'} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />} {auth.configured ? 'Sign in' : 'Create workspace'}</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const goHome = () => { if (vendor) return; setProject(null); setRev(null); go('projects'); };
  // ---- CAD workspace chrome: heads-up info and the floating tool palette ------------------------
  const weldTotal = (rev?.joints || []).filter((j: Any) => j.kind === 'weld').length;
  const inspectorContent = !!(jointDraft || weldListOpen || multi.length > 1 || part || overview);
  const canvasHud = !rev ? null : jointDraft ? (
    <div className="hud-card"><Flame size={15} className="weld-title-icon" /><span><b>{jointDraft.id ? 'Edit weld' : 'Weld setup'}</b><small>{(jointDraft.parts || []).length} component{(jointDraft.parts || []).length === 1 ? '' : 's'} · {(jointDraft.faces || []).filter((f: Any) => f.selection === 'edge').length} seam(s)</small></span></div>
  ) : multi.length > 1 ? (
    <div className="hud-card"><Layers size={15} /><span><b>{multi.length} parts selected</b><small>Shift-click a range · Ctrl/Cmd-click to toggle</small></span>
      <span className="hud-actions">
        <button type="button" className={isolate ? 'selected' : ''} title={`Show only the selected parts (${binding('part.isolate') || 'no key'})`} onClick={() => { setIsolate(!isolate); setMode('3d'); }}><Target size={14} />Isolate</button>
        <button type="button" className={multi.every(x => transparentIds.includes(x)) ? 'selected' : ''} title={`See through the selected parts (${binding('part.transparent') || 'no key'})`} onClick={() => setTransparentIds(t => multi.every(x => t.includes(x)) ? t.filter(x => !multi.includes(x)) : [...new Set([...t, ...multi])])}><Droplet size={14} />Transparent</button>
        {!vendor && editable && <button type="button" title="Add the selected parts as the next assembly step" onClick={() => addToSteps([...multi])}><ListPlus size={14} />Add step</button>}
        <button type="button" className="icon" title="Clear selection" onClick={() => choosePart(null)}><X size={14} /></button>
      </span></div>
  ) : part ? (
    <div className="hud-card">
      <Swatch hex={part.spec.coating_hex || categoryColors[part.category]} title={part.spec.coating_color || categories[part.category]} size={12} />
      <span><b title={part.name}>{part.name}</b><small>{categories[part.category]} · Qty {part.quantity}{part.spec.material ? ` · ${part.spec.material}` : ''}</small></span>
      <span className="hud-actions">
        <button type="button" className={isolate ? 'selected' : ''} title="Isolate (or double-click the part)" onClick={() => { const on = !isolate; setIsolate(on); setSolo(on && part.quantity > 1 ? (lastOccurrence.current ?? 0) : null); setMode('3d'); }}><Target size={14} />Isolate</button>
        {isolate && part.quantity > 1 && mode === '3d' && <span className="solo-step" title="This part is used more than once. Inspect one instance at a time; the view orbits around it.">
          <button type="button" className="icon" aria-label="Previous instance" onClick={() => setSolo(v => ((v ?? 0) - 1 + part.quantity) % part.quantity)}><ChevronLeft size={14} /></button>
          <button type="button" className={'solo-label' + (solo === null ? ' all' : '')} onClick={() => setSolo(v => v === null ? (lastOccurrence.current ?? 0) : null)}>{solo === null ? `All ${part.quantity}` : `${solo + 1} of ${part.quantity}`}</button>
          <button type="button" className="icon" aria-label="Next instance" onClick={() => setSolo(v => ((v ?? -1) + 1) % part.quantity)}><ChevronRight size={14} /></button>
        </span>}
        {part.category === 'sheet_metal' && <>
          <button type="button" className={mode === 'flat2d' ? 'selected' : ''} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message || 'Flat pattern (2D)'} onClick={() => setMode(mode === 'flat2d' ? '3d' : 'flat2d')}><Grid2x2 size={14} />Flat</button>
          <button type="button" className={mode === 'flat3d' ? 'selected' : ''} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message || 'Flat pattern in 3D'} onClick={() => setMode(mode === 'flat3d' ? '3d' : 'flat3d')}><Scan size={14} />Flat 3D</button>
        </>}
        <button type="button" className={'icon' + (transparentIds.includes(part.id) ? ' selected' : '')} title={`See through this part (${binding('part.transparent') || 'no key'})`} onClick={() => setTransparentIds(t => t.includes(part.id) ? t.filter(x => x !== part.id) : [...t, part.id])}><Droplet size={14} /></button>
        <button type="button" className="icon" title="Clear selection (Esc)" onClick={() => choosePart(null)}><X size={14} /></button>
      </span>
    </div>
  ) : (
    <div className="hud-card quiet"><Box size={15} /><span><b>{project?.name || rev.filename}</b><small>{parts.length} parts · {rev.manifest?.occurrences || 0} instances{blocking ? ` · ${blocking} release blockers` : ''}</small></span></div>
  );
  const canvasToolsStart = !rev ? null : <>
    {!vendor && editable && <button type="button" className={jointDraft ? 'selected' : ''} disabled={!!jointDraft} title={multi.length > 1 ? 'Weld the selected parts' : part ? 'Weld this part (to itself or to parts you click)' : 'Start a weld: click two faces'} onClick={() => startWeld(multi.length > 1 ? [...multi] : part ? [part.id] : [])}><Flame size={16} /><span>Weld</span></button>}
    {part && part.geometry.holes.length > 0 && part.category !== 'purchased' && multi.length < 2 && <button type="button" title="Hole hardware: inserts, studs, standoffs, taps, countersinks" onClick={() => setHoleCfg(part.id)}><CircleDot size={16} /><span>Holes</span></button>}
    {part && multi.length < 2 && showBend(part) && <button type="button" title={part.bend_sim ? 'Press brake simulation' : 'Press brake simulation (preview — not shared with vendors)'} onClick={() => setBendSim(part.id)}><FoldVertical size={16} /><span>Bending</span></button>}
    {!vendor && <><button type="button" className={weldListOpen ? 'selected' : ''} disabled={!!jointDraft} title="Configured welds" onClick={() => setWeldListOpen(v => !v)}><ListChecks size={16} /><span>Welds{weldTotal ? ` ${weldTotal}` : ''}</span></button>
</>}
  </>;
  const canvasToolsEnd = !rev ? null : <>
    <button type="button" className={overview && !part && multi.length < 2 && !jointDraft ? 'selected' : ''} title="Revision overview: drawing sets, readiness, part types" onClick={() => { setOverview(o => !o); if (part || multi.length > 1) choosePart(null); setLayout({ right: true, focus: false }); }}><PanelRight size={16} /><span>Overview</span></button>
    <button type="button" className="icon-only" title={layout.left && !layout.focus ? 'Hide model tree' : 'Show model tree'} onClick={() => setLayout({ left: !(layout.left && !layout.focus), focus: false })}>{layout.left && !layout.focus ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
    <button type="button" className={'icon-only' + (layout.focus ? ' selected' : '')} title={layout.focus ? 'Exit full canvas (Esc)' : `Full canvas (${binding('layout.focus')})`} onClick={() => setLayout({ focus: !layout.focus })}>{layout.focus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    <button type="button" className="icon-only" title={`Shortcuts & navigation (${binding('help.shortcuts')})`} onClick={() => setShortcutsOpen(true)}><Keyboard size={16} /></button>
    {transparentIds.length > 0 && <button type="button" title={`${transparentIds.length} transparent part(s) — make all opaque`} onClick={() => setTransparentIds([])}><Droplet size={16} /><span>{transparentIds.length}</span></button>}
  </>;
  const workspaceTab = (page === 'project' || !!vendor) && tab === 'parts' && !!rev && rev.status !== 'processing';
  if (rev && tab === 'parts' && rev.status !== 'processing') modelSeen.current = rev.id;
  const ctx = { busy, action, notify };
  const activeJobs = projects.reduce((n: number, p: Any) => n + (p.open_job_orders || 0), 0);
  const signOut = () => action(async () => { await api('/auth/logout', 'POST'); setAuth(await api('/auth/status')); });

  return (
    <div className={'app' + (vendor ? ' vendor' : '')}>
      {!vendor && <Sidebar page={page} go={go} user={auth.user} perms={perms} badges={{ joborders: activeJobs }} onSignOut={signOut} />}

      <main className={(workspaceTab ? 'fixed' : '') + (layout.focus && tab === 'parts' && page === 'project' ? ' canvas-focus' : '')}>
        {vendor && (
          <header className="v-header">
            <div className="v-crumbs"><LogoMark size={22} /><b>Forge</b><ChevronRight size={14} /><span>Vendor workspace · read only</span>{rev && <><ChevronRight size={14} /><span className="crumb-rev">Rev {rev.number} · {rev.filename}</span></>}</div>
            <div className="v-header-right">{rev && <button type="button" className="mini" onClick={copyLink}><Link size={13} />Copy link</button>}</div>
          </header>
        )}
        {!vendor && page === 'dashboard' ? <Dashboard ctx={ctx} openJobOrder={openJobOrder} openProject={openProjectId} />
        : !vendor && page === 'joborders' ? <JobOrdersPage projects={projects} ctx={ctx} perms={perms} openJobOrder={openJobOrder} />
        : !vendor && page === 'joborder' && joId ? <JobOrderDetail id={joId} ctx={ctx} back={() => go('joborders')} openProject={openProjectId} />
        : !vendor && page === 'templates' ? <TemplatesPage ctx={ctx} perms={perms} />
        : !vendor && page === 'admin' ? <AdminPage ctx={ctx} me={auth.user} />
        : !vendor && (page === 'projects' || !project) ? (
          <div className="v-page">
            <PageHeader title="Projects" description="From the first CAD upload to the final quality check." actions={<>
              {perms.has('users.manage') && <button onClick={() => { setModal('settings'); api('/settings').then(setSettings).catch(fail); }}><Settings size={15} />Workspace defaults</button>}
              {perms.has('project.create') && <button className="primary" onClick={() => setModal('project')}><Plus size={15} />New project</button>}
            </>} />
            <div className="v-body">
              {!projectsLoaded ? (
                <div className="empty-page loading-page"><LoaderCircle size={30} className="spin" /><p>Loading projects…</p></div>
              ) : projects.length ? (
                <div className="v-card flush">
                  <table className="v-table">
                    <thead><tr><th>Project</th><th>Active revision</th><th>Status</th><th>Job orders</th><th>Created</th></tr></thead>
                    <tbody>{projects.map(p => (
                      <tr key={p.id} className="click" onClick={() => action(() => openProject(p))}>
                        <td><span className="flex"><span className="project-icon sm"><Box size={16} /></span><span><b>{p.code ? p.code + ' · ' : ''}{p.name}</b><small>{p.description || 'CAD, drawings and manufacturing records'}</small></span></span></td>
                        <td>{p.active_revision ? 'Rev ' + p.active_revision : '—'}<small>{p.revision_count} revisions</small></td>
                        <td>{p.active_status ? <Badge kind={p.active_status === 'released' ? 'success' : p.active_status === 'failed' ? 'danger' : 'warning'}>{p.active_status === 'released' ? 'Production ready' : p.active_status === 'ready' ? 'In design review' : p.active_status.replace('_', ' ')}</Badge> : <Badge kind="neutral">No CAD</Badge>}</td>
                        <td className="tabular">{p.open_job_orders || 0} open</td>
                        <td>{date(p.created)}<small>{p.created_by}</small></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : (
                <div className="v-empty">
                  <Upload />
                  <h3>Start with your CAD</h3>
                  <p>Create a project, set its naming, title block and templates, then upload a STEP assembly.</p>
                  {perms.has('project.create') && <button className="primary" onClick={() => setModal('project')}><Plus size={15} />New project</button>}
                </div>
              )}
              <div className="workflow-strip">
                {[['01', 'Upload & analyze', 'STEP in; parts, features, materials and bends out.'], ['02', 'Check & review', 'Design checks and drawing review, part by part.'], ['03', 'Production ready', 'Release locks the documents for the shop floor.'], ['04', 'Job orders', 'Process checklists with counts and timestamps.']].map(([n, t, sub]) => (
                  <div key={n}><span>{n}</span><h3>{t}</h3><p>{sub}</p></div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {(vendor || project) && (
          // The open project stays mounted while other pages are shown, so coming back is instant (no model reload).
          <div className={'project-host' + (vendor || (page === 'project' && project) ? '' : ' kept-hidden')}>
            <header className="doc-bar">
              <div className="doc-id">
                {!vendor && <><button type="button" className="doc-crumb" onClick={goHome}>Projects</button><ChevronRight size={13} className="doc-sep" /></>}
                <span className="doc-name" title={project?.name || rev?.filename}>{project?.code && <em>{project.code}</em>}{project?.name || rev?.filename || 'Shared design'}</span>
                {rev && <div className="revision-picker doc-rev">
                  <button type="button" onClick={() => setRevisionOpen(!revisionOpen)} title="Switch revision"><GitBranch size={13} />Rev {rev.number}{!vendor && <ChevronDown size={13} />}</button>
                  {revisionOpen && !vendor && (
                    <div className="dropdown">
                      {project?.revisions.map((r: Any) => <button key={r.id} onClick={() => { setRevisionOpen(false); choosePart(null); loadRevision(r.id).catch(fail); }}>Rev {r.number}<Badge>{r.state}</Badge></button>)}
                      {project?.revisions.length > 1 && <button onClick={() => action(async () => { const other = project.revisions.find((r: Any) => r.id !== rev.id); setComparison(await api(`/revisions/${rev.id}/compare/${other.id}`)); setModal('compare'); setRevisionOpen(false); })}>Compare with previous</button>}
                    </div>
                  )}
                </div>}
                {rev && (() => {
                  const allReady = rev.status === 'ready' && releaseParts.length > 0 && readyCount === releaseParts.length;
                  const label = rev.state === 'archived' ? 'Archived' : rev.status === 'released' ? 'Released' : rev.status === 'ready' ? (allReady ? 'Ready to release' : 'In design review') : rev.status.replace('_', ' ');
                  const tone = rev.state === 'archived' ? 'neutral' : rev.status === 'released' || allReady ? 'success' : rev.status === 'failed' ? 'danger' : 'warning';
                  const openRelease = () => action(async () => { setRelease(await api(`/revisions/${rev.id}/release-check`)); setModal('release'); });
                  if (allReady && !vendor && rev.state === 'active') return <span className="doc-release">
                    <span className="doc-status success" title={`All ${releaseParts.length} part${releaseParts.length === 1 ? '' : 's'} production ready — release the revision to start job orders.`}><i />Ready to release</span>
                    <button type="button" className="primary" disabled={!!job || !can('revision.release')} title={can('revision.release') ? 'Final check, then release this revision for production' : 'You need the release permission'} onClick={openRelease}><ShieldCheck size={14} />Release revision</button>
                  </span>;
                  return <button type="button" className={'doc-status ' + tone} onClick={() => { choosePart(null); setOverview(true); setLayout({ right: true, focus: false }); }}
                    title={rev.status === 'released' ? 'This revision is released for production.' : `Revision status — ${readyCount} of ${releaseParts.length} parts production ready. The revision leaves design review when every part is ready and it is released from Overview.`}>
                    <i />{label}{rev.status === 'ready' && !allReady && <small>{readyCount}/{releaseParts.length} ready</small>}</button>;
                })()}
              </div>
              {rev && <nav className="doc-tabs" aria-label="Revision views">
                {[['parts', 'Model', Box], ['rules', 'Checks', ShieldCheck], ['assembly', 'Assembly', Layers], ['steps', 'Steps', ListOrdered], ...(vendor ? [['production', 'Drawings', Factory]] : [['joborders', 'Jobs', Factory]]), ['review', 'Review', MessageSquare], ['qc', 'Quality', ClipboardCheck], ...(!vendor ? [['audit', 'History', Clock]] : [])].map(([id, label, Icon]: Any) => (
                  <button type="button" className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon size={15} />{label}{id === 'rules' && blocking > 0 && <b>{blocking}</b>}</button>
                ))}
              </nav>}
              <div className="doc-actions">
                {vendor && <span className="doc-note">Supplier review · read only</span>}
                {!vendor && rev && <button type="button" className="icon" onClick={copyLink} title="Copy a link to this view"><Link size={15} /></button>}
                {!vendor && project && (project.permissions || []).includes('project.settings') && <button type="button" className="icon" title="Project settings" onClick={() => setModal('project-settings')}><Settings size={15} /></button>}
                {!vendor && (project?.permissions || []).includes('revision.upload') && <button type="button" className={importingRevision ? '' : 'icon'} title={importingRevision ? 'View import progress' : 'Upload a new revision'} onClick={() => importingRevision ? showImport() : setModal('upload')}>{importingRevision ? <><LoaderCircle size={15} className="spin" />{importingRevision.progress || 0}%</> : <Upload size={15} />}</button>}
                {rev && can('cad.download') && <button type="button" className="icon" onClick={() => doc(`/revisions/${rev.id}/assets/manufacturing-pack.zip`, 'manufacturing-pack.zip')} disabled={!rev.assets?.includes('manufacturing-pack.zip')} title={rev.assets?.includes('manufacturing-pack.zip') ? 'Download the manufacturing pack' : 'Generate the manufacturing pack first (Overview)'}><Download size={15} /></button>}
                {rev && !vendor && can('share.manage') && <button type="button" className="primary" disabled={!['ready', 'released'].includes(rev.status)} onClick={() => { setSharePath(''); setModal('share'); }}><Send size={14} />Share</button>}
              </div>
            </header>

            {importingRevision && <div className="job-pill" role="status" aria-live="polite">
              <LoaderCircle size={16} className="spin" />
              <span>Revision {importingRevision.number} · {importingRevision.message || 'Import queued'}</span>
              <progress aria-label="CAD import progress" max="100" value={importingRevision.progress || 0} />
              <b>{importingRevision.progress || 0}%</b>
              {rev?.id !== importingRevision.id && <button className="mini" onClick={showImport}>View import</button>}
            </div>}

            {!rev && vendor ? (
              <div className="empty-page"><LoaderCircle className="spin" /><p>Loading shared revision…</p></div>
            ) : !rev && (project?.revisions?.length || project?.active_revision || revLoading) ? (
              <div className="empty-page loading-page"><LoaderCircle size={34} className="spin" /><h2>Opening {project?.name || 'project'}…</h2><p>Loading the latest revision, parts and drawings. Large assemblies take a few seconds.</p></div>
            ) : !rev ? (
              <div className="empty-page"><Upload size={42} /><h2>Every part starts here.</h2><p>Upload STEP, IGES or BREP. Assemblies and multi-body parts stay connected.</p><button className="primary" onClick={() => setModal('upload')}>Upload CAD file</button></div>
            ) : (
              <>
                {job && !importingRevision && <div className="job-pill" role="status" aria-live="polite">{rev.progress >= 100 ? <CheckCircle2 size={15} /> : <LoaderCircle size={15} className="spin" />}<span>{rev.message || 'Job queued'}</span><progress max="100" value={rev.progress} /><b>{rev.progress}%</b></div>}
                {rev.status === 'failed' && <div className="error-banner">Import failed: {rev.message}. The previous active revision is preserved.</div>}
                {rev.state === 'archived' && <div className="notice"><Archive size={15} />Archived revision — read-only design and historical documents. New production work should use the active released revision.</div>}

                {(tab === 'parts' || modelSeen.current === rev.id) && (
                  <div className={(tab === 'parts' ? '' : 'kept-hidden ') + 'workspace cad' + (layout.left && !layout.focus ? '' : ' no-left') + (layout.right && !layout.focus && inspectorContent ? '' : ' no-right')}>
                    <aside className="part-list">
                      <div className={'list-heading' + (multi.length > 1 ? ' multi' : '')}><h3>{multi.length > 1 ? `${multi.length} selected` : 'Part navigator'}</h3><div className="flex">{multi.length > 1 && <button type="button" className="mini" onClick={() => choosePart(null)}><X size={12} />Clear</button>}{suppressedIds.length > 0 && <button type="button" className={'mini' + (showHidden ? ' selected' : '')} title={showHidden ? 'Hide purchased and hidden parts' : 'Override: show purchased and hidden parts'} onClick={() => setShowHidden(!showHidden)}>{showHidden ? <Eye size={13} /> : <EyeOff size={13} />}{suppressedIds.length}</button>}{hasTree && <button type="button" className={'mini' + (treeView ? ' selected' : '')} title={treeView ? 'Show a flat list' : 'Show the CAD assembly tree'} onClick={() => { const v = !treeView; setTreeView(v); try { localStorage.setItem('forge-nav-tree', v ? 'tree' : 'list'); } catch { /* ignore */ } }}><ListTree size={13} /></button>}<span>{parts.length}</span></div></div>
                      <div className="search"><Search size={16} /><input aria-label="Search parts" placeholder="Find a part…" value={query} onChange={e => setQuery(e.target.value)} /></div>
                      <div className="nav-filter"><div className="nav-filter-select"><Select size="sm" aria-label="Filter part type" value={category} onChange={value => { setCategory(value); choosePart(null); }} options={[
                        { value: 'all', label: 'All part types', hint: String(parts.length) },
                        ...Object.entries(categories).map(([k, v]) => ({ value: k, label: v, hint: String(parts.filter((p: Any) => p.category === k).length) })),
                        { value: 'hidden', label: 'Hidden in viewer', hint: String(hiddenIds.length) },
                        { value: 'excluded', label: 'Not for production', hint: String(parts.filter((p: Any) => p.excluded).length) },
                      ]} /></div>
                        <button type="button" className="icon" onClick={() => stepPart(-1)} disabled={!filtered.length} title="Previous part (↑)"><ArrowUp size={14} /></button><button type="button" className="icon" onClick={() => stepPart(1)} disabled={!filtered.length} title="Next part (↓)"><ArrowDown size={14} /></button></div>
                      <button className={'assembly-root ' + (!selected ? 'chosen' : '')} onClick={() => choosePart(null)}>
                        <Layers size={18} /><span>Complete assembly<small>{rev.manifest.occurrences || 0} body instances</small></span>
                      </button>
                      <div className="part-scroll" ref={listRef}>
                        {treeView && hasTree ? renderTree(tree, 0) : filtered.map(renderRow)}
                        {!filtered.length && <p className="muted padded">{job ? 'Analyzing components…' : 'No matching parts.'}</p>}
                      </div>
                      <div className="list-footer"><span title="Shift-click selects a range, Ctrl/Cmd-click toggles">{hiddenIds.length ? `${hiddenIds.length} hidden` : `${holes} named bores`} · ⇧ range</span><span title="Parts production ready (design review + drawing review + specification complete)">{readyCount}/{releaseParts.length} ready</span></div>
                    </aside>

                    <div className="canvas-panel">
                      {rev.status !== 'processing' && rev.status !== 'failed' ? (
                        mode === 'flat2d' && part ? (
                          <FlatPattern partId={part.id} thickness={part.geometry.thickness} kFactor={part.spec.k_factor} approved={!!part.spec.k_factor_approved} name={part.name} />
                        ) : (
                          <Viewer
                            url={mode === 'flat3d' && part ? `${rev.id}:flat.glb:${part.id}` : `${rev.id}:assembly.glb`}
                            hud={canvasHud}
                            toolbarStart={canvasToolsStart}
                            toolbarEnd={canvasToolsEnd}
                            pickMode={jointDraft && !addingParts ? pickMode : null}
                            jointPreview={weldDraftPreview}
                            welds={mode === '3d' ? savedWelds : []}
                            onWeldClick={id => { const j = (rev.joints || []).find((x: Any) => x.id === id); if (!j || jointDraft) return; if (editable) editWeld(j); else setWeldListOpen(true); }}
                            seamCandidates={jointDraft ? seamView : []}
                            hoverSeam={hoverSeam}
                            onSeamHover={setHoverSeam}
                            onSeamToggle={(id, wholeSide) => {
                              const s = seamCandidates.find(x => x.id === id); if (!s) return;
                              if (wholeSide) { const list = sameSide(seamsTagged, s).filter((t: Any) => !t.welded_by); setJointDraft((d: Any) => d && addSeams(d, list)); notify(`${list.length} ${s.side || ''} seam${list.length === 1 ? '' : 's'} added`); }
                              else setJointDraft((d: Any) => d && toggleSeamOn(d, s));
                            }}
                            hoverGeometry={hoverGeometry}
                            onWeldPreviewStatus={(valid, message) => setWeldPreviewStatus(current => current?.valid === valid && current.message === message ? current : { valid, message })}
                            onGeometryHover={(pid, point, selection, occurrence) => {
                              const request = ++hoverRequest.current;
                              if (!pid || !jointDraft || !point.length) { setHoverGeometry(null); return; }
                              api(`/parts/${pid}/${selection}-at`, 'POST', { point })
                                .then(f => { if (hoverRequest.current === request) setHoverGeometry({ part: pid, selection, occurrence, ...f }); })
                                .catch(() => { if (hoverRequest.current === request) setHoverGeometry(null); });
                            }}
                            onGeometryPick={(pid, point, selection, occurrence) => {
                              if (!jointDraft) return;
                              hoverRequest.current++;
                              setWeldPreviewStatus(null);
                              setHoverGeometry(null);
                              if (jointDraft.kind === 'weld') {
                                const candidate = parts.find((p: Any) => p.id === pid);
                                const check = weldability(candidate);
                                if (check.level === 'blocked') { notify(`${candidate?.name || 'This component'}: ${check.reason}`); return; }
                                if (jointDraft.scopeLocked && !(jointDraft.parts || []).includes(pid)) { notify('This weld is locked to the selected component. Cancel and start from another selection to change scope.'); return; }
                              }
                              if (selection === 'point') {
                                setJointDraft((d: Any) => d && ({ ...d, weld: { ...d.weld, placement: { part: pid, point, occurrence } } }));
                                setPickMode(null); return;
                              }
                              const weldType = jointDraft.weld?.type || 'linear';
                              if (jointDraft.kind === 'weld' && selection === 'face' && (weldType === 'linear' || weldType === 'stitch')) {
                                // Face pair → seam. Works for any two faces: two parts, one part closing on itself, or
                                // several parts picked pair by pair.
                                action(async () => {
                                  const f = await api(`/parts/${pid}/face-at`, 'POST', { point });
                                  const pick = { part: pid, occurrence, selection: 'face', ...f };
                                  const first = pairPick[0];
                                  if (!first) { setPairPick([pick]); setWeldPreviewStatus({ valid: false, message: 'Face A picked — now click face B, the face it is welded to.' }); return; }
                                  if (first.part === pid && first.occurrence === occurrence && first.index === f.index) { setPairPick([]); setWeldPreviewStatus(null); return; }
                                  setPairPick([first, pick]);
                                  const r = await api(`/revisions/${rev.id}/weld-seams`, 'POST', { parts: [...new Set([first.part, pid])], faces: [first, pick].map(x => ({ part: x.part, occurrence: x.occurrence || 0, index: x.index })) });
                                  setPairPick([]);
                                  if (!r.seams?.length) { setWeldPreviewStatus({ valid: false, message: r.message || 'No seam between these faces.' }); notify(r.message || 'No seam between these faces.'); return; }
                                  const offset = seamCandidates.length;
                                  const labelled = r.seams.map((x: Any, i: number) => ({ ...x, id: `S${offset + i + 1}` }));
                                  setSeamCandidates(c => [...c.filter(x => !labelled.some((y: Any) => seamKey(y) === seamKey(x))), ...labelled]);
                                  setJointDraft((d: Any) => {
                                    if (!d) return d;
                                    const have = new Set(d.faces.filter((x: Any) => x.selection === 'edge').map(seamKey));
                                    return labelled.filter((x: Any) => !have.has(seamKey(x))).reduce((acc: Any, x: Any) => toggleSeamOn(acc, x), { ...d, faces: d.faces.filter((x: Any) => x.selection === 'edge') });
                                  });
                                  const g = labelled[0];
                                  notify(`${labelled.length} seam${labelled.length === 1 ? '' : 's'} added · ${g.joint === 'gap' ? `bridges a ${fmt(g.gap)} mm gap` : g.joint === 'fillet' ? `fillet${g.angle ? ` at ${Math.round(g.angle)}°` : ''}` : g.joint} · ${Math.round(labelled.reduce((n: number, x: Any) => n + x.length, 0))} mm. Pick the next pair or save.`);
                                });
                                return;
                              }
                              action(async () => {
                                const f = await api(`/parts/${pid}/${selection}-at`, 'POST', { point });
                                setJointDraft((d: Any) => {
                                  if (!d) return d;
                                  const exists = d.faces.some((x: Any) => x.part === pid && x.occurrence === occurrence && x.selection === selection && x.index === f.index);
                                  if (exists) return { ...d, faces: d.faces.filter((x: Any) => !(x.part === pid && x.occurrence === occurrence && x.selection === selection && x.index === f.index)), weld: { ...d.weld, placement: null } };
                                  const type = d.weld?.type || 'linear';
                                  const added = [...d.faces, { part: pid, occurrence, selection, ...f }];
                                  // A continuous/stitch seam may follow several connected B-rep edges.
                                  // Face-pair inference and tack welds remain intentionally limited to 2 faces.
                                  const faces = type === 'patch' ? added.filter((x: Any) => x.selection !== 'edge')
                                    : selection === 'edge' && ['linear', 'stitch'].includes(type) ? added.filter((x: Any) => x.selection === 'edge').slice(-32)
                                      : added.filter((x: Any) => x.selection !== 'edge').slice(-2);
                                  const partIds = [...new Set([...(d.parts || []), ...faces.map((x: Any) => x.part)])];
                                  return { ...d, parts: partIds, faces, weld: { ...d.weld, placement: null } };
                                });
                              });
                            }}
                            selected={mode === 'flat3d' || jointDraft ? null : selected}
                            isolated={isolate}
                            flat={mode === 'flat3d'}
                            navStyle={prefs.navStyle}
                            displayMode={prefs.displayMode}
                            onDisplayMode={m => setPrefs({ displayMode: m })}
                            showPlanes={prefs.showPlanes}
                            onShowPlanes={v => setPrefs({ showPlanes: v })}
                            transparentIds={transparentIds}
                            command={viewCmd}
                            appearance={appearance}
                            hidden={canvasHiddenIds}
                            multi={jointDraft ? (jointDraft.parts || []) : multi}
                            focusIds={weldFocusIds}
                            representativeOccurrences={isolate && selected && solo !== null && !jointDraft ? { ...weldRepresentatives, [selected]: solo } : weldRepresentatives}
                            feature={mode === '3d' ? feature : null}
                            onPick={(id, additive, occurrence) => {
                              lastOccurrence.current = occurrence;
                              if (mode === 'flat3d') return;
                              if (jointDraft?.kind === 'weld' && addingParts) {
                                if (!id || !parts.some((p: Any) => p.id === id)) return;
                                const check = weldability(parts.find((p: Any) => p.id === id));
                                if (check.level === 'blocked') { notify(check.reason); return; }
                                const has = (jointDraft.parts || []).includes(id);
                                const next = { ...jointDraft, parts: has ? jointDraft.parts.filter((x: string) => x !== id) : [...(jointDraft.parts || []), id], faces: has ? jointDraft.faces.filter((f: Any) => f.part !== id && f.other_part !== id) : jointDraft.faces };
                                setJointDraft(next); setSeamCandidates(c => c.filter(s => next.parts.includes(s.part) && next.parts.includes(s.other_part)));
                                if (next.parts.length >= 2) detectSeams(next, true);
                                return;
                              }
                              if (jointDraft) return; // seams / faces are picked while a weld is open
                              if (!id) { if (!additive) choosePart(null); return; }
                              if (!parts.some((p: Any) => p.id === id)) return;
                              if (additive) { const next = multi.includes(id) ? multi.filter(x => x !== id) : [...(multi.length ? multi : selected ? [selected] : []), id]; setMulti(next); setSelected(next.includes(id) ? id : next[next.length - 1] || null); anchor.current = id; }
                              else choosePart(id);
                            }}
                            onIsolateToggle={occurrence => {
                              const many = (part?.quantity || 1) > 1 && occurrence !== undefined;
                              if (!isolate) { setIsolate(true); setSolo(many ? occurrence! : null); }
                              else if (many && solo === null) setSolo(occurrence!);
                              else { setIsolate(false); setSolo(null); }
                            }}
                          />
                        )
                      ) : (
                        <div className="processing">
                          <div className="cad-orbit"><Box size={72} /></div>
                          <h2>{rev.status === 'failed' ? 'CAD import needs attention' : 'Reading your design'}</h2>
                          <p>{rev.message}</p>
                          <small>Geometry processing runs independently of the website.</small>
                        </div>
                      )}
                    </div>

                    <aside className="inspector">
                      {jointDraft ? (
                        <JointPanel draft={jointDraft} setDraft={d => { setWeldPreviewStatus(null); setJointDraft(d); }} parts={parts} options={jointOptions} pickMode={pickMode} setPickMode={setPickMode} busy={busy} previewStatus={weldPreviewStatus}
                          studio={{ seams: seamsTagged, detecting, detectMessage, onDetect: () => detectSeams(jointDraft, !(jointDraft.faces || []).length), hoverSeam, setHoverSeam, addingParts, setAddingParts, seamSide, setSeamSide }}
                          onCancel={endWeld}
                          onSave={() => action(async () => {
                            const body = { kind: jointDraft.kind, parts: jointDraft.parts, faces: jointDraft.faces, weld: jointDraft.kind === 'weld' ? jointDraft.weld : {}, fasteners: jointDraft.fasteners || '', torque: jointDraft.torque || '', sequence: Number(jointDraft.sequence || 0), notes: jointDraft.notes || '', name: jointDraft.name || '' };
                            if (jointDraft.id) await api('/joints/' + jointDraft.id, 'PUT', body); else await api(`/revisions/${rev.id}/joints`, 'POST', body);
                            endWeld(); setWeldListOpen(true); await refreshJoints(rev.id); notify('Weld saved — it now shows on the model.');
                          })} />
                      ) : weldListOpen ? (
                        <ConfiguredWelds joints={rev.joints || []} parts={parts} editable={editable} onClose={() => setWeldListOpen(false)} onEdit={editWeld} onDelete={async j => {
                          if (await ask({ title: `Remove ${j.data.name || 'weld ' + (j.data.sequence || '')}?`, message: 'Its production step is removed from new job orders too.', confirm: 'Remove weld', danger: true }) === null) return;
                          // Remove it from the list at once; only the joints are re-read (not the whole revision).
                          setRev((r: Any) => r && { ...r, joints: (r.joints || []).filter((x: Any) => x.id !== j.id) });
                          api('/joints/' + j.id, 'DELETE').then(() => notify('Configured weld removed.')).catch(fail).finally(() => refreshJoints(rev.id).catch(fail));
                        }} />
                      ) : multi.length > 1 ? (
                        <GroupPanel templates={templates.filter((t: Any) => t.kind === 'process')} onProcess={tid => action(async () => { await api(`/revisions/${rev.id}/parts/process-template`, 'POST', { ids: multi, template_id: tid }); await loadRevision(rev.id); notify('Process template applied'); })}
                          onJoint={() => startWeld([...multi])} parts={parts.filter((p: Any) => multi.includes(p.id))} vendor={vendor} editable={editable} busy={busy}
                          onEdit={() => { setEditing({ group: parts.filter((p: Any) => multi.includes(p.id)) }); setModal('group-spec'); }}
                          onBulk={bulk} onExclude={() => setExcluding(parts.filter((p: Any) => multi.includes(p.id)))} onRemove={id => { const next = multi.filter(x => x !== id); setMulti(next); if (selected === id) setSelected(next[next.length - 1] || null); }}
                          onFocus={id => setSelected(id)} onClear={() => choosePart(null)} />
                      ) : part ? (() => {
                        const openFindings = selectedFindings.filter((f: Any) => f.severity === 'blocker' && !f.waiver);
                        const specDone = openFindings.length === 0;
                        const ready = partReady(part);
                        const path = part.assembly_path || [];
                        const asmKey = path.join(' / ');
                        const siblings = path.length ? parts.filter((p: Any) => (p.assembly_path || []).slice(0, path.length).join(' / ') === asmKey) : [];
                        const differ = siblings.filter((p: Any) => p.category !== part.category);
                        const missing = (k: string) => editable ? <button type="button" className="pi-add" onClick={() => setReadyFor(part.id)}>Add</button> : <span className="muted">—</span>;
                        const row = (label: string, value: Any, opt = false) => (opt && !value) ? null : <div className="pi-kv" key={label}><span>{label}</span><b>{value || missing(label)}</b></div>;
                        return (
                        <div className="pi">
                          <header className="pi-head">
                            <div className="pi-title">
                              <span className={'pi-type ' + part.category}><span className={'part-glyph ' + part.category} style={part.spec.coating_hex ? { background: part.spec.coating_hex, color: '#fff' } : undefined}>{part.category === 'sheet_metal' ? <Layers size={14} /> : <Box size={14} />}</span>{categories[part.category]}{part.geometry.carried_from && <em title="Carried over from an earlier revision">rev {part.geometry.carried_from.revision}</em>}</span>
                              <h2 title={part.name}>{part.name}</h2>
                              <small>{part.id.slice(-10).toUpperCase()} · Qty {part.quantity}{part.geometry.mass_kg !== undefined ? ` · ${fmt(part.geometry.mass_kg)} kg` : ''}</small>
                            </div>
                            {!vendor && <div className="pi-menu">
                              <button type="button" className="icon" aria-label="More actions" onClick={() => setPartMenu(v => !v)}><MoreHorizontal size={18} /></button>
                              {partMenu && <div className="pi-scrim" onClick={() => setPartMenu(false)} />}
                              {partMenu && <div className="dropdown pi-dropdown">
                                <button type="button" onClick={() => { setPartMenu(false); setFlags(part.id, { hidden: !part.hidden }); }}>{part.hidden ? <Eye size={14} /> : <EyeOff size={14} />}{part.hidden ? 'Show in viewer by default' : 'Hide in viewer by default'}</button>
                                {editable && !part.excluded && <button type="button" onClick={() => { setPartMenu(false); setEditing(JSON.parse(JSON.stringify(part))); setModal('spec'); }}><Settings size={14} />All manufacturing details</button>}
                                {editable && !part.excluded && <button type="button" onClick={() => { setPartMenu(false); startWeld([part.id]); }}><Flame size={14} />Weld this component</button>}
                                {editable && <button type="button" onClick={() => { setPartMenu(false); addToSteps([part.id]); }}><ListPlus size={14} />Add as assembly step</button>}
                                {part.geometry.holes.length > 0 && <button type="button" onClick={() => { setPartMenu(false); setHoleCfg(part.id); }}><CircleDot size={14} />Holes &amp; hardware…</button>}
                                {canBend(part) && <button type="button" onClick={() => { setPartMenu(false); setBendSim(part.id); }}><FoldVertical size={14} />Bending simulation…</button>}
                                {editable && canBend(part) && <button type="button" onClick={() => { setPartMenu(false); setBendSharing([part.id], part.bend_sim ? 'off' : 'on'); }}>{part.bend_sim ? <EyeOff size={14} /> : <Eye size={14} />}{part.bend_sim ? 'Stop sharing bending simulation' : 'Share bending simulation'}</button>}
                                {editable && canBend(part) && part.drawing_options?.bend_sim !== undefined && <button type="button" onClick={() => { setPartMenu(false); setBendSharing([part.id], 'inherit'); }}><Undo2 size={14} />Bending simulation: use project default</button>}
                                {editable && (part.excluded
                                  ? <button type="button" onClick={() => { setPartMenu(false); setFlags(part.id, { excluded: false }); }}><Undo2 size={14} />Restore to production</button>
                                  : <button type="button" className="danger" onClick={() => { setPartMenu(false); setExcluding([part]); }}><Ban size={14} />Not for production…</button>)}
                              </div>}
                            </div>}
                          </header>

                          {part.excluded ? (
                            <div className="pi-card muted-card"><Ban size={16} /><div><b>Not for production</b><p>{(part.exclusion_reason || 'Excluded from this revision').replace(/[.]?$/, '.')} Skipped in release checks, drawing packs and the vendor checklist.</p>{editable && <button type="button" className="mini" onClick={() => setFlags(part.id, { excluded: false })}><Undo2 size={13} />Restore</button>}</div></div>
                          ) : part.category === 'purchased' ? (
                            <div className="pi-card muted-card"><Box size={16} /><div><b>Purchased part</b><p>Bought complete — no drawing release needed.</p>
                              <label className="pi-switch"><input type="checkbox" checked={!!part.drawing_options?.assembly_show} disabled={busy || !editable} onChange={e => { const show = e.target.checked; action(async () => { await api(`/revisions/${rev.id}/parts/assembly-drawing`, 'POST', { ids: [part.id], show }); await loadRevision(rev.id); }); }} /><span />Show on the assembly drawing</label></div></div>
                          ) : (
                            <div className={'pi-card ready-card' + (ready ? ' ok' : '')}>
                              <div className="pi-steps">
                                <span className={specDone ? 'done' : ''} title={specDone ? 'Specification complete' : `${openFindings.length} open specification items`}><i>{specDone ? <Check size={11} /> : openFindings.length}</i>Spec</span>
                                <span className={part.reviewed ? 'done' : ''}><i>{part.reviewed ? <Check size={11} /> : '2'}</i>Design</span>
                                <span className={part.doc_reviewed ? 'done' : ''}><i>{part.doc_reviewed ? <Check size={11} /> : '3'}</i>Drawing</span>
                              </div>
                              {editable ? <button type="button" className={ready ? '' : 'primary'} onClick={() => setReadyFor(part.id)}>{ready ? <><CheckCircle2 size={15} />Production ready</> : <><Sparkles size={15} />Make production ready</>}</button>
                                : <p className="pi-ready-note">{ready ? <><CheckCircle2 size={14} />Production ready</> : 'Engineering is still completing this part — manufacture only from released drawings.'}</p>}
                            </div>
                          )}

                          {editable && !part.excluded && <div className="pi-props">
                            <label><span>Type</span><Select size="sm" value={part.category} disabled={busy} onChange={v => action(async () => { if (v === part.category) return; await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: [part.id], category: v }); await loadRevision(rev.id); notify(`${part.name} is now ${categories[v]}`); })} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} /></label>
                            <label><span>Process</span><Select size="sm" value={part.process_template_id || ''} disabled={busy} onChange={v => action(async () => { await api(`/revisions/${rev.id}/parts/process-template`, 'POST', { ids: [part.id], template_id: v }); await loadRevision(rev.id); })} options={[{ value: '', label: 'Custom' }, ...templates.filter((t: Any) => t.kind === 'process').map((t: Any) => ({ value: t.id, label: t.name }))]} /></label>
                            {siblings.length > 1 && <div className="pi-asm"><span>Assembly</span><div><Folder size={13} /><b title={asmKey}>{path[path.length - 1]}</b><small>{siblings.length} parts</small>
                              <button type="button" className="link" onClick={() => { setMulti(siblings.map((p: Any) => p.id)); setSelected(part.id); }}>Select</button>
                              {differ.length > 0 && <button type="button" className="link" disabled={busy} onClick={() => action(async () => { await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: siblings.map((p: Any) => p.id), category: part.category }); await loadRevision(rev.id); notify(`${path[path.length - 1]}: ${siblings.length} parts are now ${categories[part.category]}`); })}>Make all {categories[part.category].toLowerCase()}</button>}</div></div>}
                          </div>}

                          <nav className="pi-tabs" role="tablist">{[['details', 'Details'], ['features', `Features${part.geometry.holes.length + part.geometry.bends.length ? ' ' + (part.geometry.holes.length + part.geometry.bends.length) : ''}`], ['documents', 'Documents']].map(([t, l]) => <button type="button" role="tab" aria-selected={detail === t} key={t} className={detail === t ? 'active' : ''} onClick={() => setDetail(t)}>{l}</button>)}</nav>

                          <div className="pi-body">
                            {detail === 'details' ? (
                              <>
                                <div className="pi-dims">{['X', 'Y', 'Z'].map((a, i) => <div key={a}><span>{a}</span><b>{fmt(part.geometry.dimensions[i])}<small> mm</small></b></div>)}</div>
                                <section className="pi-section">
                                  <h4>Specification{editable && !part.excluded && <button type="button" className="link" onClick={() => { setEditing(JSON.parse(JSON.stringify(part))); setModal('spec'); }}>Edit</button>}</h4>
                                  {row('Material', part.spec.material)}
                                  {row('Process', part.spec.process)}
                                  {row('Finish', part.spec.finish)}
                                  {(part.spec.coating_color || part.spec.coating_hex) && <div className="pi-kv"><span>Colour</span><b className="flex end">{part.spec.coating_hex && <Swatch hex={part.spec.coating_hex} />}{part.spec.coating_color || part.spec.coating_hex}</b></div>}
                                  {row('Coating', part.spec.paint, true)}
                                  {row('Tolerance', part.spec.general_tolerance)}
                                  {row('Datums', part.spec.datums)}
                                  {row('Stock', part.spec.stock, true)}
                                  {row('Heat treatment', part.spec.heat_treatment && (part.spec.heat_treatment + (part.spec.hardness ? ' · ' + part.spec.hardness : '')), true)}
                                  {row('Roughness', part.spec.roughness, true)}
                                  {row('Edges', part.spec.edge_treatment, true)}
                                  {row('Masking', part.spec.masking, true)}
                                  {row('Marking', part.spec.marking, true)}
                                </section>
                                <section className="pi-section">
                                  <h4>Geometry</h4>
                                  <div className="pi-kv"><span>Solid</span><b className={part.geometry.valid ? 'green' : 'red'}>{part.geometry.valid ? 'Valid' : 'Invalid — repair in CAD'}</b></div>
                                  {part.geometry.thickness > 0 && <div className="pi-kv"><span>Thickness</span><b>{fmt(part.geometry.thickness)} mm</b></div>}
                                  {part.geometry.mass_kg !== undefined && <div className="pi-kv"><span>Mass</span><b>{fmt(part.geometry.mass_kg)} kg <small>{part.geometry.mass_basis}</small></b></div>}
                                  {part.geometry.step && Object.keys(part.geometry.step).length > 0 && <div className="pi-kv"><span>From STEP</span><b className="flex end">{part.geometry.step.color && <Swatch hex={part.geometry.step.color} title="CAD appearance" />}{[part.geometry.step.material, part.geometry.step.density && part.geometry.step.density + ' g/cm³'].filter(Boolean).join(' · ') || 'appearance only'}</b></div>}
                                  <div className="pi-kv"><span>Classified by</span><b>{part.geometry.classification_confidence}</b></div>
                                  {part.category === 'sheet_metal' && <div className="pi-kv"><span>Flat pattern</span><b className={part.geometry.flat_status === 'supported' ? 'green' : 'red'}>{part.geometry.flat_status === 'supported' ? 'Available' : 'Needs review'}</b></div>}
                                  {canBend(part) && <div className="pi-kv"><span>Bending simulation</span><b className="flex end">{part.bend_sim ? 'Shared' : 'Not shared'}{showBend(part) && <button type="button" className="mini" onClick={() => setBendSim(part.id)}><FoldVertical size={13} />Play</button>}</b></div>}
                                </section>
                                {part.spec.operations?.length > 0 && <section className="pi-section"><h4>Process steps</h4><ol className="pi-ops">{part.spec.operations.map((o: Any, i: number) => <li key={i}><b>{typeof o === 'string' ? o : o.name}</b>{o.detail && <small>{o.detail}</small>}</li>)}</ol></section>}
                                {part.spec.notes && <section className="pi-section"><h4>Notes</h4><p className="note-text">{part.spec.notes}</p></section>}
                                {part.geometry.carried_from && <p className="pi-foot">{part.geometry.carried_from.same_shape ? `Carried over from rev ${part.geometry.carried_from.revision} (identical shape) — re-approve for this revision.` : `Carried over from rev ${part.geometry.carried_from.revision}; shape changed, feature limits were reset.`}</p>}
                              </>
                            ) : detail === 'features' ? (
                              <>
                                {part.geometry.holes.length > 0 && part.category !== 'purchased' && <button type="button" className="primary-soft pi-holes-btn" onClick={() => setHoleCfg(part.id)}><CircleDot size={15} />Configure holes &amp; hardware</button>}
                                {part.geometry.holes.length > 0 && <section className="pi-section"><h4>Bores · {part.geometry.holes.length}</h4>{part.geometry.holes.map((h: Any) => (
                                  <div className={'pi-feature' + (feature?.id === h.id ? ' hot' : '')} key={h.id} onMouseEnter={() => setFeature({ kind: 'hole', partId: part.id, ...h })} onMouseLeave={() => setFeature(null)}><em>{h.id}</em><span><b>Ø {fmt(h.diameter)}</b><small>{fmt(h.depth)} mm deep · {part.spec.feature_specs?.[h.id]?.hardware?.name || part.spec.feature_specs?.[h.id]?.designation || 'no hardware'}</small></span></div>
                                ))}</section>}
                                {part.geometry.bends.length > 0 && <section className="pi-section"><h4>Bends · {part.geometry.bends.length}</h4>{part.geometry.bends.map((b: Any) => (
                                  <div className={'pi-feature' + (feature?.id === b.id ? ' hot' : '')} key={b.id} onMouseEnter={() => setFeature({ kind: 'bend', partId: part.id, ...b })} onMouseLeave={() => setFeature(null)}><em>{b.id}</em><span><b>{fmt(b.angle)}° · R{fmt(b.radius)}</b><small>{fmt(b.length)} mm long</small></span></div>
                                ))}</section>}
                                {!part.geometry.holes.length && !part.geometry.bends.length && <p className="pi-foot">No bores or bends recognised on this part.</p>}
                                <p className="pi-foot">Hover a feature to find it on the model.</p>
                              </>
                            ) : (
                              <>
                                <div className="pi-drawing">
                                  <div><FileText size={18} /><span><b>Drawing</b><small className={part.doc_reviewed ? 'green' : ''}>{part.doc_reviewed ? `Reviewed by ${part.doc_reviewed_by}` : part.assets.includes('drawing.pdf') ? 'Not reviewed yet' : 'Not generated yet'}</small></span></div>
                                  {part.assets.includes('drawing.pdf') && <button type="button" className="primary" onClick={() => setDrawingPart(part.id)}>Open editor</button>}
                                </div>
                                {editable && can('drawing.edit') && <div className="pi-props compact"><label><span>Sheet</span><Select size="sm" value={part.drawing_options?.template_id || part.drawing_options?.size || ''} disabled={busy || !!job} onChange={v => action(async () => {
                                  const isTpl = templates.some((t: Any) => t.id === v);
                                  await api(`/revisions/${rev.id}/parts/drawing-options`, 'POST', { ids: [part.id], template_id: isTpl ? v : '', size: isTpl ? '' : v });
                                  await loadRevision(rev.id); notify('Regenerating the drawing with the new sheet…');
                                })} options={[{ value: '', label: 'Project default' }, { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'A2', label: 'A2' }, ...templates.filter((t: Any) => t.kind === 'drawing').map((t: Any) => ({ value: t.id, label: t.name, hint: 'template' }))]} /></label></div>}
                                <section className="pi-section">
                                  <h4>Files</h4>
                                  <div className="pi-files">{[['drawing.pdf', 'Drawing', 'PDF', true], ['drawing.dxf', 'Drawing', 'DXF · editable', false], ['review.pdf', 'Engineering review', 'PDF', true], ['flat.dxf', 'Flat pattern', 'DXF', false], ['part.step', 'Part model', 'STEP', false]].filter(([file]: Any) => !['drawing.dxf', 'flat.dxf', 'part.step'].includes(file) || can('cad.download')).filter(([file]: Any) => file !== 'flat.dxf' || part.category === 'sheet_metal').map(([file, title, sub, previewable]: Any) => {
                                    const has = part.assets.includes(file);
                                    return <button type="button" className="pi-file" key={file} disabled={!has} onClick={() => doc(`/parts/${part.id}/assets/${file}`, part.name + '_' + file, title + ' — ' + part.name)}>
                                      <span className="ext">{String(file).split('.').pop()}</span><span><b>{title}</b><small>{has ? sub : 'Not generated'}</small></span>{has && (previewable ? <Eye size={15} /> : <Download size={15} />)}
                                    </button>;
                                  })}
                                    {(() => { const has = part.assets.includes('drawing.pdf'); return <>
                                      <button type="button" className="pi-file" disabled={!has} onClick={() => doc(`/parts/${part.id}/inspection.pdf`, part.name + '_inspection.pdf', 'Inspection drawing — ' + part.name)}>
                                        <span className="ext">pdf</span><span><b>Inspection drawing</b><small>{has ? 'Ballooned · characteristics' : 'Not generated'}</small></span>{has && <Eye size={15} />}</button>
                                      <button type="button" className="pi-file" disabled={!has} onClick={() => doc(`/parts/${part.id}/characteristics.csv`, part.name + '_characteristics.csv')}>
                                        <span className="ext">csv</span><span><b>Characteristics</b><small>{has ? 'Inspection plan' : 'Not generated'}</small></span>{has && <Download size={15} />}</button></>; })()}
                                  </div>
                                </section>
                                {!vendor && <button type="button" className="pi-generate" disabled={!!job || rev.status !== 'ready'} onClick={() => generate(part.id)}><RefreshCw size={14} className={job ? 'spin' : ''} />{job ? 'Generating…' : 'Regenerate documents'}</button>}
                              </>
                            )}
                          </div>
                        </div>
                        );
                      })(
                      ) : (
                        <>
                          <div className="inspector-top"><span className="eyebrow">REVISION OVERVIEW</span><h2>Design to delivery</h2><p className="muted">Every manufacturing decision stays with this revision.</p></div>
                          <div className="inspector-body">
                            <div className="overview-stats"><div><b>{parts.length}</b><span>Part definitions</span></div><div><b>{holes}</b><span>Named bores</span></div></div>
                            <div className="property-list">{Object.entries(categories).map(([k, v]) => <div key={k}><span className="flex"><Swatch hex={categoryColors[k]} /> {v}</span><b>{parts.filter((p: Any) => p.category === k).length}</b></div>)}</div>
                            <div className="status-card"><ShieldCheck size={20} /><div><b>{blocking} release blockers</b><p>Includes missing specifications and manual engineering checks.</p></div></div>
                            <h4>Drawing sets</h4>
                            {[['machining-drawings.pdf', 'All machining drawings', 'One PDF · every machined part'], ['sheet-metal-drawings.pdf', 'All sheet-metal drawings', 'One PDF · flat patterns and bend tables'], ['assembly.pdf', 'Assembly & mating record', 'PDF · assembly view and fits']].map(([file, title, sub]) => (
                              <button className="document" key={file} disabled={!rev.assets?.includes(file)} onClick={() => doc(`/revisions/${rev.id}/assets/${file}`, file, title)}><Files size={22} /><span><strong>{title}</strong><small>{rev.assets?.includes(file) ? sub : 'Generate the manufacturing pack first'}</small></span><Eye size={16} /></button>
                            ))}
                            {!vendor && <>
                              <button className="primary full" disabled={!!job || rev.status !== 'ready'} onClick={() => generate()}><FileText size={16} />Generate manufacturing pack</button>
                              <button className="full" disabled={rev.status !== 'ready' || !!job} onClick={() => action(async () => { setRelease(await api(`/revisions/${rev.id}/release-check`)); setModal('release'); })}><ShieldCheck size={16} />Production readiness</button>
                              {editable && <button className="full" title="Re-run make/buy name rules and hide small bought-in items on parts you have not classified yet" onClick={() => action(async () => { const r = await api(`/revisions/${rev.id}/reclassify`, 'POST'); await loadRevision(rev.id); notify(`Re-classified ${r.recategorised} parts, hid ${r.hidden} bought-in items. Reviewed parts were left alone.`); })}><RefreshCw size={16} />Re-run classification</button>}
                            </>}
                            <div className="info-card"><Palette size={18} /><p>Parts are coloured by their specified coating colour; uncoated parts use a neutral tone per category. Pick a part in the viewer or navigator to inspect it.</p></div>
                          </div>
                        </>
                      )}
                    </aside>
                  </div>
                )}

                {tab === 'rules' && <DesignChecks parts={parts} onWizard={id => setReadyFor(id)} onOpen={id => { choosePart(id); setTab('parts'); }} onRules={() => setModal(project && (project.permissions || []).includes('project.settings') ? 'project-settings' : 'rules')} />}

                {tab === 'joborders' && !vendor && project && (
                  rev.status !== 'released' && !project.revisions.some((r: Any) => r.status === 'released')
                    ? <section className="content-page"><div className="notice"><ShieldCheck size={17} />Job orders open once a revision is production ready: every part design-reviewed and drawing-reviewed, all design checks covered, then <b>Release</b> in the revision overview.</div><JobOrdersPage projects={projects} projectId={project.id} ctx={{ busy, action, notify }} perms={new Set(project.permissions || [])} openJobOrder={openJobOrder} /></section>
                    : <JobOrdersPage projects={projects} projectId={project.id} ctx={{ busy, action, notify }} perms={new Set(project.permissions || [])} openJobOrder={openJobOrder} />
                )}

                {tab === 'steps' && <AssemblySteps page revision={rev.id} parts={parts} editable={editable} navStyle={prefs.navStyle} addParts={stepsAdd?.ids} addKey={stepsAdd?.n} close={() => setTab('parts')} />}

                {tab === 'assembly' && (
                  <section className="content-page">
                    <div className="page-title">
                      <div><h2>Assembly & mating</h2><p>From geometric candidates to toleranced, approved interfaces.</p></div>
                      <div className="flex">
                        <button onClick={() => doc(`/revisions/${rev.id}/assets/assembly.pdf`, 'assembly.pdf', 'Assembly & mating record')}><Eye size={16} />Assembly document</button>
                        {editable && <button onClick={() => { setTab('parts'); startWeld(multi.length ? [...multi] : []); notify('Click the components to weld in the 3D view — Forge finds the seams where they touch.'); }}><Plus size={16} />Add joint / weld</button>}
                        {editable && <button className="primary" onClick={() => { setEditing({ data: { label: 'New interface', part_a: parts[0]?.id, part_b: parts[1]?.id || parts[0]?.id, feature_a: '', feature_b: '', fit: '', instructions: '', torque: '' }, approved: false }); setModal('fit'); }}><Plus size={16} />Add interface</button>}
                      </div>
                    </div>
                    <JointCards joints={rev.joints || []} parts={parts} editable={editable}
                      onEdit={j => { setTab('parts'); editWeld(j); }}
                      onDelete={async j => { if (await ask({ title: 'Delete this joint?', confirm: 'Delete', danger: true }) === null) return; setRev((r: Any) => r && { ...r, joints: (r.joints || []).filter((x: Any) => x.id !== j.id) }); api('/joints/' + j.id, 'DELETE').catch(fail).finally(() => refreshJoints(rev.id).catch(fail)); }} />
                    <h3 className="section-sub"><Target size={15} />Fits & interfaces</h3>
                    <div className="notice"><Target size={17} />Automatic candidates use coaxial cylindrical surfaces and axial overlap. They do not recover mates, interference intent or tolerance classes from STEP.</div>
                    <div className="fit-grid">
                      {related.filter(f => f && f.data).map(f => (
                        <article className="fit-card" key={f.id}>
                          <header><Badge kind={f.approved ? 'success' : 'warning'}>{f.approved ? 'Approved' : 'Review required'}</Badge><b>{f.data.label}</b></header>
                          <h3>{f.data.part_a_name || parts.find((p: Any) => p.id === f.data.part_a)?.name} <span>↔</span> {f.data.part_b_name || parts.find((p: Any) => p.id === f.data.part_b)?.name}</h3>
                          <p>{f.data.feature_a} / {f.data.feature_b}</p>
                          <div className="fit-number">{f.data.nominal_clearance !== undefined ? fmt(f.data.nominal_clearance) + ' mm' : 'Not computed'}<small>Nominal diametral clearance</small></div>
                          <p><strong>Fit:</strong> {f.data.fit || 'Unspecified'}</p>
                          <p><strong>Assembly:</strong> {f.data.instructions || 'Instructions required'}</p>
                          {f.data.min_clearance !== undefined && <p>Clearance range: {fmt(f.data.min_clearance)} to {fmt(f.data.max_clearance)} mm</p>}
                          {editable && <button onClick={() => { setEditing(JSON.parse(JSON.stringify(f))); setModal('fit'); }}>Specify & review <ArrowUpRight size={15} /></button>}
                        </article>
                      ))}
                    </div>
                    {!related.length && <div className="empty-inline"><Layers size={30} /><h3>No mating records yet</h3><p>Add interfaces that are not discoverable from cylindrical geometry.</p></div>}
                  </section>
                )}

                {tab === 'production' && (
                  <section className="content-page">
                    <div className="page-title">
                      <div><h2>Production checklist</h2><p>{vendor ? 'Tick each item as it is produced; quantities and remarks are recorded against this revision.' : 'Shared with vendors through the review link. Parts marked not for production are left out.'}</p></div>
                      <div className="flex">
                        <button onClick={() => doc(`/revisions/${rev.id}/assets/machining-drawings.pdf`, 'machining-drawings.pdf', 'All machining drawings')} disabled={!rev.assets?.includes('machining-drawings.pdf')}><Files size={16} />Machining set</button>
                        <button onClick={() => doc(`/revisions/${rev.id}/assets/sheet-metal-drawings.pdf`, 'sheet-metal-drawings.pdf', 'All sheet-metal drawings')} disabled={!rev.assets?.includes('sheet-metal-drawings.pdf')}><Files size={16} />Sheet-metal set</button>
                      </div>
                    </div>
                    {rev.status !== 'released' && <div className="notice"><ShieldCheck size={17} />This revision is not released yet — quantities recorded here are for planning; manufacture only from released documents.</div>}
                    <ProductionChecklist parts={parts} rows={related} busy={busy} canEdit={!vendor && can('joborder.update')}
                      onPreview={p => doc(`/parts/${p.id}/assets/drawing.pdf`, p.name + '_drawing.pdf', 'Drawing sheet — ' + p.name)}
                      onSave={async (pid, r) => { await action(async () => { await api(`/revisions/${rev.id}/production/${pid}`, 'PUT', r); await refreshRelated('production'); }); }} />
                  </section>
                )}

                {tab === 'review' && (
                  <section className="content-page review-page">
                    <div className="page-title"><div><h2>Review together</h2><p>Questions and decisions tied to parts, features and this exact revision.</p></div><Badge>{related.filter(r => !r.resolved).length} open threads</Badge></div>
                    {!vendor && <form className="comment-form" onSubmit={e => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget); const form = e.currentTarget;
                      action(async () => { await api(`/revisions/${rev.id}/comments`, 'POST', { body: f.get('body'), part_id: f.get('part_id') || null, feature: f.get('feature') || '' }); form.reset(); await refreshRelated('comments'); });
                    }}>
                      <div className="form-row">
                        <label>Part<Select name="part_id" defaultValue="" options={[{ value: '', label: 'Assembly / general' }, ...parts.map((p: Any) => ({ value: p.id, label: p.name }))]} /></label>
                        <label>Feature reference<input name="feature" placeholder="e.g. H003 or B001" /></label>
                      </div>
                      <textarea name="body" required placeholder="Ask a question, request a change, or record a review decision…" />
                      <button className="primary" disabled={busy}><Send size={15} />Post review</button>
                    </form>}
                    <div className="comment-list">
                      {related.map(c => (
                        <article key={c.id} className="comment">
                          <div className="avatar">{(c.author || '?')[0]}</div>
                          <div>
                            <header><strong>{c.author}</strong><span>{date(c.created)}</span><Badge kind={c.resolved ? 'success' : 'warning'}>{c.resolved ? 'Resolved' : 'Open'}</Badge></header>
                            <small>{parts.find((p: Any) => p.id === c.part_id)?.name || 'Assembly'} {c.feature && ' / ' + c.feature}</small>
                            <p>{c.body}</p>
                            {!vendor && !c.resolved && can('design.review') && <button onClick={() => action(async () => { await api('/comments/' + c.id + '/resolve', 'POST'); await refreshRelated('comments'); })}><Check size={14} />Resolve</button>}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {tab === 'qc' && <QualityPage rev={rev} vendor={!!vendor} can={can} action={fn => { void action(fn); }} notify={notify} doc={doc} onPlan={pid => { setBalloonMode(true); setDrawingPart(pid); }} />}

                {tab === 'audit' && (
                  <section className="content-page">
                    <div className="page-title"><div><h2>Revision history</h2><p>Uploads, specification changes, reviews, releases and measurements.</p></div></div>
                    <div className="timeline">
                      {related.map(a => (
                        <div key={a.id}>
                          <span className="timeline-dot" />
                          <time>{date(a.created)} · {new Date(a.created).toLocaleTimeString()}</time>
                          <h3>{a.action.replaceAll('.', ' / ')}</h3><p>{a.actor}</p>
                          <details><summary>Recorded detail</summary><pre>{JSON.stringify(JSON.parse(a.detail), null, 2)}</pre></details>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </main>

      {error && <div className="error-toast" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}
      <DialogHost />
      {shortcutsOpen && <ShortcutsDialog {...prefsApi} close={() => setShortcutsOpen(false)} />}
      {bendSim && rev && parts.find((p: Any) => p.id === bendSim) && <PressBrake revision={rev.id} part={bendSim} name={parts.find((p: Any) => p.id === bendSim).name} navStyle={prefs.navStyle} close={() => setBendSim(null)} />}
      {holeCfg && rev && parts.find((p: Any) => p.id === holeCfg) && <HoleConfig part={parts.find((p: Any) => p.id === holeCfg)} revision={rev.id} editable={editable} navStyle={prefs.navStyle}
        close={changed => { setHoleCfg(null); if (changed) loadRevision(rev.id).catch(fail); }} />}
      {weldCfg && rev && <WeldConfig revision={rev.id} partIds={weldCfg} parts={parts} joints={rev.joints || []} editable={editable} navStyle={prefs.navStyle}
        close={changed => { setWeldCfg(null); if (changed) refreshJoints(rev.id).catch(fail); }} />}
      {toast && <div className="toast"><CheckCircle2 size={18} />{toast}</div>}
      {excluding && <ExcludeDialog parts={excluding} busy={busy} close={() => setExcluding(null)} onConfirm={reason => action(async () => {
        if (excluding.length === 1) await api('/parts/' + excluding[0].id + '/flags', 'PATCH', { excluded: true, exclusion_reason: reason });
        else await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: excluding.map((p: Any) => p.id), excluded: true, exclusion_reason: reason });
        await loadRevision(rev.id); setExcluding(null); notify(excluding.length === 1 ? `${excluding[0].name} marked not for production` : `${excluding.length} parts marked not for production`);
      })} />}
      {drawingPart && <DrawingEditor partId={drawingPart} balloons={balloonMode} close={() => { setDrawingPart(null); setBalloonMode(false); }} onSaved={() => loadRevision(rev.id)} />}
      {readyFor && !drawingPart && rev && (() => {
        const rp = parts.find((p: Any) => p.id === readyFor);
        if (!rp) return null;
        return <ReadinessWizard key={rp.id} part={rp} settings={project?.effective_settings} editable={editable} canReview={can('design.review')}
          onClose={() => setReadyFor(null)}
          onOpenDrawing={() => setDrawingPart(rp.id)}
          onSave={async (spec, category, reviewed) => {
            const ops = (spec.operations || []).map((o: Any) => (typeof o === 'string' ? { name: o, detail: '' } : o)).filter((o: Any) => o.name?.trim());
            await api('/parts/' + rp.id, 'PATCH', { category, spec: { ...spec, operations: ops }, reviewed });
            loadRevision(rev.id).catch(fail);
          }}
          onDocReview={async () => { await api('/parts/' + rp.id + '/doc-review', 'POST', { reviewed: true }); await loadRevision(rev.id); notify('Drawing marked reviewed.'); }} />;
      })()}
      {preview && <DocumentPreview blob={preview.blob} name={preview.name} title={preview.title} close={() => setPreview(null)} />}

      {modal === 'project' && <ProjectSettingsDialog create workspace={settings || {}} config={config} ctx={{ busy, action, notify }} close={() => setModal('')} onSaved={p => action(async () => { await loadProjects(); await openProject(p); setModal('upload'); })} />}
      {modal === 'project-settings' && project && <ProjectSettingsDialog project={project} workspace={settings || {}} config={config} ctx={{ busy, action, notify }} close={() => setModal('')} onSaved={p => { setProject(p); setModal(''); notify('Project settings saved. They apply to the next upload and drawing generation; use Re-run classification for the current revision.'); }} />}

      {modal === 'upload' && (
        <Modal title="Upload a CAD revision" close={() => !busy && setModal('')}>
          {importingRevision ? <div role="status" aria-live="polite">
            <h3>Revision {importingRevision.number} is processing · {importingRevision.progress || 0}%</h3>
            <p>{importingRevision.message || 'Import queued'}</p>
            <progress aria-label="CAD import progress" max="100" value={importingRevision.progress || 0} />
            <p className="muted">Progress updates automatically. You can upload the next revision after this import finishes.</p>
            <button className="primary full" onClick={showImport}>View import progress</button>
          </div> : <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const file = f.get('file') as File; action(() => uploadFile(file, String(f.get('notes') || ''))); }}>
            <label className="dropzone"><Upload size={32} /><b>Choose your part or assembly</b><span>STEP · STP · BREP · IGES / up to 1 GB</span><input name="file" type="file" accept=".step,.stp,.brep,.brp,.igs,.iges" required /></label>
            <label>Revision notes<textarea name="notes" placeholder="What changed in this version?" /></label>
            <p className="muted">The previous revision stays active until this file processes successfully. No review approvals carry over automatically.</p>
            {uploadPercent !== null && <progress max="100" value={uploadPercent} />}
            <button className="primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Upload size={16} />}Upload & analyze {uploadPercent !== null && uploadPercent + '%'}</button>
          </form>}
        </Modal>
      )}

      {modal === 'spec' && editing && (
        <Modal title="Manufacturing specification" subtitle={editing.name} wide close={() => setModal('')}>
          <SpecEditor editing={editing} setEditing={setEditing} config={config} busy={busy} onSave={() => action(async () => {
            const spec = { ...editing.spec, operations: (editing.spec.operations || []).map((o: Any) => (typeof o === 'string' ? { name: o, detail: '' } : o)).filter((o: Any) => o.name?.trim()) };
            await api('/parts/' + editing.id, 'PATCH', { category: editing.category, spec, reviewed: editing.reviewed });
            await loadRevision(rev.id); setModal(''); notify('Specifications saved. Regenerate affected documents.');
          })} />
        </Modal>
      )}

      {modal === 'group-spec' && editing?.group && (
        <Modal title="Edit group manufacturing details" subtitle={`${editing.group.length} parts · only the fields you change are applied; feature limits and dispositions stay per part`} wide close={() => setModal('')}>
          <GroupSpecEditor parts={editing.group} config={config} busy={busy} onSave={(patch, category, reviewed) => action(async () => {
            const r = await api(`/revisions/${rev.id}/parts/group-spec`, 'POST', { ids: editing.group.map((p: Any) => p.id), spec: patch, category, reviewed });
            await loadRevision(rev.id); setModal(''); notify(`${r.updated} parts updated. Regenerate affected documents.`);
          })} />
        </Modal>
      )}

      {modal === 'share' && (
        <Modal title="Share this revision with a vendor" close={() => setModal('')}>
          <p>Read-only access for a vendor: 3D view, part details, drawings and the review thread of this revision. Vendors cannot edit, comment or record production.</p>
          {sharePath ? (
            <>
              <label>Vendor review link<input readOnly value={location.origin + sharePath} onFocus={e => e.target.select()} /></label>
              <button className="primary" onClick={() => action(async () => { await navigator.clipboard.writeText(location.origin + sharePath); notify('Link copied'); })}>Copy link</button>
              <p className="muted">This link stays pinned to revision {rev.number}. Treat it as a password.</p>
            </>
          ) : (
            <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { const s = await api(`/revisions/${rev.id}/shares`, 'POST', { label: f.get('label'), days: Number(f.get('days')), allow_cad: f.get('allow_cad') === 'on' }); setSharePath(s.path); }); }}>
              <label>Vendor name<input name="label" required placeholder="Vendor / reviewer" /></label>
              <label>Expires in<Select name="days" defaultValue="14" options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} /></label>
              <label className="check"><input type="checkbox" name="allow_cad" />Allow DXF / STEP downloads (laser and CNC programming). 3D models are never downloadable.</label>
              <button className="primary full" disabled={busy}><Link size={16} />Create read-only link</button>
            </form>
          )}
          <button className="full" onClick={() => action(async () => { setModalRows(await api(`/revisions/${rev.id}/shares`)); setModal('shares'); })}>Manage existing links</button>
        </Modal>
      )}

      {modal === 'shares' && (
        <Modal title="Vendor access links" close={() => setModal('')}>
          {modalRows.map(s => (
            <div className="document" key={s.id}>
              <div><strong>{s.label}</strong><small>Expires {date(s.expires)}{s.allow_cad ? ' · CAD downloads' : ' · view only'}</small></div>
              <Badge>{s.revoked ? 'Revoked' : 'Active'}</Badge>
              {!s.revoked && <button onClick={() => action(async () => { await api('/shares/' + s.id, 'DELETE'); setModalRows(await api(`/revisions/${rev.id}/shares`)); })}>Revoke</button>}
            </div>
          ))}
        </Modal>
      )}

      {modal === 'fit' && editing && (
        <Modal title="Mating & fit specification" close={() => setModal('')}>
          <form onSubmit={e => { e.preventDefault(); action(async () => { if (editing.id) await api('/fits/' + editing.id, 'PATCH', editing); else await api(`/revisions/${rev.id}/fits`, 'POST', editing); await refreshRelated('fits'); setModal(''); }); }}>
            <div className="form-grid">
              {['part_a', 'part_b'].map(k => (
                <label key={k}>{k.replace('_', ' ')}
                  <Select disabled={!!editing.id} value={editing.data[k]} onChange={v => setEditing({ ...editing, data: { ...editing.data, [k]: v, [k + '_name']: parts.find((p: Any) => p.id === v)?.name } })} options={parts.map((p: Any) => ({ value: p.id, label: p.name }))} />
                </label>
              ))}
              {['label', 'feature_a', 'feature_b', 'fit', 'torque', 'hole_min', 'hole_max', 'shaft_min', 'shaft_max'].map(k => (
                <label key={k}>{k.replaceAll('_', ' ')}<input type={k.includes('_min') || k.includes('_max') ? 'number' : 'text'} step="any" value={editing.data[k] ?? ''} onChange={e => setEditing({ ...editing, data: { ...editing.data, [k]: e.target.value } })} /></label>
              ))}
            </div>
            <label>Assembly instructions<textarea required value={editing.data.instructions} onChange={e => setEditing({ ...editing, data: { ...editing.data, instructions: e.target.value } })} placeholder="Sequence, orientation, press method, lubrication, retention and inspection" /></label>
            {editing.id && <label className="check"><input type="checkbox" checked={editing.approved} onChange={e => setEditing({ ...editing, approved: e.target.checked })} />Approve interface and tolerance limits</label>}
            <button className="primary full" disabled={busy}>Save mating record</button>
          </form>
        </Modal>
      )}

      {modal === 'release' && (
        <Modal title="Production readiness" close={() => setModal('')}>
          {release?.can_release ? (
            <>
              <div className="release-ready"><ShieldCheck size={35} /><h3>Every part is reviewed and every check is covered</h3><p>Marking the revision production ready locks it, generates the final document pack and opens job orders. Engineering approval remains your responsibility.</p></div>
              <button className="primary full" disabled={!can('revision.release')} title={can('revision.release') ? '' : 'You need the release permission'} onClick={() => action(async () => { await api(`/revisions/${rev.id}/release`, 'POST'); await loadRevision(rev.id); setModal(''); })}>Release revision</button>
            </>
          ) : (
            <><p>{release?.reasons.length} unresolved release requirements.</p><ul className="release-list">{release?.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>
          )}
        </Modal>
      )}

      {modal === 'rules' && (
        <Modal title="Rule library & drawing conventions" close={() => setModal('')}>
          <p>Workshop rules are configurable starting values, not universal design limits. Standards references are documented; this software is not a certification engine.</p>
          <div className="form-grid">
            {Object.entries(project?.rules || config?.default_rules || {}).map(([k, v]) => (
              <label key={k}>{k.replaceAll('_', ' ')}<input type="number" step="any" readOnly={!project || vendor} value={String(v)} onChange={e => setProject({ ...project, rules: { ...project.rules, [k]: Number(e.target.value) } })} /></label>
            ))}
          </div>
          {project && !vendor && <button className="primary full" onClick={() => action(async () => { await api('/projects/' + project.id + '/rules', 'PUT', project.rules); notify('Rules saved for future revisions. Existing revisions retain their snapshot.'); setModal(''); })}>Save for future revisions</button>}
          <h3>Drawing references</h3>
          {config?.standards.map((s: Any) => <a className="standard" href={s.url} target="_blank" rel="noreferrer" key={s.code}><span><b>{s.code}</b><small>{s.topic}</small></span><ExternalLink size={16} /></a>)}
          <h3>Manual verification coverage</h3>
          {Object.values(config?.manual_checks || {}).map((x: Any) => <p key={x} className="muted">• {x}</p>)}
        </Modal>
      )}

      {modal === 'settings' && (
        <Modal title="Workspace defaults" subtitle="Starting values for new projects (each project keeps its own settings)" close={() => setModal('')}>
          {!settings ? <p className="muted">Loading…</p> : (
            <form onSubmit={e => { e.preventDefault(); action(async () => { const body = { ...settings, sheet_prefixes: splitList(settings.sheet_prefixes), machining_prefixes: splitList(settings.machining_prefixes), purchased_prefixes: splitList(settings.purchased_prefixes) }; setSettings(await api('/settings', 'PUT', body)); notify('Settings saved. Applies to new uploads; use Re-run classification for the current revision.'); setModal(''); }); }}>
              <h3>Part-number prefixes</h3>
              <p className="muted">Names starting with these prefixes are classified without guessing. Comma-separated, case-insensitive, e.g. <code>SM-, GT-SM</code>.</p>
              <div className="form-grid">
                <label>Sheet metal prefixes<input value={joinList(settings.sheet_prefixes)} placeholder="SM-, SHT-" onChange={e => setSettings({ ...settings, sheet_prefixes: e.target.value })} /></label>
                <label>Machining prefixes<input value={joinList(settings.machining_prefixes)} placeholder="MC-, MACH-" onChange={e => setSettings({ ...settings, machining_prefixes: e.target.value })} /></label>
                <label>Purchased prefixes (optional)<input value={joinList(settings.purchased_prefixes)} placeholder="PUR-, BO-" onChange={e => setSettings({ ...settings, purchased_prefixes: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={!!settings.prefix_strict} onChange={e => setSettings({ ...settings, prefix_strict: e.target.checked })} />Everything that matches no prefix is a purchased item (strict), unless it is named like a made part (plate, bracket, cover …). Prefixes are found anywhere in the name, so exporter noise such as 11GT-MC-… still matches. Off: fall back to name and geometry rules.</label>
              <h3>Import behaviour</h3>
              <label className="check"><input type="checkbox" checked={!!settings.hide_purchased_by_default} onChange={e => setSettings({ ...settings, hide_purchased_by_default: e.target.checked })} />Hide small bought-in items (terminals, lidars, connectors, fasteners, multi-body supplier models) in the viewer by default</label>
              <label className="check"><input type="checkbox" checked={!!settings.carry_over_specs} onChange={e => setSettings({ ...settings, carry_over_specs: e.target.checked })} />Carry manufacturing specifications from the active revision into new uploads (matched by part name, then shape). Approvals and review status are never carried.</label>
              <h3>Drawing title block</h3>
              <p className="muted">Printed on every drawing sheet (GOAT A4/A3 template). Use <b>Generate documents</b> to refresh existing drawings.</p>
              <div className="form-grid">
                {[['company', 'Company'], ['drawn_by', 'Drawn by (DRN)'], ['checked_by', 'Checked by (CHK)'], ['approved_by', 'Approved by (APD)'], ['module', 'Module'], ['master', 'Master'], ['note', 'General note'], ['surface_finish', 'Surface finish'], ['tol_1dec', 'Tolerance · 1 decimal'], ['tol_2dec', 'Tolerance · 2 decimals'], ['tol_3dec', 'Tolerance · 3 decimals'], ['hole_fit', 'Fit for holes'], ['shaft_fit', 'Fit for shafts'], ['position_tol', 'Diametric position tolerance']].map(([k, label]) => (
                  <label key={k}>{label}<input value={settings.drawing?.[k] ?? ''} maxLength={80} onChange={e => setSettings({ ...settings, drawing: { ...(settings.drawing || {}), [k]: e.target.value } })} /></label>
                ))}
              </div>
              <p className="muted">Prefix rules apply on the next upload. For a revision already imported, use <b>Re-run classification</b> in its overview; parts you classified or reviewed by hand are left untouched.</p>
              <div className="modal-actions"><button className="primary" disabled={busy || !perms.has('users.manage')}><Check size={16} />Save defaults</button></div>
            </form>
          )}
        </Modal>
      )}

      {modal === 'qc' && (
        <Modal title="Record feature inspection" close={() => setModal('')}>
          <form onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); action(async () => { await api(`/revisions/${rev.id}/qc`, 'POST', { ...f, nominal: Number(f.nominal), lower_limit: Number(f.lower_limit), upper_limit: Number(f.upper_limit), measured: Number(f.measured) }); await refreshRelated('qc'); setModal(''); }); }}>
            <label>Part<Select name="part_id" required defaultValue={parts[0]?.id || ''} options={parts.map((p: Any) => ({ value: p.id, label: p.name }))} /></label>
            <div className="form-grid">
              {['feature', 'serial', 'nominal', 'lower_limit', 'upper_limit', 'measured', 'instrument'].map(k => (
                <label key={k}>{k.replaceAll('_', ' ')}<input name={k} required type={['nominal', 'lower_limit', 'upper_limit', 'measured'].includes(k) ? 'number' : 'text'} step="any" placeholder={k === 'feature' ? 'H001' : undefined} /></label>
              ))}
            </div>
            <label>Unit<Select name="unit" defaultValue="mm" options={[{ value: 'mm', label: 'mm — bores / linear dimensions' }, { value: 'deg', label: 'degrees — bend angle' }]} /></label>
            <label>Inspection notes<textarea name="notes" /></label>
            <p className="muted">Entered limits must match the approved feature limits. Results and operator identity are recorded automatically.</p>
            <button className="primary full" disabled={busy}>Save inspection record</button>
          </form>
        </Modal>
      )}

      {modal === 'compare' && (
        <Modal title="Revision comparison" close={() => setModal('')}>
          <p className="muted">{comparison?.matching}</p>
          {comparison?.parts.map((p: Any) => <div className="document" key={p.name}><span><strong>{p.name}</strong><small>Qty {p.old_quantity} → {p.new_quantity}</small></span><Badge kind={p.change === 'unchanged' ? 'neutral' : 'warning'}>{p.change}</Badge></div>)}
        </Modal>
      )}

      {modal === 'team' && (
        <Modal title="Team access" close={() => setModal('')}>
          <div>{modalRows.map(u => <div className="document" key={u.id}><span><strong>{u.name}</strong><small>{u.email}</small></span><Badge>{u.role}</Badge></div>)}</div>
          <h3>Add a team member</h3>
          <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { await api('/users', 'POST', Object.fromEntries(f)); setModalRows(await api('/users')); notify('Team member created'); }); }}>
            <div className="form-grid">
              <label>Name<input name="name" required /></label>
              <label>Email<input name="email" type="email" required /></label>
              <label>Initial password<input name="password" type="password" minLength={12} required /></label>
              <label>Role<Select name="role" defaultValue="engineer" options={[{ value: 'engineer', label: 'Engineer' }, { value: 'qc', label: 'QC inspector' }, { value: 'viewer', label: 'Viewer' }]} /></label>
            </div>
            <button className="primary full">Create team member</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return (
      <div className="boot crash">
        <div><h2>Something went wrong in the interface</h2><p>{String(this.state.error?.message || this.state.error)}</p><button className="primary" onClick={() => location.reload()}>Reload</button></div>
      </div>
    );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);

/** Group navigator parts by their STEP sub-assembly path. */
function buildTree(list: Any[]) {
  const root: Any = { key: '', name: '', groups: [], parts: [], index: new Map() };
  for (const p of list) {
    let node = root;
    for (const seg of p.assembly_path || []) {
      const key = node.key + '/' + seg;
      let child = node.index.get(seg);
      if (!child) { child = { key, name: seg, groups: [], parts: [], index: new Map() }; node.index.set(seg, child); node.groups.push(child); }
      node = child;
    }
    node.parts.push(p);
  }
  const sort = (n: Any) => { n.groups.sort((a: Any, b: Any) => a.name.localeCompare(b.name, undefined, { numeric: true })); n.groups.forEach(sort); };
  sort(root);
  return root;
}
function flattenTree(node: Any): Any[] { return [...node.groups.flatMap(flattenTree), ...node.parts]; }
