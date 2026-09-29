import React, { useMemo, useState } from 'react';
import { LayoutGrid, Search, X, ArrowRight } from 'lucide-react';
import { authorizeSSO } from '../../api/systems';
import type { System } from '../../api/systems';
import { appLinkProps, useLaunchLinks } from '../../pwa/ngaLaunch';

interface SystemsMenuProps {
  isOpen: boolean;
  onClose: () => void;
  systems: System[];
}

/** Cross-app switcher ("waffle" menu) — same design language as the NGA
 *  Central MIS / TaskMentor "Apps" grid, driven by the same live `System`
 *  list (fetched via /api/sso/systems, proxied from the MIS's /users/me). */
export const SystemsMenu: React.FC<SystemsMenuProps> = ({ isOpen, onClose, systems }) => {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const ownClientId = import.meta.env.VITE_SSO_CLIENT_ID;
    return systems
      .filter((s) => s.client_id !== ownClientId)
      .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  }, [systems, query]);

  // The MIS itself is the hub, not a spoke, so it has no System row of its
  // own to appear in `systems` — same reason taskmentor's switcher carries
  // a matching static tile for it.
  const misHomeUrl = import.meta.env.VITE_MIS_HOME_URL as string | undefined;

  // Tiles are real links so Chrome can open each app in its installed
  // window (see src/pwa/ngaLaunch.ts). Called before the early return below:
  // hooks must run on every render.
  const { tileProps } = useLaunchLinks(filtered, isOpen, (clientId, redirectUri, state) =>
    authorizeSSO(clientId, redirectUri, 'code', state),
  );

  if (!isOpen) return null;

  return (
    <div className="menu systems-menu animate-fade-in">
      <div className="systems-menu-head">
        <div className="systems-menu-brand">
          <span className="systems-menu-brand-icon"><LayoutGrid size={15} /></span>
          <div>
            <div className="systems-menu-title">Apps</div>
            <div className="systems-menu-subtitle">NGA Central MIS Ecosystem</div>
          </div>
        </div>
        <button className="systems-menu-close" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>

      <div className="systems-menu-search">
        <Search size={14} className="systems-menu-search-icon" />
        <input
          type="text"
          placeholder="Search for apps"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="systems-menu-grid">
        {misHomeUrl && (
          <a {...appLinkProps(misHomeUrl, onClose)} title="Open NGA MIS" className="systems-menu-item">
            <span className="systems-menu-tile">
              <LayoutGrid size={16} />
              <span className="systems-menu-tile-arrow"><ArrowRight size={9} /></span>
            </span>
            <span className="systems-menu-label">Back to MIS</span>
          </a>
        )}

        {filtered.map((system) => (
          <a
            key={system.system_id}
            {...tileProps(system, onClose)}
            title={`Open ${system.name}`}
            className="systems-menu-item"
          >
            <span className="systems-menu-tile">
              {system.icon_url ? (
                <img src={system.icon_url} alt="" />
              ) : (
                <LayoutGrid size={16} />
              )}
              <span className="systems-menu-tile-arrow"><ArrowRight size={9} /></span>
            </span>
            <span className="systems-menu-label">{system.name}</span>
          </a>
        ))}
      </div>

      {filtered.length === 0 && query && (
        <div className="systems-menu-empty">
          <span className="systems-menu-empty-icon"><Search size={16} /></span>
          <p>No apps found matching "{query}"</p>
        </div>
      )}
    </div>
  );
};
