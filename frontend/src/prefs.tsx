import React, { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Keyboard, RotateCcw } from 'lucide-react';
import { Modal } from './components';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { NavStyle } from './cadControls';
import type { DisplayMode } from './Viewer';

/** Keyboard actions of the CAD workspace and their default keys (SolidWorks-like where the browser allows). */
export const ACTIONS: { id: string; label: string; group: string; key: string }[] = [
  { id: 'view.front', label: 'Front view', group: 'View', key: '1' },
  { id: 'view.back', label: 'Back view', group: 'View', key: '2' },
  { id: 'view.left', label: 'Left view', group: 'View', key: '3' },
  { id: 'view.right', label: 'Right view', group: 'View', key: '4' },
  { id: 'view.top', label: 'Top view', group: 'View', key: '5' },
  { id: 'view.bottom', label: 'Bottom view', group: 'View', key: '6' },
  { id: 'view.iso', label: 'Isometric view', group: 'View', key: '7' },
  { id: 'view.normal', label: 'Normal to selected part', group: 'View', key: '8' },
  { id: 'view.fit', label: 'Zoom to fit', group: 'View', key: 'F' },
  { id: 'view.zoomSelected', label: 'Zoom to selection', group: 'View', key: 'Z' },
  { id: 'view.rotLeft', label: 'Rotate left 15° (Shift: 90°)', group: 'View', key: 'ArrowLeft' },
  { id: 'view.rotRight', label: 'Rotate right 15° (Shift: 90°)', group: 'View', key: 'ArrowRight' },
  { id: 'view.rotUp', label: 'Rotate up 15° (Shift: 90°)', group: 'View', key: 'Alt+ArrowUp' },
  { id: 'view.rotDown', label: 'Rotate down 15° (Shift: 90°)', group: 'View', key: 'Alt+ArrowDown' },
  { id: 'view.rollLeft', label: 'Roll counter-clockwise', group: 'View', key: 'Alt+ArrowLeft' },
  { id: 'view.rollRight', label: 'Roll clockwise', group: 'View', key: 'Alt+ArrowRight' },
  { id: 'view.planes', label: 'Show / hide Front, Top, Right planes', group: 'View', key: 'P' },
  { id: 'display.shaded', label: 'Shaded', group: 'Display', key: 'Shift+1' },
  { id: 'display.edges', label: 'Shaded with edges', group: 'Display', key: 'Shift+2' },
  { id: 'display.wireframe', label: 'Wireframe', group: 'Display', key: 'Shift+3' },
  { id: 'display.cycle', label: 'Next display style', group: 'Display', key: 'D' },
  { id: 'part.isolate', label: 'Isolate selection', group: 'Parts', key: 'I' },
  { id: 'part.hide', label: 'Hide / show selection in viewer', group: 'Parts', key: 'H' },
  { id: 'part.showHidden', label: 'Show purchased & hidden parts', group: 'Parts', key: 'Shift+H' },
  { id: 'part.transparent', label: 'Make selection transparent', group: 'Parts', key: 'T' },
  { id: 'part.opaque', label: 'Make all parts opaque', group: 'Parts', key: 'Shift+T' },
  { id: 'part.ghost', label: 'Ghost other parts while selecting', group: 'Parts', key: 'G' },
  { id: 'part.next', label: 'Next part', group: 'Parts', key: 'ArrowDown' },
  { id: 'part.prev', label: 'Previous part', group: 'Parts', key: 'ArrowUp' },
  { id: 'part.selectAll', label: 'Select all listed parts', group: 'Parts', key: 'Ctrl+A' },
  { id: 'select.clear', label: 'Clear selection / leave focus', group: 'Parts', key: 'Escape' },
  { id: 'tool.measure', label: 'Measure', group: 'Tools', key: 'M' },
  { id: 'tool.section', label: 'Section plane', group: 'Tools', key: 'X' },
  { id: 'tool.explode', label: 'Explode / collapse', group: 'Tools', key: 'E' },
  { id: 'layout.focus', label: 'Focus the canvas (hide panels)', group: 'Tools', key: 'Shift+F' },
  { id: 'help.shortcuts', label: 'Shortcuts & navigation', group: 'Tools', key: 'Shift+/' },
];

export type Prefs = { shortcuts: Record<string, string>; navStyle: NavStyle; displayMode: DisplayMode; showPlanes: boolean; realistic: boolean; studio: boolean };
const DEFAULTS: Prefs = { shortcuts: {}, navStyle: 'forge', displayMode: 'shaded', showPlanes: false, realistic: true, studio: false };
const KEY = 'forge-prefs';

