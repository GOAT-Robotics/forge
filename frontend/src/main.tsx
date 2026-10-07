import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Info, Tag, ClipboardList,
  MoreHorizontal, History, Sparkles, ListTree, ListChecks, PanelRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Maximize2, Minimize2, Box, Plus, ArrowUpRight, ArrowUp, ArrowDown, Upload, Folder, ChevronDown, ChevronRight, ChevronLeft, Search, Download, Check, CheckCircle2, AlertTriangle, Clock,
  FileText, Layers, Link, LogOut, Settings, ShieldCheck, MessageSquare, ClipboardCheck, GitBranch, LoaderCircle, ExternalLink, X, Eye,
  Target, Archive, SlidersHorizontal, Users, Send, RefreshCw, Scan, Grid2x2, Palette, EyeOff, Ban, Undo2, Factory, Files, Flame, Droplet, Keyboard,
  CircleDot, FoldVertical, ListOrdered, ListPlus,
} from 'lucide-react';
import Viewer from './Viewer';
import DrawingEditor from './DrawingEditor';
import type { PartAppearance } from './Viewer';
import { api, asset, download, vendorId, headers } from './api';
import { Badge, Modal, ModalFooter, DocumentPreview, FlatPattern, SpecEditor, Swatch, ProductionChecklist, GroupPanel, GroupSpecEditor, ExcludeDialog, ask, DialogHost } from './components';
import { Sidebar, TopBar, PageHeader, initTheme, LogoMark, Progress, Empty, Avatar, type Page } from './shell';
import { PricingPage, PartCost } from './pricing';
import { surfaceLook } from './surface';
import { Dashboard, JobOrdersPage, JobOrderDialog, JobOrderDetail, TemplatesPage, AdminPage, ProjectSettingsDialog, DesignChecks, JointPanel, JointCards, StatusBadge } from './pages';
import { categories, categoryColors, date, fmt, flatReason } from './constants';
import type { Any } from './constants';
import { Select } from './controls';
import { weldability, seamKey, chooseSeams, toggleSeamOn, sameSide, addSeams, findAllSeams } from './welding';
import { ReadinessWizard } from './readiness';
import BulkReady from './bulkReady';
import { ReplaceDialog, VersionsDialog, CadSourceRow, FlatIssuesCard, type FlatIssue } from './partVersions';
import { JobDocButton } from './docJob';
import { QualityPage } from './quality';
import HoleConfig from './holeConfig';
import WeldConfig, { WeldAssemblies } from './weldConfig';
import PressBrake from './pressBrake';
import AssemblySteps from './assemblySteps';
import { usePrefs, comboOf, ShortcutsDialog, KeyChip } from './prefs';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import './index.css';

