import React, { useEffect, useRef, useState } from 'react';
import { LayoutDashboard, FolderKanban, ClipboardList, Library, Settings, Moon, Sun, Monitor, LogOut, Search, ScrollText, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import type { Any } from './constants';

export type Page = 'dashboard' | 'projects' | 'project' | 'joborders' | 'joborder' | 'templates' | 'admin';

type Theme = 'light' | 'dark' | 'system';
function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
export function initTheme() {
  let t: Theme = 'system';
  try { t = (localStorage.getItem('forge-theme') as Theme) || 'system'; } catch { /* storage unavailable */ }
  applyTheme(t);
  return t;
}

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path d="M10 23V9h12M10 16h9" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const initials = (name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="v-avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${h} 45% 88%)`, color: `hsl(${h} 45% 30%)` }}>{initials}</span>;
}

type NavItem = { id: Page; label: string; icon: React.ReactNode; badge?: number; show?: boolean };

export function Sidebar({ page, go, user, perms, badges, onSignOut }: { page: Page; go: (p: Page) => void; user: Any; perms: Set<string>; badges: { joborders?: number }; onSignOut: () => void }) {
  // CAD-tool rail: icons only, labels as tooltips; the workspace gets the width.
  useEffect(() => {
    document.documentElement.style.setProperty('--rail', '56px');
    return () => { document.documentElement.style.removeProperty('--rail'); };
  }, []);
  const nav: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
    { id: 'projects', label: 'Projects', icon: <FolderKanban /> },
    { id: 'joborders', label: 'Job orders', icon: <ClipboardList />, badge: badges.joborders },
    { id: 'templates', label: 'Templates', icon: <Library /> },
    { id: 'admin', label: 'Administration', icon: <Settings />, show: perms.has('users.manage') },
  ];
  const active = (id: Page) => page === id || (id === 'projects' && page === 'project') || (id === 'joborders' && page === 'joborder');
  return (
    <aside className="v-sidebar rail">
      <button type="button" className="rail-logo" title="Forge · GOAT Robotics" onClick={() => go('dashboard')}><LogoMark size={28} /></button>
      <nav aria-label="Main">
        {nav.filter(n => n.show !== false).map(n => (
          <button key={n.id} data-tip={n.label} aria-label={n.label} className={'v-nav' + (active(n.id) ? ' active' : '')} aria-current={active(n.id) ? 'page' : undefined} onClick={() => go(n.id)}>
            {n.icon}{n.badge ? <em>{n.badge}</em> : null}
          </button>
        ))}
      </nav>
      <div className="v-sidebar-foot"><UserMenu user={user} onSignOut={onSignOut} /></div>
    </aside>
  );
}

function UserMenu({ user, onSignOut }: { user: Any; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { try { setTheme((localStorage.getItem('forge-theme') as Theme) || 'system'); } catch { /* ignore */ } }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const pick = (t: Theme) => { setTheme(t); try { localStorage.setItem('forge-theme', t); } catch { /* ignore */ } applyTheme(t); };
  return (
    <div className="v-usermenu" ref={ref}>
      <button className="v-user" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar name={user.name} />
        <span><b>{user.name}</b><small>{String(user.role || '').replace('owner', 'admin')}</small></span>
      </button>
      {open && (
        <div className="v-menu" role="menu">
          <div className="v-menu-label">{user.email}</div>
          <hr />
          <button role="menuitem" onClick={() => pick('light')}><Sun />Light{theme === 'light' && ' ✓'}</button>
          <button role="menuitem" onClick={() => pick('dark')}><Moon />Dark{theme === 'dark' && ' ✓'}</button>
          <button role="menuitem" onClick={() => pick('system')}><Monitor />System{theme === 'system' && ' ✓'}</button>
          <hr />
          <button role="menuitem" onClick={onSignOut}><LogOut />Sign out</button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ children, onSearch, right }: { children?: React.ReactNode; onSearch?: (q: string) => void; right?: React.ReactNode }) {
  return (
    <header className="v-header">
      {onSearch && (
        <form className="v-search" onSubmit={e => { e.preventDefault(); onSearch(String(new FormData(e.currentTarget).get('q') || '')); }}>
          <Search /><input name="q" placeholder="Search projects, parts, job orders…" aria-label="Search" />
        </form>
      )}
      <div className="v-crumbs">{children}</div>
      <div className="v-header-right">{right}</div>
    </header>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="v-pagehead">
      {breadcrumb && <div className="v-breadcrumb">{breadcrumb}</div>}
      <div className="v-pagehead-row">
        <div className="min0"><h1>{title}</h1>{description && <p>{description}</p>}</div>
        {actions && <div className="v-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: string }) {
  return <span className={'v-progress ' + (tone || '')}><i style={{ width: Math.max(0, Math.min(100, value)) + '%' }} /></span>;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="v-empty">{icon}<h3>{title}</h3>{children}</div>;
}

export const AuditIcon = ScrollText;
