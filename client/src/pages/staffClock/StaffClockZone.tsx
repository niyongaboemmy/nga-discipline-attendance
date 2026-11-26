import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Check, Clock, Copy, Crosshair, ListFilter, Link2, MapPin, Maximize2, Minus, Plus, Printer, QrCode, Trash2, X } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { useToast } from '../../context/ToastContext';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError } from '../../api/client';
import { staffClockApi, type ClockConfig, type ClockRules, type ClockZone } from '../../api/staffClock';
import { distanceM, sampleLocation, GeoError } from '../../clock/geo';
import { StaffClockHeader, Spinner } from './StaffClockHeader';
import { announceClockChange } from './clockEvents';
import { evaluateTest, isComputer, type TestOutcome } from './locationTest';
import { PhoneGps } from './PhoneGps';

/**
 * Zone & settings (design "C1"): the map fills the page and never scrolls. A
 * floating list on the left holds the school's areas and the selected one's
 * editor; everything outside the selected area is dimmed so it stands out.
 * Finding a place lives on the map (it only moves the map, then offers "move
 * here" / "add here"); adding an area is its own mode. Rules and the staff link
 * open as drawers. `embedded`: the same map + list inside a setup-guide step.
 */

const TILES = {
  map: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
};
const KIGALI: [number, number] = [-1.9441, 30.0619];
const MIN_R = 50;
const MAX_R = 500;

/** Bias place search to the school's country (from its timezone); empty = worldwide. */
const COUNTRY_BY_TZ: Record<string, string> = {
  'Africa/Kigali': 'rw', 'Africa/Kampala': 'ug', 'Africa/Nairobi': 'ke', 'Africa/Dar_es_Salaam': 'tz',
  'Africa/Bujumbura': 'bi', 'Africa/Kinshasa': 'cd', 'Africa/Lubumbashi': 'cd', 'Africa/Juba': 'ss',
  'Africa/Addis_Ababa': 'et', 'Africa/Lagos': 'ng', 'Africa/Accra': 'gh', 'Africa/Johannesburg': 'za',
};

interface PlaceHit { name: string; detail: string; lat: number; lng: number }

interface Draft { id: number | null; name: string; lat: number; lng: number; radius: number; active: boolean }

const toDraft = (z: ClockZone): Draft => ({ id: z.id, name: z.name, lat: z.center_lat ?? KIGALI[0], lng: z.center_lng ?? KIGALI[1], radius: z.radius_m ?? 150, active: !!z.active });

function eastOf(lat: number, lng: number, m: number): [number, number] {
  return [lat, lng + m / (111_320 * Math.cos((lat * Math.PI) / 180))];
}

/** A ring of points around a centre (for the spotlight's hole). */
function ring(lat: number, lng: number, m: number, n = 72): L.LatLngTuple[] {
  const out: L.LatLngTuple[] = [];
  const dLat = m / 111_320;
  const dLng = m / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lat + dLat * Math.sin(a), lng + dLng * Math.cos(a)]);
  }
  return out;
}

const clampR = (r: number) => Math.max(MIN_R, Math.min(MAX_R, Math.round(r / 10) * 10));
const nextName = (zs: Draft[]) => (zs.length ? `Area ${zs.length + 1}` : 'Main campus');

