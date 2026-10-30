import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FacetOption } from '../../features/catalog/catalog.selectors';

export interface FacetSelectProps {
  readonly label: string;
  readonly options: readonly FacetOption[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
}

const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const MENU_MIN_WIDTH = 220;
const MENU_MAX_HEIGHT = 320;

/** Close callbacks of the mounted facets: opening one panel folds every other panel. */
const openMenus = new Set<() => void>();

interface MenuLayout {
  readonly top?: number;
  readonly bottom?: number;
  readonly left: number;
  readonly minWidth: number;
  readonly maxHeight: number;
}

/**
 * The panel is `position: fixed`, anchored on the trigger: the filter row scrolls horizontally on
 * mobile (`overflow-x: auto`), so an absolutely positioned panel would be clipped there.
 * `contentHeight` decides whether the panel can fit below or must flip above the trigger.
 */
function computeLayout(rect: DOMRect, contentHeight: number): MenuLayout {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN - MENU_GAP;
  const spaceAbove = rect.top - VIEWPORT_MARGIN - MENU_GAP;
  const needed = Math.min(contentHeight, MENU_MAX_HEIGHT);
  const opensUpwards = spaceBelow < needed && spaceAbove > spaceBelow;
  const available = Math.max(96, opensUpwards ? spaceAbove : spaceBelow);
  const minWidth = Math.max(MENU_MIN_WIDTH, rect.width);
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, viewportWidth - minWidth - VIEWPORT_MARGIN),
  );

  return {
    ...(opensUpwards
      ? { bottom: viewportHeight - rect.top + MENU_GAP }
      : { top: rect.bottom + MENU_GAP }),
    left,
    minWidth,
    maxHeight: Math.min(MENU_MAX_HEIGHT, available),
  };
}

/** Measures the pill and the panel content; `null` when nothing is mounted yet. */
function layoutFor(pill: HTMLElement | null, menu: HTMLElement | null): MenuLayout | null {
  const rect = pill?.getBoundingClientRect();
  if (!rect) return null;
  const contentHeight = Math.min(menu?.scrollHeight ?? MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);
  return computeLayout(rect, contentHeight);
}

function ChevronIcon() {
  return (
    <svg className="facet-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Presentational and controlled: renders one facet (Architecture, Engine) and reports toggles. */
export function FacetSelect({ label, options, selected, onToggle }: FacetSelectProps) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `facet-menu-${useId().replace(/:/g, '')}`;

  // Opening a panel folds the other one: at most one menu is open at a time.
  useEffect(() => {
    const close = () => setOpen(false);
    openMenus.add(close);
    return () => {
      openMenus.delete(close);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    // The trigger moves when the row scrolls or the window is resized: the panel follows it.
    function reposition() {
      const next = layoutFor(triggerRef.current, menuRef.current);
      if (next) setLayout(next);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // The pill grows when it becomes active (border, count badge): measure once it is laid out.
  useLayoutEffect(() => {
    if (!open) return;
    const next = layoutFor(triggerRef.current, menuRef.current);
    if (next) setLayout(next);
  }, [open, selected.length]);

  function openMenu() {
    for (const close of openMenus) close();
    setOpen(true);
  }

  function closeMenu(returnFocus = false) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    closeMenu(true);
  }

  const isActive = selected.length > 0 || open;

  return (
    <div
      className="facet"
      ref={rootRef}
      data-open={open}
      data-facet={label.toLocaleLowerCase('en')}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`facet-trigger${isActive ? ' is-active' : ''}`}
        aria-label={`${label} filter, ${
          selected.length === 0 ? 'no selection' : `${selected.length} selected`
        }`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        <span className="facet-label">{label}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="facet-menu"
          id={menuId}
          role="group"
          aria-label={label}
          style={layout ?? undefined}
        >
          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            const isEmpty = option.count === 0 && !isSelected;
            return (
              <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                className={`facet-option${isSelected ? ' is-selected' : ''}${
                  isEmpty ? ' is-empty' : ''
                }`}
                data-value={option.value}
                disabled={isEmpty}
                onClick={() => onToggle(option.value)}
              >
                <span className="facet-option-label">{option.label}</span>
                <span className="facet-option-count">{option.count}</span>
                <span className="facet-option-check" aria-hidden="true">
                  {isSelected ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