/** Hint for an icon-only button (outside the dense canvas toolbars). */
function Tip({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
/** Part-type glyph tint (navigator rows, inspector title). */
/** Purchased, other and not-for-production parts skip design checks and reviews. */
const noChecks = (p: Any) => !!p.excluded || p.category === 'purchased' || p.category === 'other';
const glyphTone: Record<string, string> = { machining: 'bg-machining/10 text-machining', sheet_metal: 'bg-sheet/10 text-sheet', purchased: 'bg-purchased/10 text-purchased', other: 'bg-other/10 text-other' };
/** Selected state of a ghost button in the canvas toolbars and the HUD. */
const onTone = 'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground';
const eyebrow = 'text-2xs font-medium uppercase tracking-wider text-muted-foreground';
const field = 'grid gap-1.5 leading-normal select-auto';
const kv = 'flex min-h-[30px] items-center justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0';
const kvValue = 'min-w-0 text-right text-foreground [overflow-wrap:anywhere]';
const pageWrap = 'mx-auto w-full max-w-7xl px-6 py-6';
const pageTitle = 'mb-5 flex items-center justify-between gap-4 max-[900px]:flex-col max-[900px]:items-start';
const formGrid = 'grid grid-cols-2 gap-x-3.5 gap-y-3 max-[560px]:grid-cols-1';
const checkRow = 'flex items-start gap-2.5 text-sm leading-normal font-normal select-auto';
const docRow = 'mb-2 flex items-center justify-between gap-3 rounded-lg border p-3 text-muted-foreground';
const modalHeading = 'mt-5 mb-2 text-sm font-semibold';

type ViewMode = '3d' | 'flat3d' | 'flat2d';
const TABS = ['parts', 'rules', 'assembly', 'steps', 'joborders', 'production', 'review', 'qc', 'audit'];
initTheme();
/** Read a deep link: /projects/{pid}/revisions/{rid}/{tab}?part={id} or /vendor/{rid}?tab=&part= */
function parseRoute() {
  const q = new URLSearchParams(location.search);
  const top = location.pathname.match(/^\/(dashboard|projects|job-orders|templates|pricing|admin)\/?(?:([a-f0-9]+))?$/);
  const jo = location.pathname.match(/^\/job-orders\/([a-f0-9]+)/);
  const m = location.pathname.match(/^\/projects\/([a-f0-9]+)(?:\/revisions\/([a-f0-9]+))?(?:\/([a-z]+))?/);
  const page: Page = m ? 'project' : jo ? 'joborder' : top ? ({ dashboard: 'dashboard', projects: 'projects', 'job-orders': 'joborders', templates: 'templates', pricing: 'pricing', admin: 'admin' } as Record<string, Page>)[top[1]] : 'dashboard';
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
  // the navigator's type filter is part of how a project's view was left
  const navKey = project ? `forge-nav:${project.id}` : '';
  useEffect(() => { if (!navKey) return; try { const v = localStorage.getItem(navKey); if (v) setCategory(v); } catch { /* ignore */ } }, [navKey]);
  useEffect(() => { if (!navKey) return; try { localStorage.setItem(navKey, category); } catch { /* ignore */ } }, [navKey, category]);
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
  const [preview, setPreview] = useState<{ blob: Blob; name: string; title: string } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [overview, setOverview] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [layout, setLayoutState] = useState<{ left: boolean; right: boolean; focus: boolean }>(() => { try { return { left: true, right: true, ...JSON.parse(localStorage.getItem('forge-layout') || '{}'), focus: false }; } catch { return { left: true, right: true, focus: false }; } });
  const setLayout = (patch: Partial<typeof layout>) => setLayoutState(l => { const n = { ...l, ...patch }; try { localStorage.setItem('forge-layout', JSON.stringify({ left: n.left, right: n.right })); } catch { /* ignore */ } return n; });
  const [weldView, setWeldView] = useState(() => { try { return localStorage.getItem('forge-nav-weld') === '1'; } catch { return false; } });
  const [treeView, setTreeView] = useState(() => { try { return localStorage.getItem('forge-nav-tree') !== 'list'; } catch { return true; } });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const colorBy = 'coating' as 'coating' | 'type';  // coating colour where specified, otherwise part-type colour
  const [multi, setMulti] = useState<string[]>([]);
  const route = useRef(parseRoute());
  const [settings, setSettings] = useState<Any>(null);
  const [feature, setFeature] = useState<Any>(null);
  const [excluding, setExcluding] = useState<Any[] | null>(null);
  /** part geometry replacement / version history dialogs; hovered and pinned flat-pattern issue */
  const [replacing, setReplacing] = useState<Any | null>(null);
  const [versionsOf, setVersionsOf] = useState<Any | null>(null);
  const [flatHover, setFlatHover] = useState<number | null>(null);
  const [flatPin, setFlatPin] = useState<number | null>(null);
  useEffect(() => { setFlatHover(null); setFlatPin(null); }, [selected]);
  const anchor = useRef<string | null>(null);
  const [page, setPage] = useState<Page>(route.current.page);
  const [joId, setJoId] = useState<string | null>(route.current.jo);
  const [jointDraft, setJointDraft] = useState<Any>(null);
  const [holeCfg, setHoleCfg] = useState<string | null>(null);
  const [bendSim, setBendSim] = useState<string | null>(null);
  const [bulkReady, setBulkReady] = useState(false);
  const [stepsAdd, setStepsAdd] = useState<{ ids: string[]; n: number } | null>(null);
  const [asmView, setAsmViewState] = useState<'steps' | 'welds'>(() => { try { return localStorage.getItem('forge-asm-view') === 'welds' ? 'welds' : 'steps'; } catch { return 'steps'; } });
  const setAsmView = (v: 'steps' | 'welds') => { setAsmViewState(v); try { localStorage.setItem('forge-asm-view', v); } catch { /* ignore */ } };
  // Assembly holds both the build steps and the joints / welds (one tab; old "steps" links land on the steps view)
  useEffect(() => { if (tab === 'steps') { setAsmView('steps'); setTab('assembly'); } }, [tab]);
  const addToSteps = (ids: string[]) => { setStepsAdd({ ids, n: Date.now() }); setAsmView('steps'); setTab('assembly'); };
  /** press-brake simulation: shown where it is shared; editors can preview it on any formed part */
  // the simulation develops the part itself (also rolled curves the import could not flatten); it reports why if it cannot
  const canBend = (p: Any) => p?.category === 'sheet_metal' && p.geometry?.bends?.length > 0;
  const showBend = (p: Any) => canBend(p) && (p.bend_sim || editable);
  const [weldCfg, setWeldCfg] = useState<{ parts: string[]; weldment: Any | null } | null>(null);
  const [joTitle, setJoTitle] = useState('');
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
  const notify = (s: string) => { toast.success(s, { duration: 5000 }); };
  /** A short, easy name for a part, shown beside the CAD name and searchable (job orders and nesting use it too). */
  const editAlias = async (p: Any) => {
    const v = await ask({ title: 'Part alias', message: `${p.name} — a short name you and the shop can use. Leave empty to remove it.`, confirm: 'Save', input: { label: 'Alias', placeholder: 'e.g. BASE PLATE, SM-12', initial: p.alias || '' } });
    if (v === null) return;
    await action(async () => { await api(`/parts/${p.id}/alias`, 'PUT', { alias: v }); await loadRevision(rev.id); });
  };
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const loadProjects = async () => { setProjects(await api('/projects')); setProjectsLoaded(true); };
  const [revLoading, setRevLoading] = useState(false);
  const loadRevision = useCallback(async (id: string) => { setRevLoading(true); try { const r = await api('/revisions/' + id); setRev(r); return r; } finally { setRevLoading(false); } }, []);
  /** Joints only: fast refresh after a weld is saved or removed (a full revision reload evaluates every part). */
  const refreshJoints = useCallback(async (id: string) => { const [joints, weldments] = await Promise.all([api(`/revisions/${id}/joints`), api(`/revisions/${id}/weldments`).catch(() => null)]); setRev((r: Any) => r && r.id === id ? { ...r, joints, weldments: weldments || r.weldments } : r); }, []);
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

  // document bar: tabs never scroll or clip; details give way step by step until everything fits
  const docBar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = docBar.current; if (!el) return;
    const fit = () => {
      const nav = el.querySelector('.doc-tabs') as HTMLElement | null;
      const status = el.querySelector('.doc-status') as HTMLElement | null;
      const ok = () => (!nav || nav.scrollWidth <= nav.clientWidth + 1) && el.scrollWidth <= el.clientWidth + 1 && (!status || status.scrollWidth <= status.clientWidth + 1);
      el.classList.remove('t1', 't2', 't3', 't4');
      for (const c of ['t1', 't2', 't3', 't4']) { if (ok()) break; el.classList.add(c); }
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  });

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
    const active = rev.status === 'processing' || rev.jobs?.some((j: Any) => ['queued', 'running', 'cancelling'].includes(j.status));
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal && !preview && !document.querySelector('[data-slot="dialog-content"], [role="menu"], [role="listbox"], [data-slot="popover-content"]')) setMulti(selected ? [selected] : []); };
    // capture phase: runs before Radix closes an open dialog or menu on Escape, so that Escape only closes it
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
  const filtered = parts.filter((p: Any) => (category === 'all' ? (showHidden || !p.hidden) : category === 'hidden' ? p.hidden : category === 'excluded' ? p.excluded : p.category === category && (showHidden || !p.hidden)) && (p.name + ' ' + (p.alias || '')).toLowerCase().includes(query.toLowerCase()));
  const hasTree = parts.some((p: Any) => (p.assembly_path || []).length);
  const tree = useMemo(() => buildTree(filtered), [filtered.map((p: Any) => p.id + (p.assembly_path || []).join('/') + (p.alias || '')).join('|')]);
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
      const r = await findAllSeams(rev.id, ids, p => { if (request === detectRequest.current) { setSeamCandidates(p.seams); setDetectMessage(`Searching seams… ${p.searched} of ${p.total} component pairs`); } }, () => request === detectRequest.current);
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
    const uniq = [...new Set(ids)];
    // the weld configuration works on one weld assembly: the selection joined with the assemblies it touches
    if (!editable || !rev) { setWeldCfg({ parts: weldmentOf(uniq[0])?.parts || uniq, weldment: weldmentOf(uniq[0]) }); return; }
    action(async () => { const w = await api(`/revisions/${rev.id}/weldments`, 'POST', { parts: uniq }); setWeldCfg({ parts: w.parts, weldment: w }); });
  };
  const weldmentOf = (pid?: string | null) => (rev?.weldments || []).find((w: Any) => pid && (w.parts || []).includes(pid)) || null;
  const openWeldment = (w: Any) => { if (editable) startWeld(w.parts); else setWeldCfg({ parts: w.parts, weldment: w }); };
  const weldmentJobOrder = (w: Any) => { setJoTitle(w.name); setJoSelection(parts.filter((p: Any) => (w.parts || []).includes(p.id)).map((p: Any) => ({ id: p.id, name: p.name }))); };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const startWeldStudio = (ids: string[], extra: Any = {}) => {
    const draft = { kind: 'weld', parts: ids, faces: [], weld: { type: 'linear', process: 'MIG/MAG (135)', sides: 'one' }, sequence: (rev?.joints?.length || 0) + 1, ...extra };
    setJointDraft(draft); setPickMode('face'); setPairPick([]); setSeamCandidates([]); setDetectMessage(''); setHoverSeam(null); setWeldPreviewStatus(null);
    // One component: Forge looks for the gaps it closes on itself (bent box corners) and keeps
    // "add from 3D" on so the mating parts can be clicked.
    setAddingParts(false);
    if (ids.length >= 1) detectSeams(draft, true);
  };
  const editWeld = (j: Any) => { const w = weldmentOf((j.data.parts || [])[0]); if (w) openWeldment(w); else startWeld(j.data.parts || []); };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const editWeldStudio = (j: Any) => {
    const draft = { id: j.id, kind: j.kind, ...j.data };
    setJointDraft(draft); setPickMode('face'); setPairPick([]); setAddingParts(false); setSeamCandidates([]); setHoverSeam(null); setWeldPreviewStatus(null);
    if (j.kind === 'weld' && (j.data.parts || []).length) detectSeams(draft, false);
  };
  const endWeld = () => { setPairPick([]); setJointDraft(null); setPickMode(null); setSeamCandidates([]); setHoverSeam(null); setAddingParts(false); setWeldPreviewStatus(null); detectRequest.current++; };
  const weldDraftPreview = useMemo(() => jointDraft ? { faces: [...jointDraft.faces, ...pairPick], weld: jointDraft.weld } : null, [jointDraft?.faces, jointDraft?.weld, pairPick]);
  const holes = parts.reduce((n: number, p: Any) => n + p.geometry.holes.length, 0);
  const findings = parts.flatMap((p: Any) => (noChecks(p) ? [] : p.findings));
  const selectedFindings = part?.findings || [];
  /** problems the unfolder located on the selected part (sheet metal whose flat pattern was refused) */
  const flatIssues: FlatIssue[] = part && part.category === 'sheet_metal' && part.geometry.flat_status === 'needs_review' ? (part.geometry.flat_issues || []) : [];
  /** changes whenever a part's active geometry version changes: the viewer reloads the assembly mesh */
  const modelStamp = (rev?.parts || []).filter((p: Any) => p.version && p.version.count > 1).map((p: Any) => p.id.slice(-6) + '.' + p.version.active).join('-') || '0';
  /** A part is production ready when its spec has no open blocker, its design review and its drawing review are done.
   *  Purchased, other and not-for-production parts need nothing. */
  const partReady = (p: Any) => noChecks(p) || (!!p.reviewed && !!p.doc_reviewed
    && !(p.findings || []).some((f: Any) => f.severity === 'blocker' && (!f.waiver || ['GEO001', 'FLAT001'].includes(f.code))));
  const releaseParts = (rev?.parts || []).filter((p: Any) => !noChecks(p));
  const readyCount = releaseParts.filter(partReady).length;
  const blocking = findings.filter((f: Any) => f.severity === 'blocker' && !f.waiver).length;
  const [dismissedJob, setDismissedJob] = useState('');
  const [joSelection, setJoSelection] = useState<{ id: string; name: string }[] | null>(null);
  const job = rev?.jobs?.find((j: Any) => ['queued', 'running', 'cancelling'].includes(j.status) && !['instructions', 'welding'].includes(j.kind));
  const appearance = useMemo<Record<string, PartAppearance>>(() => {
    const out: Record<string, PartAppearance> = {};
    for (const p of parts) {
      // realistic: the finish and material decide colour, gloss and metalness; otherwise the part-type colours
      const look = prefs.realistic ? surfaceLook(p.spec || {}, p.category) : null;
      out[p.id] = { color: (colorBy === 'coating' && p.spec.coating_hex) || look?.color || categoryColors[p.category] || categoryColors.other, category: p.category, name: p.name, roughness: look?.roughness, metalness: look?.metalness };
    }
    return out;
  }, [rev?.id, colorBy, prefs.realistic, parts.map((p: Any) => [p.spec.coating_hex, p.category, p.spec.finish, p.spec.paint, p.spec.material, p.spec.roughness].join('~')).join('|')]);

  // Keep the address bar in sync so any view can be copied and opened by a colleague or vendor.
  useEffect(() => {
    if (!auth?.user) return;
    let path = vendor ? location.pathname : ({ dashboard: '/dashboard', projects: '/projects', joborders: '/job-orders', joborder: '/job-orders/' + joId, templates: '/templates', pricing: '/pricing', admin: '/admin', project: '/projects' } as Record<string, string>)[page];
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
    if (page !== 'project' || modal || preview || drawingPart || shortcutsOpen || document.querySelector('[data-slot="dialog-content"], [role="menu"], [role="listbox"], [data-slot="popover-content"]')) return;
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
  useEffect(() => { const h = (e: KeyboardEvent) => shortcutRef.current(e); window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true); }, []);
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
  const partById = useMemo(() => new Map<string, Any>(parts.map((x: Any) => [x.id, x])), [parts]);
  // rows read the current part (the grouped tree is memoised on structure, not on every edit)
  const renderRow = (p0: Any) => { const p = partById.get(p0.id) || p0; const chosen = p.id === selected; const inMulti = !chosen && multi.includes(p.id); return (
                          <div key={p.id} data-part={p.id} className={cn('group/row relative mx-1.5 flex min-h-11 items-center rounded-md', chosen ? 'bg-selection shadow-[inset_2px_0_0_var(--color-primary)]' : inMulti ? 'bg-selection' : 'hover:bg-accent')}>
                            <Button type="button" variant="ghost" className={cn('h-auto min-w-0 flex-1 justify-start gap-2.5 px-2 py-1.5 text-left font-normal whitespace-normal select-none hover:bg-transparent group-focus-within/row:pr-10 group-hover/row:pr-10 dark:hover:bg-transparent', p.hidden && 'pr-10 opacity-55', p.excluded && 'pr-10')} onClick={ev => clickRow(p.id, ev)}>
                              <span className={cn('grid size-[26px] shrink-0 place-items-center rounded-md', glyphTone[p.category] || glyphTone.other)} style={p.spec.coating_hex ? { background: p.spec.coating_hex, color: '#fff' } : undefined}>{p.category === 'sheet_metal' ? <Layers className="size-4" /> : <Box className="size-4" />}</span>
                              <span className="min-w-0 flex-1"><span className={cn('block truncate text-sm font-medium text-foreground', p.excluded && 'text-muted-foreground line-through')} title={p.alias ? `${p.alias} — ${p.name}` : p.name}>{p.alias && <span className="mr-1.5 inline-block rounded bg-selection px-1.5 align-[1px] text-2xs leading-[17px] font-medium text-selection-foreground">{p.alias}</span>}{p.name}</span><span className="mt-0.5 block truncate text-2xs text-muted-foreground">{p.excluded ? <span className="font-medium text-destructive">Not for production</span> : categories[p.category]} <span className="text-faint">· Qty {p.quantity}</span>{p.spec.material && !p.excluded && <span className="text-faint"> · {p.spec.material}</span>}</span></span>
                              {jointDraft?.kind === 'weld' && (() => { const check = weldability(p); return <span className={cn('grid size-5 shrink-0 place-items-center rounded-full', check.level === 'good' ? 'bg-success-soft text-success' : check.level === 'blocked' ? 'bg-danger-soft text-destructive' : 'bg-warning-soft text-warning')} title={`${check.label}: ${check.reason}`}><Flame className="size-3" /></span>; })()}
                              {noChecks(p) ? <span className="size-[9px] shrink-0 rounded-full border-2 border-dashed border-faint/60" title={p.excluded ? 'Not for production' : `${categories[p.category]} — no checks needed`} />
                                : partReady(p) ? <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label="Production ready" />
                                : <span className={cn('size-[9px] shrink-0 rounded-full border-2 border-warning', (p.reviewed || p.doc_reviewed) && 'bg-[linear-gradient(90deg,var(--color-warning)_50%,transparent_50%)]')} title={[!p.reviewed && 'design review', !p.doc_reviewed && 'drawing review', p.reviewed && p.doc_reviewed && 'open specification items'].filter(Boolean).join(' + ') + ' still to do'} />}
                            </Button>
                            {!vendor && <Button type="button" variant="ghost" size="icon-xs" className={cn('absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100', p.hidden && 'opacity-100')} title={p.hidden ? 'Show in viewer' : 'Hide in viewer'} onClick={() => setFlags(p.id, { hidden: !p.hidden })}>{p.hidden ? <EyeOff /> : <Eye />}</Button>}
                          </div>
                        ); };
  /** Hover actions on a sub-assembly / weld-assembly row (always shown while active). */
  const asmAction = (active: boolean) => cn('size-7 bg-card text-muted-foreground opacity-0 shadow-none group-focus-within/asm:opacity-100 group-hover/asm:opacity-100', active && 'border-primary/30 bg-selection text-primary opacity-100 hover:bg-selection');
  const asmRow = (chosen: boolean) => cn('group/asm relative mx-1 flex min-h-10 items-center gap-0.5 rounded-md pr-1.5', chosen ? 'bg-selection' : 'hover:bg-accent');
  const asmName = 'h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-1.5 text-left font-normal text-foreground hover:bg-transparent group-focus-within/asm:pr-[70px] group-hover/asm:pr-[70px] dark:hover:bg-transparent';
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
          <div key={g.key}>
            <div className={asmRow(chosen)} style={{ paddingLeft: 4 + depth * 12 }}>
              <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setCollapsed(c => { const n = new Set(c); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</Button>
              <Button type="button" variant="ghost" className={asmName} title="Select the whole sub-assembly" onClick={() => { setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; if (mode !== '3d') setMode('3d'); }}>
                <Folder className="size-4 text-warning" /><span className="min-w-0 truncate text-sm font-medium">{g.name}</span><span className="ml-auto text-2xs whitespace-nowrap text-muted-foreground">{ids.length} part{ids.length === 1 ? '' : 's'} · {cats.length === 1 ? categories[cats[0]] : 'mixed'}</span>
              </Button>
              <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-1">
                <Button type="button" variant="outline" size="icon-sm" className={asmAction(chosen && isolate)} title="Isolate this sub-assembly (show only its parts)" onClick={() => { if (chosen && isolate) { setIsolate(false); return; } setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; setIsolate(true); if (mode !== '3d') setMode('3d'); }}><Target className="size-3.5" /></Button>
                {!vendor && <Button type="button" variant="outline" size="icon-sm" className={asmAction(false)} title={allHidden ? 'Show sub-assembly in viewer' : 'Hide sub-assembly in viewer'} onClick={() => action(async () => { await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids, hidden: !allHidden }); await loadRevision(rev.id); })}>{allHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</Button>}
              </span>
            </div>
            {open && <div className="border-l border-dashed" style={{ marginLeft: 15 + depth * 12 }}>{renderTree(g, depth + 1)}</div>}
          </div>
        );
      })}
      {node.parts.map(renderRow)}
    </React.Fragment>
  );
  /** Navigator grouped by weld assembly: each assembly with its parts, then the parts not welded. */
  const renderWeldGroups = () => {
    const inAny = new Set<string>((rev?.weldments || []).flatMap((w: Any) => w.parts || []));
    const groups = [...(rev?.weldments || []).map((w: Any) => ({ key: 'w:' + w.id, w, rows: filtered.filter((p: Any) => (w.parts || []).includes(p.id)) })),
      { key: 'w:none', w: null, rows: filtered.filter((p: Any) => !inAny.has(p.id)) }].filter(g => g.rows.length);
    return groups.map(g => {
      const open = !collapsed.has(g.key);
      const ids = g.rows.map((p: Any) => p.id);
      const chosen = ids.every((id: string) => multi.includes(id));
      return (
        <div key={g.key}>
          <div className={asmRow(chosen)} style={{ paddingLeft: 4 }}>
            <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setCollapsed(c => { const n = new Set(c); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</Button>
            <Button type="button" variant="ghost" className={asmName} title={g.w ? 'Select the parts of this weld assembly' : 'Select the parts that are not welded'} onClick={() => { setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; if (mode !== '3d') setMode('3d'); }}>
              {g.w ? <Flame className="size-4 text-pink-500" /> : <Folder className="size-4 text-warning" />}<span className="min-w-0 truncate text-sm font-medium">{g.w ? g.w.name : 'Not welded'}</span><span className="ml-auto text-2xs whitespace-nowrap text-muted-foreground">{ids.length} part{ids.length === 1 ? '' : 's'}{g.w ? ` · ${(g.w.welds || []).length} weld${(g.w.welds || []).length === 1 ? '' : 's'}` : ''}</span>
            </Button>
            <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-1">
              {g.w && <Button type="button" variant="outline" size="icon-sm" className={asmAction(false)} title="Weld configuration" onClick={() => openWeldment(g.w)}><Flame className="size-3.5" /></Button>}
              <Button type="button" variant="outline" size="icon-sm" className={asmAction(chosen && isolate)} title="Isolate (show only these parts)" onClick={() => { if (chosen && isolate) { setIsolate(false); return; } setMulti(ids); setSelected(ids[0] || null); anchor.current = ids[0] || null; setIsolate(true); if (mode !== '3d') setMode('3d'); }}><Target className="size-3.5" /></Button>
            </span>
          </div>
          {open && <div className="ml-[15px] border-l border-dashed">{g.rows.map(renderRow)}</div>}
        </div>
      );
    });
  };
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

  if (!auth) return <div className="flex min-h-screen items-center justify-center gap-4 text-base text-muted-foreground"><LogoMark size={32} /><LoaderCircle className="size-4 animate-spin text-primary" />Opening Forge…{error && <p className="text-destructive">{error}</p>}</div>;

  if (!auth.user && !vendor) {
    const providers = auth.providers || { local: true, entra: false, domains: [] };
    const signinError = new URLSearchParams(location.search).get('signin_error');
    const reasons: Record<string, string> = { DomainNotAllowed: `Only ${(providers.domains || []).join(', ')} accounts can use Forge.`, GuestsNotAllowed: 'Guest accounts cannot use Forge.', WrongTenant: 'That account belongs to another organisation.', AccessDisabled: 'Your Forge access is disabled. Ask an administrator.', AccountConflict: 'This e-mail is linked to a different Microsoft account.', SessionExpired: 'The sign-in took too long. Try again.', StateMismatch: 'The sign-in could not be verified. Try again.', TokenInvalid: 'Microsoft sign-in could not be verified. Try again.', EntraError: 'Microsoft sign-in was cancelled or failed.', NoEmail: 'Your Microsoft account has no e-mail address.' };
    return (
      <div className="grid min-h-screen place-items-center bg-background bg-[radial-gradient(1200px_500px_at_50%_-10%,var(--color-selection),transparent)] p-5">
        <div className="flex w-full max-w-[380px] flex-col gap-3 rounded-xl border bg-card p-7 shadow-pop">
          <div className="flex items-center gap-2.5"><LogoMark size={36} /><span className="grid"><span className="text-lg font-semibold leading-tight">Forge</span><span className="text-xs text-faint">GOAT Robotics · CAD to shop floor</span></span></div>
          <h1 className="mt-3 text-xl font-semibold">{auth.configured || providers.entra ? 'Sign in' : 'Set up your workspace'}</h1>
          <p className="text-sm text-muted-foreground">Drawings, design reviews, job orders and quality records — one revision-controlled workspace.</p>
          {signinError && <p className="text-sm text-destructive">{reasons[signinError] || 'Sign-in failed.'}</p>}
          {providers.entra && (
            <Button asChild className="h-9 w-full gap-2.5">
              <a href={'/api/auth/entra/login?next=' + encodeURIComponent(location.pathname === '/' ? '/dashboard' : location.pathname + location.search)}>
                <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>
                Sign in with Microsoft
              </a>
            </Button>
          )}
          {providers.entra && <small className="text-center text-xs text-muted-foreground">{(providers.domains || []).join(', ')} accounts only</small>}
          {providers.local && (
            <form className="grid gap-3" onSubmit={e => {
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
              {providers.entra && <div className="my-1.5 flex items-center gap-2 text-2xs text-faint before:flex-1 before:border-t before:content-[''] after:flex-1 after:border-t after:content-['']"><span>or local account</span></div>}
              {!auth.configured && <Label className={field}>Your name<Input name="name" required autoComplete="name" /></Label>}
              <Label className={field}>E-mail<Input type="email" name="email" required autoComplete="username" /></Label>
              <Label className={field}>Password<Input name="password" type="password" required minLength={auth.configured ? 1 : 12} autoComplete={auth.configured ? 'current-password' : 'new-password'} /></Label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button variant={providers.entra ? 'outline' : 'default'} className="w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowUpRight />} {auth.configured ? 'Sign in' : 'Create workspace'}</Button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const goHome = () => { if (vendor) return; setProject(null); setRev(null); go('projects'); };
  // ---- CAD workspace chrome: heads-up info and the floating tool palette ------------------------
  const inspectorContent = !!(jointDraft || multi.length > 1 || part || overview);
  const hudCard = 'glass pointer-events-auto inline-flex max-w-full items-center gap-2.5 rounded-xl py-1.5 pr-2 pl-3';
  const hudText = 'flex min-w-0 flex-col';
  const hudTitle = 'max-w-[360px] truncate text-sm font-semibold text-foreground';
  const hudSub = 'truncate text-2xs text-muted-foreground';
  const hudActions = 'ml-0.5 flex flex-none items-center gap-1 border-l pl-2';
  const canvasHud = !rev ? null : jointDraft ? (
    <div className={cn(hudCard, 'pr-3')}><Flame className="size-4 flex-none text-orange-600" /><span className={hudText}><span className={hudTitle}>{jointDraft.id ? 'Edit weld' : 'Weld setup'}</span><span className={hudSub}>{(jointDraft.parts || []).length} component{(jointDraft.parts || []).length === 1 ? '' : 's'} · {(jointDraft.faces || []).filter((f: Any) => f.selection === 'edge').length} seam(s)</span></span></div>
  ) : multi.length > 1 ? (
    <div className={hudCard}><Layers className="size-4 flex-none text-muted-foreground" /><span className={hudText}><span className={hudTitle}>{multi.length} parts selected</span><span className={hudSub}>Shift-click a range · Ctrl/Cmd-click to toggle</span></span>
      <span className={hudActions}>
        <Button type="button" variant="ghost" size="sm" className={cn(isolate && onTone)} title={`Show only the selected parts (${binding('part.isolate') || 'no key'})`} onClick={() => { setIsolate(!isolate); setMode('3d'); }}><Target /><span>Isolate</span></Button>
        <Button type="button" variant="ghost" size="sm" className={cn(multi.every(x => transparentIds.includes(x)) && onTone)} title={`See through the selected parts (${binding('part.transparent') || 'no key'})`} onClick={() => setTransparentIds(t => multi.every(x => t.includes(x)) ? t.filter(x => !multi.includes(x)) : [...new Set([...t, ...multi])])}><Droplet /><span>Transparent</span></Button>
        {!vendor && editable && <Button type="button" variant="ghost" size="sm" title="Add the selected parts as the next assembly step" onClick={() => addToSteps([...multi])}><ListPlus /><span>Add step</span></Button>}
        {!vendor && (project?.permissions || []).includes('joborder.create') && <Button type="button" variant="ghost" size="sm" title="New job order for just these parts (from the production-ready revision)" onClick={() => setJoSelection(parts.filter((p: Any) => multi.includes(p.id)).map((p: Any) => ({ id: p.id, name: p.name })))}><ClipboardList /><span>Job order</span></Button>}
        <Button type="button" variant="ghost" size="icon-sm" title="Clear selection" aria-label="Clear selection" onClick={() => choosePart(null)}><X /></Button>
      </span></div>
  ) : part ? (
    <div className={hudCard}>
      <Swatch hex={part.spec.coating_hex || categoryColors[part.category]} title={part.spec.coating_color || categories[part.category]} size={12} />
      <span className={hudText}><span className={hudTitle} title={part.name}>{part.name}</span><span className={hudSub}>{categories[part.category]} · Qty {part.quantity}{part.spec.material ? ` · ${part.spec.material}` : ''}</span></span>
      <span className={hudActions}>
        <Button type="button" variant="ghost" size="sm" className={cn(isolate && onTone)} title="Isolate (or double-click the part)" onClick={() => { const on = !isolate; setIsolate(on); setSolo(on && part.quantity > 1 ? (lastOccurrence.current ?? 0) : null); setMode('3d'); }}><Target /><span>Isolate</span></Button>
        {isolate && part.quantity > 1 && mode === '3d' && <span className="inline-flex h-7 items-center overflow-hidden rounded-md border" title="This part is used more than once. Inspect one instance at a time; the view orbits around it.">
          <Button type="button" variant="ghost" size="icon-xs" className="h-[26px] w-6 rounded-none" aria-label="Previous instance" onClick={() => setSolo(v => ((v ?? 0) - 1 + part.quantity) % part.quantity)}><ChevronLeft /></Button>
          <Button type="button" variant="ghost" size="xs" className={cn('h-[26px] min-w-[52px] rounded-none px-1.5 text-xs font-medium tabular-nums', solo === null && 'text-muted-foreground')} onClick={() => setSolo(v => v === null ? (lastOccurrence.current ?? 0) : null)}>{solo === null ? `All ${part.quantity}` : `${solo + 1} of ${part.quantity}`}</Button>
          <Button type="button" variant="ghost" size="icon-xs" className="h-[26px] w-6 rounded-none" aria-label="Next instance" onClick={() => setSolo(v => ((v ?? -1) + 1) % part.quantity)}><ChevronRight /></Button>
        </span>}
        {part.category === 'sheet_metal' && <>
          <Button type="button" variant="ghost" size="sm" className={cn(mode === 'flat2d' && onTone)} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message || 'Flat pattern (2D)'} onClick={() => setMode(mode === 'flat2d' ? '3d' : 'flat2d')}><Grid2x2 /><span>Flat</span></Button>
          <Button type="button" variant="ghost" size="sm" className={cn(mode === 'flat3d' && onTone)} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message || 'Flat pattern in 3D'} onClick={() => setMode(mode === 'flat3d' ? '3d' : 'flat3d')}><Scan /><span>Flat 3D</span></Button>
        </>}
        {!vendor && editable && <Button type="button" variant="ghost" size="sm" title="Add this part as the next assembly step" onClick={() => addToSteps([part.id])}><ListPlus /><span>Add step</span></Button>}
        <Button type="button" variant="ghost" size="icon-sm" className={cn(transparentIds.includes(part.id) && onTone)} title={`See through this part (${binding('part.transparent') || 'no key'})`} aria-label="See through this part" onClick={() => setTransparentIds(t => t.includes(part.id) ? t.filter(x => x !== part.id) : [...t, part.id])}><Droplet /></Button>
        <Button type="button" variant="ghost" size="icon-sm" title="Clear selection (Esc)" aria-label="Clear selection" onClick={() => choosePart(null)}><X /></Button>
      </span>
    </div>
  ) : (
    null
  );
  const canvasToolsStart = !rev ? null : <>
    {!vendor && editable && <Button type="button" variant="ghost" size="sm" className={cn(jointDraft && onTone)} disabled={!!jointDraft} title={multi.length > 1 ? 'Weld the selected parts' : part ? 'Weld this part (to itself or to parts you click)' : 'Start a weld: click two faces'} onClick={() => startWeld(multi.length > 1 ? [...multi] : part ? [part.id] : [])}><Flame /><span className="group-[.compact]/palette:hidden">Weld</span></Button>}
    {part && part.geometry.holes.length > 0 && part.category !== 'purchased' && multi.length < 2 && <Button type="button" variant="ghost" size="sm" title="Hole hardware: inserts, studs, standoffs, taps, countersinks" onClick={() => setHoleCfg(part.id)}><CircleDot /><span className="group-[.compact]/palette:hidden">Holes</span></Button>}
    {part && multi.length < 2 && showBend(part) && <Button type="button" variant="ghost" size="sm" title={part.bend_sim ? 'Forming simulation (press brake and rolling)' : 'Forming simulation (preview — not shared with vendors)'} onClick={() => setBendSim(part.id)}><FoldVertical /><span className="group-[.compact]/palette:hidden">Bending</span></Button>}
  </>;
  const canvasToolsEnd = !rev || !transparentIds.length ? null : <>
    <Button type="button" variant="ghost" size="sm" title={`${transparentIds.length} transparent part(s) — make all opaque`} onClick={() => setTransparentIds([])}><Droplet /><span>{transparentIds.length}</span></Button>
  </>;
  const rightOpen = layout.right && !layout.focus && inspectorContent;
  const leftOpen = layout.left && !layout.focus;
  const cornerBtn = (on: boolean) => cn('text-muted-foreground', on && 'text-foreground');
  const canvasCorner = !rev ? null : <>
    <Button type="button" variant="ghost" size="icon" className={cornerBtn(leftOpen)} title={leftOpen ? 'Hide the part navigator' : 'Show the part navigator'} aria-label="Part navigator" onClick={() => setLayout({ left: !leftOpen, focus: false })}>{leftOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</Button>
    <Button type="button" variant="ghost" size="icon" className={cornerBtn(!!rightOpen)} title={rightOpen ? 'Hide the side panel' : 'Show the side panel (revision overview when nothing is selected)'} aria-label="Side panel" onClick={() => { if (rightOpen) { setLayout({ right: false }); return; } if (!part && multi.length < 2 && !jointDraft) setOverview(true); setLayout({ right: true, focus: false }); }}>{rightOpen ? <PanelRightClose /> : <PanelRightOpen />}</Button>
    <Button type="button" variant="ghost" size="icon" className={cornerBtn(layout.focus)} title={layout.focus ? 'Exit full canvas (Esc)' : `Full canvas (${binding('layout.focus')})`} aria-label="Full canvas" onClick={() => setLayout({ focus: !layout.focus })}>{layout.focus ? <Minimize2 /> : <Maximize2 />}</Button>
  </>;
  const workspaceTab = (page === 'project' || !!vendor) && tab === 'parts' && !!rev && rev.status !== 'processing';
  if (rev && tab === 'parts' && rev.status !== 'processing') modelSeen.current = rev.id;
  const ctx = { busy, action, notify };
  const activeJobs = projects.reduce((n: number, p: Any) => n + (p.open_job_orders || 0), 0);
  const signOut = () => action(async () => { await api('/auth/logout', 'POST'); setAuth(await api('/auth/status')); });

  const canvasFocus = layout.focus && tab === 'parts' && page === 'project';
  const docTab = 'relative h-full gap-1.5 rounded-none px-3 text-sm font-medium text-muted-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent group-[.t1:not(.t2)]/doc:px-2.5 group-[.t2:not(.t4)]/doc:px-2 group-[.t4]/doc:px-1.5 group-[.t4]/doc:text-xs';
  const statusTone: Record<string, string> = { warning: 'bg-warning-soft text-warning hover:bg-warning-soft hover:text-warning', success: 'bg-success-soft text-success hover:bg-success-soft hover:text-success', danger: 'bg-danger-soft text-destructive hover:bg-danger-soft hover:text-destructive', neutral: 'bg-muted text-muted-foreground hover:bg-muted hover:text-muted-foreground' };
  const statusPill = 'doc-status inline-flex h-6 min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-full px-2.5 text-2xs font-medium whitespace-nowrap group-[.t3]/doc:gap-0 group-[.t3]/doc:px-2';
  const statusDot = 'size-1.5 shrink-0 rounded-full bg-current group-[.t3]/doc:size-2';
  const banner = 'flex shrink-0 items-center gap-2.5 border-b px-6 py-2.5 text-sm [&>svg]:shrink-0';
  const notice = 'mb-4 flex items-center gap-2.5 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning [&>svg]:shrink-0';
  const pill = 'fixed bottom-[84px] left-1/2 z-[150] flex max-w-[min(560px,90vw)] -translate-x-1/2 items-center gap-2.5 rounded-full border bg-card/90 py-2 pr-2.5 pl-3.5 text-xs text-foreground shadow-pop backdrop-blur-md';
  const emptyPage = 'flex min-h-[450px] flex-col items-center justify-center gap-3.5 px-6 py-16 text-center text-muted-foreground [&>p]:max-w-[420px]';
  const cols = leftOpen && rightOpen ? 'grid-cols-[280px_minmax(360px,1fr)_344px] min-[1700px]:grid-cols-[304px_minmax(400px,1fr)_368px]'
    : leftOpen ? 'grid-cols-[280px_minmax(360px,1fr)_0] min-[1700px]:grid-cols-[304px_minmax(400px,1fr)_0]'
    : rightOpen ? 'grid-cols-[0_minmax(360px,1fr)_344px] min-[1700px]:grid-cols-[0_minmax(400px,1fr)_368px]'
    : 'grid-cols-[0_1fr_0]';

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-screen overflow-hidden bg-background">
      {!vendor && <Sidebar page={page} go={go} user={auth.user} perms={perms} badges={{ joborders: activeJobs }} onSignOut={signOut} />}

      <main className={cn('flex h-screen min-w-0 flex-1 flex-col', workspaceTab ? 'overflow-hidden' : 'overflow-y-auto')}>
        {vendor && (
          <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><LogoMark size={22} /><span className="font-medium text-foreground">Forge</span><ChevronRight className="size-3.5 shrink-0" /><span className="whitespace-nowrap">Vendor workspace · read only</span>{rev && <><ChevronRight className="size-3.5 shrink-0 max-[1200px]:hidden" /><span className="max-w-[360px] truncate max-[1200px]:hidden">Rev {rev.number} · {rev.filename}</span></>}</div>
            <div className="ml-auto flex items-center gap-2">{rev && <Button type="button" variant="outline" size="xs" onClick={copyLink}><Link />Copy link</Button>}</div>
          </header>
        )}
        {!vendor && page === 'dashboard' ? <Dashboard ctx={ctx} openJobOrder={openJobOrder} openProject={openProjectId} />
        : !vendor && page === 'joborders' ? <JobOrdersPage projects={projects} ctx={ctx} perms={perms} openJobOrder={openJobOrder} />
        : !vendor && page === 'joborder' && joId ? <JobOrderDetail id={joId} ctx={ctx} back={() => go('joborders')} openProject={openProjectId} />
        : !vendor && page === 'templates' ? <TemplatesPage ctx={ctx} perms={perms} />
        : !vendor && page === 'pricing' ? <PricingPage ctx={ctx} />
        : !vendor && page === 'admin' ? <AdminPage ctx={ctx} me={auth.user} />
        : !vendor && (page === 'projects' || !project) ? (
          <div className={pageWrap}>
            <PageHeader title="Projects" description="From the first CAD upload to the final quality check." actions={<>
              {perms.has('users.manage') && <Button variant="outline" onClick={() => { setModal('settings'); api('/settings').then(setSettings).catch(fail); }}><Settings />Workspace defaults</Button>}
              {perms.has('project.create') && <Button onClick={() => setModal('project')}><Plus />New project</Button>}
            </>} />
            <div className="flex flex-col gap-4">
              {!projectsLoaded ? (
                <div className={emptyPage}><LoaderCircle className="size-7 animate-spin" /><p>Loading projects…</p></div>
              ) : projects.length ? (
                <div className="overflow-hidden rounded-lg border bg-card">
                  <Table>
                    <TableHeader className="bg-subtle"><TableRow><TableHead>Project</TableHead><TableHead>Active revision</TableHead><TableHead>Status</TableHead><TableHead>Job orders</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                    <TableBody>{projects.map(p => (
                      <TableRow key={p.id} className="cursor-pointer" onClick={() => action(() => openProject(p))}>
                        <TableCell><span className="flex items-center gap-2.5"><span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Box className="size-4" /></span><span className="min-w-0"><span className="block font-medium">{p.code ? p.code + ' · ' : ''}{p.name}</span><span className="block text-2xs text-faint">{p.description || 'CAD, drawings and manufacturing records'}</span></span></span></TableCell>
                        <TableCell>{p.active_revision ? 'Rev ' + p.active_revision : '—'}<span className="block text-2xs text-faint">{p.revision_count} revisions</span></TableCell>
                        <TableCell>{p.active_status ? <Badge kind={p.active_status === 'released' ? 'success' : p.active_status === 'failed' ? 'danger' : 'warning'}>{p.active_status === 'released' ? 'Production ready' : p.active_status === 'ready' ? 'In design review' : p.active_status.replace('_', ' ')}</Badge> : <Badge kind="neutral">No CAD</Badge>}</TableCell>
                        <TableCell className="tabular-nums">{p.open_job_orders || 0} open</TableCell>
                        <TableCell>{date(p.created)}<span className="block text-2xs text-faint">{p.created_by}</span></TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </div>
              ) : (
                <Empty icon={<Upload />} title="Start with your CAD">
                  <p className="max-w-md text-xs">Create a project, set its naming, title block and templates, then upload a STEP assembly.</p>
                  {perms.has('project.create') && <Button className="mt-2" onClick={() => setModal('project')}><Plus />New project</Button>}
                </Empty>
              )}
              <div className="mt-12 grid grid-cols-4 gap-6 border-t pt-6 max-[900px]:grid-cols-2 max-[900px]:gap-4">
                {[['01', 'Upload & analyze', 'STEP in; parts, features, materials and bends out.'], ['02', 'Check & review', 'Design checks and drawing review, part by part.'], ['03', 'Production ready', 'Release locks the documents for the shop floor.'], ['04', 'Job orders', 'Process checklists with counts and timestamps.']].map(([n, t, sub]) => (
                  <div key={n}><span className="text-xs font-medium text-primary tabular-nums">{n}</span><h3 className="mt-2 text-base font-semibold">{t}</h3><p className="mt-1 text-sm text-muted-foreground">{sub}</p></div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {(vendor || project) && (
          // The open project stays mounted while other pages are shown, so coming back is instant (no model reload).
          <div className={vendor || (page === 'project' && project) ? 'contents' : 'hidden'}>
            <header className={cn('group/doc sticky top-0 z-20 flex h-12 flex-none items-center gap-4 border-b bg-card pr-3.5 pl-4 [&.t1]:gap-3', canvasFocus && 'hidden')} ref={docBar}>
              <div className="flex min-w-[180px] shrink items-center gap-2">
                {!vendor && <><Button type="button" variant="link" className="h-auto p-0 font-normal text-muted-foreground hover:text-primary hover:no-underline group-[.t2]/doc:hidden" onClick={goHome}>Projects</Button><ChevronRight className="size-3.5 flex-none text-faint group-[.t2]/doc:hidden" /></>}
                <span className="flex min-w-0 max-w-[300px] shrink items-center gap-2 text-base font-semibold text-foreground group-[.t3:not(.t4)]/doc:max-w-40 group-[.t4]/doc:max-w-[110px]" title={project?.name || rev?.filename}>{project?.code && <span className="flex-none rounded border bg-muted px-1.5 py-px font-mono text-2xs font-medium tracking-wide text-muted-foreground">{project.code}</span>}<span className="truncate">{project?.name || rev?.filename || 'Shared design'}</span></span>
                {rev && <DropdownMenu open={revisionOpen && !vendor} onOpenChange={setRevisionOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="xs" className="h-7 flex-none gap-1 bg-subtle px-2 text-xs shadow-none" title="Switch revision"><GitBranch className="size-3.5" />Rev {rev.number}{!vendor && <ChevronDown className="size-3.5" />}</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[200px]">
                    {project?.revisions.map((r: Any) => <DropdownMenuItem key={r.id} className="justify-between" onClick={() => { setRevisionOpen(false); choosePart(null); loadRevision(r.id).catch(fail); }}>Rev {r.number}<Badge>{r.state}</Badge></DropdownMenuItem>)}
                    {project?.revisions.length > 1 && <DropdownMenuItem onClick={() => action(async () => { const other = project.revisions.find((r: Any) => r.id !== rev.id); setComparison(await api(`/revisions/${rev.id}/compare/${other.id}`)); setModal('compare'); setRevisionOpen(false); })}>Compare with previous</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>}
                {rev && (() => {
                  const allReady = rev.status === 'ready' && releaseParts.length > 0 && readyCount === releaseParts.length;
                  const label = rev.state === 'archived' ? 'Archived' : rev.status === 'released' ? 'Released' : rev.status === 'ready' ? (allReady ? 'Ready to release' : 'In design review') : rev.status.replace('_', ' ');
                  const tone = rev.state === 'archived' ? 'neutral' : rev.status === 'released' || allReady ? 'success' : rev.status === 'failed' ? 'danger' : 'warning';
                  const openRelease = () => action(async () => { setRelease(await api(`/revisions/${rev.id}/release-check`)); setModal('release'); });
                  if (allReady && !vendor && rev.state === 'active') return <span className="inline-flex flex-none items-center gap-2">
                    <span className={cn(statusPill, statusTone.success)} title={`All ${releaseParts.length} part${releaseParts.length === 1 ? '' : 's'} production ready — release the revision to start job orders.`}><i className={statusDot} /><span className="group-[.t3]/doc:hidden">Ready to release</span></span>
                    <Button type="button" size="sm" className="rounded-full max-[1180px]:w-7 max-[1180px]:px-0" disabled={!!job || !can('revision.release')} title={can('revision.release') ? 'Final check, then release this revision for production' : 'You need the release permission'} onClick={openRelease}><ShieldCheck /><span className="max-[1180px]:hidden">Release revision</span></Button>
                  </span>;
                  return <Button type="button" variant="ghost" size="xs" className={cn(statusPill, statusTone[tone], 'hover:ring-1 hover:ring-current hover:ring-inset')} onClick={() => { choosePart(null); setOverview(true); setLayout({ right: true, focus: false }); }}
                    title={rev.status === 'released' ? 'This revision is released for production.' : `Revision status — ${readyCount} of ${releaseParts.length} parts production ready. The revision leaves design review when every part is ready and it is released from Overview.`}>
                    <i className={statusDot} /><span className="group-[.t3]/doc:hidden">{label}</span>{rev.status === 'ready' && !allReady && <span className="font-normal tabular-nums opacity-80 group-[.t1]/doc:hidden">{readyCount}/{releaseParts.length} ready</span>}</Button>;
                })()}
              </div>
              {rev && <nav className="doc-tabs flex flex-none items-stretch gap-0.5 self-stretch" aria-label="Revision views">
                {[['parts', 'Model', Box], ['rules', 'Checks', ShieldCheck], ['assembly', 'Assembly', Layers], ...(vendor ? [['production', 'Drawings', Factory]] : [['joborders', 'Jobs', Factory]]), ['review', 'Review', MessageSquare], ['qc', 'Quality', ClipboardCheck], ...(!vendor ? [['audit', 'History', Clock]] : [])].map(([id, label, Icon]: Any) => (
                  <Button type="button" variant="ghost" className={cn(docTab, tab === id && 'text-foreground after:opacity-100')} key={id} onClick={() => setTab(id)}><Icon className="size-4 group-[.t1]/doc:hidden" />{label}{id === 'rules' && blocking > 0 && <Badge kind="danger" className="h-4 px-1.5 tabular-nums">{blocking}</Badge>}</Button>
                ))}
              </nav>}
              <div className="ml-auto flex flex-none items-center gap-1.5 group-[.t4]/doc:gap-0.5">
                {vendor && <span className="text-xs text-muted-foreground">Supplier review · read only</span>}
                {!vendor && importingRevision && <Button type="button" variant="ghost" title="View import progress" onClick={showImport}><LoaderCircle className="animate-spin" />{importingRevision.progress || 0}%</Button>}
                {!vendor && <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
                  <Tip label="More">
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground" aria-label="More" aria-expanded={moreOpen}><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                  </Tip>
                  <DropdownMenuContent align="end" className="min-w-[250px]" onClick={() => setMoreOpen(false)}>
                    {rev && <DropdownMenuItem onClick={copyLink}><Link />Copy link to this view</DropdownMenuItem>}
                    {(project?.permissions || []).includes('revision.upload') && !importingRevision && <DropdownMenuItem onClick={() => setModal('upload')}><Upload />Upload a new revision</DropdownMenuItem>}
                    {rev && can('cad.download') && <DropdownMenuItem disabled={!rev.assets?.includes('manufacturing-pack.zip')} title={rev.assets?.includes('manufacturing-pack.zip') ? '' : 'Generate the manufacturing pack first (side panel, nothing selected)'} onClick={() => doc(`/revisions/${rev.id}/assets/manufacturing-pack.zip`, 'manufacturing-pack.zip')}><Download />Download manufacturing pack</DropdownMenuItem>}
                    <DropdownMenuItem onClick={() => setShortcutsOpen(true)}><Keyboard />Shortcuts &amp; navigation</DropdownMenuItem>
                    {project && (project.permissions || []).includes('project.settings') && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => setModal('project-settings')}><Settings />Project settings</DropdownMenuItem></>}
                  </DropdownMenuContent>
                </DropdownMenu>}
                {vendor && rev && can('cad.download') && <Tip label="Download the manufacturing pack"><Button type="button" variant="ghost" size="icon" className="text-muted-foreground" aria-label="Download the manufacturing pack" onClick={() => doc(`/revisions/${rev.id}/assets/manufacturing-pack.zip`, 'manufacturing-pack.zip')} disabled={!rev.assets?.includes('manufacturing-pack.zip')}><Download /></Button></Tip>}
                {rev && !vendor && can('share.manage') && <Button type="button" className="max-[1180px]:w-8 max-[1180px]:px-0 group-[.t3]/doc:w-8 group-[.t3]/doc:px-0" disabled={!['ready', 'released'].includes(rev.status)} onClick={() => { setSharePath(''); setModal('share'); }}><Send /><span className="max-[1180px]:hidden group-[.t3]/doc:hidden">Share</span></Button>}
              </div>
            </header>

            {importingRevision && <div className={pill} role="status" aria-live="polite">
              <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
              <span className="min-w-0 truncate">Revision {importingRevision.number} · {importingRevision.message || 'Import queued'}</span>
              <span className="w-[90px] shrink-0" role="progressbar" aria-label="CAD import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={importingRevision.progress || 0}><Progress value={importingRevision.progress || 0} /></span>
              <span className="min-w-[30px] text-right text-2xs text-muted-foreground tabular-nums">{importingRevision.progress || 0}%</span>
              {rev?.id !== importingRevision.id && <Button variant="outline" size="xs" className="rounded-full" onClick={showImport}>View import</Button>}
            </div>}

            {!rev && vendor ? (
              <div className={emptyPage}><LoaderCircle className="animate-spin" /><p>Loading shared revision…</p></div>
            ) : !rev && (project?.revisions?.length || project?.active_revision || revLoading) ? (
              <div className={emptyPage}><LoaderCircle className="size-8 animate-spin" /><h2 className="text-xl font-semibold text-foreground">Opening {project?.name || 'project'}…</h2><p>Loading the latest revision, parts and drawings. Large assemblies take a few seconds.</p></div>
            ) : !rev ? (
              <div className={emptyPage}><Upload className="size-10 text-faint" /><h2 className="text-xl font-semibold text-foreground">Every part starts here.</h2><p>Upload STEP, IGES or BREP. Assemblies and multi-body parts stay connected.</p><Button onClick={() => setModal('upload')}>Upload CAD file</Button></div>
            ) : (
              <>
                {job && !importingRevision && <div className={pill} role="status" aria-live="polite"><LoaderCircle className="size-4 shrink-0 animate-spin text-primary" /><span className="min-w-0 truncate">{job.status === 'cancelling' ? 'Stopping…' : rev.message || 'Job queued'}</span><span className="w-[90px] shrink-0" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(rev.progress, 99)}><Progress value={Math.min(rev.progress, 99)} /></span><span className="min-w-[30px] text-right text-2xs text-muted-foreground tabular-nums">{Math.min(rev.progress, 99)}%</span>
                  {job.kind !== 'import' && can('drawing.edit') && job.status !== 'cancelling' && <Button type="button" variant="outline" size="xs" className="flex-none rounded-full border-destructive/30 text-destructive hover:bg-danger-soft hover:text-destructive" title="Stop this run — parts not reached yet keep their current drawings" onClick={async () => {
                    if ((await ask({ title: 'Stop drawing generation?', message: 'Parts already being drawn by this run are marked for regeneration; the others keep their current drawings.', confirm: 'Stop', danger: true })) === null) return;
                    try { await api(`/jobs/${job.id}/cancel`, 'POST'); await loadRevision(rev.id); } catch (e: unknown) { notify((e as Error).message); }
                  }}><X />Stop</Button>}</div>}
                {!job && rev.jobs?.[0]?.status === 'cancelled' && dismissedJob !== rev.jobs[0].id && <div className="fixed bottom-[84px] left-1/2 z-[150] flex max-w-[min(620px,90vw)] -translate-x-1/2 items-center gap-2.5 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning shadow-pop [&>svg]:shrink-0"><Info className="size-4" /><span>Generation stopped{rev.jobs[0].error ? ` (${rev.jobs[0].error.toLowerCase()})` : ''}. Parts it had started need Regenerate; the others kept their drawings.</span><Button type="button" variant="ghost" size="icon-xs" className="text-warning hover:bg-warning/10 hover:text-warning" aria-label="Dismiss" onClick={() => setDismissedJob(rev.jobs[0].id)}><X /></Button></div>}
                {!job && rev.jobs?.[0]?.status === 'failed' && rev.jobs[0].kind !== 'import' && <div className={cn(banner, 'bg-danger-soft text-destructive')}>{rev.jobs[0].kind === 'replace' ? 'Part replacement failed' : 'Document generation failed'}: {rev.jobs[0].error || 'Retry generation.'}</div>}
                {rev.status === 'failed' && <div className={cn(banner, 'bg-danger-soft text-destructive')}>Import failed: {rev.message}. The previous active revision is preserved.</div>}
                {rev.state === 'archived' && <div className={cn(banner, 'border-warning/30 bg-warning-soft text-warning')}><Archive className="size-4" />Archived revision — read-only design and historical documents. New production work should use the active released revision.</div>}

                {(tab === 'parts' || modelSeen.current === rev.id) && (
                  <div className={cn('grid min-h-0 flex-1 bg-background transition-[grid-template-columns] duration-200', cols, tab !== 'parts' && 'hidden')}>
                    <aside className={cn('flex min-h-0 flex-col border-r bg-card', !leftOpen && 'invisible overflow-hidden border-0')}>
                      {(() => {
                        const navMode = weldView && (rev?.weldments || []).length ? 'welds' : treeView && hasTree ? 'tree' : 'list';
                        const setNav = (m: string) => {
                          setWeldView(m === 'welds'); try { localStorage.setItem('forge-nav-weld', m === 'welds' ? '1' : '0'); } catch { /* ignore */ }
                          if (m !== 'welds') { setTreeView(m === 'tree'); try { localStorage.setItem('forge-nav-tree', m === 'tree' ? 'tree' : 'list'); } catch { /* ignore */ } }
                        };
                        const modes = [hasTree && ['tree', 'Tree', 'CAD assembly tree'], ['list', 'List', 'Flat list of part definitions'], (rev?.weldments || []).length > 0 && ['welds', 'Welds', 'Grouped by weld assembly']].filter(Boolean) as string[][];
                        return <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
                          <h3 className={cn('inline-flex min-w-0 items-center gap-1.5 truncate', eyebrow)}>{multi.length > 1 ? `${multi.length} selected` : 'Parts'}{multi.length < 2 && <span className="rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium tracking-normal tabular-nums">{parts.length}</span>}</h3>
                          {multi.length > 1 ? <Button type="button" variant="ghost" size="xs" onClick={() => choosePart(null)}><X />Clear</Button>
                            : modes.length > 1 && <Tabs value={navMode} onValueChange={setNav}><TabsList aria-label="Navigator view" className="h-7">{modes.map(([m, label, tip]) => <TabsTrigger key={m} value={m} title={tip} className="px-2 text-2xs">{label}</TabsTrigger>)}</TabsList></Tabs>}
                        </div>;
                      })()}
                      <div className="relative mx-2.5 mb-1.5"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" /><Input aria-label="Search parts" placeholder="Find a part…" className="h-[30px] bg-subtle pl-8 shadow-none" value={query} onChange={e => setQuery(e.target.value)} /></div>
                      <div className="mx-2.5 mb-1.5 flex items-center gap-1"><div className="min-w-0 flex-1"><Select size="sm" aria-label="Filter part type" value={category} onChange={value => { setCategory(value); choosePart(null); }} options={[
                        { value: 'all', label: 'All part types', hint: String(parts.length) },
                        ...Object.entries(categories).map(([k, v]) => ({ value: k, label: v, hint: String(parts.filter((p: Any) => p.category === k).length) })),
                        { value: 'hidden', label: 'Hidden in viewer', hint: String(hiddenIds.length) },
                        { value: 'excluded', label: 'Not for production', hint: String(parts.filter((p: Any) => p.excluded).length) },
                      ]} /></div>
                        {editable && <Tip label="Make many parts production ready (all sheet metal, all machining or the selection)"><Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Make many parts production ready" onClick={() => setBulkReady(true)}><ListChecks /></Button></Tip>}</div>
                      <Button variant="outline" className={cn('mx-1.5 mb-1 h-auto justify-start gap-2.5 bg-subtle px-2.5 py-1.5 text-left font-medium shadow-none', !selected && 'border-primary/30 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground')} onClick={() => choosePart(null)}>
                        <Layers className="size-[18px]" /><span className="grid">Complete assembly<span className="text-2xs font-normal text-muted-foreground">{rev.manifest.occurrences || 0} body instances</span></span>
                      </Button>
                      <div className="min-h-0 flex-1 overflow-y-auto" ref={listRef}>
                        {weldView && (rev.weldments || []).length ? renderWeldGroups() : treeView && hasTree ? renderTree(tree, 0) : filtered.map(renderRow)}
                        {!filtered.length && <p className="p-5 text-sm text-muted-foreground">{job ? 'Analyzing components…' : 'No matching parts.'}</p>}
                      </div>
                      <div className="flex items-center justify-between border-t px-3 py-2 text-2xs text-muted-foreground">{suppressedIds.length > 0 ? <Button type="button" variant="link" size="xs" className="h-auto gap-1 p-0 text-2xs font-normal has-[>svg]:px-0" title={showHidden ? 'Hide purchased and hidden parts again' : 'Show purchased and hidden parts in the viewer'} onClick={() => setShowHidden(!showHidden)}>{showHidden ? <EyeOff /> : <Eye />}{showHidden ? 'Hide' : 'Show'} {suppressedIds.length} hidden</Button> : <span title="Shift-click selects a range, Ctrl/Cmd-click toggles">⇧ range · ⌘ toggle</span>}<span className="tabular-nums" title="Parts production ready (design review + drawing review + specification complete)">{readyCount}/{releaseParts.length} ready</span></div>
                    </aside>

                    <div className="@container/canvas relative flex min-h-0 min-w-0 flex-col bg-viewer">
                      {rev.status !== 'processing' && rev.status !== 'failed' ? (
                        mode === 'flat2d' && part ? (
                          <FlatPattern partId={part.id} thickness={part.geometry.thickness} kFactor={part.spec.k_factor} approved={!!part.spec.k_factor_approved} name={part.name} />
                        ) : (
                          <Viewer
                            url={mode === 'flat3d' && part ? `${rev.id}:flat.glb:${part.id}:${part.version?.active || 1}` : `${rev.id}:assembly.glb::${modelStamp}`}
                            viewKey={project ? `forge-view:${project.id}` : undefined}
                            hud={canvasHud}
                            toolbarStart={canvasToolsStart}
                            toolbarEnd={canvasToolsEnd}
                            corner={canvasCorner}
                            pickMode={jointDraft && !addingParts ? pickMode : null}
                            jointPreview={weldDraftPreview}
                            welds={mode === '3d' ? savedWelds : []}
                            onWeldClick={id => { const j = (rev.joints || []).find((x: Any) => x.id === id); if (!j || jointDraft) return; editWeld(j); }}
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
                            realistic={prefs.realistic}
                            onRealistic={v => setPrefs({ realistic: v })}
                            studio={prefs.studio}
                            onStudio={v => setPrefs({ studio: v })}
                            transparentIds={transparentIds}
                            command={viewCmd}
                            appearance={appearance}
                            hidden={canvasHiddenIds}
                            multi={jointDraft ? (jointDraft.parts || []) : multi}
                            focusIds={weldFocusIds}
                            representativeOccurrences={isolate && selected && solo !== null && !jointDraft ? { ...weldRepresentatives, [selected]: solo } : weldRepresentatives}
                            feature={mode === '3d' ? feature : null}
                            issues={mode === '3d' && part && flatIssues.length ? { partId: part.id, items: flatIssues, active: flatHover, focus: flatPin } : null}
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
                        <div className="flex min-h-[370px] flex-1 flex-col items-center justify-center gap-3.5 bg-viewer px-6 py-16 text-center text-muted-foreground">
                          <div className="m-2.5 grid size-[140px] place-items-center rounded-full border border-dashed border-input text-faint"><Box className="size-[72px]" strokeWidth={1.25} /></div>
                          <h2 className="text-xl font-semibold text-foreground">{rev.status === 'failed' ? 'CAD import needs attention' : 'Reading your design'}</h2>
                          <p className="max-w-[550px]">{rev.message}</p>
                          <small className="text-xs text-faint">Geometry processing runs independently of the website.</small>
                        </div>
                      )}
                    </div>

                    <aside className={cn('flex min-h-0 flex-col border-l bg-card', !rightOpen && 'invisible overflow-hidden border-0')}>
                      {jointDraft ? (
                        <JointPanel draft={jointDraft} setDraft={d => { setWeldPreviewStatus(null); setJointDraft(d); }} parts={parts} options={jointOptions} pickMode={pickMode} setPickMode={setPickMode} busy={busy} previewStatus={weldPreviewStatus}
                          studio={{ seams: seamsTagged, detecting, detectMessage, onDetect: () => detectSeams(jointDraft, !(jointDraft.faces || []).length), hoverSeam, setHoverSeam, addingParts, setAddingParts, seamSide, setSeamSide }}
                          onCancel={endWeld}
                          onSave={() => action(async () => {
                            const body = { kind: jointDraft.kind, parts: jointDraft.parts, faces: jointDraft.faces, weld: jointDraft.kind === 'weld' ? jointDraft.weld : {}, fasteners: jointDraft.fasteners || '', torque: jointDraft.torque || '', sequence: Number(jointDraft.sequence || 0), notes: jointDraft.notes || '', name: jointDraft.name || '' };
                            if (jointDraft.id) await api('/joints/' + jointDraft.id, 'PUT', body); else await api(`/revisions/${rev.id}/joints`, 'POST', body);
                            endWeld(); await refreshJoints(rev.id); notify('Weld saved — it now shows on the model.');
                          })} />
                      ) : multi.length > 1 ? (
                        <GroupPanel templates={templates.filter((t: Any) => t.kind === 'process')} onProcess={tid => action(async () => { await api(`/revisions/${rev.id}/parts/process-template`, 'POST', { ids: multi, template_id: tid }); await loadRevision(rev.id); notify('Process template applied'); })}
                          onJoint={() => startWeld([...multi])} parts={parts.filter((p: Any) => multi.includes(p.id))} vendor={vendor} editable={editable} busy={busy}
                          onEdit={() => { setEditing({ group: parts.filter((p: Any) => multi.includes(p.id)) }); setModal('group-spec'); }} onReady={() => setBulkReady(true)}
                          onBulk={bulk} onExclude={() => setExcluding(parts.filter((p: Any) => multi.includes(p.id)))} onRemove={id => { const next = multi.filter(x => x !== id); setMulti(next); if (selected === id) setSelected(next[next.length - 1] || null); }}
                          onFocus={id => setSelected(id)} onClear={() => choosePart(null)} />
                      ) : part ? (() => {
                        const canCost = !vendor && ['joborder.create', 'pricing.manage'].some(k => (project?.permissions || []).includes(k));
                        const openFindings = selectedFindings.filter((f: Any) => f.severity === 'blocker' && !f.waiver);
                        const specDone = openFindings.length === 0;
                        const ready = partReady(part);
                        const path = part.assembly_path || [];
                        const asmKey = path.join(' / ');
                        const siblings = path.length ? parts.filter((p: Any) => (p.assembly_path || []).slice(0, path.length).join(' / ') === asmKey) : [];
                        const differ = siblings.filter((p: Any) => p.category !== part.category);
                        const missing = (k: string) => editable ? <Button type="button" variant="outline" size="xs" className="h-5 border-dashed px-2 text-2xs text-primary shadow-none hover:border-primary hover:bg-transparent hover:text-primary" onClick={() => setReadyFor(part.id)}>Add</Button> : <span className="text-muted-foreground">—</span>;
                        const row = (label: string, value: Any, opt = false) => (opt && !value) ? null : <div className={kv} key={label}><span className="shrink-0 text-muted-foreground">{label}</span><span className={kvValue}>{value || missing(label)}</span></div>;
                        const card = 'mx-4 mb-3 flex gap-2.5 rounded-lg border p-3';
                        const cardText = 'mt-0.5 mb-2 text-xs leading-relaxed text-muted-foreground';
                        const section = 'grid';
                        const sectionTitle = cn('mb-1 flex items-center justify-between', eyebrow);
                        const linkBtn = 'h-auto p-0 text-xs font-medium normal-case tracking-normal has-[>svg]:px-0';
                        const step = (done: boolean) => cn('flex items-center gap-1.5 text-2xs whitespace-nowrap', done ? 'text-foreground' : 'text-muted-foreground');
                        const stepDot = (done: boolean) => cn('grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] text-[10px] font-medium not-italic', done ? 'border-success bg-success text-white' : 'text-muted-foreground');
                        const propRow = 'grid grid-cols-[74px_1fr] items-center gap-2 text-sm font-normal';
                        const fileBtn = 'h-auto w-full justify-start gap-2.5 rounded-none border-b px-3 py-2 text-left font-normal whitespace-normal last:border-b-0';
                        const ext = 'grid h-[22px] w-[34px] shrink-0 place-items-center rounded bg-muted text-[9.5px] font-medium uppercase text-muted-foreground';
                        return (
                        <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
                          <header className="flex items-start gap-2 px-4 pt-3.5 pb-2.5">
                            <div className="grid min-w-0 flex-1 gap-0.5">
                              <span className={cn('inline-flex items-center gap-1.5', eyebrow)}><span className={cn('grid size-5 place-items-center rounded-md', glyphTone[part.category] || glyphTone.other)} style={part.spec.coating_hex ? { background: part.spec.coating_hex, color: '#fff' } : undefined}>{part.category === 'sheet_metal' ? <Layers className="size-3.5" /> : <Box className="size-3.5" />}</span>{categories[part.category]}{part.geometry.carried_from && <span className="rounded-full bg-muted px-1.5 py-px font-normal normal-case tracking-normal" title="Carried over from an earlier revision">rev {part.geometry.carried_from.revision}</span>}</span>
                              <h2 className="truncate text-base font-semibold" title={part.name}>{part.name}</h2>
                              {(part.alias || (!vendor && can('part.edit'))) && <Button type="button" variant="outline" size="xs" className={cn('my-0.5 w-fit max-w-full self-start shadow-none disabled:opacity-100', part.alias ? 'border-primary/30 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground' : 'border-dashed bg-transparent font-normal text-muted-foreground')} disabled={vendor || !can('part.edit')} title={part.alias ? 'Alias — click to change' : 'Give this part a short, easy name'} onClick={() => editAlias(part)}><Tag />{part.alias || 'Add alias'}</Button>}
                              <small className="text-2xs text-muted-foreground tabular-nums">{part.id.slice(-10).toUpperCase()} · Qty {part.quantity}{part.geometry.mass_kg !== undefined ? ` · ${fmt(part.geometry.mass_kg)} kg` : ''}</small>
                            </div>
                            {!vendor && <DropdownMenu key={part.id} modal={false}>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More actions" title="More actions"><MoreHorizontal /></Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-[230px]">
                                <DropdownMenuItem onClick={() => { setFlags(part.id, { hidden: !part.hidden }); }}>{part.hidden ? <Eye /> : <EyeOff />}{part.hidden ? 'Show in viewer by default' : 'Hide in viewer by default'}</DropdownMenuItem>
                                {editable && !part.excluded && <DropdownMenuItem onClick={() => { setEditing(JSON.parse(JSON.stringify(part))); setModal('spec'); }}><Settings />All manufacturing details</DropdownMenuItem>}
                                {editable && !part.excluded && <DropdownMenuItem onClick={() => { startWeld([part.id]); }}><Flame />Weld this component</DropdownMenuItem>}
                                {editable && <DropdownMenuItem onClick={() => { addToSteps([part.id]); }}><ListPlus />Add as assembly step</DropdownMenuItem>}
                                {editable && <DropdownMenuItem disabled={!!part.version?.processing} onClick={() => setReplacing(part)}><Upload />Replace with STEP…</DropdownMenuItem>}
                                {(part.version?.count || 0) > 1 && <DropdownMenuItem onClick={() => setVersionsOf(part)}><History />Geometry versions…</DropdownMenuItem>}
                                {part.geometry.holes.length > 0 && <DropdownMenuItem onClick={() => { setHoleCfg(part.id); }}><CircleDot />Holes &amp; hardware…</DropdownMenuItem>}
                                {canBend(part) && <DropdownMenuItem onClick={() => { setBendSim(part.id); }}><FoldVertical />Bending simulation…</DropdownMenuItem>}
                                {editable && canBend(part) && <DropdownMenuItem onClick={() => { setBendSharing([part.id], part.bend_sim ? 'off' : 'on'); }}>{part.bend_sim ? <EyeOff /> : <Eye />}{part.bend_sim ? 'Stop sharing bending simulation' : 'Share bending simulation'}</DropdownMenuItem>}
                                {editable && canBend(part) && part.drawing_options?.bend_sim !== undefined && <DropdownMenuItem onClick={() => { setBendSharing([part.id], 'inherit'); }}><Undo2 />Bending simulation: use project default</DropdownMenuItem>}
                                {editable && (part.excluded
                                  ? <DropdownMenuItem onClick={() => { setFlags(part.id, { excluded: false }); }}><Undo2 />Restore to production</DropdownMenuItem>
                                  : <DropdownMenuItem variant="destructive" onClick={() => { setExcluding([part]); }}><Ban />Not for production…</DropdownMenuItem>)}
                              </DropdownMenuContent>
                            </DropdownMenu>}
                          </header>

                          {part.category === 'sheet_metal' && part.geometry.flat_status === 'needs_review' && !part.excluded && <FlatIssuesCard part={part} issues={flatIssues} active={flatHover} onActive={setFlatHover} pinned={flatPin} onPin={i => { setFlatPin(i); if (i !== null && mode !== '3d') setMode('3d'); }}
                            editable={editable} busy={busy || !!job} onRecheck={() => generate(part.id)} onReplace={() => setReplacing(part)} />}
                          {(() => { const wm = weldmentOf(part.id); if (!wm) return null; return (
                            <div className={card}><Flame className="mt-px size-4 flex-none text-pink-500" /><div className="min-w-0"><div className="text-sm font-medium">{wm.name}</div><p className={cardText}>Weld assembly · {wm.parts.length} part{wm.parts.length === 1 ? '' : 's'} · {(wm.welds || []).length} weld{(wm.welds || []).length === 1 ? '' : 's'}</p>
                              <div className="flex flex-wrap items-center gap-1.5"><Button type="button" variant="outline" size="xs" onClick={() => openWeldment(wm)}><Flame />Weld configuration</Button>
                                {!vendor && (project?.permissions || []).includes('joborder.create') && <Button type="button" variant="outline" size="xs" onClick={() => weldmentJobOrder(wm)}><ClipboardList />Job order</Button>}</div></div></div>); })()}
                          {part.excluded ? (
                            <div className={card}><Ban className="mt-px size-4 flex-none text-muted-foreground" /><div className="min-w-0"><div className="text-sm font-medium">Not for production</div><p className={cardText}>{(part.exclusion_reason || 'Excluded from this revision').replace(/[.]?$/, '.')} Skipped in release checks, drawing packs and the vendor checklist.</p>{editable && <Button type="button" variant="outline" size="xs" onClick={() => setFlags(part.id, { excluded: false })}><Undo2 />Restore</Button>}</div></div>
                          ) : noChecks(part) ? (
                            <div className={card}><Box className="mt-px size-4 flex-none text-muted-foreground" /><div className="min-w-0 flex-1"><div className="text-sm font-medium">{part.category === 'purchased' ? 'Purchased part' : 'Other part'}</div><p className={cardText}>{part.category === 'purchased' ? 'Bought complete — no checks or drawing release needed.' : 'No design checks or reviews needed for this part.'}</p>
                              {part.category === 'purchased' && <Label className="mb-2 cursor-pointer text-xs font-normal"><Switch checked={!!part.drawing_options?.assembly_show} disabled={busy || !editable} onCheckedChange={show => { action(async () => { await api(`/revisions/${rev.id}/parts/assembly-drawing`, 'POST', { ids: [part.id], show }); await loadRevision(rev.id); }); }} />Show on the assembly drawing</Label>}
                              {editable && <Button type="button" variant="outline" size="xs" className="text-destructive hover:bg-danger-soft hover:text-destructive" onClick={() => setExcluding([part])}><Ban />Not for production</Button>}</div></div>
                          ) : (
                            <div className={cn(card, 'flex-col bg-subtle', ready && 'border-success/40')}>
                              <div className="grid grid-cols-3 gap-1.5">
                                <span className={step(specDone)} title={specDone ? 'Specification complete' : `${openFindings.length} open specification items`}><i className={stepDot(specDone)}>{specDone ? <Check className="size-[11px]" /> : openFindings.length}</i>Spec</span>
                                <span className={step(!!part.reviewed)}><i className={stepDot(!!part.reviewed)}>{part.reviewed ? <Check className="size-[11px]" /> : '2'}</i>Design</span>
                                <span className={step(!!part.doc_reviewed)}><i className={stepDot(!!part.doc_reviewed)}>{part.doc_reviewed ? <Check className="size-[11px]" /> : '3'}</i>Drawing</span>
                              </div>
                              {editable ? <Button type="button" variant={ready ? 'outline' : 'default'} className={cn('w-full', ready && 'text-success hover:text-success')} onClick={() => setReadyFor(part.id)}>{ready ? <><CheckCircle2 />Production ready</> : <><Sparkles />Make production ready</>}</Button>
                                : <p className="flex items-center gap-1.5 text-xs leading-snug text-muted-foreground">{ready ? <><CheckCircle2 className="size-3.5 text-success" />Production ready</> : 'Engineering is still completing this part — manufacture only from released drawings.'}</p>}
                            </div>
                          )}

                          {editable && !part.excluded && <div className="grid gap-1.5 px-4 pb-3">
                            <Label className={propRow}><span className="text-muted-foreground">Type</span><Select size="sm" value={part.category} disabled={busy} onChange={v => action(async () => { if (v === part.category) return; await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: [part.id], category: v }); await loadRevision(rev.id); notify(`${part.name} is now ${categories[v]}`); })} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} /></Label>
                            <Label className={propRow}><span className="text-muted-foreground">Process</span><Select size="sm" value={part.process_template_id || ''} disabled={busy} onChange={v => action(async () => { await api(`/revisions/${rev.id}/parts/process-template`, 'POST', { ids: [part.id], template_id: v }); await loadRevision(rev.id); })} options={[{ value: '', label: 'Custom' }, ...templates.filter((t: Any) => t.kind === 'process').map((t: Any) => ({ value: t.id, label: t.name }))]} /></Label>
                            {siblings.length > 1 && <div className={propRow}><span className="text-muted-foreground">Assembly</span><div className="flex min-w-0 flex-wrap items-center gap-1.5"><Folder className="size-3.5 text-muted-foreground" /><span className="max-w-[130px] truncate font-medium" title={asmKey}>{path[path.length - 1]}</span><span className="text-xs text-muted-foreground">{siblings.length} parts</span>
                              <Button type="button" variant="link" size="xs" className={linkBtn} onClick={() => { setMulti(siblings.map((p: Any) => p.id)); setSelected(part.id); }}>Select</Button>
                              {differ.length > 0 && <Button type="button" variant="link" size="xs" className={linkBtn} disabled={busy} onClick={() => action(async () => { await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: siblings.map((p: Any) => p.id), category: part.category }); await loadRevision(rev.id); notify(`${path[path.length - 1]}: ${siblings.length} parts are now ${categories[part.category]}`); })}>Make all {categories[part.category].toLowerCase()}</Button>}</div></div>}
                          </div>}
                          {!vendor && <CadSourceRow part={part} editable={editable} busy={busy || !!job} onReplace={() => setReplacing(part)} onHistory={() => setVersionsOf(part)} />}

                          <Tabs value={detail} onValueChange={setDetail} className="sticky top-0 z-10 gap-0 bg-card px-4 pt-1 pb-0.5">
                            <TabsList className="w-full">{[['details', 'Details'], ['features', `Features${part.geometry.holes.length + part.geometry.bends.length ? ' ' + (part.geometry.holes.length + part.geometry.bends.length) : ''}`], ['documents', 'Documents'], ...(canCost && !part.excluded && part.category !== 'purchased' ? [['cost', 'Cost']] : [])].map(([t, l]) => <TabsTrigger key={t} value={t} className="text-xs">{l}</TabsTrigger>)}</TabsList>
                          </Tabs>

                          <div className="grid flex-none content-start gap-3.5 px-4 pt-3 pb-5">
                            {detail === 'details' ? (
                              <>
                                <div className="grid grid-cols-3 gap-1.5">{['X', 'Y', 'Z'].map((a, i) => <div key={a} className="flex items-baseline gap-1.5 rounded-md border px-2 py-1.5"><span className="text-2xs font-medium text-muted-foreground">{a}</span><span className="text-sm tabular-nums">{fmt(part.geometry.dimensions[i])}<small className="text-2xs text-muted-foreground"> mm</small></span></div>)}</div>
                                <section className={section}>
                                  <h4 className={sectionTitle}>Specification{editable && !part.excluded && <Button type="button" variant="link" size="xs" className={linkBtn} onClick={() => { setEditing(JSON.parse(JSON.stringify(part))); setModal('spec'); }}>Edit</Button>}</h4>
                                  {row('Material', part.spec.material)}
                                  {row('Process', part.spec.process)}
                                  {row('Finish', part.spec.finish)}
                                  {(part.spec.coating_color || part.spec.coating_hex) && <div className={kv}><span className="shrink-0 text-muted-foreground">Colour</span><span className={cn(kvValue, 'flex items-center justify-end gap-2')}>{part.spec.coating_hex && <Swatch hex={part.spec.coating_hex} />}{part.spec.coating_color || part.spec.coating_hex}</span></div>}
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
                                <section className={section}>
                                  <h4 className={sectionTitle}>Geometry</h4>
                                  <div className={kv}><span className="shrink-0 text-muted-foreground">Solid</span><span className={cn(kvValue, part.geometry.valid ? 'text-success' : 'text-destructive')}>{part.geometry.valid ? 'Valid' : 'Invalid — repair in CAD'}</span></div>
                                  {part.geometry.thickness > 0 && <div className={kv}><span className="shrink-0 text-muted-foreground">Thickness</span><span className={kvValue}>{fmt(part.geometry.thickness)} mm</span></div>}
                                  {part.geometry.mass_kg !== undefined && <div className={kv}><span className="shrink-0 text-muted-foreground">Mass</span><span className={kvValue}>{fmt(part.geometry.mass_kg)} kg <small className="text-muted-foreground">{part.geometry.mass_basis}</small></span></div>}
                                  {part.geometry.step && Object.keys(part.geometry.step).length > 0 && <div className={kv}><span className="shrink-0 text-muted-foreground">From STEP</span><span className={cn(kvValue, 'flex items-center justify-end gap-2')}>{part.geometry.step.color && <Swatch hex={part.geometry.step.color} title="CAD appearance" />}{[part.geometry.step.material, part.geometry.step.density && part.geometry.step.density + ' g/cm³'].filter(Boolean).join(' · ') || 'appearance only'}</span></div>}
                                  <div className={kv}><span className="shrink-0 text-muted-foreground">Classified by</span><span className={kvValue}>{part.geometry.classification_confidence}</span></div>
                                  {part.category === 'sheet_metal' && <div className={kv}><span className="shrink-0 text-muted-foreground">Flat pattern</span><span className={cn(kvValue, part.geometry.flat_status === 'supported' ? 'text-success' : 'text-destructive')}>{part.geometry.flat_status === 'supported' ? 'Available' : 'Not developed'}</span></div>}
                                  {canBend(part) && <div className={kv}><span className="shrink-0 text-muted-foreground">Bending simulation</span><span className={cn(kvValue, 'flex items-center justify-end gap-2')}>{part.bend_sim ? 'Shared' : 'Not shared'}{showBend(part) && <Button type="button" variant="outline" size="xs" onClick={() => setBendSim(part.id)}><FoldVertical />Play</Button>}</span></div>}
                                </section>
                                {part.spec.operations?.length > 0 && <section className={section}><h4 className={sectionTitle}>Process steps</h4><ol className="m-0 grid list-decimal gap-1 pl-[18px] text-sm">{part.spec.operations.map((o: Any, i: number) => <li key={i}><span className="font-medium">{typeof o === 'string' ? o : o.name}</span>{o.detail && <small className="block text-xs text-muted-foreground">{o.detail}</small>}</li>)}</ol></section>}
                                {part.spec.notes && <section className={section}><h4 className={sectionTitle}>Notes</h4><p className="text-sm whitespace-pre-wrap">{part.spec.notes}</p></section>}
                                {part.geometry.carried_from && <p className="text-2xs leading-relaxed text-muted-foreground">{part.geometry.carried_from.same_shape ? `Carried over from rev ${part.geometry.carried_from.revision} (identical shape) — re-approve for this revision.` : `Carried over from rev ${part.geometry.carried_from.revision}; shape changed, feature limits were reset.`}</p>}
                              </>
                            ) : detail === 'cost' && canCost ? (
                              <PartCost part={part} />
                            ) : detail === 'features' ? (
                              <>
                                {part.geometry.holes.length > 0 && part.category !== 'purchased' && <Button type="button" variant="outline" className="w-full border-primary/30 bg-selection text-selection-foreground hover:bg-selection/70 hover:text-selection-foreground" onClick={() => setHoleCfg(part.id)}><CircleDot />Configure holes &amp; hardware</Button>}
                                {part.geometry.holes.length > 0 && <section className={section}><h4 className={sectionTitle}>Bores · {part.geometry.holes.length}</h4>{part.geometry.holes.map((h: Any) => (
                                  <div className={cn('flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent', feature?.id === h.id && 'bg-accent')} key={h.id} onMouseEnter={() => setFeature({ kind: 'hole', partId: part.id, ...h })} onMouseLeave={() => setFeature(null)}><span className="min-w-[30px] font-mono text-2xs font-medium text-primary">{h.id}</span><span className="grid text-sm"><span className="font-medium">Ø {fmt(h.diameter)}</span><small className="text-2xs text-muted-foreground">{fmt(h.depth)} mm deep · {part.spec.feature_specs?.[h.id]?.hardware?.name || part.spec.feature_specs?.[h.id]?.designation || 'no hardware'}</small></span></div>
                                ))}</section>}
                                {part.geometry.bends.length > 0 && <section className={section}><h4 className={sectionTitle}>Bends · {part.geometry.bends.length}</h4>{part.geometry.bends.map((b: Any) => (
                                  <div className={cn('flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent', feature?.id === b.id && 'bg-accent')} key={b.id} onMouseEnter={() => setFeature({ kind: 'bend', partId: part.id, ...b })} onMouseLeave={() => setFeature(null)}><span className="min-w-[30px] font-mono text-2xs font-medium text-primary">{b.id}</span><span className="grid text-sm"><span className="font-medium">{fmt(b.angle)}° · R{fmt(b.radius)}</span><small className="text-2xs text-muted-foreground">{fmt(b.length)} mm long</small></span></div>
                                ))}</section>}
                                {!part.geometry.holes.length && !part.geometry.bends.length && <p className="text-2xs leading-relaxed text-muted-foreground">No bores or bends recognised on this part.</p>}
                                <p className="text-2xs leading-relaxed text-muted-foreground">Hover a feature to find it on the model.</p>
                              </>
                            ) : (
                              <>
                                <div className="flex items-center justify-between gap-2.5 rounded-lg border px-3 py-2.5">
                                  <div className="flex min-w-0 items-center gap-2.5"><FileText className="size-[18px] shrink-0 text-primary" /><span className="grid text-sm"><span className="font-medium">Drawing</span><small className={cn('text-2xs', part.doc_reviewed ? 'text-success' : 'text-muted-foreground')}>{part.doc_reviewed ? `Reviewed by ${part.doc_reviewed_by}` : part.assets.includes('drawing.pdf') ? 'Not reviewed yet' : 'Not generated yet'}</small></span></div>
                                  {part.assets.includes('drawing.pdf') && <Button type="button" size="sm" onClick={() => setDrawingPart(part.id)}>Open editor</Button>}
                                </div>
                                {editable && can('drawing.edit') && <div className="grid gap-1.5"><Label className={propRow}><span className="text-muted-foreground">Sheet</span><Select size="sm" value={part.drawing_options?.template_id || part.drawing_options?.size || ''} disabled={busy || !!job} onChange={v => action(async () => {
                                  const isTpl = templates.some((t: Any) => t.id === v);
                                  await api(`/revisions/${rev.id}/parts/drawing-options`, 'POST', { ids: [part.id], template_id: isTpl ? v : '', size: isTpl ? '' : v });
                                  await loadRevision(rev.id); notify('Regenerating the drawing with the new sheet…');
                                })} options={[{ value: '', label: 'Project default' }, { value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'A2', label: 'A2' }, ...templates.filter((t: Any) => t.kind === 'drawing').map((t: Any) => ({ value: t.id, label: t.name, hint: 'template' }))]} /></Label></div>}
                                <section className={section}>
                                  <h4 className={sectionTitle}>Files</h4>
                                  <div className="grid overflow-hidden rounded-lg border">{[['drawing.pdf', 'Drawing', 'PDF', true], ['drawing.dxf', 'Drawing', 'DXF · editable', false], ['review.pdf', 'Engineering review', 'PDF', true], ['flat.dxf', 'Flat pattern', 'DXF', false], ['part.step', 'Part model', 'STEP', false]].filter(([file]: Any) => !['drawing.dxf', 'flat.dxf', 'part.step'].includes(file) || can('cad.download')).filter(([file]: Any) => file !== 'flat.dxf' || part.category === 'sheet_metal').map(([file, title, sub, previewable]: Any) => {
                                    const has = part.assets.includes(file);
                                    return <Button type="button" variant="ghost" className={fileBtn} key={file} disabled={!has} onClick={() => doc(`/parts/${part.id}/assets/${file}`, part.name + '_' + file, title + ' — ' + part.name)}>
                                      <span className={ext}>{String(file).split('.').pop()}</span><span className="grid flex-1 text-sm"><span>{title}</span><small className="text-2xs text-muted-foreground">{has ? sub : 'Not generated'}</small></span>{has && (previewable ? <Eye className="text-muted-foreground" /> : <Download className="text-muted-foreground" />)}
                                    </Button>;
                                  })}
                                    {(() => { const has = part.assets.includes('drawing.pdf'); return <>
                                      <Button type="button" variant="ghost" className={fileBtn} disabled={!has} onClick={() => doc(`/parts/${part.id}/inspection.pdf`, part.name + '_inspection.pdf', 'Inspection drawing — ' + part.name)}>
                                        <span className={ext}>pdf</span><span className="grid flex-1 text-sm"><span>Inspection drawing</span><small className="text-2xs text-muted-foreground">{has ? 'Ballooned · characteristics' : 'Not generated'}</small></span>{has && <Eye className="text-muted-foreground" />}</Button>
                                      <Button type="button" variant="ghost" className={fileBtn} disabled={!has} onClick={() => doc(`/parts/${part.id}/characteristics.csv`, part.name + '_characteristics.csv')}>
                                        <span className={ext}>csv</span><span className="grid flex-1 text-sm"><span>Characteristics</span><small className="text-2xs text-muted-foreground">{has ? 'Inspection plan' : 'Not generated'}</small></span>{has && <Download className="text-muted-foreground" />}</Button></>; })()}
                                  </div>
                                </section>
                                {!vendor && <Button type="button" variant="outline" size="sm" className="w-full" disabled={!!job || rev.status !== 'ready'} onClick={() => generate(part.id)}><RefreshCw className={job ? 'animate-spin' : ''} />{job ? 'Generating…' : 'Regenerate documents'}</Button>}
                              </>
                            )}
                          </div>
                        </div>
                        );
                      })(
                      ) : (
                        <>
                          <div className="px-4 pt-3 pb-2.5"><span className="block text-2xs font-medium tracking-wider text-faint">REVISION OVERVIEW</span><h2 className="mt-2 mb-1 text-base font-semibold [overflow-wrap:anywhere]">Design to delivery</h2><p className="text-xs text-muted-foreground">Every manufacturing decision stays with this revision.</p></div>
                          <div className="flex-1 overflow-auto px-4 pt-3 pb-5">
                            <div className="grid grid-cols-2 gap-2.5"><div className="rounded-lg border bg-subtle px-3 py-3.5"><span className="block text-2xl font-semibold tabular-nums">{parts.length}</span><span className="text-xs text-muted-foreground">Part definitions</span></div><div className="rounded-lg border bg-subtle px-3 py-3.5"><span className="block text-2xl font-semibold tabular-nums">{holes}</span><span className="text-xs text-muted-foreground">Named bores</span></div></div>
                            <div className="mt-1.5 mb-3.5">{Object.entries(categories).map(([k, v]) => <div key={k} className={kv}><span className="flex items-center gap-2 text-muted-foreground"><Swatch hex={categoryColors[k]} /> {v}</span><span className={cn(kvValue, 'font-medium tabular-nums')}>{parts.filter((p: Any) => p.category === k).length}</span></div>)}</div>
                            <div className="my-3.5 flex gap-2.5 rounded-lg border border-warning/30 bg-warning-soft p-3 text-warning"><ShieldCheck className="size-5 shrink-0" /><div><div className="text-sm font-medium">{blocking} release blockers</div><p className="mt-0.5 text-sm leading-relaxed">Includes missing specifications and manual engineering checks.</p></div></div>
                            <h4 className={cn('mb-2', eyebrow)}>Drawing sets</h4>
                            {[['machining-drawings.pdf', 'All machining drawings', 'One PDF · every machined part'], ['sheet-metal-drawings.pdf', 'All sheet-metal drawings', 'One PDF · flat patterns and bend tables'], ['assembly.pdf', 'Assembly & mating record', 'PDF · assembly view and fits']].map(([file, title, sub]) => (
                              <Button variant="outline" className="mb-2 h-auto w-full justify-between gap-3 p-3 text-left font-normal whitespace-normal text-muted-foreground shadow-none" key={file} disabled={!rev.assets?.includes(file)} onClick={() => doc(`/revisions/${rev.id}/assets/${file}`, file, title)}><Files className="size-[22px]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{title}</span><span className="mt-0.5 block text-2xs">{rev.assets?.includes(file) ? sub : 'Generate the manufacturing pack first'}</span></span><Eye /></Button>
                            ))}
                            {!vendor && <div className="mt-1 grid gap-2">
                              <Button className="w-full" disabled={!!job || rev.status !== 'ready'} onClick={() => generate()}><FileText />Generate manufacturing pack</Button>
                              <Button variant="outline" className="w-full" disabled={rev.status !== 'ready' || !!job} onClick={() => action(async () => { setRelease(await api(`/revisions/${rev.id}/release-check`)); setModal('release'); })}><ShieldCheck />Production readiness</Button>
                              {editable && <Button variant="outline" className="w-full" title="Re-run make/buy name rules and hide small bought-in items on parts you have not classified yet" onClick={() => action(async () => { const r = await api(`/revisions/${rev.id}/reclassify`, 'POST'); await loadRevision(rev.id); notify(`Re-classified ${r.recategorised} parts, hid ${r.hidden} bought-in items. Reviewed parts were left alone.`); })}><RefreshCw />Re-run classification</Button>}
                            </div>}
                            <div className="my-3.5 flex gap-2.5 rounded-lg border bg-subtle p-3 text-muted-foreground"><Palette className="size-[18px] shrink-0" /><p className="text-sm leading-relaxed">Parts are coloured by their specified coating colour; uncoated parts use a neutral tone per category. Pick a part in the viewer or navigator to inspect it.</p></div>
                          </div>
                        </>
                      )}
                    </aside>
                  </div>
                )}

                {tab === 'rules' && <DesignChecks parts={parts} onWizard={id => setReadyFor(id)} onOpen={id => { choosePart(id); setTab('parts'); }} onRules={() => setModal(project && (project.permissions || []).includes('project.settings') ? 'project-settings' : 'rules')} />}

                {tab === 'joborders' && !vendor && project && (
                  rev.status !== 'released' && !project.revisions.some((r: Any) => r.status === 'released')
                    ? <section className={pageWrap}><div className={notice}><ShieldCheck className="size-4" /><span>Job orders open once a revision is production ready: every part design-reviewed and drawing-reviewed, all design checks covered, then <b>Release</b> in the revision overview.</span></div><JobOrdersPage projects={projects} projectId={project.id} ctx={{ busy, action, notify }} perms={new Set(project.permissions || [])} openJobOrder={openJobOrder} /></section>
                    : <JobOrdersPage projects={projects} projectId={project.id} ctx={{ busy, action, notify }} perms={new Set(project.permissions || [])} openJobOrder={openJobOrder} />
                )}

                {(tab === 'assembly' || tab === 'steps') && <div className="flex h-[calc(100vh-48px)] min-h-0 flex-col">
                  <Tabs value={asmView} onValueChange={v => setAsmView(v as 'steps' | 'welds')} className="mx-3 mt-3 self-start">
                    <TabsList>
                      <TabsTrigger value="steps" className="px-2.5 text-xs"><ListOrdered className="size-3.5" />Build steps</TabsTrigger>
                      <TabsTrigger value="welds" className="px-2.5 text-xs"><Flame className="size-3.5" />Weld assemblies <span className="font-normal text-muted-foreground tabular-nums">{(rev.weldments || []).length}</span></TabsTrigger>
                    </TabsList>
                  </Tabs>
                {asmView === 'steps' ? <AssemblySteps page revision={rev.id} parts={parts} editable={editable} navStyle={prefs.navStyle} addParts={stepsAdd?.ids} addKey={stepsAdd?.n} close={() => setTab('parts')} /> : (
                  <section className={cn(pageWrap, 'min-h-0 flex-1 overflow-auto')}>
                    <div className={pageTitle}>
                      <div><h2 className="text-xl font-semibold">Weld assemblies</h2><p className="mt-1 text-sm text-muted-foreground">Each weld assembly is a set of parts welded into one unit. Open one to add or remove its welds; select a part in the model to see its assembly.</p></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" onClick={() => doc(`/revisions/${rev.id}/assets/assembly.pdf`, 'assembly.pdf', 'Assembly & mating record')}><Eye />Assembly document</Button>
                        <JobDocButton key={(rev.joints || []).map((j: Any) => j.id + j.updated).join()} revision={rev.id} kind="welding" label="Welding document" icon={<Flame size={16} />} notify={notify}
                          disabled={!(rev.joints || []).some((j: Any) => j.kind === 'weld')} open={path => doc(path, 'welding.pdf', 'Welding document')} />
                        {editable && <Button variant="outline" onClick={() => { if (!multi.length && !selected) { setTab('parts'); notify('Select the parts to weld in the model (Ctrl/⌘-click for several), then Weld.'); return; } startWeld(multi.length ? [...multi] : [selected!]); }}><Plus />New weld assembly</Button>}
                      </div>
                    </div>
                    <WeldAssemblies weldments={rev.weldments || []} parts={parts} editable={editable} canJobOrder={!vendor && (project?.permissions || []).includes('joborder.create')}
                      onOpen={openWeldment} onJobOrder={weldmentJobOrder}
                      onSelect={w => { setTab('parts'); setMulti(w.parts); setSelected(w.parts[0] || null); setIsolate(true); }}
                      onDelete={async w => { if (await ask({ title: `Delete ${w.name}?`, message: `The weld assembly and its ${(w.welds || []).length} weld(s) are removed. The parts stay.`, confirm: 'Delete', danger: true }) === null) return; action(async () => { await api('/weldments/' + w.id, 'DELETE'); await refreshJoints(rev.id); notify('Weld assembly deleted'); }); }} />
                    {(rev.joints || []).some((j: Any) => j.kind !== 'weld') && <JointCards joints={(rev.joints || []).filter((j: Any) => j.kind !== 'weld')} parts={parts} editable={editable}
                      onEdit={j => { setTab('parts'); editWeld(j); }}
                      onDelete={async j => { if (await ask({ title: 'Delete this joint?', confirm: 'Delete', danger: true }) === null) return; setRev((r: Any) => r && { ...r, joints: (r.joints || []).filter((x: Any) => x.id !== j.id) }); api('/joints/' + j.id, 'DELETE').catch(fail).finally(() => refreshJoints(rev.id).catch(fail)); }} />}
                  </section>
                )}
                </div>}

                {tab === 'production' && (
                  <section className={pageWrap}>
                    <div className={pageTitle}>
                      <div><h2 className="text-xl font-semibold">Production checklist</h2><p className="mt-1 text-sm text-muted-foreground">{vendor ? 'Tick each item as it is produced; quantities and remarks are recorded against this revision.' : 'Shared with vendors through the review link. Parts marked not for production are left out.'}</p></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" onClick={() => doc(`/revisions/${rev.id}/assets/machining-drawings.pdf`, 'machining-drawings.pdf', 'All machining drawings')} disabled={!rev.assets?.includes('machining-drawings.pdf')}><Files />Machining set</Button>
                        <Button variant="outline" onClick={() => doc(`/revisions/${rev.id}/assets/sheet-metal-drawings.pdf`, 'sheet-metal-drawings.pdf', 'All sheet-metal drawings')} disabled={!rev.assets?.includes('sheet-metal-drawings.pdf')}><Files />Sheet-metal set</Button>
                      </div>
                    </div>
                    {rev.status !== 'released' && <div className={notice}><ShieldCheck className="size-4" />This revision is not released yet — quantities recorded here are for planning; manufacture only from released documents.</div>}
                    <ProductionChecklist parts={parts} rows={related} busy={busy} canEdit={!vendor && can('joborder.update')}
                      onPreview={p => doc(`/parts/${p.id}/assets/drawing.pdf`, p.name + '_drawing.pdf', 'Drawing sheet — ' + p.name)}
                      onSave={async (pid, r) => { await action(async () => { await api(`/revisions/${rev.id}/production/${pid}`, 'PUT', r); await refreshRelated('production'); }); }} />
                  </section>
                )}

                {tab === 'review' && (
                  <section className={pageWrap}>
                    <div className={pageTitle}><div><h2 className="text-xl font-semibold">Review together</h2><p className="mt-1 text-sm text-muted-foreground">Questions and decisions tied to parts, features and this exact revision.</p></div><Badge>{related.filter(r => !r.resolved).length} open threads</Badge></div>
                    {!vendor && <form className="grid gap-3 rounded-lg border bg-card p-5" onSubmit={e => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget); const form = e.currentTarget;
                      action(async () => { await api(`/revisions/${rev.id}/comments`, 'POST', { body: f.get('body'), part_id: f.get('part_id') || null, feature: f.get('feature') || '' }); form.reset(); await refreshRelated('comments'); });
                    }}>
                      <div className="flex gap-4 max-[560px]:flex-col">
                        <Label className={cn(field, 'flex-1')}>Part<Select name="part_id" defaultValue="" options={[{ value: '', label: 'Assembly / general' }, ...parts.map((p: Any) => ({ value: p.id, label: p.name }))]} /></Label>
                        <Label className={cn(field, 'flex-1')}>Feature reference<Input name="feature" placeholder="e.g. H003 or B001" /></Label>
                      </div>
                      <Textarea name="body" required className="min-h-[90px]" placeholder="Ask a question, request a change, or record a review decision…" />
                      <Button className="justify-self-start" disabled={busy}><Send />Post review</Button>
                    </form>}
                    <div className="mt-6">
                      {related.map(c => (
                        <article key={c.id} className="flex gap-3 border-b py-5">
                          <Avatar name={c.author || '?'} size={32} />
                          <div className="min-w-0 flex-1">
                            <header className="mb-1 flex items-center gap-3"><span className="text-base font-medium">{c.author}</span><span className="text-xs text-muted-foreground">{date(c.created)}</span><Badge kind={c.resolved ? 'success' : 'warning'}>{c.resolved ? 'Resolved' : 'Open'}</Badge></header>
                            <small className="block text-xs text-muted-foreground">{parts.find((p: Any) => p.id === c.part_id)?.name || 'Assembly'} {c.feature && ' / ' + c.feature}</small>
                            <p className="mt-1 text-sm whitespace-pre-wrap">{c.body}</p>
                            {!vendor && !c.resolved && can('design.review') && <Button variant="outline" size="sm" className="mt-2" onClick={() => action(async () => { await api('/comments/' + c.id + '/resolve', 'POST'); await refreshRelated('comments'); })}><Check />Resolve</Button>}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {tab === 'qc' && <QualityPage rev={rev} vendor={!!vendor} can={can} action={fn => { void action(fn); }} notify={notify} doc={doc} onPlan={pid => { setBalloonMode(true); setDrawingPart(pid); }} />}

                {tab === 'audit' && (
                  <section className={pageWrap}>
                    <div className={pageTitle}><div><h2 className="text-xl font-semibold">Revision history</h2><p className="mt-1 text-sm text-muted-foreground">Uploads, specification changes, reviews, releases and measurements.</p></div></div>
                    <div className="mx-4 my-5 border-l-2">
                      {related.map(a => (
                        <div key={a.id} className="relative pb-6 pl-7">
                          <span className="absolute top-[5px] -left-[6px] size-2.5 rounded-full border-2 border-background bg-primary" />
                          <time className="text-xs text-muted-foreground">{date(a.created)} · {new Date(a.created).toLocaleTimeString()}</time>
                          <h3 className="mt-1.5 text-base font-semibold capitalize">{a.action.replaceAll('.', ' / ')}</h3><p className="text-sm">{a.actor}</p>
                          <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">Recorded detail</summary><pre className="mt-2 max-h-[300px] overflow-auto rounded-md border bg-card p-3.5 text-xs whitespace-pre-wrap">{JSON.stringify(JSON.parse(a.detail), null, 2)}</pre></details>
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

      {error && <div className="fixed bottom-6 left-1/2 z-[3200] flex max-w-[85vw] -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/20 bg-danger-soft px-4 py-3 text-sm text-destructive shadow-pop" role="alert"><AlertTriangle className="size-[18px] shrink-0" /><span className="max-h-[180px] overflow-auto">{error}</span><Button variant="ghost" size="icon-xs" className="text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label="Dismiss" onClick={() => setError('')}><X /></Button></div>}
      <DialogHost />
      <Toaster />
      {shortcutsOpen && <ShortcutsDialog {...prefsApi} close={() => setShortcutsOpen(false)} />}
      {bulkReady && rev && <BulkReady revision={rev.id} parts={parts} selection={multi.length > 1 ? multi : category === 'sheet_metal' || category === 'machining' ? parts.filter((p: Any) => p.category === category).map((p: Any) => p.id) : []}
        canDesign={can('design.review')} canDrawing={can('drawing.review')} close={() => setBulkReady(false)} done={() => loadRevision(rev.id)} />}
      {joSelection && project && <JobOrderDialog projects={projects} projectId={project.id} selection={joSelection} title={joTitle} ctx={{ busy, action, notify }} close={() => { setJoSelection(null); setJoTitle(''); }} onCreated={jo => { setJoSelection(null); setJoTitle(''); openJobOrder(jo.id); }} />}
      {bendSim && rev && parts.find((p: Any) => p.id === bendSim) && <PressBrake revision={rev.id} part={bendSim} name={parts.find((p: Any) => p.id === bendSim).name} navStyle={prefs.navStyle} canEdit={editable} close={() => setBendSim(null)} />}
      {holeCfg && rev && parts.find((p: Any) => p.id === holeCfg) && <HoleConfig part={parts.find((p: Any) => p.id === holeCfg)} revision={rev.id} editable={editable} navStyle={prefs.navStyle}
        close={changed => { setHoleCfg(null); if (changed) loadRevision(rev.id).catch(fail); }} />}
      {weldCfg && rev && <WeldConfig key={weldCfg.weldment?.id || weldCfg.parts.join()} revision={rev.id} partIds={weldCfg.parts} weldment={weldCfg.weldment} parts={parts} joints={rev.joints || []} editable={editable} navStyle={prefs.navStyle}
        canJobOrder={!vendor && (project?.permissions || []).includes('joborder.create')}
        onJobOrder={w => { setWeldCfg(null); refreshJoints(rev.id).catch(fail); weldmentJobOrder(w); }}
        close={() => { setWeldCfg(null); refreshJoints(rev.id).catch(fail); }} />}
      {replacing && project && <ReplaceDialog part={replacing} projectId={project.id} close={() => setReplacing(null)}
        onQueued={() => { notify(`Processing the new geometry for ${replacing.alias || replacing.name}…`); loadRevision(rev.id).catch(fail); }} />}
      {versionsOf && rev && (() => { const live = (rev.parts || []).find((p: Any) => p.id === versionsOf.id) || versionsOf; return <VersionsDialog part={live} editable={editable} canCad={can('cad.download')} busy={busy || !!job} close={() => setVersionsOf(null)}
        preview={(path, name, title) => doc(path, name, title)}
        onActivate={v => action(async () => { await api(`/parts/${live.id}/versions/${v.id}/activate`, 'POST'); await loadRevision(rev.id); notify(`Switching ${live.alias || live.name} to version ${v.number}…`); })} />; })()}
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
          {importingRevision ? <div className="grid gap-3" role="status" aria-live="polite">
            <h3 className="text-base font-semibold">Revision {importingRevision.number} is processing · {importingRevision.progress || 0}%</h3>
            <p className="text-sm">{importingRevision.message || 'Import queued'}</p>
            <span role="progressbar" aria-label="CAD import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={importingRevision.progress || 0}><Progress value={importingRevision.progress || 0} /></span>
            <p className="text-sm text-muted-foreground">Progress updates automatically. You can upload the next revision after this import finishes.</p>
            <ModalFooter><Button onClick={showImport}>View import progress</Button></ModalFooter>
          </div> : <form className="grid gap-4" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const file = f.get('file') as File; action(() => uploadFile(file, String(f.get('notes') || ''))); }}>
            <Label className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed border-input bg-subtle p-7 font-normal leading-normal text-muted-foreground"><Upload className="size-8" /><span className="text-lg font-semibold text-foreground">Choose your part or assembly</span><span className="text-sm">STEP · STP · BREP · IGES / up to 1 GB</span><Input name="file" type="file" accept=".step,.stp,.brep,.brp,.igs,.iges" required className="h-auto max-w-[320px] border-0 bg-transparent shadow-none dark:bg-transparent" /></Label>
            <Label className={field}>Revision notes<Textarea name="notes" placeholder="What changed in this version?" /></Label>
            <p className="text-sm text-muted-foreground">The previous revision stays active until this file processes successfully. No review approvals carry over automatically.</p>
            {uploadPercent !== null && <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPercent}><Progress value={uploadPercent} /></span>}
            <ModalFooter><Button disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Upload />}Upload & analyze {uploadPercent !== null && uploadPercent + '%'}</Button></ModalFooter>
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
          <div className="grid gap-3">
            <p className="text-sm">Read-only access for a vendor: 3D view, part details, drawings and the review thread of this revision. Vendors cannot edit, comment or record production.</p>
            {sharePath ? (
              <>
                <Label className={field}>Vendor review link<Input readOnly className="bg-subtle text-muted-foreground" value={location.origin + sharePath} onFocus={e => e.target.select()} /></Label>
                <p className="text-sm text-muted-foreground">This link stays pinned to revision {rev.number}. Treat it as a password.</p>
              </>
            ) : (
              <form id="share-form" className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { const s = await api(`/revisions/${rev.id}/shares`, 'POST', { label: f.get('label'), days: Number(f.get('days')), allow_cad: f.get('allow_cad') === 'on' }); setSharePath(s.path); }); }}>
                <Label className={field}>Vendor name<Input name="label" required placeholder="Vendor / reviewer" /></Label>
                <Label className={field}>Expires in<Select name="days" defaultValue="14" options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} /></Label>
                <Label className={checkRow}><Checkbox name="allow_cad" className="mt-0.5" />Allow DXF / STEP downloads (laser and CNC programming). 3D models are never downloadable.</Label>
              </form>
            )}
          </div>
          <ModalFooter>
            <Button variant="outline" onClick={() => action(async () => { setModalRows(await api(`/revisions/${rev.id}/shares`)); setModal('shares'); })}>Manage existing links</Button>
            {sharePath
              ? <Button onClick={() => action(async () => { await navigator.clipboard.writeText(location.origin + sharePath); notify('Link copied'); })}>Copy link</Button>
              : <Button type="submit" form="share-form" disabled={busy}><Link />Create read-only link</Button>}
          </ModalFooter>
        </Modal>
      )}

      {modal === 'shares' && (
        <Modal title="Vendor access links" close={() => setModal('')}>
          {modalRows.map(s => (
            <div className={docRow} key={s.id}>
              <div className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{s.label}</span><span className="mt-0.5 block text-2xs">Expires {date(s.expires)}{s.allow_cad ? ' · CAD downloads' : ' · view only'}</span></div>
              <Badge>{s.revoked ? 'Revoked' : 'Active'}</Badge>
              {!s.revoked && <Button variant="outline" size="sm" onClick={() => action(async () => { await api('/shares/' + s.id, 'DELETE'); setModalRows(await api(`/revisions/${rev.id}/shares`)); })}>Revoke</Button>}
            </div>
          ))}
        </Modal>
      )}

      {modal === 'fit' && editing && (
        <Modal title="Mating & fit specification" close={() => setModal('')}>
          <form className="grid gap-3" onSubmit={e => { e.preventDefault(); action(async () => { if (editing.id) await api('/fits/' + editing.id, 'PATCH', editing); else await api(`/revisions/${rev.id}/fits`, 'POST', editing); await refreshRelated('fits'); setModal(''); }); }}>
            <div className={formGrid}>
              {['part_a', 'part_b'].map(k => (
                <Label key={k} className={cn(field, 'capitalize')}>{k.replace('_', ' ')}
                  <Select disabled={!!editing.id} value={editing.data[k]} onChange={v => setEditing({ ...editing, data: { ...editing.data, [k]: v, [k + '_name']: parts.find((p: Any) => p.id === v)?.name } })} options={parts.map((p: Any) => ({ value: p.id, label: p.name }))} />
                </Label>
              ))}
              {['label', 'feature_a', 'feature_b', 'fit', 'torque', 'hole_min', 'hole_max', 'shaft_min', 'shaft_max'].map(k => (
                <Label key={k} className={cn(field, 'capitalize')}>{k.replaceAll('_', ' ')}<Input type={k.includes('_min') || k.includes('_max') ? 'number' : 'text'} step="any" value={editing.data[k] ?? ''} onChange={e => setEditing({ ...editing, data: { ...editing.data, [k]: e.target.value } })} /></Label>
              ))}
            </div>
            <Label className={field}>Assembly instructions<Textarea required value={editing.data.instructions} onChange={e => setEditing({ ...editing, data: { ...editing.data, instructions: e.target.value } })} placeholder="Sequence, orientation, press method, lubrication, retention and inspection" /></Label>
            {editing.id && <Label className={checkRow}><Checkbox className="mt-0.5" checked={!!editing.approved} onCheckedChange={v => setEditing({ ...editing, approved: v === true })} />Approve interface and tolerance limits</Label>}
            <ModalFooter><Button disabled={busy}>Save mating record</Button></ModalFooter>
          </form>
        </Modal>
      )}

      {modal === 'release' && (
        <Modal title="Production readiness" close={() => setModal('')}>
          {release?.can_release ? (
            <>
              <div className="grid justify-items-center gap-2 p-6 text-center text-success"><ShieldCheck className="size-9" /><h3 className="text-base font-semibold">Every part is reviewed and every check is covered</h3><p className="text-sm text-muted-foreground">Marking the revision production ready locks it, generates the final document pack and opens job orders. Engineering approval remains your responsibility.</p></div>
              {release?.warnings?.length > 0 && <ul className="mx-6 mb-2 grid gap-1 rounded-md border border-warning/30 bg-warning-soft p-3 text-xs text-warning">{release.warnings.map((w: string, i: number) => <li key={i} className="flex gap-2"><AlertTriangle className="mt-px size-3.5 shrink-0" />{w}</li>)}</ul>}
              <ModalFooter><Button disabled={!can('revision.release')} title={can('revision.release') ? '' : 'You need the release permission'} onClick={() => action(async () => { await api(`/revisions/${rev.id}/release`, 'POST'); await loadRevision(rev.id); setModal(''); })}>Release revision</Button></ModalFooter>
            </>
          ) : (
            <><p className="text-sm">{release?.reasons.length} unresolved release requirements.</p><ul className="mt-2 max-h-[430px] list-disc overflow-auto pl-5 text-sm leading-7 text-warning">{release?.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></>
          )}
        </Modal>
      )}

      {modal === 'rules' && (
        <Modal title="Rule library & drawing conventions" close={() => setModal('')}>
          <p className="text-sm">Workshop rules are configurable starting values, not universal design limits. Standards references are documented; this software is not a certification engine.</p>
          <div className={cn(formGrid, 'mt-4')}>
            {Object.entries(project?.rules || config?.default_rules || {}).map(([k, v]) => (
              <Label key={k} className={cn(field, 'capitalize')}>{k.replaceAll('_', ' ')}<Input type="number" step="any" readOnly={!project || vendor} className="read-only:bg-subtle read-only:text-muted-foreground" value={String(v)} onChange={e => setProject({ ...project, rules: { ...project.rules, [k]: Number(e.target.value) } })} /></Label>
            ))}
          </div>
          <h3 className={modalHeading}>Drawing references</h3>
          {config?.standards.map((s: Any) => <a className="my-2 flex items-center justify-between rounded-md border p-3 text-sm hover:bg-accent" href={s.url} target="_blank" rel="noreferrer" key={s.code}><span className="grid"><span className="font-medium">{s.code}</span><small className="mt-0.5 text-2xs text-muted-foreground">{s.topic}</small></span><ExternalLink className="size-4 text-muted-foreground" /></a>)}
          <h3 className={modalHeading}>Manual verification coverage</h3>
          {Object.values(config?.manual_checks || {}).map((x: Any) => <p key={x} className="text-sm text-muted-foreground">• {x}</p>)}
          {project && !vendor && <ModalFooter><Button onClick={() => action(async () => { await api('/projects/' + project.id + '/rules', 'PUT', project.rules); notify('Rules saved for future revisions. Existing revisions retain their snapshot.'); setModal(''); })}>Save for future revisions</Button></ModalFooter>}
        </Modal>
      )}

      {modal === 'settings' && (
        <Modal title="Workspace defaults" subtitle="Starting values for new projects (each project keeps its own settings)" close={() => setModal('')}>
          {!settings ? <p className="text-sm text-muted-foreground">Loading…</p> : (
            <form className="grid gap-3" onSubmit={e => { e.preventDefault(); action(async () => { const body = { ...settings, sheet_prefixes: splitList(settings.sheet_prefixes), machining_prefixes: splitList(settings.machining_prefixes), purchased_prefixes: splitList(settings.purchased_prefixes) }; setSettings(await api('/settings', 'PUT', body)); notify('Settings saved. Applies to new uploads; use Re-run classification for the current revision.'); setModal(''); }); }}>
              <h3 className={cn(modalHeading, 'mt-0')}>Part-number prefixes</h3>
              <p className="text-sm text-muted-foreground">Names starting with these prefixes are classified without guessing. Comma-separated, case-insensitive, e.g. <code>SM-, GT-SM</code>.</p>
              <div className={formGrid}>
                <Label className={field}>Sheet metal prefixes<Input value={joinList(settings.sheet_prefixes)} placeholder="SM-, SHT-" onChange={e => setSettings({ ...settings, sheet_prefixes: e.target.value })} /></Label>
                <Label className={field}>Machining prefixes<Input value={joinList(settings.machining_prefixes)} placeholder="MC-, MACH-" onChange={e => setSettings({ ...settings, machining_prefixes: e.target.value })} /></Label>
                <Label className={field}>Purchased prefixes (optional)<Input value={joinList(settings.purchased_prefixes)} placeholder="PUR-, BO-" onChange={e => setSettings({ ...settings, purchased_prefixes: e.target.value })} /></Label>
              </div>
              <Label className={checkRow}><Checkbox className="mt-0.5" checked={!!settings.prefix_strict} onCheckedChange={v => setSettings({ ...settings, prefix_strict: v === true })} />Everything that matches no prefix is a purchased item (strict), unless it is named like a made part (plate, bracket, cover …). Prefixes are found anywhere in the name, so exporter noise such as 11GT-MC-… still matches. Off: fall back to name and geometry rules.</Label>
              <h3 className={modalHeading}>Import behaviour</h3>
              <Label className={checkRow}><Checkbox className="mt-0.5" checked={!!settings.hide_purchased_by_default} onCheckedChange={v => setSettings({ ...settings, hide_purchased_by_default: v === true })} />Hide small bought-in items (terminals, lidars, connectors, fasteners, multi-body supplier models) in the viewer by default</Label>
              <Label className={checkRow}><Checkbox className="mt-0.5" checked={!!settings.carry_over_specs} onCheckedChange={v => setSettings({ ...settings, carry_over_specs: v === true })} />Carry manufacturing specifications from the active revision into new uploads (matched by part name, then shape). Approvals and review status are never carried.</Label>
              <h3 className={modalHeading}>Drawing title block</h3>
              <p className="text-sm text-muted-foreground">Printed on every drawing sheet (GOAT A4/A3 template). Use <b>Generate documents</b> to refresh existing drawings.</p>
              <div className={formGrid}>
                {[['company', 'Company'], ['drawn_by', 'Drawn by (DRN)'], ['checked_by', 'Checked by (CHK)'], ['approved_by', 'Approved by (APD)'], ['module', 'Module'], ['master', 'Master'], ['note', 'General note'], ['surface_finish', 'Surface finish'], ['tol_1dec', 'Tolerance · 1 decimal'], ['tol_2dec', 'Tolerance · 2 decimals'], ['tol_3dec', 'Tolerance · 3 decimals'], ['hole_fit', 'Fit for holes'], ['shaft_fit', 'Fit for shafts'], ['position_tol', 'Diametric position tolerance']].map(([k, label]) => (
                  <Label key={k} className={field}>{label}<Input value={settings.drawing?.[k] ?? ''} maxLength={80} onChange={e => setSettings({ ...settings, drawing: { ...(settings.drawing || {}), [k]: e.target.value } })} /></Label>
                ))}
              </div>
              <ModalFooter note={<>Prefix rules apply on the next upload. For a revision already imported, use <b>Re-run classification</b> in its overview; parts you classified or reviewed by hand are left untouched.</>}><Button disabled={busy || !perms.has('users.manage')}><Check />Save defaults</Button></ModalFooter>
            </form>
          )}
        </Modal>
      )}

      {modal === 'qc' && (
        <Modal title="Record feature inspection" close={() => setModal('')}>
          <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget)); action(async () => { await api(`/revisions/${rev.id}/qc`, 'POST', { ...f, nominal: Number(f.nominal), lower_limit: Number(f.lower_limit), upper_limit: Number(f.upper_limit), measured: Number(f.measured) }); await refreshRelated('qc'); setModal(''); }); }}>
            <Label className={field}>Part<Select name="part_id" required defaultValue={parts[0]?.id || ''} options={parts.map((p: Any) => ({ value: p.id, label: p.name }))} /></Label>
            <div className={formGrid}>
              {['feature', 'serial', 'nominal', 'lower_limit', 'upper_limit', 'measured', 'instrument'].map(k => (
                <Label key={k} className={cn(field, 'capitalize')}>{k.replaceAll('_', ' ')}<Input name={k} required type={['nominal', 'lower_limit', 'upper_limit', 'measured'].includes(k) ? 'number' : 'text'} step="any" placeholder={k === 'feature' ? 'H001' : undefined} /></Label>
              ))}
            </div>
            <Label className={field}>Unit<Select name="unit" defaultValue="mm" options={[{ value: 'mm', label: 'mm — bores / linear dimensions' }, { value: 'deg', label: 'degrees — bend angle' }]} /></Label>
            <Label className={field}>Inspection notes<Textarea name="notes" /></Label>
            <p className="text-sm text-muted-foreground">Entered limits must match the approved feature limits. Results and operator identity are recorded automatically.</p>
            <ModalFooter><Button disabled={busy}>Save inspection record</Button></ModalFooter>
          </form>
        </Modal>
      )}

      {modal === 'compare' && (
        <Modal title="Revision comparison" close={() => setModal('')}>
          <p className="mb-3 text-sm text-muted-foreground">{comparison?.matching}</p>
          {comparison?.parts.map((p: Any) => <div className={docRow} key={p.name}><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{p.name}</span><span className="mt-0.5 block text-2xs">Qty {p.old_quantity} → {p.new_quantity}</span></span><Badge kind={p.change === 'unchanged' ? 'neutral' : 'warning'}>{p.change}</Badge></div>)}
        </Modal>
      )}

      {modal === 'team' && (
        <Modal title="Team access" close={() => setModal('')}>
          <div>{modalRows.map(u => <div className={docRow} key={u.id}><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{u.name}</span><span className="mt-0.5 block text-2xs">{u.email}</span></span><Badge>{u.role}</Badge></div>)}</div>
          <h3 className={modalHeading}>Add a team member</h3>
          <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { await api('/users', 'POST', Object.fromEntries(f)); setModalRows(await api('/users')); notify('Team member created'); }); }}>
            <div className={formGrid}>
              <Label className={field}>Name<Input name="name" required /></Label>
              <Label className={field}>Email<Input name="email" type="email" required /></Label>
              <Label className={field}>Initial password<Input name="password" type="password" minLength={12} required /></Label>
              <Label className={field}>Role<Select name="role" defaultValue="engineer" options={[{ value: 'engineer', label: 'Engineer' }, { value: 'qc', label: 'QC inspector' }, { value: 'viewer', label: 'Viewer' }]} /></Label>
            </div>
            <ModalFooter><Button>Create team member</Button></ModalFooter>
          </form>
        </Modal>
      )}
    </div>
    </TooltipProvider>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center">
        <div className="grid justify-items-center gap-3"><h2 className="text-lg font-semibold">Something went wrong in the interface</h2><p className="max-w-[520px] text-sm text-muted-foreground">{String(this.state.error?.message || this.state.error)}</p><Button onClick={() => location.reload()}>Reload</Button></div>
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
