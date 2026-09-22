import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box, Plus, ArrowUpRight, Upload, Folder, ChevronDown, ChevronRight, Search, Download, Check, CheckCircle2, AlertTriangle, Clock,
  FileText, Layers, Link, LogOut, Settings, ShieldCheck, MessageSquare, ClipboardCheck, GitBranch, LoaderCircle, ExternalLink, X, Eye,
  Target, Archive, SlidersHorizontal, Users, Send, RefreshCw, Scan, Grid2x2, Palette, EyeOff, Ban, Undo2, Factory, Files,
} from 'lucide-react';
import Viewer from './Viewer';
import type { PartAppearance } from './Viewer';
import { api, asset, download, vendorId, headers } from './api';
import { Badge, Modal, DocumentPreview, FlatPattern, SpecEditor, Swatch, ProductionChecklist, GroupPanel, GroupSpecEditor, ExcludeDialog } from './components';
import { categories, categoryColors, date, fmt } from './constants';
import type { Any } from './constants';
import { Select } from './controls';
import './style.css';

type ViewMode = '3d' | 'flat3d' | 'flat2d';
const TABS = ['parts', 'rules', 'assembly', 'production', 'review', 'qc', 'audit'];
/** Read a deep link: /projects/{pid}/revisions/{rid}/{tab}?part={id} or /vendor/{rid}?tab=&part= */
function parseRoute() {
  const q = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/projects\/([a-f0-9]+)(?:\/revisions\/([a-f0-9]+))?(?:\/([a-z]+))?/);
  return { project: m?.[1] || null, revision: m?.[2] || null, tab: (m?.[3] && TABS.includes(m[3]) ? m[3] : q.get('tab') && TABS.includes(q.get('tab')!) ? q.get('tab')! : null), part: q.get('part') };
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
  const [preview, setPreview] = useState<{ blob: Blob; name: string; title: string } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const route = useRef(parseRoute());
  const [settings, setSettings] = useState<Any>(null);
  const [feature, setFeature] = useState<Any>(null);
  const [excluding, setExcluding] = useState<Any[] | null>(null);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fail = (e: Any) => setError(e.message || String(e));
  const notify = (s: string) => { setToast(s); setTimeout(() => setToast(''), 5000); };
  const action = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const loadProjects = async () => setProjects(await api('/projects'));
  const loadRevision = useCallback(async (id: string) => { const r = await api('/revisions/' + id); setRev(r); return r; }, []);
  /** Open whatever the URL points at (after sign-in). */
  const openRoute = async () => {
    const r = route.current;
    if (!r.project) return;
    const d = await api('/projects/' + r.project);
    setProject(d); setComparison(null);
    const target = (r.revision && d.revisions.find((x: Any) => x.id === r.revision)) || d.revisions.find((x: Any) => x.state === 'active') || d.revisions[0];
    if (target) await loadRevision(target.id);
    if (r.tab) setTab(r.tab);
    if (r.part) { setSelected(r.part); setMulti([r.part]); anchor.current = r.part; }
  };
  const openProject = async (p: Any) => {
    const d = await api('/projects/' + p.id);
    setProject(d); setRev(null); setSelected(null); setMode('3d'); setIsolate(false); setComparison(null); setTab('parts');
    const active = d.revisions.find((r: Any) => r.state === 'active') || d.revisions[0];
    if (active) await loadRevision(active.id);
  };

  useEffect(() => {
    api('/config').then(setConfig).catch(fail);
    if (vendorId) { loadRevision(vendorId).catch(fail); setAuth({ user: { name: 'Vendor', role: 'vendor' } }); if (route.current.tab) setTab(route.current.tab); if (route.current.part) setSelected(route.current.part); }
    else api('/auth/status').then(a => { setAuth(a); if (a.user) { loadProjects().catch(fail); api('/settings').then(setSettings).catch(() => {}); openRoute().catch(fail); } }).catch(fail);
  }, []);

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
    const endpoint = tab === 'assembly' ? 'fits' : tab === 'qc' ? 'qc' : tab === 'review' ? 'comments' : tab === 'audit' ? 'audit' : tab === 'production' ? 'production' : null;
    setRelated([]); // never render one tab with another tab's rows
    if (endpoint) api(`/revisions/${rev.id}/${endpoint}`).then(setRelated).catch(fail);
  }, [rev?.id, tab]);

  useEffect(() => {
    if (multi.length < 2) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal && !preview && !document.getElementById('popover-root')?.childElementCount) setMulti(selected ? [selected] : []); };
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
  const editable = !vendor && ['owner', 'engineer'].includes(auth?.user?.role) && rev?.state === 'active' && rev?.status === 'ready';
  const filtered = parts.filter((p: Any) => (category === 'all' ? (showHidden || !p.hidden) : category === 'hidden' ? p.hidden : category === 'excluded' ? p.excluded : p.category === category && (showHidden || !p.hidden)) && p.name.toLowerCase().includes(query.toLowerCase()));
  const hiddenIds = parts.filter((p: Any) => p.hidden).map((p: Any) => p.id);
  const holes = parts.reduce((n: number, p: Any) => n + p.geometry.holes.length, 0);
  const findings = parts.flatMap((p: Any) => (p.category === 'purchased' || p.excluded ? [] : p.findings));
  const selectedFindings = part?.findings || [];
  const blocking = findings.filter((f: Any) => f.severity === 'blocker' && !f.waiver).length;
  const job = rev?.jobs?.find((j: Any) => ['queued', 'running'].includes(j.status));
  const appearance = useMemo<Record<string, PartAppearance>>(() => {
    const out: Record<string, PartAppearance> = {};
    for (const p of parts) out[p.id] = { color: p.spec.coating_hex || categoryColors[p.category] || categoryColors.other, category: p.category, name: p.name };
    return out;
  }, [rev?.id, parts.map((p: Any) => p.spec.coating_hex + p.category).join('|')]);

  // Keep the address bar in sync so any view can be copied and opened by a colleague or vendor.
  useEffect(() => {
    if (!auth?.user) return;
    let path = vendor ? location.pathname : '/';
    if (!vendor && project) { path = `/projects/${project.id}`; if (rev) path += `/revisions/${rev.id}/${tab}`; }
    const q = new URLSearchParams();
    if (vendor && tab !== 'parts') q.set('tab', tab);
    if (rev && selected && parts.some((p: Any) => p.id === selected)) q.set('part', selected);
    const next = path + (q.toString() ? '?' + q.toString() : '');
    if (next !== location.pathname + location.search) history.replaceState(null, '', next);
  }, [auth?.user, project?.id, rev?.id, tab, selected, vendor, parts.length]);
  const copyLink = () => action(async () => { await navigator.clipboard.writeText(location.href); notify(vendor ? 'Link copied. The vendor token stays in this browser; share the original vendor link for access.' : 'Link copied — opens this exact view for signed-in team members.'); });

  const refreshRelated = async (endpoint: string) => setRelated(await api(`/revisions/${rev.id}/${endpoint}`));
  /** PDFs open in a preview first; other formats download directly. */
  const doc = (path: string, name: string, title = name) => action(async () => {
    if (name.toLowerCase().endsWith('.pdf')) setPreview({ blob: await asset(path), name, title });
    else await download(path, name);
  });
  const generate = async (pid?: string) => action(async () => {
    await api(`/revisions/${rev.id}/documents`, 'POST', pid ? { part_id: pid } : {});
    await loadRevision(rev.id);
    notify('Drawing generation queued. You can keep reviewing.');
  });
  const setFlags = (pid: string, flags: Any) => action(async () => { await api('/parts/' + pid + '/flags', 'PATCH', flags); await loadRevision(rev.id); });
  const choosePart = (id: string | null) => { setSelected(id); setMulti(id ? [id] : []); anchor.current = id; if (id) setDetail(d => (d === 'documents' ? d : 'details')); if (!id) { setIsolate(false); } if (mode !== '3d') setMode('3d'); };
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
  const bulk = (body: Any) => action(async () => { const r = await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: multi, ...body }); await loadRevision(rev.id); notify(`${r.updated} parts updated`); });

  const uploadFile = (file: File, notes: string) => new Promise<void>((resolve, reject) => {
    const data = new FormData();
    data.append('file', file); data.append('notes', notes);
    const xhr = new XMLHttpRequest();
    const responseError = () => {
      const fallback = xhr.status ? `Upload failed (HTTP ${xhr.status}${xhr.statusText ? ` ${xhr.statusText}` : ''})` : 'Upload failed';
      try {
        const body = JSON.parse(xhr.responseText);
        return typeof body.detail === 'string' ? body.detail : fallback;
      } catch {
        // Proxies can return HTML for upload limits and timeouts. Never leave the
        // enclosing action pending merely because their error is not JSON.
        return fallback;
      }
    };
    xhr.open('POST', `/api/projects/${project.id}/revisions`);
    Object.entries(headers()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = e => setUploadPercent(Math.round(e.loaded / e.total * 100));
    xhr.onload = () => {
      setUploadPercent(null);
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(responseError())); return; }
      void (async () => {
        const r = JSON.parse(xhr.responseText);
        await loadRevision(r.id);
        setProject(await api('/projects/' + project.id));
        setModal('');
      })().then(resolve).catch(e => reject(e instanceof Error ? e : new Error(String(e))));
    };
    xhr.onerror = () => { setUploadPercent(null); reject(new Error('Upload failed')); };
    xhr.onabort = () => { setUploadPercent(null); reject(new Error('Upload cancelled')); };
    xhr.send(data);
  });

  if (!auth) return <div className="boot"><div className="brand-mark">F</div><span className="spinner" />Opening Forge…{error && <p>{error}</p>}</div>;

  if (!auth.user && !vendor) return (
    <div className="auth">
      <div className="auth-story">
        <div className="wordmark"><div className="brand-mark">F</div>forge<span>MANUFACTURING</span></div>
        <div>
          <span className="eyebrow">FROM GEOMETRY TO THE SHOP FLOOR</span>
          <h1>One part.<br />Every detail.<br /><em>Ready to make.</em></h1>
          <p>Your CAD, engineering decisions, suppliers and quality records. Connected by revision.</p>
        </div>
        <span>PROJECTS / DRAWINGS / ASSEMBLY / QUALITY</span>
      </div>
      <section className="auth-form">
        <div className="eyebrow">YOUR MANUFACTURING WORKSPACE</div>
        <h2>{auth.configured ? 'Welcome back.' : 'Set up your workspace.'}</h2>
        <p>{auth.configured ? 'Sign in to continue your projects.' : 'Create the owner account. Project files stay in your Docker storage.'}</p>
        <form onSubmit={e => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          action(async () => {
            const a = Object.fromEntries(f);
            if (!auth.configured) await api('/auth/setup', 'POST', a);
            await api('/auth/login', 'POST', a);
            setAuth(await api('/auth/status'));
            await loadProjects();
            api('/settings').then(setSettings).catch(() => {});
            await openRoute();
          });
        }}>
          {!auth.configured && <label>Your name<input name="name" required autoComplete="name" /></label>}
          <label>Email<input type="email" name="email" required autoComplete="username" /></label>
          <label>Password<input name="password" type="password" required minLength={auth.configured ? 1 : 12} autoComplete={auth.configured ? 'current-password' : 'new-password'} /></label>
          {error && <p className="error-text">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={17} />} {auth.configured ? 'Sign in' : 'Create workspace'}</button>
        </form>
        <small>Self-hosted. No external CAD upload service.</small>
      </section>
    </div>
  );

  const goHome = () => { if (vendor) return; setProject(null); setRev(null); loadProjects().catch(fail); };
  const workspaceTab = tab === 'parts' && !!rev && rev.status !== 'processing';

  return (
    <div className="app">
      <aside className="rail">
        <button className="brand-mark" title="All projects" disabled={vendor} onClick={goHome}>F</button>
        <button className={!project ? 'rail-active' : ''} title="Projects" disabled={vendor} onClick={goHome}><Folder size={22} /></button>
        {!vendor && <>
          <button title="Team" onClick={() => { setModal('team'); api('/users').then(setModalRows).catch(fail); }}><Users size={21} /></button>
          <button title="Rules & standards" onClick={() => setModal('rules')}><SlidersHorizontal size={21} /></button>
          <button title="Workspace settings" onClick={() => { setModal('settings'); api('/settings').then(setSettings).catch(fail); }}><Settings size={21} /></button>
        </>}
        <div className="rail-spacer" />
        <span className="avatar" title={auth.user.name}>{auth.user.name[0]}</span>
        {!vendor && <button title="Sign out" onClick={() => action(async () => { await api('/auth/logout', 'POST'); setAuth(await api('/auth/status')); })}><LogOut size={20} /></button>}
      </aside>

      <main className={workspaceTab ? 'fixed' : ''}>
        <header className="topbar">
          <div className="crumb">
            <span className="logo-text">forge</span>
            <span className="slash">/</span>
            <button onClick={goHome}>{vendor ? 'Vendor workspace' : 'Projects'}</button>
            {(project || vendor) && <><ChevronRight size={15} /><strong>{project?.name || 'Shared revision'}</strong></>}
            {rev && <><ChevronRight size={15} /><span className="crumb-rev">Rev {rev.number} · {rev.filename}</span></>}
          </div>
          <div className="topright">
            {rev && <button type="button" className="mini" title="Copy a link to this view" onClick={copyLink}><Link size={13} />Copy link</button>}
            {rev && <Badge kind={rev.status === 'released' ? 'success' : rev.state === 'archived' ? 'neutral' : 'warning'}>{rev.state === 'archived' ? 'Archived' : rev.status.replace('_', ' ')}</Badge>}
            <span className="live-dot" />Local workspace
            <Badge kind="neutral">{auth.user.role}</Badge>
          </div>
        </header>

        {!project && !vendor ? (
          <section className="projects">
            <div className="section-heading">
              <div><span className="eyebrow">MANUFACTURING OPERATIONS</span><h1>Your projects</h1><p>From the first CAD upload to the final quality check.</p></div>
              <button className="primary" onClick={() => setModal('project')}><Plus size={17} />New project</button>
            </div>
            <div className="project-grid">
              {projects.map(p => (
                <button className="project-card" key={p.id} onClick={() => action(() => openProject(p))}>
                  <div className="project-icon"><Box size={30} /></div>
                  <div><h2>{p.name}</h2><p>{p.description || 'CAD, drawings and manufacturing records'}</p></div>
                  <footer><span>{p.revision_count} revisions</span><span>{date(p.created)} <ArrowUpRight size={15} /></span></footer>
                </button>
              ))}
              <button className="project-card add-project" onClick={() => setModal('project')}>
                <div className="dashed-icon"><Plus size={27} /></div>
                <h3>Start with your CAD</h3><p>Create a project. Upload a part or an assembly.</p>
              </button>
            </div>
            <div className="workflow-strip">
              {[['01', 'Upload & version', 'Preserve your design history.'], ['02', 'Analyze & specify', 'Features, processes, rules and fits.'], ['03', 'Review & release', 'Vendor access and controlled documents.'], ['04', 'Assemble & inspect', 'Mating records and feature-level QC.']].map(([n, t, s]) => (
                <div key={n}><span>{n}</span><h3>{t}</h3><p>{s}</p></div>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="project-head">
              <div className="project-title">
                <h1>{project?.name || rev?.filename || 'Shared design'}</h1>
                <span className="project-sub">{vendor ? 'Supplier review portal' : rev ? `${parts.length} parts · ${rev.manifest?.occurrences || 0} body instances · ${holes} named bores` : 'Upload your first CAD file to begin'}</span>
              </div>
              <div className="project-actions">
                {!vendor && <button onClick={() => importingRevision ? showImport() : setModal('upload')}>{importingRevision ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}{importingRevision ? 'View import progress' : 'Upload revision'}</button>}
                {rev && <>
                  <button onClick={() => doc(`/revisions/${rev.id}/assets/manufacturing-pack.zip`, 'manufacturing-pack.zip')} disabled={!rev.assets?.includes('manufacturing-pack.zip')} title="Generate the manufacturing pack in the revision overview"><Download size={16} />Package</button>
                  {!vendor && <button className="primary" disabled={!['ready', 'released'].includes(rev.status)} onClick={() => { setSharePath(''); setModal('share'); }}><Link size={16} />Share with vendor</button>}
                </>}
              </div>
            </section>

            {importingRevision && <div className="progress-banner" role="status" aria-live="polite">
              <LoaderCircle size={16} className="spin" />
              <span>Revision {importingRevision.number} · {importingRevision.message || 'Import queued'}</span>
              <progress aria-label="CAD import progress" max="100" value={importingRevision.progress || 0} />
              <b>{importingRevision.progress || 0}%</b>
              {rev?.id !== importingRevision.id && <button className="mini" onClick={showImport}>View import</button>}
            </div>}

            {!rev && vendor ? (
              <div className="empty-page"><LoaderCircle className="spin" /><p>Loading shared revision…</p></div>
            ) : !rev ? (
              <div className="empty-page"><Upload size={42} /><h2>Every part starts here.</h2><p>Upload STEP, IGES or BREP. Assemblies and multi-body parts stay connected.</p><button className="primary" onClick={() => setModal('upload')}>Upload CAD file</button></div>
            ) : (
              <>
                <div className="tabs-bar">
                  <nav>
                    {[['parts', 'Parts & drawings', Box], ['rules', 'Design checks', ShieldCheck], ['assembly', 'Assembly & fits', Layers], ['production', 'Production', Factory], ['review', 'Review', MessageSquare], ['qc', 'Quality control', ClipboardCheck], ...(!vendor ? [['audit', 'History', Clock]] : [])].map(([id, label, Icon]: Any) => (
                      <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon size={16} />{label}{id === 'rules' && blocking > 0 && <b>{blocking}</b>}</button>
                    ))}
                  </nav>
                  <div className="revision-picker">
                    <button onClick={() => setRevisionOpen(!revisionOpen)}><GitBranch size={15} />Revision {rev.number}<ChevronDown size={14} /></button>
                    {revisionOpen && !vendor && (
                      <div className="dropdown">
                        {project?.revisions.map((r: Any) => <button key={r.id} onClick={() => { setRevisionOpen(false); choosePart(null); loadRevision(r.id).catch(fail); }}>Rev {r.number}<Badge>{r.state}</Badge></button>)}
                        {project?.revisions.length > 1 && <button onClick={() => action(async () => { const other = project.revisions.find((r: Any) => r.id !== rev.id); setComparison(await api(`/revisions/${rev.id}/compare/${other.id}`)); setModal('compare'); setRevisionOpen(false); })}>Compare with previous</button>}
                      </div>
                    )}
                  </div>
                </div>

                {job && !importingRevision && <div className="progress-banner"><LoaderCircle size={16} className="spin" /><span>{rev.message || 'Job queued'}</span><progress max="100" value={rev.progress} /><b>{rev.progress}%</b></div>}
                {rev.status === 'failed' && <div className="error-banner">Import failed: {rev.message}. The previous active revision is preserved.</div>}
                {rev.state === 'archived' && <div className="notice"><Archive size={15} />Archived revision — read-only design and historical documents. New production work should use the active released revision.</div>}

                {tab === 'parts' && (
                  <div className="workspace">
                    <aside className="part-list">
                      <div className="list-heading"><h3>{multi.length > 1 ? `${multi.length} selected` : 'Part navigator'}</h3><div className="flex">{multi.length > 1 && <button type="button" className="mini" onClick={() => choosePart(null)}><X size={12} />Clear</button>}{hiddenIds.length > 0 && <button type="button" className={'mini' + (showHidden ? ' selected' : '')} title={showHidden ? 'Hide the parts marked hidden' : 'Show the parts marked hidden'} onClick={() => setShowHidden(!showHidden)}>{showHidden ? <Eye size={13} /> : <EyeOff size={13} />}{hiddenIds.length}</button>}<span>{parts.length}</span></div></div>
                      <div className="search"><Search size={16} /><input aria-label="Search parts" placeholder="Find a part…" value={query} onChange={e => setQuery(e.target.value)} /></div>
                      <div className="nav-filter"><Select size="sm" aria-label="Filter part type" value={category} onChange={setCategory} options={[
                        { value: 'all', label: 'All part types', hint: String(parts.length) },
                        ...Object.entries(categories).map(([k, v]) => ({ value: k, label: v, hint: String(parts.filter((p: Any) => p.category === k).length) })),
                        { value: 'hidden', label: 'Hidden in viewer', hint: String(hiddenIds.length) },
                        { value: 'excluded', label: 'Not for production', hint: String(parts.filter((p: Any) => p.excluded).length) },
                      ]} /></div>
                      <button className={'assembly-root ' + (!selected ? 'chosen' : '')} onClick={() => choosePart(null)}>
                        <Layers size={18} /><span>Complete assembly<small>{rev.manifest.occurrences || 0} body instances</small></span>
                      </button>
                      <div className="part-scroll" ref={listRef}>
                        {filtered.map((p: Any) => (
                          <div key={p.id} data-part={p.id} className={'part-row ' + (p.id === selected ? 'chosen' : multi.includes(p.id) ? 'multi' : '') + (p.hidden ? ' is-hidden' : '') + (p.excluded ? ' is-excluded' : '')}>
                            <button type="button" className="row-main" onClick={ev => clickRow(p.id, ev)}>
                              <span className={'part-glyph ' + p.category} style={p.spec.coating_hex ? { background: p.spec.coating_hex, color: '#fff' } : undefined}>{p.category === 'sheet_metal' ? <Layers size={17} /> : <Box size={17} />}</span>
                              <span><strong>{p.name}</strong><small>{p.excluded ? <b className="excluded-tag">Not for production</b> : categories[p.category]} <span>· Qty {p.quantity}</span>{p.spec.material && !p.excluded && <span> · {p.spec.material}</span>}</small></span>
                              {p.reviewed ? <CheckCircle2 size={15} className="green" /> : <span className="pending-dot" title="Not reviewed" />}
                            </button>
                            {!vendor && <button type="button" className="icon row-eye" title={p.hidden ? 'Show in viewer' : 'Hide in viewer'} onClick={() => setFlags(p.id, { hidden: !p.hidden })}>{p.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>}
                          </div>
                        ))}
                        {!filtered.length && <p className="muted padded">{job ? 'Analyzing components…' : 'No matching parts.'}</p>}
                      </div>
                      <div className="list-footer"><span title="Shift-click selects a range, Ctrl/Cmd-click toggles">{hiddenIds.length ? `${hiddenIds.length} hidden` : `${holes} named bores`} · ⇧ range</span><span>{parts.filter((p: Any) => p.reviewed && !p.excluded).length}/{parts.filter((p: Any) => !p.excluded).length} reviewed</span></div>
                    </aside>

                    <div className="canvas-panel">
                      <div className="canvas-header">
                        <div className="canvas-title">
                          {part && <Swatch hex={part.spec.coating_hex} title={part.spec.coating_color} size={12} />}
                          <strong>{multi.length > 1 ? `${multi.length} parts selected` : part?.name || 'Complete assembly'}</strong>
                          <small>{part ? (mode === '3d' ? (isolate ? 'Isolated · assembly placement' : 'Highlighted in assembly') : 'Part definition coordinates') : 'Assembly placements from CAD'}</small>
                        </div>
                        <div className="canvas-actions">
                          {part && <>
                            <button className={isolate ? 'selected' : ''} onClick={() => { setIsolate(!isolate); setMode('3d'); }}><Target size={15} />Isolate</button>
                            {part.category === 'sheet_metal' && <>
                              <button className={mode === 'flat2d' ? 'selected' : ''} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message} onClick={() => setMode(mode === 'flat2d' ? '3d' : 'flat2d')}><Grid2x2 size={15} />Flat pattern</button>
                              <button className={mode === 'flat3d' ? 'selected' : ''} disabled={part.geometry.flat_status !== 'supported'} title={part.geometry.flat_message} onClick={() => setMode(mode === 'flat3d' ? '3d' : 'flat3d')}><Scan size={15} />Flat 3D</button>
                            </>}
                            <button onClick={() => choosePart(null)} title="Clear selection"><X size={15} />Clear</button>
                          </>}
                        </div>
                      </div>
                      {rev.status !== 'processing' && rev.status !== 'failed' ? (
                        mode === 'flat2d' && part ? (
                          <FlatPattern partId={part.id} thickness={part.geometry.thickness} kFactor={part.spec.k_factor} approved={!!part.spec.k_factor_approved} name={part.name} />
                        ) : (
                          <Viewer
                            url={mode === 'flat3d' && part ? `/parts/${part.id}/assets/flat.glb` : `/revisions/${rev.id}/assets/assembly.glb`}
                            selected={mode === 'flat3d' ? null : selected}
                            isolated={isolate}
                            flat={mode === 'flat3d'}
                            appearance={appearance}
                            hidden={showHidden ? [] : hiddenIds}
                            multi={multi}
                            feature={mode === '3d' ? feature : null}
                            onPick={id => { if (mode === 'flat3d') return; if (!id) choosePart(null); else if (parts.some((p: Any) => p.id === id)) choosePart(id); }}
                            onIsolateToggle={() => setIsolate(v => !v)}
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
                      <div className="canvas-footer">
                        <span><span className="live-dot" />Source geometry preserved</span>
                        <span>{mode === 'flat2d' ? 'Developed blank from the approved bend graph · scroll to zoom · drag to pan' : 'Drag to orbit · Scroll to zoom · Click a part to select · Double-click to isolate · Click empty space to clear'}</span>
                        <Badge>STEP → GLB</Badge>
                      </div>
                    </div>

                    <aside className="inspector">
                      {multi.length > 1 ? (
                        <GroupPanel parts={parts.filter((p: Any) => multi.includes(p.id))} vendor={vendor} editable={editable} busy={busy}
                          onEdit={() => { setEditing({ group: parts.filter((p: Any) => multi.includes(p.id)) }); setModal('group-spec'); }}
                          onBulk={bulk} onExclude={() => setExcluding(parts.filter((p: Any) => multi.includes(p.id)))} onRemove={id => { const next = multi.filter(x => x !== id); setMulti(next); if (selected === id) setSelected(next[next.length - 1] || null); }}
                          onFocus={id => setSelected(id)} onClear={() => choosePart(null)} />
                      ) : part ? (
                        <>
                          <div className="inspector-top">
                            <div className="flex"><Badge kind={part.category}>{categories[part.category]}</Badge>{part.excluded ? <Badge kind="danger">Not for production</Badge> : part.reviewed ? <Badge kind="success">Reviewed</Badge> : <Badge kind="warning">Review pending</Badge>}{part.geometry.carried_from && <Badge kind="neutral" >From rev {part.geometry.carried_from.revision}</Badge>}</div>
                            <h2>{part.name}</h2>
                            <span className="muted">{part.id.slice(-10).toUpperCase()} · Qty {part.quantity}</span>
                            {!vendor && (
                              <div className="part-actions">
                                {part.excluded
                                  ? <button type="button" disabled={!editable} title={editable ? 'Put this part back into production' : 'Only on an active, ready revision (owner/engineer)'} onClick={() => setFlags(part.id, { excluded: false })}><Undo2 size={14} />Restore to production</button>
                                  : <button type="button" className="danger-ghost" disabled={!editable} title={editable ? 'Exclude from release checks, drawing sets and the vendor checklist' : 'Only on an active, ready revision (owner/engineer)'} onClick={() => setExcluding([part])}><Ban size={14} />Not for production</button>}
                                <button type="button" title={part.hidden ? 'Show in viewer by default' : 'Hide in viewer by default'} onClick={() => setFlags(part.id, { hidden: !part.hidden })}>{part.hidden ? <Eye size={14} /> : <EyeOff size={14} />}{part.hidden ? 'Show' : 'Hide'}</button>
                              </div>
                            )}
                          </div>
                          <div className="mini-tabs">{['details', 'features', 'documents'].map(t => <button key={t} className={detail === t ? 'active' : ''} onClick={() => setDetail(t)}>{t}</button>)}</div>
                          <div className="inspector-body">
                            {detail === 'details' ? (
                              <>
                                <div className="metric-trio">{['X', 'Y', 'Z'].map((a, i) => <div key={a}><span>{a} / mm</span><b>{fmt(part.geometry.dimensions[i])}</b></div>)}</div>
                                <h4>Manufacturing</h4>
                                <div className="property-list">
                                  <div><span>Geometry</span><b className={part.geometry.valid ? 'green' : 'red'}>{part.geometry.valid ? 'Valid solid' : 'Invalid'}</b></div>
                                  <div><span>Classification</span><b>{part.geometry.classification_confidence}</b></div>
                                  {part.geometry.thickness > 0 && <div><span>Thickness</span><b>{fmt(part.geometry.thickness)} mm · inferred</b></div>}
                                  <div><span>Material</span><b>{part.spec.material || <em>Not specified</em>}</b></div>
                                  {part.spec.stock && <div><span>Raw stock</span><b>{part.spec.stock}</b></div>}
                                  <div><span>Process</span><b>{part.spec.process || <em>Not specified</em>}</b></div>
                                  {part.spec.heat_treatment && <div><span>Heat treatment</span><b>{part.spec.heat_treatment}{part.spec.hardness && ' · ' + part.spec.hardness}</b></div>}
                                  <div><span>Finish</span><b>{part.spec.finish || <em>Not specified</em>}</b></div>
                                  <div><span>Coating</span><b>{part.spec.paint || <em>Not specified</em>}</b></div>
                                  <div><span>Colour</span><b className="flex end">{part.spec.coating_hex && <Swatch hex={part.spec.coating_hex} />}{part.spec.coating_color || part.spec.coating_hex || <em>Not specified</em>}</b></div>
                                  {part.spec.coating_thickness && <div><span>Film thickness</span><b>{part.spec.coating_thickness}</b></div>}
                                  {part.spec.masking && <div><span>Masking</span><b>{part.spec.masking}</b></div>}
                                  <div><span>Tolerance</span><b>{part.spec.general_tolerance || <em>Not specified</em>}</b></div>
                                  {part.spec.roughness && <div><span>Roughness</span><b>{part.spec.roughness}</b></div>}
                                  {part.spec.datums && <div><span>Datums</span><b>{part.spec.datums}</b></div>}
                                  {part.spec.edge_treatment && <div><span>Edges</span><b>{part.spec.edge_treatment}</b></div>}
                                  {part.spec.marking && <div><span>Marking</span><b>{part.spec.marking}</b></div>}
                                  {part.spec.packaging && <div><span>Packaging</span><b>{part.spec.packaging}</b></div>}
                                </div>
                                {part.spec.operations?.length > 0 && (
                                  <>
                                    <h4>Process sequence</h4>
                                    <ol className="ops-view">{part.spec.operations.map((o: Any, i: number) => <li key={i}><b>{typeof o === 'string' ? o : o.name}</b>{o.detail && <small>{o.detail}</small>}</li>)}</ol>
                                  </>
                                )}
                                {part.spec.notes && <><h4>Notes</h4><p className="note-text">{part.spec.notes}</p></>}
                                {part.category === 'sheet_metal' && (
                                  <div className="info-card"><Layers size={18} /><div><strong>{part.geometry.flat_status === 'supported' ? 'Developed pattern available' : 'Unfold review required'}</strong><p>{part.geometry.flat_message}</p></div></div>
                                )}
                                <h4>Engineering status</h4>
                                {part.excluded ? (
                                  <div className="status-card excluded"><Ban size={17} /><div><b>Not for production</b><p>{(part.exclusion_reason || 'Excluded from this revision').replace(/[.]?$/, '.')}{part.excluded_by && ` Marked by ${part.excluded_by}${part.excluded_at ? ' on ' + new Date(part.excluded_at).toLocaleString() : ''}.`} Skipped in release checks, drawing packs and the vendor checklist.</p></div></div>
                                ) : (
                                  <div className="status-card"><AlertTriangle size={17} /><div><b>{selectedFindings.filter((f: Any) => !f.waiver).length} open checks</b><p>Review manufacturing specifications before release.</p></div></div>
                                )}
                                {editable && !part.excluded && <button className="full primary" onClick={() => { setEditing(JSON.parse(JSON.stringify(part))); setModal('spec'); }}><Settings size={15} />Edit manufacturing details</button>}
                                {part.geometry.carried_from && (
                                  <div className="info-card"><GitBranch size={18} /><div><strong>Carried over from revision {part.geometry.carried_from.revision}</strong><p>{part.geometry.carried_from.same_shape ? 'Identical shape: specification, feature limits and verification notes were copied. Review and re-approve for this revision.' : 'Shape changed: material, process, finish and coating were copied; feature limits, verification notes and dispositions were reset.'}</p></div></div>
                                )}
                              </>
                            ) : detail === 'features' ? (
                              <>
                                <h4>{part.geometry.holes.length} named bores</h4>
                                {part.geometry.holes.map((h: Any) => (
                                  <div className={'feature' + (feature?.id === h.id ? ' hot' : '')} key={h.id} onMouseEnter={() => setFeature({ kind: 'hole', partId: part.id, ...h })} onMouseLeave={() => setFeature(null)}><Badge kind="neutral">{h.id}</Badge><div><strong>Ø {fmt(h.diameter)} mm</strong><small>Axial length {fmt(h.depth)} mm</small><small>{part.spec.feature_specs?.[h.id]?.designation || 'Thread / bore designation pending'}</small></div></div>
                                ))}
                                <h4>{part.geometry.bends.length} bends</h4>
                                {part.geometry.bends.map((b: Any) => (
                                  <div className={'feature' + (feature?.id === b.id ? ' hot' : '')} key={b.id} onMouseEnter={() => setFeature({ kind: 'bend', partId: part.id, ...b })} onMouseLeave={() => setFeature(null)}><Badge>{b.id}</Badge><div><strong>{fmt(b.angle)}° · R{fmt(b.radius)}</strong><small>Length {fmt(b.length)} mm</small></div></div>
                                ))}
                                <p className="muted">Geometric features carry stable labels within this revision. Renamed or changed features require reconciliation on a new revision.</p>
                              </>
                            ) : (
                              <>
                                <h4>Part documents</h4>
                                {[['drawing.pdf', 'Drawing sheet', 'PDF · views, feature labels & specs', true], ['drawing.dxf', 'Drawing geometry', 'DXF · layers and named holes', false], ['flat.dxf', 'Developed pattern', 'DXF · contour and bend lines', false], ['part.step', 'Individual part', 'STEP · exact solid geometry', false]].map(([file, title, sub, previewable]: Any) => (
                                  <button className="document" key={file} disabled={!part.assets.includes(file)} onClick={() => doc(`/parts/${part.id}/assets/${file}`, part.name + '_' + file, title + ' — ' + part.name)}>
                                    <FileText size={22} /><span><strong>{title}</strong><small>{part.assets.includes(file) ? sub : 'Not generated'}</small></span>{previewable ? <Eye size={16} /> : <Download size={16} />}
                                  </button>
                                ))}
                                {!vendor && <button className="primary full" disabled={!!job || rev.status !== 'ready'} onClick={() => generate(part.id)}><RefreshCw size={15} />Generate documents</button>}
                                <p className="muted">PDFs open in a preview; download from there. Unsupported developments are never exported as flat blanks.</p>
                              </>
                            )}
                          </div>
                        </>
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
                              <button className="full" disabled={rev.status !== 'ready' || !!job} onClick={() => action(async () => { setRelease(await api(`/revisions/${rev.id}/release-check`)); setModal('release'); })}><ShieldCheck size={16} />Review release readiness</button>
                              {editable && <button className="full" title="Re-run make/buy name rules and hide small bought-in items on parts you have not classified yet" onClick={() => action(async () => { const r = await api(`/revisions/${rev.id}/reclassify`, 'POST'); await loadRevision(rev.id); notify(`Re-classified ${r.recategorised} parts, hid ${r.hidden} bought-in items. Reviewed parts were left alone.`); })}><RefreshCw size={16} />Re-run classification</button>}
                            </>}
                            <div className="info-card"><Palette size={18} /><p>Parts are coloured by their specified coating colour; uncoated parts use a neutral tone per category. Pick a part in the viewer or navigator to inspect it.</p></div>
                          </div>
                        </>
                      )}
                    </aside>
                  </div>
                )}

                {tab === 'rules' && (
                  <section className="content-page">
                    <div className="page-title"><div><h2>Design checks</h2><p>Explicit coverage. Configurable shop rules. Recorded engineering decisions.</p></div><button onClick={() => setModal('rules')}><Settings size={16} />Rule library</button></div>
                    <div className="summary-cards">
                      <div><span>OPEN BLOCKERS</span><b>{blocking}</b></div>
                      <div><span>WARNINGS</span><b>{findings.filter((f: Any) => f.severity === 'warning' && !f.waiver).length}</b></div>
                      <div><span>REVIEWED PARTS</span><b>{parts.filter((p: Any) => p.reviewed).length}<small> / {parts.length}</small></b></div>
                      <div><span>RULE COVERAGE</span><b className="text-stat">Geometry + manual</b></div>
                    </div>
                    <div className="notice"><ShieldCheck size={18} />A passing CAD check does not certify strength, fatigue, fits or compliance. The library lists what the tool checks and what an engineer must verify.</div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Part</th><th>Rule</th><th>Finding</th><th>Feature</th><th>Status</th></tr></thead>
                        <tbody>
                          {parts.filter((p: Any) => p.category !== 'purchased' && !p.excluded).flatMap((p: Any) => p.findings.map((f: Any, i: number) => (
                            <tr key={p.id + i} onClick={() => { choosePart(p.id); setTab('parts'); }}>
                              <td>{p.name}</td><td><code>{f.code}</code></td><td><strong>{f.title}</strong><small>{f.detail}</small></td><td>{f.feature || '—'}</td>
                              <td><Badge kind={f.waiver ? 'success' : f.severity === 'blocker' ? 'danger' : 'warning'}>{f.waiver ? 'Disposition recorded' : f.severity}</Badge></td>
                            </tr>
                          )))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {tab === 'assembly' && (
                  <section className="content-page">
                    <div className="page-title">
                      <div><h2>Assembly & mating</h2><p>From geometric candidates to toleranced, approved interfaces.</p></div>
                      <div className="flex">
                        <button onClick={() => doc(`/revisions/${rev.id}/assets/assembly.pdf`, 'assembly.pdf', 'Assembly & mating record')}><Eye size={16} />Assembly document</button>
                        {editable && <button className="primary" onClick={() => { setEditing({ data: { label: 'New interface', part_a: parts[0]?.id, part_b: parts[1]?.id || parts[0]?.id, feature_a: '', feature_b: '', fit: '', instructions: '', torque: '' }, approved: false }); setModal('fit'); }}><Plus size={16} />Add interface</button>}
                      </div>
                    </div>
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
                    <ProductionChecklist parts={parts} rows={related} busy={busy} canEdit={['owner', 'engineer', 'qc', 'vendor'].includes(auth.user.role)}
                      onPreview={p => doc(`/parts/${p.id}/assets/drawing.pdf`, p.name + '_drawing.pdf', 'Drawing sheet — ' + p.name)}
                      onSave={async (pid, r) => { await action(async () => { await api(`/revisions/${rev.id}/production/${pid}`, 'PUT', r); await refreshRelated('production'); }); }} />
                  </section>
                )}

                {tab === 'review' && (
                  <section className="content-page review-page">
                    <div className="page-title"><div><h2>Review together</h2><p>Questions and decisions tied to parts, features and this exact revision.</p></div><Badge>{related.filter(r => !r.resolved).length} open threads</Badge></div>
                    <form className="comment-form" onSubmit={e => {
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
                    </form>
                    <div className="comment-list">
                      {related.map(c => (
                        <article key={c.id} className="comment">
                          <div className="avatar">{(c.author || '?')[0]}</div>
                          <div>
                            <header><strong>{c.author}</strong><span>{date(c.created)}</span><Badge kind={c.resolved ? 'success' : 'warning'}>{c.resolved ? 'Resolved' : 'Open'}</Badge></header>
                            <small>{parts.find((p: Any) => p.id === c.part_id)?.name || 'Assembly'} {c.feature && ' / ' + c.feature}</small>
                            <p>{c.body}</p>
                            {!vendor && !c.resolved && editable && <button onClick={() => action(async () => { await api('/comments/' + c.id + '/resolve', 'POST'); await refreshRelated('comments'); })}><Check size={14} />Resolve</button>}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {tab === 'qc' && (
                  <section className="content-page">
                    <div className="page-title">
                      <div><h2>Quality control</h2><p>Feature-level measurements against approved limits, with serial and instrument traceability.</p></div>
                      <div className="flex">
                        <button onClick={() => doc(`/revisions/${rev.id}/qc.csv`, 'qc-revision-' + rev.number + '.csv')}><Download size={16} />Export QC</button>
                        {!vendor && <button className="primary" disabled={rev.status !== 'released'} onClick={() => setModal('qc')}><Plus size={16} />Record inspection</button>}
                      </div>
                    </div>
                    {rev.status !== 'released' && <div className="notice"><ShieldCheck size={17} />Production inspection opens after this revision is released. Set feature limits in the part specifications first.</div>}
                    <div className="summary-cards">
                      <div><span>MEASUREMENTS</span><b>{related.length}</b></div>
                      <div><span>PASS</span><b className="green">{related.filter(x => x.result === 'PASS').length}</b></div>
                      <div><span>NONCONFORMING</span><b className="red">{related.filter(x => x.result === 'FAIL').length}</b></div>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Serial / batch</th><th>Part / feature</th><th>Limits</th><th>Measured</th><th>Result</th><th>Instrument / operator</th></tr></thead>
                        <tbody>
                          {related.map(q => (
                            <tr key={q.id}>
                              <td>{q.serial}</td><td>{parts.find((p: Any) => p.id === q.part_id)?.name}<small>{q.feature}</small></td>
                              <td>{fmt(q.lower_limit)} – {fmt(q.upper_limit)} {q.unit}</td><td>{fmt(q.measured)} {q.unit}</td>
                              <td><Badge kind={q.result === 'PASS' ? 'success' : 'danger'}>{q.result}</Badge></td>
                              <td>{q.instrument}<small>{q.operator} · {date(q.created)}</small></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!related.length && <div className="empty-inline"><ClipboardCheck size={30} /><p>No inspection records for this revision.</p></div>}
                    </div>
                  </section>
                )}

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
          </>
        )}
      </main>

      {error && <div className="error-toast" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}
      {toast && <div className="toast"><CheckCircle2 size={18} />{toast}</div>}
      {excluding && <ExcludeDialog parts={excluding} busy={busy} close={() => setExcluding(null)} onConfirm={reason => action(async () => {
        if (excluding.length === 1) await api('/parts/' + excluding[0].id + '/flags', 'PATCH', { excluded: true, exclusion_reason: reason });
        else await api(`/revisions/${rev.id}/parts/bulk`, 'POST', { ids: excluding.map((p: Any) => p.id), excluded: true, exclusion_reason: reason });
        await loadRevision(rev.id); setExcluding(null); notify(excluding.length === 1 ? `${excluding[0].name} marked not for production` : `${excluding.length} parts marked not for production`);
      })} />}
      {preview && <DocumentPreview blob={preview.blob} name={preview.name} title={preview.title} close={() => setPreview(null)} />}

      {modal === 'project' && (
        <Modal title="New manufacturing project" close={() => setModal('')}>
          <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { const p = await api('/projects', 'POST', Object.fromEntries(f)); await loadProjects(); await openProject(p); setModal('upload'); }); }}>
            <label>Project name<input name="name" placeholder="e.g. OMNI 1.5T — Chassis" required /></label>
            <label>Description<textarea name="description" placeholder="Product, customer, or manufacturing context" /></label>
            <button className="primary full" disabled={busy}>Create project <ArrowUpRight size={16} /></button>
          </form>
        </Modal>
      )}

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
          <p>Give your vendor scoped access to the 3D model, part details, generated documents and review discussions.</p>
          {sharePath ? (
            <>
              <label>Vendor review link<input readOnly value={location.origin + sharePath} onFocus={e => e.target.select()} /></label>
              <button className="primary" onClick={() => action(async () => { await navigator.clipboard.writeText(location.origin + sharePath); notify('Link copied'); })}>Copy link</button>
              <p className="muted">This link stays pinned to revision {rev.number}. Treat it as a password.</p>
            </>
          ) : (
            <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); action(async () => { const s = await api(`/revisions/${rev.id}/shares`, 'POST', { label: f.get('label'), days: Number(f.get('days')) }); setSharePath(s.path); }); }}>
              <label>Vendor name<input name="label" required placeholder="Vendor / reviewer" /></label>
              <label>Expires in<Select name="days" defaultValue="14" options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} /></label>
              <button className="primary full" disabled={busy}><Link size={16} />Create review link</button>
            </form>
          )}
          <button className="full" onClick={() => action(async () => { setModalRows(await api(`/revisions/${rev.id}/shares`)); setModal('shares'); })}>Manage existing links</button>
        </Modal>
      )}

      {modal === 'shares' && (
        <Modal title="Vendor access links" close={() => setModal('')}>
          {modalRows.map(s => (
            <div className="document" key={s.id}>
              <div><strong>{s.label}</strong><small>Expires {date(s.expires)}</small></div>
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
        <Modal title="Release readiness" close={() => setModal('')}>
          {release?.can_release ? (
            <>
              <div className="release-ready"><ShieldCheck size={35} /><h3>Recorded checks are complete</h3><p>Releasing locks this revision and generates the final document pack. Engineering approval remains your responsibility.</p></div>
              <button className="primary full" onClick={() => action(async () => { await api(`/revisions/${rev.id}/release`, 'POST'); await loadRevision(rev.id); setModal(''); })}>Release & generate locked documents</button>
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
        <Modal title="Workspace settings" subtitle="Naming convention and import behaviour for every project" close={() => setModal('')}>
          {!settings ? <p className="muted">Loading…</p> : (
            <form onSubmit={e => { e.preventDefault(); action(async () => { const body = { ...settings, sheet_prefixes: splitList(settings.sheet_prefixes), machining_prefixes: splitList(settings.machining_prefixes), purchased_prefixes: splitList(settings.purchased_prefixes) }; setSettings(await api('/settings', 'PUT', body)); notify('Settings saved. Applies to new uploads; use Re-run classification for the current revision.'); setModal(''); }); }}>
              <h3>Part-number prefixes</h3>
              <p className="muted">Names starting with these prefixes are classified without guessing. Comma-separated, case-insensitive, e.g. <code>SM-, GT-SM</code>.</p>
              <div className="form-grid">
                <label>Sheet metal prefixes<input value={joinList(settings.sheet_prefixes)} placeholder="SM-, SHT-" onChange={e => setSettings({ ...settings, sheet_prefixes: e.target.value })} /></label>
                <label>Machining prefixes<input value={joinList(settings.machining_prefixes)} placeholder="MC-, MACH-" onChange={e => setSettings({ ...settings, machining_prefixes: e.target.value })} /></label>
                <label>Purchased prefixes (optional)<input value={joinList(settings.purchased_prefixes)} placeholder="PUR-, BO-" onChange={e => setSettings({ ...settings, purchased_prefixes: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={!!settings.prefix_strict} onChange={e => setSettings({ ...settings, prefix_strict: e.target.checked })} />Everything that matches no prefix is a purchased item (strict). Off: fall back to name and geometry rules.</label>
              <h3>Import behaviour</h3>
              <label className="check"><input type="checkbox" checked={!!settings.hide_purchased_by_default} onChange={e => setSettings({ ...settings, hide_purchased_by_default: e.target.checked })} />Hide small bought-in items (terminals, lidars, connectors, fasteners, multi-body supplier models) in the viewer by default</label>
              <label className="check"><input type="checkbox" checked={!!settings.carry_over_specs} onChange={e => setSettings({ ...settings, carry_over_specs: e.target.checked })} />Carry manufacturing specifications from the active revision into new uploads (matched by part name, then shape). Approvals and review status are never carried.</label>
              <p className="muted">Prefix rules apply on the next upload. For a revision already imported, use <b>Re-run classification</b> in its overview; parts you classified or reviewed by hand are left untouched.</p>
              <div className="modal-actions"><button className="primary" disabled={busy || !['owner', 'engineer'].includes(auth.user.role)}><Check size={16} />Save settings</button></div>
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
