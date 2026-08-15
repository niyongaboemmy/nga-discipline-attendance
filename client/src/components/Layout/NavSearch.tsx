import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { searchCatalog } from './searchCatalog';

/** Finds every catalog entry whose label, description, or keywords match
 *  every word in the query (order-independent, so "excuse review" and
 *  "review excuse" both hit "Excuse Review"). */
function matches(haystack: string[], query: string): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const text = haystack.join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Top-bar search over the app's own pages/features (not live record data) —
 *  answers "I don't remember where X lives" by matching page names,
 *  descriptions, and common synonyms. Mirrors MIS's NavSearch dropdown. */
export const NavSearch: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const results = useMemo(() => {
    if (!user) return [];
    const available = searchCatalog.filter((item) => item.roles.includes(user.role));
    if (!query.trim()) return available;
    return available.filter((item) => matches([item.label, item.description, ...(item.keywords || [])], query));
  }, [query, user]);

  const close = () => { setIsOpen(false); setQuery(''); setHighlight(0); };
  const open = () => { setIsOpen(true); setHighlight(0); };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isOpen && containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Global "/" shortcut opens search, like most search-heavy apps.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleSelect = (path: string) => {
    navigate(path);
    close();
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return; }
    if (e.key === 'Enter' && results[highlight]) { handleSelect(results[highlight].path); }
  };

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <button
        className="icon-btn"
        onClick={() => (isOpen ? close() : open())}
        aria-label="Search"
        title="Search (press /)"
      >
        <Search size={18} />
      </button>

      {isOpen && (
        <div className="popover nav-search-popover animate-fade-in">
          <div className="nav-search-input-wrap">
            <Search size={15} className="nav-search-icon" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search pages and features…"
              className="nav-search-input"
            />
            {query && (
              <button className="nav-search-clear" onClick={() => onQueryChange('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="nav-search-results">
            {results.length === 0 ? (
              <div className="empty-state" style={{ padding: '28px 16px' }}>
                <Search size={20} />
                <span className="text-sm">No pages match “{query}”</span>
              </div>
            ) : (
              results.map((item, i) => (
                <button
                  key={item.path + item.label}
                  onClick={() => handleSelect(item.path)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`nav-search-result${i === highlight ? ' is-active' : ''}`}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="text-sm font-semibold truncate">{item.label}</div>
                    <div className="text-xs text-secondary truncate">{item.description}</div>
                  </div>
                  <ArrowRight size={14} className="nav-search-go" />
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