/** The key combination of a keyboard event as written in the bindings ("Ctrl+Shift+F", "Alt+ArrowUp", "7"). */
export function comboOf(e: KeyboardEvent | React.KeyboardEvent) {
  const code = e.code || '';
  let key = code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : code.startsWith('Numpad') && /\d$/.test(code) ? code.slice(6)
    : ({ Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`', Space: 'Space' } as Record<string, string>)[code] || e.key;
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return '';
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

export function loadPrefs(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function usePrefs() {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  // Signed in → prefs live on the user's account (follow them across browsers and sessions);
  // localStorage is only a fast first paint / offline copy.
  const remote = useRef(false); const timer = useRef<number | undefined>(undefined);
  const push = (next: Prefs) => {
    if (!remote.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { api('/me/prefs', 'PUT', next).catch(() => { /* kept locally; retried on next change */ }); }, 400);
  };
  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(p => {
    const next = { ...p, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window: keep in memory */ }
    push(next);
    return next;
  });
  /** Called after sign-in with the prefs stored on the account (null on sign-out). */
  const adopt = (server: Partial<Prefs> | null | undefined) => {
    if (server === null) { remote.current = false; return; }
    remote.current = true;
    if (server && Object.keys(server).length) {
      const next = { ...DEFAULTS, ...server, shortcuts: { ...(server.shortcuts || {}) } };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      setPrefsState(next);
    } else setPrefsState(p => { push(p); return p; });  // first sign-in after this change: move this browser's settings to the account
  };
  const binding = (id: string) => prefs.shortcuts[id] ?? ACTIONS.find(a => a.id === id)?.key ?? '';
  /** Action for a key combination; rotate actions also fire with Shift added (90° steps). */
  const actionFor = (combo: string): { id: string; big: boolean } | null => {
    for (const a of ACTIONS) { const b = binding(a.id); if (b && b === combo) return { id: a.id, big: false }; }
    if (combo.includes('Shift+')) {
      const plain = combo.replace('Shift+', '');
      for (const a of ACTIONS) if (a.id.startsWith('view.rot') && binding(a.id) === plain) return { id: a.id, big: true };
    }
    return null;
  };
  return { prefs, setPrefs, binding, actionFor, adopt };
}

const pretty = (b: string) => b.replace('Ctrl', /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl').replace(/Arrow(Up|Down|Left|Right)/, (_m, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' } as Record<string, string>)[d]);

export function KeyChip({ combo }: { combo: string }) {
  return combo ? <KbdGroup>{pretty(combo).split('+').map((k, i) => <Kbd key={i} className="border border-b-2 bg-card font-mono text-2xs text-foreground">{k}</Kbd>)}</KbdGroup> : <span className="text-muted-foreground">—</span>;
}

/** Personal shortcuts and mouse navigation (saved in this browser). Click a key, press the new combination. */
export function ShortcutsDialog({ close, prefs, setPrefs, binding }: ReturnType<typeof usePrefs> & { close: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape' && !e.shiftKey && !e.altKey && !e.ctrlKey) { setEditing(null); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { setPrefs({ shortcuts: { ...prefs.shortcuts, [editing]: '' } }); setEditing(null); return; }
      const combo = comboOf(e); if (!combo) return;
      // one key, one action: take it away from the action that had it
      const next = { ...prefs.shortcuts };
      for (const a of ACTIONS) if (a.id !== editing && binding(a.id) === combo) next[a.id] = '';
      next[editing] = combo;
      setPrefs({ shortcuts: next }); setEditing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, prefs.shortcuts]);
  const groups = [...new Set(ACTIONS.map(a => a.group))];
  return (
    <Modal title="Shortcuts & navigation" subtitle="Personal — saved to your account, on every device" close={() => { if (!editing) close(); }} wide>
      <div className="grid gap-6">
        <section className="grid gap-2.5">
          <h4 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">Mouse</h4>
          <RadioGroup value={prefs.navStyle} onValueChange={v => setPrefs({ navStyle: v as NavStyle })} className="grid gap-2.5 sm:grid-cols-2">
            {([['forge', 'Forge', 'Left drag rotates · right / middle drag pans · wheel zooms at the cursor · click selects'],
               ['solidworks', 'SolidWorks', 'Middle drag rotates · Ctrl+middle pans · Shift+middle zooms · right drag pans · wheel zooms at the cursor · left click / drag stays for selection']] as const).map(([k, l, d]) =>
              <Label key={k} htmlFor={'nav-' + k} className={cn('min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50', prefs.navStyle === k && 'border-primary bg-selection/40 hover:bg-selection/40')}>
                <RadioGroupItem id={'nav-' + k} value={k} className="mt-0.5" />
                <span className="grid min-w-0 gap-1"><span className="font-medium">{l}</span><span className="text-xs leading-relaxed font-normal text-muted-foreground">{d}</span></span>
              </Label>)}
          </RadioGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">Rotation is free in every direction (no locked “up”), like a parametric modeller. Arrow keys rotate 15°, with Shift 90°; Alt+←/→ rolls.</p>
        </section>
        <section className="grid gap-1">
          <div className="flex items-center gap-2.5">
            <h4 className="flex-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase">Keyboard</h4>
            <Input className="h-7 max-w-[260px] text-xs" placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />
            <Button type="button" variant="outline" size="sm" onClick={() => setPrefs({ shortcuts: {} })}><RotateCcw />Defaults</Button>
          </div>
          {groups.map(g => {
            const rows = ACTIONS.filter(a => a.group === g && (!filter || a.label.toLowerCase().includes(filter.toLowerCase())));
            if (!rows.length) return null;
            return <div key={g} className="grid">
              <h5 className="mt-3 mb-1 px-2 text-2xs font-medium tracking-wider text-faint uppercase">{g}</h5>
              {rows.map(a => <div key={a.id} className={cn('flex items-center justify-between gap-3 rounded-md px-2 py-0.5 hover:bg-accent', editing === a.id && 'bg-selection text-selection-foreground hover:bg-selection')}>
                <span className="min-w-0 truncate">{a.label}</span>
                <Button type="button" variant="ghost" size="sm" className="min-w-[120px] justify-end font-normal hover:bg-transparent" title="Click, then press the new key combination (Backspace clears, Esc cancels)" onClick={() => setEditing(a.id)}>
                  {editing === a.id ? <span className="flex items-center gap-1 text-muted-foreground"><Keyboard className="size-3.5" /> Press keys…</span> : <KeyChip combo={binding(a.id)} />}
                </Button>
              </div>)}
            </div>;
          })}
        </section>
      </div>
    </Modal>
  );
}