export const StaffClockZone: React.FC<{ embedded?: { onSaved?: () => void } }> = ({ embedded }) => {
  const toast = useToast();
  const location = useLocation();
  const { can } = usePermissions();
  const canEdit = can('STAFF_ATTENDANCE_ZONES_MANAGE');
  const [cfg, setCfg] = useState<ClockConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zones, setZones] = useState<Draft[]>([]);
  const [sel, setSel] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [style, setStyle] = useState<'map' | 'satellite'>('map');
  const [rules, setRules] = useState<ClockRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [found, setFound] = useState<PlaceHit | null>(null);
  const [adding, setAdding] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<null | 'rules' | 'share'>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tilesLoading, setTilesLoading] = useState(false);
  const [locating, setLocating] = useState(false);

  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const shade = useRef<L.LayerGroup | null>(null);
  const foundMarker = useRef<L.Marker | null>(null);
  const meMarker = useRef<L.Marker | null>(null);
  const meCircle = useRef<L.Circle | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // The map's click handler is created once: it reads the latest state through refs.
  const live = useRef({ adding: false, canEdit: false });
  const addAtRef = useRef<(lat: number, lng: number) => void>(() => undefined);
  const canEditRef = useRef(canEdit);
  useEffect(() => { canEditRef.current = canEdit; }, [canEdit]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await staffClockApi.config();
      setCfg(c);
      setRules(c.rules);
      const zs = c.zones.filter((z) => z.kind === 'circle').map(toDraft);
      setZones(zs);
      setSel(0);
      setDirty(false);
      setConfirmRemove(false);
      setAdding(zs.length === 0 && canEditRef.current);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the school zone.');
    }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  useEffect(() => { live.current = { adding, canEdit }; }, [adding, canEdit]);

  /** Add an area at a point and select it (adding mode or the first area). */
  const addAt = useCallback((lat: number, lng: number, label?: string) => {
    setZones((zs) => {
      const next = [...zs, { id: null, name: label ? label.slice(0, 60) : nextName(zs), lat, lng, radius: 150, active: true }];
      setSel(next.length - 1);
      return next;
    });
    setAdding(false);
    setFound(null);
    setDirty(true);
    setTest(null);
    toast.success('Area added', 'Drag the pin or the white handle to fit the grounds, then Save.');
  }, [toast]);
  useEffect(() => { addAtRef.current = addAt; }, [addAt]);

  // The map itself (once).
  useEffect(() => {
    if (!mapEl.current || map.current || !cfg) return;
    const first = cfg.zones.find((z) => z.center_lat != null);
    const m = L.map(mapEl.current, { zoomControl: false, attributionControl: true }).setView(first ? [first.center_lat!, first.center_lng!] : KIGALI, first ? 17 : 13);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    tiles.current = L.tileLayer(TILES.map.url, { attribution: TILES.map.attribution, maxZoom: TILES.map.maxZoom, keepBuffer: 4 }).addTo(m);
    tiles.current.on('loading', () => setTilesLoading(true));
    tiles.current.on('load', () => setTilesLoading(false));
    tiles.current.on('tileerror', (e: L.TileErrorEvent) => {
      const img = e.tile as HTMLImageElement;
      const tries = Number(img.dataset.tries || 0);
      if (tries >= 3) return;
      img.dataset.tries = String(tries + 1);
      const src = img.src.replace(/[?&]retry=\d+$/, '');
      window.setTimeout(() => { img.src = `${src}${src.includes('?') ? '&' : '?'}retry=${tries + 1}`; }, 700 * (tries + 1));
    });
    shade.current = L.layerGroup().addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (live.current.canEdit && live.current.adding) addAtRef.current(e.latlng.lat, e.latlng.lng);
    });
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    if (mapEl.current) ro.observe(mapEl.current);
    const settle = [120, 600].map((ms) => window.setTimeout(() => m.invalidateSize(), ms));
    return () => {
      ro.disconnect();
      settle.forEach((t) => window.clearTimeout(t));
      m.remove();
      map.current = null;
    };
  }, [cfg]);

  useEffect(() => {
    if (!map.current) return;
    const t = TILES[style];
    tiles.current?.setUrl(t.url);
    map.current.attributionControl.remove();
    map.current.attributionControl = L.control.attribution({ prefix: false }).addAttribution(t.attribution).addTo(map.current);
  }, [style, cfg]);

  // The crosshair cursor while adding.
  useEffect(() => {
    mapEl.current?.classList.toggle('zc-adding', adding);
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAdding(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adding]);

  // Draw the areas, the selected one with its draggable centre and edge, and the spotlight.
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    const s = shade.current;
    if (!m || !g || !s) return;
    g.clearLayers();
    s.clearLayers();
    const blue = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
    const tone = style === 'satellite' ? '#93c5fd' : blue;
    const z0 = zones[sel];
    if (z0 && !adding) {
      // Everything but the selected area, dimmed.
      L.polygon([[[85, -179.99], [85, 179.99], [-85, 179.99], [-85, -179.99]], ring(z0.lat, z0.lng, z0.radius)], {
        stroke: false, fillColor: '#030712', fillOpacity: style === 'satellite' ? 0.45 : 0.32, interactive: false,
      }).addTo(s);
    }
    zones.forEach((z, i) => {
      const selected = i === sel && !adding;
      const hot = i === hover;
      const circle = L.circle([z.lat, z.lng], {
        radius: z.radius, color: z.active ? tone : '#9ca3af', weight: selected ? 3.5 : hot ? 3 : 2, dashArray: selected ? undefined : '6 6',
        fillColor: tone, fillOpacity: selected ? 0 : hot ? 0.2 : z.active ? 0.08 : 0.02, opacity: z.active || selected ? 1 : 0.7,
      }).addTo(g);
      circle.on('click', (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); if (!live.current.adding) { setSel(i); setConfirmRemove(false); } });
      circle.on('mouseover', () => setHover(i));
      circle.on('mouseout', () => setHover((h) => (h === i ? null : h)));
      if (!selected) {
        circle.bindTooltip(`${z.name || 'Untitled'} · ${z.radius} m`, { direction: 'center', className: 'zc-tip', sticky: true });
        return;
      }
      const pin = L.marker([z.lat, z.lng], {
        draggable: canEdit,
        icon: L.divIcon({ className: '', html: `<svg class="sc-pin" viewBox="0 0 24 24"><path fill="${blue}" d="M12 22s-7-6.4-7-12a7 7 0 0 1 14 0c0 5.6-7 12-7 12z"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>`, iconSize: [34, 34], iconAnchor: [17, 32] }),
        keyboard: true,
        title: 'Area centre: drag to move',
      }).addTo(g);
      pin.bindTooltip(`${z.name || 'Untitled'} · ${z.radius} m`, { permanent: true, direction: 'top', offset: [0, -30], className: 'sc-pin-label' });
      const edge = L.marker(eastOf(z.lat, z.lng, z.radius), {
        draggable: canEdit,
        icon: L.divIcon({ className: '', html: '<div class="sc-handle"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        title: 'Drag to resize',
      }).addTo(g);
      pin.on('drag', (e: L.LeafletEvent) => {
        const ll = (e.target as L.Marker).getLatLng();
        circle.setLatLng(ll);
        edge.setLatLng(eastOf(ll.lat, ll.lng, z.radius));
        s.clearLayers();
      });
      pin.on('dragend', (e: L.LeafletEvent) => {
        const ll = (e.target as L.Marker).getLatLng();
        setZones((zs) => zs.map((x, j) => (j === i ? { ...x, lat: ll.lat, lng: ll.lng } : x)));
        setDirty(true);
        setTest(null);
      });
      edge.on('drag', (e: L.LeafletEvent) => {
        const r = Math.max(MIN_R, Math.min(MAX_R, Math.round(distanceM({ lat: z.lat, lng: z.lng }, (e.target as L.Marker).getLatLng()))));
        circle.setRadius(r);
        pin.setTooltipContent(`${z.name || 'Untitled'} · ${r} m`);
        s.clearLayers();
      });
      edge.on('dragend', (e: L.LeafletEvent) => {
        const r = clampR(distanceM({ lat: z.lat, lng: z.lng }, (e.target as L.Marker).getLatLng()));
        setZones((zs) => zs.map((x, j) => (j === i ? { ...x, radius: r } : x)));
        setDirty(true);
        setTest(null);
      });
    });
  }, [zones, sel, hover, style, canEdit, adding]);

  /** Show an area whole, clear of the list on the left. */
  const flyTo = useCallback((z: Draft) => {
    const m = map.current;
    if (!m) return;
    const narrow = (mapEl.current?.clientWidth ?? 1000) < 760;
    m.flyToBounds(L.latLng(z.lat, z.lng).toBounds(z.radius * 2.6), {
      paddingTopLeft: narrow ? [20, 80] : [embedded ? 330 : 360, 90],
      paddingBottomRight: narrow ? [20, 300] : [drawer ? 400 : 60, 60],
      maxZoom: 18, duration: 0.6,
    });
  }, [embedded, drawer]);

  const fitAll = () => {
    const m = map.current;
    if (!m || !zones.length) return;
    const b = L.latLngBounds(zones.map((z) => L.latLng(z.lat, z.lng).toBounds(z.radius * 2.2)).flatMap((x) => [x.getNorthWest(), x.getSouthEast()]));
    m.flyToBounds(b, { paddingTopLeft: [embedded ? 330 : 360, 90], paddingBottomRight: [60, 60], maxZoom: 18, duration: 0.6 });
  };

  // Arriving from the setup checklist (/staff/clock/zone#zone-rules etc.).
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!cfg || !id) return;
    const t = window.setTimeout(() => {
      if (id === 'zone-rules') setDrawer('rules');
      const el = document.getElementById(id);
      el?.classList.add('sc-flash');
      window.setTimeout(() => el?.classList.remove('sc-flash'), 1600);
    }, 400);
    return () => window.clearTimeout(t);
  }, [cfg, location.hash]);

  // The searched place on the map.
  useEffect(() => {
    foundMarker.current?.remove();
    foundMarker.current = null;
    if (!found || !map.current) return;
    foundMarker.current = L.marker([found.lat, found.lng], {
      icon: L.divIcon({ className: '', html: '<div class="zc-found"><i></i></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      interactive: false,
    }).addTo(map.current);
  }, [found]);

  const current = zones[sel] ?? null;
  const original = useMemo(() => new Map((cfg?.zones ?? []).map((z) => [z.id, toDraft(z)])), [cfg]);
  const tagOf = (z: Draft): 'New' | 'Edited' | null => {
    if (z.id == null) return 'New';
    const o = original.get(z.id);
    if (!o) return null;
    return o.name !== z.name || o.radius !== z.radius || o.active !== z.active || Math.abs(o.lat - z.lat) > 1e-7 || Math.abs(o.lng - z.lng) > 1e-7 ? 'Edited' : null;
  };
  const shown = zones.map((z, i) => ({ z, i })).filter(({ z }) => !filter.trim() || z.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const pick = (i: number) => {
    setSel(i);
    setConfirmRemove(false);
    setTest(null);
    if (zones[i]) flyTo(zones[i]);
  };
  const patch = (p: Partial<Draft>) => {
    setZones((zs) => zs.map((z, i) => (i === sel ? { ...z, ...p } : z)));
    setDirty(true);
  };
  const patchRules = (p: Partial<ClockRules>) => {
    setRules((r) => (r ? { ...r, ...p } : r));
    setDirty(true);
  };
  const startAdding = () => {
    setAdding((a) => !a);
    setFound(null);
    setHits(null);
    window.setTimeout(() => searchInput.current?.focus(), 50);
  };

  const save = async (enable?: boolean) => {
    if (!rules || !cfg) return;
    setSaving(true);
    try {
      const keep = new Set<number>();
      for (const z of zones) {
        if (!z.name.trim()) throw new ApiError('Give every area a name.', 400);
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
      announceClockChange();
      embedded?.onSaved?.();
      toast.success(enable === true ? 'Staff clock is on' : enable === false ? 'Staff clock is off' : 'Saved', enable === true ? 'Staff can check in from the link now.' : 'Staff phones use it from the next tap.');
      await load();
    } catch (e) {
      toast.error('Not saved', e instanceof ApiError ? e.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const showMe = (fix: { lat: number; lng: number; accuracy: number }) => {
    const m = map.current;
    if (!m) return;
    meMarker.current?.remove();
    meCircle.current?.remove();
    meCircle.current = L.circle([fix.lat, fix.lng], { radius: fix.accuracy, color: '#64748b', weight: 1.5, dashArray: '4 6', fillColor: '#64748b', fillOpacity: 0.08, interactive: false }).addTo(m);
    meMarker.current = L.marker([fix.lat, fix.lng], { icon: L.divIcon({ className: '', html: '<div class="sc-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(m);
  };

  const judge = (fix: { lat: number; lng: number; accuracy: number; ts: number }, fromPhone: boolean) => {
    showMe(fix);
    const outcome = evaluateTest(fix, zones.filter((x) => x.active).map((z) => ({ name: z.name, lat: z.lat, lng: z.lng, radius: z.radius })), {
      maxAccuracy: rules?.maxAccuracy ?? 100, allowance: rules?.allowance ?? 50, computer: !fromPhone && isComputer(),
    });
    setTest(fromPhone ? { ...outcome, text: `From your phone: ${outcome.text}` } : outcome);
    if (outcome.vague) map.current?.fitBounds(L.latLng(fix.lat, fix.lng).toBounds(fix.accuracy * 2.4), { maxZoom: 17 });
    else if (fromPhone) map.current?.panTo([fix.lat, fix.lng]);
    if (outcome.ok && canEdit) void staffClockApi.saveRules({ setupDone: ['tested'] }).then(announceClockChange).catch(() => undefined);
  };

  const testHere = async () => {
    setTesting(true);
    setTest(null);
    try {
      const { best } = await sampleLocation({ maxMs: 10000 });
      judge(best, false);
    } catch (e) {
      toast.error('Location not found', e instanceof GeoError && e.kind === 'denied' ? 'Allow location for this site in the browser.' : 'Make sure Wi-Fi is on (computers) or try near a window (phones).');
    } finally {
      setTesting(false);
    }
  };

  /** Show where this device is; while adding (or with no area yet) drop the new area there. */
  const goToMyLocation = async () => {
    setLocating(true);
    try {
      const { best } = await sampleLocation({ maxMs: 10000 });
      showMe(best);
      const vague = best.accuracy > (rules?.maxAccuracy ?? 100);
      map.current?.flyTo([best.lat, best.lng], vague ? 16 : 18, { duration: 0.6 });
      if (vague) {
        toast.info(`Approximate: ± ${Math.round(best.accuracy)} m`, isComputer()
          ? 'Computers have no GPS. Search the school or click the map on its buildings instead.'
          : 'Step outside for a precise reading, or click the map on the school.');
      }
      if (canEdit && (adding || zones.length === 0)) addAt(best.lat, best.lng);
      else if (!vague) toast.success('This is where you are', current ? `Drag “${current.name}” here if it should be.` : undefined);
    } catch {
      toast.error('Location not found', 'Allow location for this site and try again.');
    } finally {
      setLocating(false);
    }
  };

  /** A place was chosen: add the area there while adding, else just go there and offer actions. */
  const choose = (h: PlaceHit) => {
    setHits(null);
    if (canEdit && adding) {
      map.current?.flyTo([h.lat, h.lng], 18, { duration: 0.6 });
      addAt(h.lat, h.lng);
      return;
    }
    map.current?.flyTo([h.lat, h.lng], 18, { duration: 0.6 });
    setFound(h);
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      const lat = Number(coords[1]);
      const lng = Number(coords[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        toast.error('Not valid coordinates', 'Use latitude, longitude, like -1.9536, 30.1044.');
        return;
      }
      choose({ name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, detail: 'Coordinates', lat, lng });
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ format: 'jsonv2', limit: '6', q, 'accept-language': 'en' });
      const cc = COUNTRY_BY_TZ[cfg?.school.timezone ?? ''];
      if (cc) params.set('countrycodes', cc);
      const b = map.current?.getBounds().pad(2);
      if (b) params.set('viewbox', [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((n) => n.toFixed(4)).join(','));
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } });
      const list: Array<{ lat: string; lon: string; name?: string; display_name: string }> = await res.json();
      const hitsFound = (Array.isArray(list) ? list : []).map((r) => {
        const parts = r.display_name.split(',').map((x) => x.trim());
        return { name: r.name || parts[0], detail: parts.slice(1, 4).join(', '), lat: Number(r.lat), lng: Number(r.lon) };
      });
      if (!hitsFound.length) throw new Error();
      if (hitsFound.length === 1) choose(hitsFound[0]);
      else setHits(hitsFound);
    } catch {
      setHits(null);
      toast.error('Place not found', `${COUNTRY_BY_TZ[cfg?.school.timezone ?? ''] ? 'Searched in your school’s country. ' : ''}Try a nearby road or landmark, or paste coordinates like -1.9536, 30.1044.`);
    } finally {
      setSearching(false);
    }
  };

  const copyLink = async () => {
    if (!cfg) return;
    try {
      await navigator.clipboard.writeText(cfg.link.url);
      toast.success('Link copied', 'Send it to staff by WhatsApp, Tupo or e-mail.');
      void staffClockApi.saveRules({ setupDone: ['shared'] }).then(announceClockChange).catch(() => undefined);
    } catch {
      toast.error('Could not copy', cfg.link.url);
    }
  };

  const ruleRows: Array<[keyof ClockRules, string, string, 'time' | 'number', string?]> = [
    ['opens', 'Check-in opens', 'Earliest tap, school time', 'time'],
    ['lateAfter', 'Late after', 'Check-in later than this is late', 'time'],
    ['earlyLeaveBefore', 'Early leave before', 'Check-out earlier than this is early', 'time'],
    ['minShiftMinutes', 'Check-out opens after', 'Minutes after check-in', 'number', 'min'],
    ['maxAccuracy', 'Location precision', 'Vaguer readings are refused', 'number', 'm'],
    ['selfReplaceDays', 'New phone approval', 'A second phone within this many days needs approval', 'number', 'days'],
  ];

  const tag = current ? tagOf(current) : null;
  const activeCount = zones.filter((z) => z.active).length;

  const panel = cfg && rules && (
    <aside className="zc-rail" aria-label="School areas">
      <div className="zc-rail-head">
        <b>School areas <span>· {zones.length}</span></b>
        {zones.length > 3 && (
          <button className={`zc-icon${filterOpen ? ' on' : ''}`} onClick={() => { setFilterOpen((f) => !f); setFilter(''); }} aria-label="Filter areas" aria-pressed={filterOpen} title="Filter areas"><ListFilter size={16} /></button>
        )}
        {canEdit && <button className={`sc-btn sc-btn-sm${adding ? ' sc-btn-primary' : ''}`} onClick={startAdding} data-testid="add-area">{adding ? 'Adding…' : <><Plus size={15} /> Add area</>}</button>}
      </div>
      {filterOpen && (
        <label className="zc-filter">
          <ListFilter size={14} />
          <span className="sr-only">Filter areas by name</span>
          <input autoFocus placeholder="Filter areas by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
      )}
      <div className="zc-list" role="listbox" aria-label="Areas">
        {adding && (
          <div className="zc-row zc-row-draft"><span className="zc-num">{zones.length + 1}</span><span className="zc-name">New area</span><span className="zc-meta">click the map</span></div>
        )}
        {zones.length === 0 && !adding && <div className="zc-empty"><MapPin size={18} />No area yet. Press Add area.</div>}
        {shown.map(({ z, i }) => {
          const t = tagOf(z);
          return (
            <button key={`${z.id ?? 'new'}-${i}`} role="option" aria-selected={i === sel && !adding} className={`zc-row${i === sel && !adding ? ' on' : ''}`}
              onClick={() => { setAdding(false); pick(i); }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
              <span className="zc-num">{i + 1}</span>
              <span className="zc-name" title={z.name}>{z.name || 'Untitled'}</span>
              {t && <span className={`zc-tag${t === 'New' ? ' new' : ''}`}>{t}</span>}
              <span className="zc-meta">{z.radius} m</span>
              <i className={`zc-dot${z.active ? ' on' : ''}`} title={z.active ? 'Active' : 'Off'} />
            </button>
          );
        })}
        {filter && shown.length === 0 && <div className="zc-empty">No area matches “{filter}”.</div>}
      </div>

      {current && !adding && (
        <div className="zc-editor" id="zone-test">
          <div className="zc-field">
            <span>Name</span>
            <input className="zc-input" value={current.name} maxLength={60} disabled={!canEdit} onChange={(e) => patch({ name: e.target.value })} aria-label="Area name" />
          </div>
          <div className="zc-field">
            <span>Radius</span>
            <div className="zc-radius">
              <button className="zc-step" disabled={!canEdit || current.radius <= MIN_R} onClick={() => patch({ radius: clampR(current.radius - 10) })} aria-label="10 m smaller"><Minus size={15} /></button>
              <input type="range" className="sc-range" min={MIN_R} max={MAX_R} step={10} value={current.radius} disabled={!canEdit} onChange={(e) => patch({ radius: Number(e.target.value) })} aria-label="Radius in metres" />
              <button className="zc-step" disabled={!canEdit || current.radius >= MAX_R} onClick={() => patch({ radius: clampR(current.radius + 10) })} aria-label="10 m larger"><Plus size={15} /></button>
              <b>{current.radius} m</b>
            </div>
          </div>
          {current.radius < 100 && <div className="zc-hint"><AlertTriangle size={14} />Under 100 m may refuse staff indoors</div>}
          <div className="zc-field">
            <span>Active</span>
            <span className="zc-coords" title="Centre">{current.lat.toFixed(5)}, {current.lng.toFixed(5)}</span>
            <button className="sc-switch" role="switch" aria-checked={current.active} disabled={!canEdit} aria-label={`${current.active ? 'Turn off' : 'Turn on'} ${current.name}`} onClick={() => patch({ active: !current.active })}><span /></button>
          </div>
          <div className="zc-actions">
            <button className="sc-btn sc-btn-sm" onClick={() => void testHere()} disabled={testing}>{testing ? <Spinner /> : <Crosshair size={15} />} Test here</button>
            {canEdit && isComputer() && <PhoneGps compact onFix={(f) => judge(f, true)} />}
            <div style={{ flex: 1 }} />
            {canEdit && (confirmRemove ? (
              <span className="zc-confirm">Remove?
                <button className="sc-btn sc-btn-danger sc-btn-sm" onClick={() => { setZones((zs) => zs.filter((_, j) => j !== sel)); setSel(0); setDirty(true); setConfirmRemove(false); toast.info('Area removed', 'Save to keep this change, or Discard.'); }}>Yes</button>
                <button className="sc-btn sc-btn-sm" onClick={() => setConfirmRemove(false)}>No</button>
              </span>
            ) : (
              <button className="zc-icon danger" onClick={() => setConfirmRemove(true)} aria-label={`Remove ${current.name}`} title="Remove area"><Trash2 size={16} /></button>
            ))}
          </div>
          {test && (
            <div className={`zc-test ${test.ok ? 'ok' : test.vague ? 'vague' : 'bad'}`} role="status">
              {test.ok ? <Check size={16} /> : <AlertTriangle size={16} />}
              <span><b>{test.title}.</b> {test.text}</span>
            </div>
          )}
          {test?.vague && canEdit && (
            <button className="sc-btn sc-btn-soft sc-btn-sm" onClick={() => { void staffClockApi.saveRules({ setupDone: ['tested'] }).then(announceClockChange).catch(() => undefined); toast.success('Area confirmed'); }}>
              <Check size={15} /> The circle covers the school
            </button>
          )}
          {tag && <div className="zc-unsaved"><i />{tag === 'New' ? 'New area, not saved yet' : 'Changed, not saved yet'}</div>}
        </div>
      )}

      {canEdit && (
        <div className={`zc-save${dirty ? ' dirty' : ''}`} role="region" aria-label="Save">
          <i aria-hidden="true" />
          <span>{dirty ? 'Unsaved changes' : 'All saved'}</span>
          <button className="sc-btn sc-btn-sm" disabled={!dirty || saving} onClick={() => void load()}>Discard</button>
          <button className="sc-btn sc-btn-primary sc-btn-sm" disabled={!dirty || saving} onClick={() => void save()}>{saving && <Spinner />}Save</button>
        </div>
      )}
    </aside>
  );

  const content = (
    <div className={embedded ? 'sc-page sc-page-embedded zc-page' : 'sc-page zc-page'}>
      {!embedded && (
        <StaffClockHeader
          title="Zone & settings"
          lead="Staff check in and out only inside these areas."
          actions={cfg && rules && canEdit ? (
            <>
              <span className={`sc-pill ${rules.enabled ? 'sc-tone-green' : 'sc-tone-muted'}`} style={{ height: 38, padding: '0 14px', fontSize: 14 }}><i />{rules.enabled ? 'Clock is on' : 'Clock is off'}</span>
              {rules.enabled ? (
                <button className="sc-btn" disabled={saving} onClick={() => void save(false)}>Turn off</button>
              ) : (
                <button className="sc-btn sc-btn-soft" disabled={saving || activeCount === 0} onClick={() => void save(true)}>Turn on</button>
              )}
            </>
          ) : undefined}
        />
      )}
      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {!cfg && !error ? (
        <div className="zc-stage zc-stage-skel" aria-busy="true">
          <div className="zc-rail" style={{ gap: 10 }}>{[40, 52, 52, 52, 180].map((h, i) => <div key={i} className="sc-skel" style={{ height: h, borderRadius: 999 }} />)}</div>
        </div>
      ) : cfg && rules && (
        <section className="zc-stage sc-map" id="zone-map" aria-label="Map">
          <div ref={mapEl} className="sc-map-el" />
          {tilesLoading && <span className="sc-map-loading" role="status"><Spinner /> Loading map…</span>}

          {panel}

          <div className={`zc-top${embedded ? ' embedded' : ''}`}>
            <form className={`zc-search${adding ? ' adding' : ''}`} onSubmit={(e) => void search(e)} role="search">
              <MapPin size={17} />
              <label className="sr-only" htmlFor="zc-place">Go to a place on the map</label>
              <input id="zc-place" ref={searchInput} placeholder={adding ? 'Where is the new area? Search a place…' : 'Go to a place or paste coordinates'} value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="sc-btn sc-btn-sm sc-btn-soft" type="submit" disabled={searching || !query.trim()}>{searching ? <Spinner /> : 'Go'}</button>
            </form>
            {hits && (
              <div className="zc-hits" role="listbox" aria-label="Places found">
                <div className="sc-hits-head"><span>{adding ? 'Add the new area at…' : 'Go to…'}</span><button type="button" onClick={() => setHits(null)}>Close</button></div>
                {hits.map((h, i) => (
                  <button key={`${h.lat},${h.lng},${i}`} type="button" role="option" aria-selected="false" className="sc-hit" onClick={() => choose(h)}>
                    <b className="sc-clip">{h.name}</b>
                    <small className="sc-clip">{h.detail}</small>
                  </button>
                ))}
              </div>
            )}
            {adding && (
              <div className="zc-banner" role="status">
                <Plus size={15} /> Click the map or search a place to drop the new area
                <button onClick={() => setAdding(false)}>Cancel</button>
              </div>
            )}
            {found && !adding && (
              <div className="zc-found-card" role="dialog" aria-label="Place found">
                <MapPin size={16} />
                <span className="sc-clip" title={found.name}><b>{found.name}</b></span>
                {canEdit && current && (
                  <button className="sc-btn sc-btn-sm" onClick={() => { patch({ lat: found.lat, lng: found.lng }); setFound(null); setTest(null); toast.success(`“${current.name}” moved`, 'Save to keep it.'); }}>Move “{current.name.slice(0, 18)}” here</button>
                )}
                {canEdit && <button className="sc-btn sc-btn-sm sc-btn-primary" onClick={() => addAt(found.lat, found.lng, found.detail === 'Coordinates' ? undefined : found.name)}><Plus size={14} /> Add area here</button>}
                <button className="zc-icon" onClick={() => setFound(null)} aria-label="Close"><X size={15} /></button>
              </div>
            )}
          </div>

          <div className="sc-seg zc-style" role="group" aria-label="Map style">
            <button aria-pressed={style === 'map'} onClick={() => setStyle('map')}>Map</button>
            <button aria-pressed={style === 'satellite'} onClick={() => setStyle('satellite')}>Satellite</button>
          </div>
          <div className="zc-tools">
            {!embedded && (
              <>
                <button className={`sc-btn${drawer === 'rules' ? ' sc-btn-primary' : ''}`} onClick={() => setDrawer((d) => (d === 'rules' ? null : 'rules'))} aria-expanded={drawer === 'rules'} data-testid="open-rules" aria-label="Rules"><Clock size={16} /><span className="zc-lbl">Rules</span></button>
                <button className={`sc-btn${drawer === 'share' ? ' sc-btn-primary' : ''}`} onClick={() => setDrawer((d) => (d === 'share' ? null : 'share'))} aria-expanded={drawer === 'share'} aria-label="Share"><Link2 size={16} /><span className="zc-lbl">Share</span></button>
              </>
            )}
          </div>

          {drawer === 'rules' && (
            <div className="zc-drawer" id="zone-rules" role="dialog" aria-label="Check-in rules">
              <div className="zc-drawer-head"><b>Check-in rules</b><button className="zc-icon" onClick={() => setDrawer(null)} aria-label="Close rules"><X size={16} /></button></div>
              <div className="zc-drawer-body">
                {ruleRows.map(([key, label, hint, type, unit]) => (
                  <label className="zc-rule" key={key} title={hint}>
                    <span>{label}</span>
                    <span className="zc-rule-in">
                      <input className="zc-input zc-input-sm" type={type} aria-label={label} disabled={!canEdit} value={String(rules[key])} min={type === 'number' ? 0 : undefined}
                        onChange={(e) => patchRules({ [key]: type === 'number' ? Number(e.target.value) : e.target.value } as Partial<ClockRules>)} />
                      {unit && <small>{unit}</small>}
                    </span>
                  </label>
                ))}
                <label className="zc-rule" title="Empty = any Google account. Or list domains: gmail.com, school.rw">
                  <span>Google accounts</span>
                  <input className="zc-input zc-input-md" aria-label="Allowed Google domains" placeholder="Any" disabled={!canEdit} value={rules.googleDomains} onChange={(e) => patchRules({ googleDomains: e.target.value })} />
                </label>
                <label className="zc-rule" title="Optional fixed IP range of the school Wi-Fi; counts as at school">
                  <span>School Wi-Fi</span>
                  <input className="zc-input zc-input-md" aria-label="School network" placeholder="41.186.10.0/24" disabled={!canEdit} value={rules.schoolNetworks} onChange={(e) => patchRules({ schoolNetworks: e.target.value })} />
                </label>
              </div>
              {canEdit && <div className="zc-drawer-foot">Changes save with the areas</div>}
            </div>
          )}
          {drawer === 'share' && (
            <div className="zc-drawer zc-drawer-short" role="dialog" aria-label="Staff link">
              <div className="zc-drawer-head"><b>Staff link</b><button className="zc-icon" onClick={() => setDrawer(null)} aria-label="Close"><X size={16} /></button></div>
              <div className="zc-drawer-body">
                <div className="zc-link"><Link2 size={15} /><a href={cfg.link.url} target="_blank" rel="noopener noreferrer" className="sc-clip">{cfg.link.display}</a><button className="sc-btn sc-btn-primary sc-btn-sm" onClick={() => void copyLink()}><Copy size={14} /> Copy</button></div>
                <p className="zc-sub"><i className={`zc-dot${rules.enabled ? ' on' : ''}`} />{rules.enabled ? 'Open: staff can register and check in' : 'Closed until the clock is on'}</p>
                <div className="zc-share-row">
                  <Link className="sc-btn sc-btn-sm" to="/staff/clock/poster"><Printer size={15} /> Poster</Link>
                  {can('STAFF_DEVICES_MANAGE') && <Link className="sc-btn sc-btn-sm" to="/staff/clock/devices"><QrCode size={15} /> QR cards</Link>}
                </div>
                {!cfg.googleConfigured && <div className="zc-hint"><AlertTriangle size={14} />Google sign-in is not set up on this server</div>}
              </div>
            </div>
          )}

          <div className="zc-bottom">
            {zones.length > 1 && <button className="sc-btn" onClick={fitAll} aria-label="Fit all areas"><Maximize2 size={16} /><span className="zc-lbl">Fit all</span></button>}
            <button className="sc-btn" onClick={() => void goToMyLocation()} disabled={locating} aria-label="My location">{locating ? <Spinner /> : <Crosshair size={16} />}<span className="zc-lbl">My location</span></button>
          </div>
        </section>
      )}
    </div>
  );
  return embedded ? content : <DashboardLayout>{content}</DashboardLayout>;
};
