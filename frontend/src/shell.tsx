import React, { useEffect, useState } from 'react';
import { LayoutDashboard, FolderKanban, ClipboardList, Library, Settings, Moon, Sun, Monitor, LogOut, Search, ScrollText, PanelLeftOpen, PanelLeftClose, IndianRupee } from 'lucide-react';
import type { Any } from './constants';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type Page = 'dashboard' | 'projects' | 'project' | 'joborders' | 'joborder' | 'templates' | 'pricing' | 'admin';

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
      <rect width="32" height="32" rx="7" fill="var(--ui-primary)" />
      <path d="M10 23V9h12M10 16h9" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const initials = (name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="inline-grid shrink-0 place-items-center rounded-full font-medium" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 45% 88%)`, color: `hsl(${h} 45% 30%)` }}>{initials}</span>;
}

type NavItem = { id: Page; label: string; icon: React.ReactNode; badge?: number; show?: boolean };

/** App rail: icons only with tooltips, the workspace gets the width. */
export function Sidebar({ page, go, user, perms, badges, onSignOut }: { page: Page; go: (p: Page) => void; user: Any; perms: Set<string>; badges: { joborders?: number }; onSignOut: () => void }) {
  const nav: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
    { id: 'projects', label: 'Projects', icon: <FolderKanban /> },
    { id: 'joborders', label: 'Job orders', icon: <ClipboardList />, badge: badges.joborders },
    { id: 'templates', label: 'Templates', icon: <Library /> },
    { id: 'pricing', label: 'Vendors & pricing', icon: <IndianRupee />, show: perms.has('pricing.manage') || perms.has('joborder.create') },
    { id: 'admin', label: 'Administration', icon: <Settings />, show: perms.has('users.manage') },
  ];
  const active = (id: Page) => page === id || (id === 'projects' && page === 'project') || (id === 'joborders' && page === 'joborder');
  return (
    <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-1 bg-sidebar py-3 text-sidebar-foreground">
      <button type="button" className="mb-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Forge · GOAT Robotics" onClick={() => go('dashboard')}><LogoMark size={30} /></button>
      <nav aria-label="Main" className="flex flex-col items-center gap-1">
        {nav.filter(n => n.show !== false).map(n => (
          <Tooltip key={n.id}>
            <TooltipTrigger asChild>
              <button type="button" aria-label={n.label} aria-current={active(n.id) ? 'page' : undefined} onClick={() => go(n.id)}
                className={cn('relative grid size-10 place-items-center rounded-lg transition-colors [&_svg]:size-[18px] [&_svg]:stroke-[1.75]',
                  active(n.id) ? 'bg-white/10 text-white before:absolute before:top-2 before:-left-2 before:h-6 before:w-[3px] before:rounded-r before:bg-primary' : 'hover:bg-white/5 hover:text-white')}>
                {n.icon}
                {n.badge ? <span className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white">{n.badge}</span> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{n.label}</TooltipContent>
          </Tooltip>
        ))}
      </nav>
      <div className="mt-auto"><UserMenu user={user} onSignOut={onSignOut} /></div>
    </aside>
  );
}

function UserMenu({ user, onSignOut }: { user: Any; onSignOut: () => void }) {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => { try { setTheme((localStorage.getItem('forge-theme') as Theme) || 'system'); } catch { /* ignore */ } }, []);
  const pick = (t: Theme) => { setTheme(t); try { localStorage.setItem('forge-theme', t); } catch { /* ignore */ } applyTheme(t); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account" className="grid size-10 place-items-center rounded-lg outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring"><Avatar name={user.name} size={28} /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-60">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="truncate text-sm font-medium">{user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{user.email} · {String(user.role || '').replace('owner', 'admin')}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={v => pick(v as Theme)}>
          <DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor />System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}><LogOut />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar({ children, onSearch, right }: { children?: React.ReactNode; onSearch?: (q: string) => void; right?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-card px-4">
      {onSearch && (
        <form className="relative w-72" onSubmit={e => { e.preventDefault(); onSearch(String(new FormData(e.currentTarget).get('q') || '')); }}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" placeholder="Search projects, parts, job orders…" aria-label="Search" className="pl-8" />
        </form>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">{children}</div>
      <div className="flex items-center gap-2">{right}</div>
    </header>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-6 grid gap-1.5">
      {breadcrumb && <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{breadcrumb}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}</div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: string }) {
  const bar = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : tone === 'danger' ? 'bg-destructive' : 'bg-primary';
  return <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"><i className={cn('block h-full rounded-full transition-[width]', bar)} style={{ width: Math.max(0, Math.min(100, value)) + '%' }} /></span>;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="grid place-items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center text-sm text-muted-foreground [&>svg]:size-8 [&>svg]:text-faint"><>{icon}</><h3 className="text-base font-semibold text-foreground">{title}</h3>{children}</div>;
}

export const AuditIcon = ScrollText;
