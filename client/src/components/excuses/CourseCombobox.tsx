import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';

/**
 * Course picker.
 *
 * This used to swap between a SearchableSelect (which is a *button*) and a
 * plain input depending on whether the class list had loaded — so whether you
 * could type at all depended on a race with the network, and a list that
 * arrived mid-typing replaced the element under the cursor. It is one control
 * now: always a text input, with the known classes offered as suggestions.
 * Free text stays valid because a student can need to explain an absence from
 * a class they have no attendance record in yet — which is exactly the case
 * where the list comes back empty.
 */
export const CourseCombobox: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: string[];
  invalid: boolean;
}> = ({ value, onChange, options, invalid }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = `${useId()}-courses`;

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    return options.filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 8);
  }, [options, value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const commit = (v: string) => { onChange(v); setOpen(false); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive((i) => (i - 1 + matches.length) % matches.length); }
    // Enter picks a highlighted suggestion, but never hijacks submit when the
    // list is closed — typed-in text must be able to go straight through.
    else if (e.key === 'Enter' && open) { e.preventDefault(); commit(matches[active] ?? value); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="ex-combo" ref={rootRef}>
      <input
        id="excuse-course"
        className={`input${invalid ? ' is-invalid' : ''}`}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open && matches.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length ? `${listboxId}-${active}` : undefined}
        placeholder={options.length ? 'Type or pick a class…' : 'Type the class name…'}
        value={value}
        onChange={(e) => { onChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="ex-combo-toggle"
          tabIndex={-1}
          aria-label={open ? 'Hide class suggestions' : 'Show class suggestions'}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={15} />
        </button>
      )}
      {open && matches.length > 0 && (
        <ul className="ex-combo-panel" id={listboxId} role="listbox" aria-label="Your classes">
          {matches.map((o, i) => (
            <li
              key={o}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={o === value}
              className={`ex-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
            >
              {o}
              {o === value && <CheckCircle2 size={13} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
