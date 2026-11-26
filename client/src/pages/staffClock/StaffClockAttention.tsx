import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Copy, KeyRound, MapPin, Power, ShieldAlert, Smartphone, X } from 'lucide-react';
import type { Overview } from '../../api/staffClock';
import { initialsOf } from '../../api/staffClock';
import { useToast } from '../../context/ToastContext';

/**
 * Dashboard "Attention": only what stops or spoils staff check-in, one tile each,
 * one tap to the fix. Nothing to fix -> a single "Ready" pill.
 */
type Tone = 'red' | 'amber' | 'blue';
interface Item { key: string; tone: Tone; icon: React.ReactNode; value?: number; label: string; to?: string; onClick?: () => void }

export const AttentionStrip: React.FC<{ data: Overview; canSetup: boolean; onReview: () => void; onPhones: () => void }> = ({ data, canSetup, onReview, onPhones }) => {
  const h = data.health;
  const items: Item[] = [];
  if (h) {
    if (!h.google) items.push({ key: 'google', tone: 'red', icon: <KeyRound size={18} />, label: 'Google sign-in not set up', to: canSetup ? '/staff/clock/setup?step=google' : undefined });
    if (!h.zones) items.push({ key: 'zone', tone: 'red', icon: <MapPin size={18} />, label: 'No school zone', to: canSetup ? '/staff/clock/setup?step=zone' : undefined });
    if (!h.enabled) items.push({ key: 'open', tone: 'red', icon: <Power size={18} />, label: 'Check-in is off', to: canSetup ? '/staff/clock/setup?step=open' : undefined });
    if (h.zones && !h.tested) items.push({ key: 'tested', tone: 'amber', icon: <ClipboardCheck size={18} />, label: 'Zone not tested', to: canSetup ? '/staff/clock/setup?step=test' : undefined });
    if (h.unregistered > 0) items.push({ key: 'phones', tone: 'amber', icon: <Smartphone size={18} />, value: h.unregistered, label: h.unregistered === 1 ? 'staff without a phone' : 'staff without a phone', to: '/staff/clock/devices' });
  }
  if (data.phones.pending.length) items.push({ key: 'pending', tone: 'blue', icon: <Smartphone size={18} />, value: data.phones.pending.length, label: 'phone waiting approval', onClick: onPhones });
  if (data.kpis.needsReview) items.push({ key: 'review', tone: 'amber', icon: <ShieldAlert size={18} />, value: data.kpis.needsReview, label: 'unusual check-in', onClick: onReview });

  if (!items.length) {
    return (
      <div className="sc-ready" role="status">
        <CheckCircle2 size={18} /> Staff check-in is ready
      </div>
    );
  }
  return (
    <section className="sc-attn" aria-label="Needs attention">
      {items.map((it) => {
        const body = (
          <>
            <span className={`sc-attn-ico sc-attn-${it.tone}`}>{it.icon}</span>
            <span className="sc-attn-text">
              {it.value != null && <b>{it.value}</b>}
              <span>{it.label}</span>
            </span>
            {(it.to || it.onClick) && <ArrowRight size={16} className="sc-attn-go" />}
          </>
        );
        if (it.to) return <Link key={it.key} to={it.to} className="sc-attn-item" data-attn={it.key}>{body}</Link>;
        if (it.onClick) return <button key={it.key} type="button" onClick={it.onClick} className="sc-attn-item" data-attn={it.key}>{body}</button>;
        return <div key={it.key} className="sc-attn-item" data-attn={it.key}>{body}</div>;
      })}
    </section>
  );
};

/** Check-in ring: share of staff in today. */
export const Ring: React.FC<{ value: number; total: number; size?: number }> = ({ value, total, size = 92 }) => {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? Math.min(1, value / total) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${total} checked in`} className="sc-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary-light)" strokeWidth="10" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary)" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s ease' }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="sc-ring-text">{Math.round(pct * 100)}%</text>
    </svg>
  );
};

export interface SheetPerson { id: string; name: string; meta?: string; tag?: string; group?: string }

/** Side sheet listing people (not in, no check-out ...), with "Copy names". */
export const ListSheet: React.FC<{ title: string; subtitle?: string; people: SheetPerson[]; empty: string; onClose: () => void }> = ({ title, subtitle, people, empty, onClose }) => {
  const toast = useToast();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const groups = new Map<string, SheetPerson[]>();
  for (const p of people) {
    const g = p.group ?? '';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const copy = async () => {
    const names = [...new Set(people.map((p) => p.name))].join('\n');
    try {
      await navigator.clipboard.writeText(names);
      toast.success('Names copied');
    } catch {
      toast.error('Could not copy');
    }
  };
  return (
    <div className="sc-sheet-back" onClick={onClose}>
      <aside className="sc-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sc-sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2>{title} <span className="sc-sheet-count">{people.length}</span></h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="sc-icon-close" style={{ position: 'static' }} aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {people.length === 0 ? (
          <div className="sc-sheet-empty"><CheckCircle2 size={28} /><span>{empty}</span></div>
        ) : (
          <div className="sc-sheet-list">
            {[...groups.entries()].map(([g, ps]) => (
              <div key={g || 'all'}>
                {g && <div className="sc-sheet-group">{g}</div>}
                {ps.map((p) => (
                  <div key={`${g}-${p.id}`} className="sc-item">
                    <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(p.name)}</span>
                    <span className="sc-item-main"><b className="sc-clip" title={p.name}>{p.name}</b>{p.meta && <small className="sc-clip sc-muted">{p.meta}</small>}</span>
                    {p.tag && <span className="sc-pill sc-tone-amber" style={{ height: 24, fontSize: 12 }}><AlertTriangle size={12} />{p.tag}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {people.length > 0 && (
          <footer className="sc-sheet-foot">
            <button className="sc-btn sc-btn-soft" onClick={() => void copy()}><Copy size={16} /> Copy names</button>
          </footer>
        )}
      </aside>
    </div>
  );
};
