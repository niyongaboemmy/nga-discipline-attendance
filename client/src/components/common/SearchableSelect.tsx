import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional dimmer second line (e.g. a subject code or class programme). */
  hint?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Shown when nothing is selected; also the label of the "clear" entry
   *  when `clearable`. */
  placeholder?: string;
  disabled?: boolean;
  /** Below this many options the search box is hidden — typing to filter 4
   *  statuses is more friction than it saves. */
  searchThreshold?: number;
  /** Lets the user return to the empty/placeholder value. */
  clearable?: boolean;
  id?: string;
  required?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * Accessible combobox: a button that opens a filterable listbox.
 *
 * Replaces native <select> wherever the option count makes scanning painful
 * (subjects, classes, students). Keyboard behaviour deliberately mirrors a
 * native select — arrows move, Enter/Space commit, Escape closes, Home/End
 * jump, and typing filters — so it stays usable without a mouse.
 */
export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  searchThreshold = 7,
  clearable = false,
  id,
  required = false,
  className = '',
  'aria-label': ariaLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const listboxId = `${id || generatedId}-listbox`;

  const selected = options.find((o) => o.value === value) || null;
  const showSearch = options.length >= searchThreshold;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || (o.hint ? o.hint.toLowerCase().includes(q) : false)
    );
  }, [options, query]);

  // Reopening should land on the current selection, not the top of the list.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const i = filtered.findIndex((o) => o.value === value);
    setActiveIndex(i >= 0 ? i : 0);
    if (showSearch) searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Filtering can shrink the list out from under the cursor.
  useEffect(() => {
    setActiveIndex((i) => (i >= filtered.length ? 0 : i));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(filtered.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[activeIndex]) commit(filtered[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className={`ss ${className}`} ref={rootRef}>
      <button
        type="button"
        id={id}
        className={`ss-control${open ? ' is-open' : ''}${selected ? '' : ' is-placeholder'}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-required={required || undefined}
      >
        <span className="ss-value">
          {selected ? selected.label : placeholder}
          {selected?.hint && <span className="ss-value-hint">{selected.hint}</span>}
        </span>
        {clearable && selected && !disabled ? (
          <span
            className="ss-clear"
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
          >
            <X size={13} />
          </span>
        ) : (
          <ChevronDown size={15} className="ss-caret" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="ss-panel">
          {showSearch && (
            <div className="ss-search">
              <Search size={13} className="ss-search-icon" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder="Search…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                aria-label="Search options"
                aria-controls={listboxId}
              />
            </div>
          )}

          <div className="ss-list" role="listbox" id={listboxId} ref={listRef} tabIndex={-1}>
            {filtered.length === 0 ? (
              <div className="ss-empty">No matches for “{query}”</div>
            ) : (
              filtered.map((option, i) => {
                const isSelected = option.value === value;
                return (
                  <div
                    key={option.value || `__placeholder-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={`ss-option${i === activeIndex ? ' is-active' : ''}${
                      isSelected ? ' is-selected' : ''
                    }${option.disabled ? ' is-disabled' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(option)}
                  >
                    <span className="ss-option-body">
                      <span className="ss-option-label">{option.label}</span>
                      {option.hint && <span className="ss-option-hint">{option.hint}</span>}
                    </span>
                    {isSelected && <Check size={14} className="ss-option-check" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
