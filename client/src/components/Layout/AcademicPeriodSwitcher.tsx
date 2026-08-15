import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Calendar, AlertTriangle } from 'lucide-react';
import { useAcademicPeriod } from '../../context/AcademicPeriodContext';

/** Global year → term switcher. Displays every academic year but defaults to
 *  whichever year/term the MIS currently flags as active (see AcademicPeriodContext).
 *  Renders as a warning pill when no year/term is selected, since every scoped
 *  page falls back to unfiltered ("all periods") data in that state. */
export const AcademicPeriodSwitcher: React.FC = () => {
  const {
    years, termsByYear, selectedYearId, selectedTermId, hasSelection, misHasActivePeriod, loading,
    fetchTermsForYear, switchPeriod,
  } = useAcademicPeriod();
  const [open, setOpen] = useState(false);
  const [activeYearId, setActiveYearId] = useState<number | null>(selectedYearId);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setActiveYearId(selectedYearId); }, [selectedYearId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open && activeYearId != null) fetchTermsForYear(activeYearId);
  }, [open, activeYearId, fetchTermsForYear]);

  if (loading && years.length === 0) return null;

  const selectedYear = years.find((y) => y.academic_year_id === selectedYearId);
  const selectedTerm = termsByYear[selectedYearId ?? -1]?.find((t) => t.academic_term_id === selectedTermId);
  const terms = activeYearId != null ? termsByYear[activeYearId] || [] : [];

  const handlePick = async (yearId: number, termId: number) => {
    if (yearId === selectedYearId && termId === selectedTermId) { setOpen(false); return; }
    setSwitching(true);
    try {
      await switchPeriod(yearId, termId);
      setOpen(false);
    } catch (err) {
      console.error('Error switching academic period:', err);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        className="icon-btn hide-mobile"
        style={{
          alignItems: 'center', gap: '6px', width: 'auto', padding: '0 10px',
          ...(hasSelection ? {} : { background: 'var(--warning-light)', color: 'var(--warning)' }),
        }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={hasSelection ? 'Switch academic period' : 'No academic period selected — choose one'}
        title={hasSelection ? undefined : 'No academic year/term selected. Data shown may span every period.'}
      >
        {hasSelection ? <Calendar size={16} /> : <AlertTriangle size={16} />}
        <span className="text-sm font-semibold">
          {years.length === 0
            ? 'No academic years'
            : hasSelection
              ? `${selectedYear?.name ?? ''}${selectedTerm ? ` · ${selectedTerm.name}` : ''}`
              : 'Select academic period'}
        </span>
        <ChevronDown size={14} className="topnav-caret" />
      </button>

      {open && years.length === 0 && (
        <div className="menu menu--right animate-fade-in" style={{ minWidth: '260px' }}>
          <div className="empty-state" style={{ padding: '16px' }}>
            <AlertTriangle size={20} color="var(--warning)" />
            <span className="text-sm text-secondary">
              No academic years are configured in the MIS yet. Contact an administrator.
            </span>
          </div>
        </div>
      )}

      {open && years.length > 0 && (
        <div className="menu menu--right animate-fade-in" style={{ display: 'flex', minWidth: '320px' }}>
          {!misHasActivePeriod && (
            <div
              className="text-xs"
              style={{
                position: 'absolute', top: '-34px', right: 0, whiteSpace: 'nowrap',
                background: 'var(--warning-light)', color: 'var(--warning)', padding: '6px 10px', borderRadius: '6px',
              }}
            >
              The MIS has no active term — pick one manually.
            </div>
          )}
          <div style={{ borderRight: '1px solid var(--border-color)', minWidth: '140px' }}>
            {years.map((y) => (
              <button
                key={y.academic_year_id}
                className={`menu-item${y.academic_year_id === activeYearId ? ' is-active' : ''}`}
                onClick={() => setActiveYearId(y.academic_year_id)}
              >
                <span>{y.name}</span>
                {y.is_current === 1 && <span className="text-xs text-tertiary">current</span>}
              </button>
            ))}
          </div>
          <div style={{ minWidth: '160px' }}>
            {terms.length === 0 ? (
              <div className="empty-state" style={{ padding: '16px' }}>
                <span className="text-sm text-secondary">No terms found</span>
              </div>
            ) : (
              terms.map((t) => (
                <button
                  key={t.academic_term_id}
                  className={`menu-item${t.academic_term_id === selectedTermId && activeYearId === selectedYearId ? ' is-active' : ''}`}
                  disabled={switching}
                  onClick={() => activeYearId != null && handlePick(activeYearId, t.academic_term_id)}
                >
                  <span>{t.name}</span>
                  {t.is_current === 1 && <span className="text-xs text-tertiary">current</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
