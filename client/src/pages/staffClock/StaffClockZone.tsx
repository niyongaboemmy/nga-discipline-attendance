import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Check, Crosshair, Info, Plus, Search, Trash2, AlertTriangle, Copy, Printer } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type ClockConfig, type ClockRules, type ClockZone } from '../../api/staffClock';
import { distanceM, sampleLocation, GeoError } from '../../clock/geo';
import { StaffClockHeader, Spinner } from './StaffClockHeader';

/**
 * School zone (prototype "Admin: school zone setup"): circles on an OpenStreetMap
 * map (or satellite imagery), centre and edge dragged on the map, radius slider,
 * "test from where I stand", the check-in rules and the staff link.
 */

const TILES = {
  map: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
};
const KIGALI: [number, number] = [-1.9441, 30.0619];

interface Draft {
  id: number | null;
  name: string;
  lat: number;
  lng: number;
  radius: number;
  active: boolean;
}

const toDraft = (z: ClockZone): Draft => ({ id: z.id, name: z.name, lat: z.center_lat ?? KIGALI[0], lng: z.center_lng ?? KIGALI[1], radius: z.radius_m ?? 150, active: !!z.active });

/** The point `m` metres east of (lat, lng): where the edge handle sits. */
function eastOf(lat: number, lng: number, m: number): [number, number] {
  return [lat, lng + m / (111_320 * Math.cos((lat * Math.PI) / 180))];
}

