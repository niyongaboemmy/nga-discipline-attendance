import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Copy, KeyRound, MapPin, Power, ShieldAlert, Smartphone, X, ChevronRight } from 'lucide-react';
import type { Overview } from '../../api/staffClock';
import { initialsOf } from '../../api/staffClock';
import { useToast } from '../../context/ToastContext';

/**
 * Dashboard "Attention": only what stops or spoils staff check-in, one tile each,
 * one tap to the fix. Nothing to fix -> a single "Ready" pill.
 */
type Tone = 'red' | 'amber' | 'warn';
interface Item { key: string; tone: Tone; icon: React.ReactNode; value?: number; label: string; hint: string; to?: string; onClick?: () => void }

export const AttentionStrip: React.FC<{ data: Overview; canSetup: boolean; onReview: () => void; onPhones: () => void }> = ({ data, canSetup, onReview, onPhones }) => {
  const h = data.health;
  const items: Item[] = [];
  const waiting = data.phones.pending.length;
  // A phone waiting for approval comes first and keeps pulsing until someone decides:
  // that person cannot check in meanwhile.
  if (waiting) items.push({ key: 'pending', tone: 'warn', icon: <Smartphone size={16} />, value: waiting, label: waiting === 1 ? 'phone waiting' : 'phones waiting', hint: `${waiting} new ${waiting === 1 ? 'phone is' : 'phones are'} waiting for approval. Until you decide, ${waiting === 1 ? 'that person' : 'those people'} cannot check in.`, onClick: onPhones });
  if (h) {
    if (!h.google) items.push({ key: 'google', tone: 'red', icon: <KeyRound size={16} />, label: 'Set up Google', hint: 'Google sign-in is not set up', to: canSetup ? '/staff/clock/setup?step=google' : undefined });
    if (!h.zones) items.push({ key: 'zone', tone: 'red', icon: <MapPin size={16} />, label: 'Add a zone', hint: 'The school has no check-in zone', to: canSetup ? '/staff/clock/setup?step=zone' : undefined });
    if (!h.enabled) items.push({ key: 'open', tone: 'red', icon: <Power size={16} />, label: 'Check-in is off', hint: 'Staff check-in is switched off', to: canSetup ? '/staff/clock/setup?step=open' : undefined });
    if (h.zones && !h.tested) items.push({ key: 'tested', tone: 'amber', icon: <ClipboardCheck size={16} />, label: 'Test the zone', hint: 'The zone has not been tested yet', to: canSetup ? '/staff/clock/setup?step=test' : undefined });
    if (h.unregistered > 0) items.push({ key: 'phones', tone: 'amber', icon: <Smartphone size={16} />, value: h.unregistered, label: 'no phone', hint: `${h.unregistered} staff have not registered a phone`, to: '/staff/clock/devices' });
  }
  if (data.kpis.needsReview) items.push({ key: 'review', tone: 'amber', icon: <ShieldAlert size={16} />, value: data.kpis.needsReview, label: 'to review', hint: `${data.kpis.needsReview} unusual check-in${data.kpis.needsReview === 1 ? '' : 's'} to review`, onClick: onReview });

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
        const cls = `sc-attn-item sc-attn-${it.tone}`;
        const body = (
          <>
            {it.tone === 'warn' && <i className="sc-attn-pulse" aria-hidden="true" />}
            <span className="sc-attn-ico">{it.icon}</span>
            <span className="sc-attn-text">{it.value != null && <b>{it.value}</b>}{it.label}</span>
            {(it.to || it.onClick) && <ArrowRight size={15} className="sc-attn-go" />}
          </>
        );
        if (it.to) return <Link key={it.key} to={it.to} className={cls} data-attn={it.key} title={it.hint} aria-label={it.hint}>{body}</Link>;
        if (it.onClick) return <button key={it.key} type="button" onClick={it.onClick} className={cls} data-attn={it.key} title={it.hint} aria-label={it.hint} role={it.tone === 'warn' ? 'alert' : undefined}>{body}</button>;
        return <div key={it.key} className={cls} data-attn={it.key} title={it.hint}>{body}</div>;
      })}
    </section>
  );
};

/** Check-in ring: share of staff in today. */
export const Ring: React.FC<{ value: number; total: number; size?: number; label?: string }> = ({ value, total, size = 92, label }) => {
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? Math.min(1, value / total) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `${value} of ${total} checked in`} className="sc-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary-light)" strokeWidth="10" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary)" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s ease' }} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="sc-ring-text">{Math.round(pct * 100)}%</text>
    </svg>
  );
};

export interface SheetPerson { id: string; name: string; meta?: string; tag?: string; group?: string; personId?: string; /** the day this row is about */ date?: string }

/** Side sheet listing people (not in, no check-out ...), with "Copy names". */
export const ListSheet: React.FC<{ title: string; subtitle?: string; people: SheetPerson[]; empty: string; onClose: () => void; onPick?: (p: SheetPerson) => void }> = ({ title, subtitle, people, empty, onClose, onPick }) => {
  const toast = useToast();
  useEffect(() => {
    // A person's history open on top: Escape closes that first, not this list.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.sh-overlay')) onClose(); };
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
                {ps.map((p) => {
                  const inner = (
                    <>
                      <span className="sc-avatar" style={{ width: 38, height: 38 }}>{initialsOf(p.name)}</span>
                      <span className="sc-item-main"><b className="sc-clip" title={p.name}>{p.name}</b>{p.meta && <small className="sc-clip sc-muted">{p.meta}</small>}</span>
                      {p.tag && <span className="sc-pill sc-tone-amber" style={{ height: 24, fontSize: 12 }}><AlertTriangle size={12} />{p.tag}</span>}
                      {onPick && p.personId && <ChevronRight size={16} className="sc-item-go" aria-hidden />}
                    </>
                  );
                  return onPick
                    ? <button key={`${g}-${p.id}`} className="sc-item sc-item-pick" onClick={() => onPick(p)}>{inner}</button>
                    : <div key={`${g}-${p.id}`} className="sc-item">{inner}</div>;
                })}
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
