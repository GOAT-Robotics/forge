import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/* -------------------------------------------------------------------------------------------
   Custom form controls. Native <select> and <datalist> pop-ups take the OS look and cannot be
   styled, so the app draws its own: a Select (single choice) and a Combo (free text + suggestions).
   Both open a portal-mounted popover positioned from the trigger, support keyboard navigation,
   and close on outside click, Escape, scroll or resize.
   ------------------------------------------------------------------------------------------- */

export type Option = { value: string; label: string; hint?: string; disabled?: boolean };

function usePopover(open: boolean, anchor: React.RefObject<HTMLElement | null>, close: () => void) {
  const [rect, setRect] = useState<{ top: number; left: number; width: number; up: boolean; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current) { setRect(null); return; }
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const up = below < 200 && above > below;
      setRect({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, up, maxHeight: Math.max(120, Math.min(320, up ? above : below)) });
    };
    place();
    const onScroll = (e: Event) => { if (e.target instanceof Node && anchor.current && (e.target as Node).contains(anchor.current)) close(); };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', close); document.removeEventListener('scroll', onScroll, true); };
  }, [open, anchor, close]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || document.getElementById('popover-root')?.contains(t)) return;
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, anchor, close]);
  return rect;
}

function popoverRoot() {
  let el = document.getElementById('popover-root');
  if (!el) { el = document.createElement('div'); el.id = 'popover-root'; document.body.appendChild(el); }
  return el;
}

type SelectProps = {
  options: Option[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
};

// Radix Select reserves the empty string; Forge uses '' for "none / default", so it travels as a sentinel.
const EMPTY = '__forge_empty__';
const enc = (v: string | undefined) => (v === '' ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? '' : v);

/** Single-choice select (shadcn / Radix). Options may carry a muted hint (a count, a unit) on the right. */
export function Select({ options, value, defaultValue, onChange, placeholder = 'Choose…', disabled, name, required, size = 'md', className, ...rest }: SelectProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = controlled ? value! : inner;
  const known = options.some(o => o.value === current);
  return (
    <>
      <UiSelect value={known ? enc(current) : undefined} disabled={disabled} onValueChange={v => { const d = dec(v); if (!controlled) setInner(d); onChange?.(d); }}>
        <SelectTrigger size={size === 'sm' ? 'sm' : 'default'} aria-label={rest['aria-label']} className={cn('w-full min-w-0 justify-between', className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80 min-w-[var(--radix-select-trigger-width)]">
          {options.map((o, i) => (
            <SelectItem key={o.value + i} value={enc(o.value)!} disabled={o.disabled} hint={o.hint}>{o.label}</SelectItem>
          ))}
          {!options.length && <div className="px-2 py-1.5 text-sm text-muted-foreground">No options</div>}
        </SelectContent>
      </UiSelect>
      {name && <input type="hidden" name={name} value={current} required={required} />}
    </>
  );
}

type ComboProps = {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  autoFocus?: boolean;
};

/** Text input with a styled suggestion list (replaces <input list> + <datalist>). Free text is always allowed. */
export function Combo({ value, onChange, suggestions, placeholder, disabled, size = 'md', autoFocus, ...rest }: ComboProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  const rect = usePopover(open, anchor, close);
  const q = (value || '').trim().toLowerCase();
  const matches = q ? suggestions.filter(s => s.toLowerCase().includes(q)) : suggestions;
  const shown = matches.slice(0, 40);
  useEffect(() => { if (open) listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  const pick = (s: string) => { onChange(s); setOpen(false); input.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); setActive(a => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(-1, a - 1)); }
    else if (e.key === 'Enter') { if (open && active >= 0 && shown[active]) { e.preventDefault(); pick(shown[active]); } else setOpen(false); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); } }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div ref={anchor} className="relative w-full">
      <input ref={input} className={cn('w-full min-w-0 rounded-md border border-input bg-card pr-8 pl-2.5 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50', size === 'sm' ? 'h-7' : 'h-8')} value={value ?? ''} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} aria-label={rest['aria-label']} autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKey} />
      <button type="button" tabIndex={-1} className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent disabled:opacity-50" aria-label="Show suggestions" disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => { setOpen(o => !o); input.current?.focus(); }}><ChevronDown size={14} /></button>
      {open && rect && shown.length > 0 && createPortal(
        <div ref={listRef} className="fixed z-50 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-pop animate-in fade-in-0 zoom-in-95" role="listbox" style={{ top: rect.up ? undefined : rect.top, bottom: rect.up ? window.innerHeight - rect.top : undefined, left: rect.left, width: rect.width, maxHeight: rect.maxHeight }}>
          {shown.map((s, i) => (
            <div key={s} role="option" aria-selected={s === value} data-active={i === active} className={cn('flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm select-none', i === active && 'bg-accent text-accent-foreground', s === value && 'font-medium')}
              onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(s)}>
              <span className="truncate">{s}</span>{s === value && <Check className="size-3.5 text-primary" />}
            </div>
          ))}
          {matches.length > shown.length && <div className="px-2 py-1.5 text-xs text-muted-foreground">Keep typing to narrow {matches.length} matches</div>}
        </div>, popoverRoot())}
    </div>
  );
}
