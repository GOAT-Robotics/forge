import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

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

export function Select({ options, value, defaultValue, onChange, placeholder = 'Choose…', disabled, name, required, size = 'md', className, ...rest }: SelectProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const current = controlled ? value! : inner;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  const rect = usePopover(open, anchor, close);
  const selected = options.find(o => o.value === current);

  const choose = (v: string) => { if (!controlled) setInner(v); onChange?.(v); setOpen(false); anchor.current?.focus(); };
  const openList = () => { if (disabled) return; setActive(Math.max(0, options.findIndex(o => o.value === current))); setOpen(true); };
  useEffect(() => { if (open) listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = options[active]; if (o && !o.disabled) choose(o.value); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1) { const i = options.findIndex(o => o.label.toLowerCase().startsWith(e.key.toLowerCase())); if (i >= 0) setActive(i); }
  };

  return (
    <>
      <button type="button" ref={anchor} className={'select-trigger' + (size === 'sm' ? ' sm' : '') + (open ? ' open' : '') + (className ? ' ' + className : '')} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={rest['aria-label']} onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKey}>
        <span className={selected ? '' : 'placeholder'}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={15} />
      </button>
      {name && <input type="hidden" name={name} value={current} required={required} />}
      {open && rect && createPortal(
        <div ref={listRef} className={'popover' + (rect.up ? ' up' : '')} role="listbox" style={{ top: rect.up ? undefined : rect.top, bottom: rect.up ? window.innerHeight - rect.top : undefined, left: rect.left, width: rect.width, maxHeight: rect.maxHeight }}>
          {options.map((o, i) => (
            <div key={o.value + i} role="option" aria-selected={o.value === current} data-active={i === active} className={'popover-item' + (o.value === current ? ' selected' : '') + (i === active ? ' active' : '') + (o.disabled ? ' disabled' : '')}
              onMouseEnter={() => setActive(i)} onClick={() => !o.disabled && choose(o.value)}>
              <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>
              {o.value === current && <Check size={14} />}
            </div>
          ))}
          {!options.length && <div className="popover-empty">No options</div>}
        </div>, popoverRoot())}
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
    <div ref={anchor} className={'combo' + (size === 'sm' ? ' sm' : '')}>
      <input ref={input} value={value ?? ''} placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} aria-label={rest['aria-label']} autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKey} />
      <button type="button" tabIndex={-1} className="combo-toggle" aria-label="Show suggestions" disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => { setOpen(o => !o); input.current?.focus(); }}><ChevronDown size={14} /></button>
      {open && rect && shown.length > 0 && createPortal(
        <div ref={listRef} className={'popover' + (rect.up ? ' up' : '')} role="listbox" style={{ top: rect.up ? undefined : rect.top, bottom: rect.up ? window.innerHeight - rect.top : undefined, left: rect.left, width: rect.width, maxHeight: rect.maxHeight }}>
          {shown.map((s, i) => (
            <div key={s} role="option" aria-selected={s === value} data-active={i === active} className={'popover-item' + (s === value ? ' selected' : '') + (i === active ? ' active' : '')}
              onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(s)}>
              <span>{s}</span>{s === value && <Check size={14} />}
            </div>
          ))}
          {matches.length > shown.length && <div className="popover-empty">Keep typing to narrow {matches.length} matches</div>}
        </div>, popoverRoot())}
    </div>
  );
}