export const StaffClockZone: React.FC = () => {
  const toast = useToast();
  const { can } = usePermissions();
  const canEdit = can('STAFF_ATTENDANCE_ZONES_MANAGE');
  const [cfg, setCfg] = useState<ClockConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zones, setZones] = useState<Draft[]>([]);
  const [sel, setSel] = useState(0);
  const [style, setStyle] = useState<'map' | 'satellite'>('map');
  const [rules, setRules] = useState<ClockRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ inside: boolean; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [placing, setPlacing] = useState(false);

  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const meMarker = useRef<L.Marker | null>(null);
  const placingRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await staffClockApi.config();
      setCfg(c);
      setRules(c.rules);
      setZones(c.zones.filter((z) => z.kind === 'circle').map(toDraft));
      setSel(0);
      setDirty(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the school zone.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  // The map itself (once).
  useEffect(() => {
    if (!mapEl.current || map.current || !cfg) return;
    const first = cfg.zones.find((z) => z.center_lat != null);
    const m = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(first ? [first.center_lat!, first.center_lng!] : KIGALI, first ? 17 : 13);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    tiles.current = L.tileLayer(TILES.map.url, { attribution: TILES.map.attribution, maxZoom: TILES.map.maxZoom }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (!placingRef.current) return;
      placingRef.current = false;
      setPlacing(false);
      setZones((zs) => {
        const next = [...zs, { id: null, name: zs.length ? `Zone ${zs.length + 1}` : 'Main campus', lat: e.latlng.lat, lng: e.latlng.lng, radius: 150, active: true }];
        setSel(next.length - 1);
        return next;
      });
      setDirty(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [cfg]);

  useEffect(() => {
    if (!map.current) return;
    const t = TILES[style];
    tiles.current?.setUrl(t.url);
    tiles.current?.options && (tiles.current.options.attribution = t.attribution);
    map.current.attributionControl.remove();
    map.current.attributionControl = L.control.attribution({ prefix: false }).addAttribution(t.attribution).addTo(map.current);
  }, [style, cfg]);

  // Draw zones, the selected one with its draggable centre and edge.
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const blue = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
    zones.forEach((z, i) => {
      const selected = i === sel;
      const circle = L.circle([z.lat, z.lng], {
        radius: z.radius, color: style === 'satellite' ? '#93c5fd' : blue, weight: selected ? 3 : 2, dashArray: selected ? undefined : '6 6',
        fillColor: style === 'satellite' ? '#93c5fd' : blue, fillOpacity: z.active ? (style === 'satellite' ? 0.22 : 0.12) : 0.03, opacity: z.active ? 1 : 0.5,
      }).addTo(g);
      circle.on('click', () => setSel(i));
      if (!selected) return;
      const pin = L.marker([z.lat, z.lng], {
        draggable: canEdit,
        icon: L.divIcon({ className: '', html: `<svg class="sc-pin" viewBox="0 0 24 24"><path fill="${blue}" d="M12 22s-7-6.4-7-12a7 7 0 0 1 14 0c0 5.6-7 12-7 12z"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>`, iconSize: [34, 34], iconAnchor: [17, 32] }),
        keyboard: true,
        title: 'Zone centre',
      }).addTo(g);
      pin.bindTooltip(`${z.name || 'Untitled zone'} · ${z.radius} m`, { permanent: true, direction: 'top', offset: [0, -30], className: 'sc-pin-label' });
      pin.on('drag', (e: any) => {
        const ll = e.target.getLatLng();
        circle.setLatLng(ll);
        edge.setLatLng(eastOf(ll.lat, ll.lng, z.radius));
      });
      pin.on('dragend', (e: any) => {
        const ll = e.target.getLatLng();
        setZones((zs) => zs.map((x, j) => (j === i ? { ...x, lat: ll.lat, lng: ll.lng } : x)));
        setDirty(true);
      });
      const edge = L.marker(eastOf(z.lat, z.lng, z.radius), {
        draggable: canEdit,
        icon: L.divIcon({ className: '', html: '<div class="sc-handle"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        title: 'Drag to resize',
      }).addTo(g);
      edge.on('drag', (e: any) => {
        const r = Math.max(50, Math.min(500, Math.round(distanceM({ lat: z.lat, lng: z.lng }, { lat: e.latlng?.lat ?? e.target.getLatLng().lat, lng: e.target.getLatLng().lng }))));
        circle.setRadius(r);
      });
      edge.on('dragend', (e: any) => {
        const ll = e.target.getLatLng();
        const r = Math.max(50, Math.min(500, Math.round(distanceM({ lat: z.lat, lng: z.lng }, ll) / 10) * 10));
        setZones((zs) => zs.map((x, j) => (j === i ? { ...x, radius: r } : x)));
        setDirty(true);
      });
    });
  }, [zones, sel, style, canEdit]);

  const current = zones[sel] ?? null;
  const patch = (p: Partial<Draft>) => {
    setZones((zs) => zs.map((z, i) => (i === sel ? { ...z, ...p } : z)));
    setDirty(true);
  };
  const patchRules = (p: Partial<ClockRules>) => {
    setRules((r) => (r ? { ...r, ...p } : r));
    setDirty(true);
  };

  const save = async (enable?: boolean) => {
    if (!rules || !cfg) return;
    setSaving(true);
    try {
      // Zones first (the clock can only open with one), then rules.
      const keep = new Set<number>();
      for (const z of zones) {
        if (!z.name.trim()) throw new ApiError('Give every zone a name.', 400);
        if (z.id == null) {
          const created = await staffClockApi.createZone({ name: z.name.trim(), lat: z.lat, lng: z.lng, radius: z.radius, active: z.active });
          keep.add(created.id);
        } else {
          await staffClockApi.updateZone(z.id, { name: z.name.trim(), lat: z.lat, lng: z.lng, radius: z.radius, active: z.active });
          keep.add(z.id);
        }
      }
      for (const z of cfg.zones) if (z.kind === 'circle' && !keep.has(z.id)) await staffClockApi.deleteZone(z.id);
      const { allowance: _a, autoCloseAt: _b, ...editable } = rules;
      void _a; void _b;
      await staffClockApi.saveRules({ ...editable, enabled: enable ?? rules.enabled });
      toast.success(enable === true ? 'Staff clock is on' : enable === false ? 'Staff clock is off' : 'Saved', enable === true ? 'Staff can check in from the link now.' : 'Staff phones use it from the next tap.');
      await load();
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const testHere = async () => {
    setTesting(true);
    setTest(null);
    try {
      const { best } = await sampleLocation({ maxMs: 8000 });
      const m = map.current;
      if (m) {
        meMarker.current?.remove();
        meMarker.current = L.marker([best.lat, best.lng], { icon: L.divIcon({ className: '', html: '<div class="sc-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(m);
      }
      const maxAcc = rules?.maxAccuracy ?? 100;
      const allowance = rules?.allowance ?? 50;
      let bestZone: { z: Draft; d: number; inside: boolean } | null = null;
      for (const z of zones.filter((x) => x.active)) {
        const d = distanceM(best, z);
        const inside = d <= z.radius + Math.min(best.accuracy, allowance);
        if (!bestZone || (inside && !bestZone.inside) || d - z.radius < bestZone.d - bestZone.z.radius) bestZone = { z, d, inside };
      }
      if (best.accuracy > maxAcc) setTest({ inside: false, text: `Your location is not precise enough (± ${Math.round(best.accuracy)} m). Step outside and try again.` });
      else if (!bestZone) setTest({ inside: false, text: 'Add a zone first.' });
      else if (bestZone.inside) setTest({ inside: true, text: `You are ${Math.max(0, Math.round(bestZone.z.radius - bestZone.d))} m inside ${bestZone.z.name} (precision ± ${Math.round(best.accuracy)} m)` });
      else setTest({ inside: false, text: `You are ${Math.round(bestZone.d - bestZone.z.radius)} m outside ${bestZone.z.name}.` });
      toast.success('Location found');
    } catch (e) {
      toast.error('Location not found', e instanceof GeoError && e.kind === 'denied' ? 'Allow location for this site in the browser.' : 'Try again near a window or outside.');
    } finally {
      setTesting(false);
    }
  };

  const useMyLocation = async () => {
    try {
      const { best } = await sampleLocation({ maxMs: 8000 });
      map.current?.setView([best.lat, best.lng], 18);
      if (current && canEdit) patch({ lat: best.lat, lng: best.lng });
      else if (canEdit) {
        setZones((zs) => [...zs, { id: null, name: 'Main campus', lat: best.lat, lng: best.lng, radius: 150, active: true }]);
        setSel(zones.length);
        setDirty(true);
      }
      toast.success('Moved to your location');
    } catch {
      toast.error('Location not found', 'Allow location for this site and try again.');
    }
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      map.current?.setView([Number(coords[1]), Number(coords[2])], 18);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) throw new Error();
      map.current?.setView([Number(list[0].lat), Number(list[0].lon)], 17);
    } catch {
      toast.error('Place not found', 'Try another name, or paste coordinates like -1.9536, 30.1044.');
    } finally {
      setSearching(false);
    }
  };

  const copyLink = async () => {
    if (!cfg) return;
    try {
      await navigator.clipboard.writeText(cfg.link.url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy', cfg.link.url);
    }
  };

  const ruleRows: Array<[keyof ClockRules, string, string, 'time' | 'number']> = [
    ['opens', 'Check-in opens', 'Earliest tap, school time', 'time'],
    ['lateAfter', 'Late after', 'Check-in later than this is late', 'time'],
    ['earlyLeaveBefore', 'Early leave before', 'Check-out earlier than this is early', 'time'],
    ['minShiftMinutes', 'Check-out opens after', 'Minutes after check-in', 'number'],
    ['maxAccuracy', 'Location precision', 'Vaguer fixes are refused (metres)', 'number'],
    ['selfReplaceDays', 'New phone within', 'Days that need your approval', 'number'],
  ];

  return (
    <DashboardLayout>
      <div className="sc-page">
        <StaffClockHeader
          title="School zone"
          lead="Staff can check in and out only inside these areas. Draw them while standing at school for the best result."
          actions={cfg && rules && canEdit ? (
            <>
              <span className={`sc-pill ${rules.enabled ? 'sc-tone-green' : 'sc-tone-muted'}`} style={{ height: 40, padding: '0 14px', fontSize: 14 }}><i />{rules.enabled ? 'Clock is on' : 'Clock is off'}</span>
              {rules.enabled ? (
                <button className="sc-btn" disabled={saving} onClick={() => void save(false)}>Turn off</button>
              ) : (
                <button className="sc-btn sc-btn-soft" disabled={saving || zones.filter((z) => z.active).length === 0} onClick={() => void save(true)}>Turn on</button>
              )}
              <button className="sc-btn sc-btn-primary" disabled={saving || !dirty} onClick={() => void save()}>{saving && <Spinner />}Save changes</button>
            </>
          ) : undefined}
        />
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {cfg && !cfg.googleConfigured && (
          <div className="sc-notice"><b>Google sign-in is not set up on this server.</b><p>Staff cannot register their phones until GOOGLE_CLIENT_ID is set for Tendo and its address is added to the Google sign-in client.</p></div>
        )}

        {!cfg && !error ? (
          <div className="sc-row"><div className="sc-skel sc-grow" style={{ height: 680, borderRadius: 24 }} /><div className="sc-skel sc-side" style={{ height: 680, borderRadius: 24 }} /></div>
        ) : cfg && rules && (
          <div className="sc-row" style={{ alignItems: 'flex-start' }}>
            <section className="sc-map sc-grow" aria-label="Map">
              <div ref={mapEl} className="sc-map-el" />
              <div className="sc-map-top">
                <form className="sc-map-search" onSubmit={(e) => void search(e)} role="search">
                  <Search size={18} />
                  <label className="sr-only" htmlFor="sc-place">Search a place</label>
                  <input id="sc-place" placeholder="Search a place or paste coordinates" value={query} onChange={(e) => setQuery(e.target.value)} />
                  <button className="sc-btn sc-btn-sm sc-btn-soft" type="submit" disabled={searching}>{searching ? <Spinner /> : 'Find'}</button>
                </form>
                <div style={{ flex: 1 }} />
                <div className="sc-seg" role="group" aria-label="Map style">
                  <button aria-pressed={style === 'map'} onClick={() => setStyle('map')}>Map</button>
                  <button aria-pressed={style === 'satellite'} onClick={() => setStyle('satellite')}>Satellite</button>
                </div>
              </div>
              <div className="sc-map-bottom" style={{ bottom: 120 }}>
                <button className="sc-btn" onClick={() => void useMyLocation()}><Crosshair size={18} /> Use my location</button>
              </div>
              <span className="sc-map-hint">{placing ? 'Click the map where the new zone’s centre is' : 'Drag the pin to move · drag the white handle to resize'}</span>
            </section>

            <aside className="sc-side" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <section className="sc-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h2>Zones</h2>
                  {canEdit && <button className="sc-btn sc-btn-sm" onClick={() => { placingRef.current = true; setPlacing(true); toast.info?.('Click the map to place the zone'); }}><Plus size={16} /> Add zone</button>}
                </div>
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {zones.length === 0 && <div className="sc-info"><Info size={18} />No zone yet. Press “Use my location” at school, or “Add zone” and click the map.</div>}
                  {zones.map((z, i) => (
                    <div key={`${z.id ?? 'new'}-${i}`} className={`sc-zone${i === sel ? ' selected' : ''}`}>
                      <button className="sc-zone-btn" onClick={() => { setSel(i); map.current?.setView([z.lat, z.lng], Math.max(map.current.getZoom(), 16)); }} title={z.name}>
                        <span className="sc-zone-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg></span>
                        <span><b className="sc-clip">{z.name || 'Untitled zone'}</b><small>Circle · {z.radius} m{z.id == null ? ' · not saved' : ''}</small></span>
                      </button>
                      <button className="sc-switch" role="switch" aria-checked={z.active} disabled={!canEdit} aria-label={`${z.active ? 'Turn off' : 'Turn on'} ${z.name}`}
                        onClick={() => { setZones((zs) => zs.map((x, j) => (j === i ? { ...x, active: !x.active } : x))); setDirty(true); }}><span /></button>
                    </div>
                  ))}
                </div>
              </section>

              {current && (
                <section className="sc-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <h2 style={{ overflowWrap: 'anywhere' }}>Edit “{current.name || 'Untitled zone'}”</h2>
                  <label className="sc-field">
                    <span className="sc-field-top"><span>Name</span><span>{current.name.length}/60</span></span>
                    <input className="sc-input" value={current.name} maxLength={60} disabled={!canEdit} onChange={(e) => patch({ name: e.target.value })} />
                  </label>
                  <label className="sc-field">
                    <span className="sc-field-top"><span>Radius</span><span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{current.radius} m</span></span>
                    <input className="sc-range" type="range" min={50} max={500} step={10} value={current.radius} disabled={!canEdit} onChange={(e) => patch({ radius: Number(e.target.value) })} />
                    <span className="sc-field-top" style={{ fontWeight: 400 }}><span className="sc-muted">50 m</span><span>500 m</span></span>
                  </label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span className="sc-muted">Centre</span><span className="sc-num">{current.lat.toFixed(5)}, {current.lng.toFixed(5)}</span></div>
                  <div className="sc-info"><Info size={18} />Keep it 100 m or more. Phones indoors are often 20 to 60 m off, so a tight circle refuses honest staff.</div>
                  <button className="sc-btn" onClick={() => void testHere()} disabled={testing}>{testing && <Spinner />}Test from where I stand</button>
                  {test && <div className={test.inside ? 'sc-ok' : 'sc-bad'} role="status">{test.inside ? <Check size={18} /> : <AlertTriangle size={18} />}<span style={{ overflowWrap: 'anywhere' }}>{test.text}</span></div>}
                  {canEdit && (
                    <button className="sc-btn sc-btn-danger sc-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setZones((zs) => zs.filter((_, j) => j !== sel)); setSel(0); setDirty(true); }}>
                      <Trash2 size={15} /> Remove this zone
                    </button>
                  )}
                </section>
              )}

              <section className="sc-card">
                <h2>Check-in rules</h2>
                <div style={{ marginTop: 10 }}>
                  {ruleRows.map(([key, label, hint, type]) => (
                    <div className="sc-rule" key={key}>
                      <span><b>{label}</b><small>{hint}</small></span>
                      <input className="sc-input sc-input-time" type={type} aria-label={label} disabled={!canEdit}
                        value={String(rules[key])} min={type === 'number' ? 0 : undefined}
                        onChange={(e) => patchRules({ [key]: type === 'number' ? Number(e.target.value) : e.target.value } as Partial<ClockRules>)} />
                    </div>
                  ))}
                  <div className="sc-rule">
                    <span><b>Google accounts</b><small>Empty = any. Or list domains: gmail.com, school.rw</small></span>
                    <input className="sc-input" style={{ width: 180 }} aria-label="Allowed Google domains" disabled={!canEdit} value={rules.googleDomains} onChange={(e) => patchRules({ googleDomains: e.target.value })} />
                  </div>
                  <div className="sc-rule">
                    <span><b>School Wi-Fi address</b><small>Optional fixed IP range; counts as at school</small></span>
                    <input className="sc-input" style={{ width: 180 }} aria-label="School network" placeholder="41.186.10.0/24" disabled={!canEdit} value={rules.schoolNetworks} onChange={(e) => patchRules({ schoolNetworks: e.target.value })} />
                  </div>
                </div>
              </section>

              <section className="sc-card">
                <h2>Staff link</h2>
                <p className="sc-card-sub">Share it once. Staff register their phone or tablet from it.</p>
                <div className="sc-link"><span className="sc-clip">{cfg.link.display}</span><button className="sc-btn sc-btn-soft sc-btn-sm" onClick={() => void copyLink()}><Copy size={14} /> Copy</button></div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link className="sc-btn sc-btn-sm" to="/staff/clock/poster"><Printer size={15} /> Print poster</Link>
                  {can('STAFF_DEVICES_MANAGE') && <Link className="sc-btn sc-btn-sm" to="/staff/clock/devices">Staff QR cards</Link>}
                </div>
              </section>
            </aside>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
