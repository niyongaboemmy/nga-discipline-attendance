import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, Clock3, School, Search, Settings as SettingsIcon, Star, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import { UserAvatar } from '../common/UserAvatar';
import { matchPath, placeLinks, visibleAreas, type NavArea, type NavGroup, type PlacedLink } from './navModel';

interface SidebarProps {
  /** Rail only: the panel opens over the page when an area is clicked. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** Called after a page is chosen (closes the phone drawer). */
  onNavigate?: () => void;
  /** Phone: drawn as a drawer over the page instead of a column beside it. */
  drawer?: boolean;
}

const KEYS = { area: 'tendo.sidebar.area', pins: 'tendo.sidebar.pins', recent: 'tendo.sidebar.recent' };
const readList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeList = (key: string, list: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private mode: just not remembered */
  }
};
const RECENT_MAX = 4;

interface AccountLink {
  label: string;
  icon: LucideIcon;
  path?: string;
  action?: () => void;
}

/**
 * The Tendo menu, drawn exactly like the Amashuri (central MIS) one: an icon rail of
 * areas (Attendance, Discipline, Administration…) and a panel with the chosen area's
 * groups and pages. Labels on the rail show on hover or focus. The panel adds a menu
 * search ("/"), pinned pages and recent pages. Collapsed, only the rail stays and the
 * panel opens over the page.
 */
