import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface VariantOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface VariantDropdownProps {
  readonly variants: readonly VariantOption[];
  /** id de la variante actuellement sélectionnée. */
  readonly value: string;
  /** Appelé au choix d'une variante (avec son slug). */
  readonly onSelect: (slug: string) => void;
}

/** Chevron minimal : l'orientation est pilotée en CSS via `[data-open]`. */
function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/**
 * Dropdown de variantes maison (présentationnel) : bouton + menu `listbox`.
 *
 * Le composant ne connaît ni le routeur ni le catalogue : il affiche le nom de
 * la variante sélectionnée et remonte le slug choisi via `onSelect`. Le libellé
 * « Variante » n'est pas affiché (seul `aria-label` le porte pour l'a11y).
 */
export function VariantDropdown({ variants, value, onSelect }: VariantDropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Index à focaliser dès que le menu est monté (ouverture au clavier).
  const pendingFocusRef = useRef<number | null>(null);

  const selectedIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.id === value),
  );
  const selected = variants[selectedIndex] ?? variants[0];

  /** Ouvre le menu en positionnant l'option active. */
  function openMenu(index: number, focusOption = false) {
    setActiveIndex(index);
    if (focusOption) pendingFocusRef.current = index;
    setOpen(true);
  }

  /** Ferme le menu, en rendant (optionnellement) le focus au déclencheur. */
  function closeMenu(returnFocus = false) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  /** Valide la variante à l'index donné puis referme en rendant le focus. */
  function selectAt(index: number) {
    const option = variants[index];
    if (!option) return;
    onSelect(option.slug);
    closeMenu(true);
  }

  /** Déplace le focus réel sur l'option `index` (navigation circulaire). */
  function focusOption(index: number) {
    const count = variants.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  }

  // Fermeture au clic hors du composant.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  // Focus différé dès que les options existent dans le DOM.
  useEffect(() => {
    if (!open || pendingFocusRef.current === null) return;
    const index = pendingFocusRef.current;
    pendingFocusRef.current = null;
    optionRefs.current[index]?.focus();
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu(true);
        }
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (!open) openMenu(selectedIndex, true);
        else focusOption(activeIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) openMenu(selectedIndex, true);
        else focusOption(activeIndex - 1);
        return;
      case 'Home':
        if (open) {
          event.preventDefault();
          focusOption(0);
        }
        return;
      case 'End':
        if (open) {
          event.preventDefault();
          focusOption(variants.length - 1);
        }
        return;
      case 'Enter':
      case ' ':
        // Entrée/Espace n'ouvrent que depuis le déclencheur : les options
        // valident via leur propre clic natif.
        if (!open && event.target === triggerRef.current) {
          event.preventDefault();
          openMenu(selectedIndex, true);
        } else if (open && event.key === 'Enter' && event.target === triggerRef.current) {
          event.preventDefault();
          selectAt(activeIndex);
        }
        return;
      default:
        return;
    }
  }

  if (variants.length === 0) return null;

  return (
    <div
      className="variant-dropdown"
      ref={containerRef}
      data-open={open}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!open) return;
        if (
          containerRef.current &&
          !containerRef.current.contains(event.relatedTarget as Node | null)
        ) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="variant-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choisir la variante"
        onClick={() => (open ? closeMenu() : openMenu(selectedIndex))}
      >
        <span className="variant-dropdown-value">{selected?.name}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <ul role="listbox" className="variant-dropdown-menu" aria-label="Variantes disponibles">
          {variants.map((variant, index) => (
            <li key={variant.id} role="option" aria-selected={variant.id === value}>
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                className="variant-dropdown-item"
                onClick={() => selectAt(index)}
              >
                {variant.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
