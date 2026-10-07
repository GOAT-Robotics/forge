# Forge UI guide (Tailwind v4 + shadcn/ui)

Forge is a dense engineering tool: calm, light-weight type, neutral surfaces and one blue accent. Every screen is
built from Tailwind utilities and the shadcn components in `src/components/ui/`. There is no hand-written page CSS.

## Foundations

- **Type:** Geist (sans) and Geist Mono, self-hosted. Body is `text-sm` (13 px). The scale is `text-2xs` 11 · `text-xs` 12 ·
  `text-sm` 13 · `text-base` 14 · `text-lg` 16 · `text-xl` 18 · `text-2xl` 22.
- **Weights:** 400 normal, `font-medium` 500 for labels and buttons, `font-semibold` 580 for titles and key numbers.
  Never use `font-bold`, `font-extrabold` or `<b>` for decoration. `<b>`/`<strong>` render at 560.
- **Colour tokens (light and dark handled automatically):**
  - surfaces: `bg-background` (app), `bg-card` (panels, cards), `bg-subtle` (inset areas), `bg-muted` / `bg-accent` (hover, neutral fills), `bg-popover`
  - text: `text-foreground`, `text-muted-foreground` (secondary), `text-faint` (tertiary, captions)
  - lines: `border` (uses `border-border`), `border-input` for fields
  - accent: `bg-primary text-primary-foreground` (primary action), selection: `bg-selection text-selection-foreground`
  - status: `text-success bg-success-soft`, `text-warning bg-warning-soft`, `text-destructive bg-danger-soft`
  - part types: `text-machining`, `text-sheet`, `text-purchased`, `text-other` (and `bg-*` with `/10` etc. for tints)
  - 3D: `bg-viewer` canvas backdrop; floating canvas panels use the `glass` utility (`glass rounded-xl`)
  - app rail: `bg-sidebar text-sidebar-foreground`
- **Radius:** `rounded-md` for controls, `rounded-lg` for cards and menus, `rounded-xl` for floating canvas panels.
- **Shadows:** cards have none (border only). Popovers and floating panels: `shadow-pop`.
- **Icons:** lucide, `size-4` in buttons and rows (shadcn sets this automatically inside `Button`), `size-3.5` in tight rows.
  Pass icons as children without `size={…}` where possible; use `className="size-4"` otherwise.

## Sizing (density)

- Buttons: `Button` default is h-8; `size="sm"` h-7 for toolbars and rows; `size="xs"` h-6 for chips;
  icon buttons `size="icon"` (32) / `"icon-sm"` (28) / `"icon-xs"` (24). Inputs and selects are h-8.
- Spacing: panels `p-4`, dense lists `px-3 py-2`, section gap `gap-4`, field gap `gap-1.5` (label → control).
- Page content: `mx-auto w-full max-w-6xl px-6 py-6` (wider tables may use `max-w-7xl`).

## Components to use

| Need | Use |
|---|---|
| Any button | `Button` (`default` primary, `outline` secondary, `ghost` toolbar/icon, `destructive`, `link`) |
| Text field / area | `Input`, `Textarea`, with `Label` |
| Choice | `Select` from `src/controls.tsx` (API unchanged: `options`, `value`, `onChange`, `size="sm"`) · free text with suggestions: `Combo` |
| On/off | `Switch` (settings), `Checkbox` (lists, forms) |
| One of a few | `ToggleGroup type="single"` (segmented control) or `RadioGroup` |
| Tabs | `Tabs`/`TabsList`/`TabsTrigger` (keep the existing state; pass `value`/`onValueChange`) |
| Menus (⋯, overflow) | `DropdownMenu` with `DropdownMenuItem` (icon first, then label), `DropdownMenuSeparator` |
| Small floating panel | `Popover` |
| Dialog | `Modal` from `src/components.tsx` (shadcn Dialog; body scrolls) with `ModalFooter` as the last child for actions. `ask()` for confirm / prompt |
| Status pill | `Badge` from `src/components.tsx` (`kind`: success · warning · danger · accent · neutral) |
| Hints | `Tooltip` for icon-only buttons (a `title` attribute is acceptable inside dense canvas toolbars) |
| Tables | `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableCell` |
| Progress | `Progress` from `src/shell.tsx` (thin bar with `tone`) |
| Empty states | `Empty` from `src/shell.tsx` |
| Slider | `Slider` |
| Scrolling panes | plain `overflow-y-auto` (or `ScrollArea` for fixed-height lists) |
| Toasts | `toast()` from `sonner` |
| Keys | `Kbd` |

## Patterns

- **Section title (eyebrow):** `text-2xs font-medium uppercase tracking-wider text-muted-foreground`.
- **Key / value row:** `flex items-center justify-between gap-3 py-1.5 text-sm` · key `text-muted-foreground` · value `text-foreground text-right`.
- **Card:** `rounded-lg border bg-card p-4` (no shadow). Inset: `rounded-md bg-subtle p-3`.
- **List row:** `flex items-center gap-3 rounded-md px-3 py-2 hover:bg-accent`, selected `bg-selection text-selection-foreground`.
- **Numbers:** `tabular-nums`; money right-aligned.
- **Notices:** `Alert` (or `rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning`).
- **Floating canvas UI:** `glass rounded-xl p-1` containers holding `Button variant="ghost" size="icon-sm"`.
- One primary button per view. Secondary actions are `outline` or `ghost`; rare ones go into a ⋯ `DropdownMenu`.

## Rules for code

- Keep behaviour, props, state, API calls, `aria-*`, `role`, `data-*` attributes and keyboard handling exactly as they are.
  This is a visual rewrite only.
- Replace every legacy class name (from `style.css` / `cad.css`) with utilities or components. When done, no legacy class
  may remain in your files (`style.css` and `cad.css` are deleted at the end).
- A legacy class that JavaScript reads (`querySelector`, `closest`, `classList`) must be replaced consistently in the JS too.
  Dialogs are detected with `document.querySelector('[data-slot="dialog-content"]')` (not `.overlay`).
- CSS that utilities cannot express (SVG drawing internals, keyframes, third-party DOM such as the pdf.js text layer,
  `@font-face`) goes into `src/styles/<area>.css`, written with `var(--ui-*)` tokens, imported from `src/index.css`.
  Keep these files small.
- Use `cn()` from `@/lib/utils` to combine conditional classes.
- Check with `npx tsc -p tsconfig.json --noEmit` and `npx vite build` from `frontend/`.