export const Sidebar: React.FC<SidebarProps> = ({ collapsed = false, onToggle, onNavigate, drawer = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, school, schools, switchSchool } = useAuth();
  const { can } = usePermissions();

  const role = user?.role ?? 'unassigned';
  const areas = visibleAreas(role, (k) => can(k));
  const placed = placeLinks(areas);
  const current = matchPath(placed, location.pathname);
  const panelAreas = areas.filter((a) => a.groups);

  // ---- remembered state ----
  const [storedArea, setStoredArea] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEYS.area);
    } catch {
      return null;
    }
  });
  const [pins, setPins] = useState<string[]>(() => readList(KEYS.pins));
  const [recent, setRecent] = useState<string[]>(() => readList(KEYS.recent));
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountBtnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const togglePin = (path: string) =>
    setPins((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      writeList(KEYS.pins, next);
      return next;
    });

  // Landing on a page: its area becomes the panel and it joins Recent.
  const currentPath = current?.link.path;
  const currentAreaId = current?.area.groups ? current.area.id : null;
  const [seenPath, setSeenPath] = useState<string | null>(null);
  if (seenPath !== location.pathname) {
    setSeenPath(location.pathname);
    setOverlayOpen(false);
    setAccountOpen(false);
    setQuery('');
    setTip(null);
    if (currentAreaId) setStoredArea(currentAreaId);
    if (currentPath && currentAreaId) setRecent((prev) => [currentPath, ...prev.filter((p) => p !== currentPath)].slice(0, RECENT_MAX + 1));
  }
  useEffect(() => {
    try {
      if (storedArea) localStorage.setItem(KEYS.area, storedArea);
    } catch {
      /* not remembered */
    }
  }, [storedArea]);
  useEffect(() => writeList(KEYS.recent, recent), [recent]);

  const area = panelAreas.find((a) => a.id === storedArea) ?? panelAreas.find((a) => a.id === currentAreaId) ?? panelAreas[0];
  const panelVisible = !!area && (!collapsed || overlayOpen);

  // Overlay and account menu close on Escape or a click outside them.
  useEffect(() => {
    if (!overlayOpen && !accountOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (accountOpen && !accountRef.current?.contains(t) && !accountBtnRef.current?.contains(t)) setAccountOpen(false);
      if (overlayOpen && !asideRef.current?.contains(t)) setOverlayOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (accountOpen) {
        setAccountOpen(false);
        accountBtnRef.current?.focus();
      } else setOverlayOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [overlayOpen, accountOpen]);

  // "/" jumps to the menu search (not while typing somewhere else).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (!asideRef.current) return;
      e.preventDefault();
      if (searchRef.current) searchRef.current.focus();
      else {
        setOverlayOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed]);

  // Move focus to the first account item when the menu opens.
  useEffect(() => {
    if (accountOpen) accountRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [accountOpen]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return placed.filter(({ link, area: a, group }) => `${link.label} ${group?.label ?? ''} ${a.label}`.toLowerCase().includes(q)).slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, location.pathname, placed.length]);

  if (!user) return null;

  const byPath = (path: string) => placed.find((p) => p.link.path === path && p.area.groups);
  const pinned = pins.map(byPath).filter((p): p is PlacedLink => !!p);
  const recents = recent
    .filter((p) => p !== currentPath && !pins.includes(p))
    .map(byPath)
    .filter((p): p is PlacedLink => !!p)
    .slice(0, RECENT_MAX - 1);

  // ---- rail ----
  const showTip = (el: HTMLElement, label: string) => {
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, left: r.right + 10 });
  };
  const tipProps = (label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showTip(e.currentTarget, label),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showTip(e.currentTarget, label),
    onBlur: () => setTip(null),
  });
  const railKeys = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = Array.from(asideRef.current?.querySelectorAll<HTMLElement>('[data-rail]') ?? []);
    const i = all.indexOf(e.currentTarget);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  };

  const onArea = (a: NavArea) => {
    setTip(null);
    if (collapsed) {
      if (overlayOpen && area?.id === a.id) setOverlayOpen(false);
      else {
        setStoredArea(a.id);
        setOverlayOpen(true);
      }
      return;
    }
    if (area?.id === a.id) onToggle?.();
    else setStoredArea(a.id);
  };

  // ---- panel rows ----
  const pageRow = (p: PlacedLink, opts: { showWhere?: boolean; icon?: React.ReactNode } = {}) => {
    const { link } = p;
    const active = current?.link === link;
    const isPinned = pins.includes(link.path);
    const Icon = link.icon;
    return (
      <li key={`${p.area.id}:${link.path}`} className="nav-row">
        <Link to={link.path} onClick={() => onNavigate?.()} aria-current={active ? 'page' : undefined} className={`nav-row-link${active ? ' is-active' : ''}`}>
          <span className="nav-row-icon">{opts.icon ?? <Icon aria-hidden />}</span>
          <span className="nav-row-text">
            <span className="nav-row-label">{link.label}</span>
            {opts.showWhere && (
              <span className="nav-row-where">{[p.area.label, p.group && p.group.label !== p.area.label ? p.group.label : null].filter(Boolean).join(' › ')}</span>
            )}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => togglePin(link.path)}
          aria-label={isPinned ? `Unpin ${link.label}` : `Pin ${link.label}`}
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin' : 'Pin to top'}
          className={`nav-row-pin${isPinned ? ' is-pinned' : ''}`}
        >
          <Star aria-hidden />
        </button>
      </li>
    );
  };

  const groupBlock = (a: NavArea, g: NavGroup) => (
    <div key={`${a.id}/${g.label}`}>
      <h3 className="nav-heading">{g.label}</h3>
      <ul aria-label={g.label} className="nav-list">
        {g.items.map((link) => pageRow({ link, area: a, group: g }))}
      </ul>
    </div>
  );

  const areaBody = (a: NavArea) => {
    const groups = a.groups ?? [];
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    // One group, or a handful of pages: no headings, just the pages.
    if (groups.length === 1 || total <= 4) {
      return (
        <ul aria-label={a.label} className="nav-list nav-list--flat">
          {groups.flatMap((g) => g.items.map((link) => pageRow({ link, area: a, group: g })))}
        </ul>
      );
    }
    return groups.map((g) => groupBlock(a, g));
  };

  const panel = area && (
    <div id="nav-panel" className={`nav-panel${collapsed ? ' is-overlay' : ''}`}>
      <div className="nav-panel-head">
        <h2 className="nav-panel-title">{query ? 'Search' : area.label}</h2>
        <button
          type="button"
          onClick={() => (collapsed ? setOverlayOpen(false) : onToggle?.())}
          aria-label={collapsed ? 'Close menu' : 'Collapse menu'}
          title={collapsed ? 'Close' : 'Collapse menu'}
          className="nav-panel-collapse"
        >
          {collapsed || drawer ? <X aria-hidden /> : <ChevronsLeft aria-hidden />}
        </button>
      </div>
      <div className="nav-search-wrap">
        <label className="nav-search">
          <Search className="nav-search-glass" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setQuery('');
              } else if (e.key === 'Enter' && results[0]) {
                navigate(results[0].link.path);
                onNavigate?.();
              }
            }}
            placeholder="Search menu"
            aria-label="Search menu"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="nav-search-x">
              <X aria-hidden />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>
      </div>
      <nav aria-label={query ? 'Search results' : area.label} className="nav-panel-body">
        {query ? (
          results.length ? (
            <ul aria-label="Search results" className="nav-list">
              {results.map((p) => pageRow(p, { showWhere: true }))}
            </ul>
          ) : (
            <p className="nav-empty">No page called “{query}”. Try another word.</p>
          )
        ) : (
          <div key={area.id} className="nav-reveal">
            {pinned.length > 0 && (
              <div>
                <h3 className="nav-heading">Pinned</h3>
                <ul aria-label="Pinned" className="nav-list">
                  {pinned.map((p) => pageRow(p, { icon: <Star className="nav-pin-star" aria-hidden /> }))}
                </ul>
              </div>
            )}
            {recents.length > 0 && (
              <div>
                <h3 className="nav-heading">Recent</h3>
                <ul aria-label="Recent" className="nav-list">
                  {recents.map((p) => pageRow(p, { icon: <Clock3 aria-hidden /> }))}
                </ul>
              </div>
            )}
            {(pinned.length > 0 || recents.length > 0) && <div className="nav-divider" />}
            {areaBody(area)}
          </div>
        )}
      </nav>
    </div>
  );

  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const accountLinks: AccountLink[] = [
    { label: 'Settings', path: '/settings', icon: SettingsIcon },
    ...(schools.length >= 2 ? [{ label: 'Switch school', action: switchSchool, icon: School }] : []),
  ];

  return (
    <>
      <aside ref={asideRef} className={`sidebar${collapsed ? ' is-collapsed' : ''}${drawer ? ' is-drawer' : ''}`} aria-label="Main menu">
        {/* Rail: one icon per area; the label shows on hover or focus. */}
        <nav aria-label="Areas" className="nav-rail">
          {areas.map((a) => {
            const Icon = a.icon;
            if (a.link) {
              const active = current?.area.id === a.id;
              return (
                <Link
                  key={a.id}
                  to={a.link.path}
                  data-rail
                  aria-label={a.label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    setTip(null);
                    onNavigate?.();
                  }}
                  onKeyDown={railKeys}
                  {...tipProps(a.label)}
                  className={`nav-rail-btn${active ? ' is-on' : ''}`}
                >
                  <Icon aria-hidden />
                </Link>
              );
            }
            const showing = panelVisible && area?.id === a.id;
            const holdsCurrent = currentAreaId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                data-rail
                aria-label={a.label}
                aria-expanded={showing}
                aria-controls="nav-panel"
                onClick={() => onArea(a)}
                onKeyDown={railKeys}
                {...tipProps(a.label)}
                className={`nav-rail-btn${showing ? ' is-on' : holdsCurrent ? ' is-current' : ''}`}
              >
                <Icon aria-hidden />
              </button>
            );
          })}
          <div className="nav-rail-gap" />
          {collapsed && (
            <button type="button" data-rail onClick={onToggle} onKeyDown={railKeys} aria-label="Expand menu" {...tipProps('Expand menu')} className="nav-rail-btn">
              <ChevronsRight aria-hidden />
            </button>
          )}
          <button
            ref={accountBtnRef}
            type="button"
            data-rail
            onClick={() => {
              setTip(null);
              setAccountOpen((o) => !o);
            }}
            onKeyDown={railKeys}
            aria-label="Account"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            {...tipProps('Account')}
            className={`nav-rail-account${accountOpen ? ' is-open' : ''}`}
          >
            <UserAvatar name={user.name} avatar={user.avatar} px={34} className="avatar nav-avatar" decorative fallback="person" />
          </button>
        </nav>

        {panelVisible && panel}
      </aside>

      {/* Rail labels: fixed so the rail's scroll box never clips them. */}
      {tip && (
        <div key={tip.label} role="tooltip" className="nav-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      )}

      {/* Account menu: everything about you, out of the main list. */}
      {accountOpen && (
        <div
          ref={accountRef}
          role="menu"
          aria-label="Account"
          className="nav-account"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = Array.from(accountRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
          }}
        >
          <div className="nav-account-who">
            <UserAvatar name={user.name} avatar={user.avatar} px={36} className="avatar nav-avatar nav-avatar--lg" decorative fallback="person" />
            <div className="nav-account-id">
              <div className="nav-account-name">{user.name}</div>
              <div className="nav-account-role">{roleLabel}</div>
            </div>
          </div>
          <div className="nav-account-rule" />
          {accountLinks.map((l) => {
            const Icon = l.icon;
            const cls = `nav-account-item${l.path && location.pathname === l.path ? ' is-active' : ''}`;
            const body = (
              <>
                <Icon aria-hidden />
                {l.label}
              </>
            );
            return l.path ? (
              <Link
                key={l.label}
                to={l.path}
                role="menuitem"
                className={cls}
                onClick={() => {
                  setAccountOpen(false);
                  onNavigate?.();
                }}
              >
                {body}
              </Link>
            ) : (
              <button
                key={l.label}
                type="button"
                role="menuitem"
                className={cls}
                onClick={() => {
                  setAccountOpen(false);
                  l.action?.();
                  onNavigate?.();
                }}
              >
                {body}
              </button>
            );
          })}
          <div className="nav-account-foot">{school?.name ? `Tendo · ${school.name}` : 'Tendo'}</div>
        </div>
      )}
    </>
  );
};
