import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';
import { useAuth } from './AuthContext';

export interface AcademicYear {
  academic_year_id: number;
  name: string;
  start_date?: string;
  end_date?: string;
  is_current?: number;
}

export interface AcademicTerm {
  academic_term_id: number;
  academic_year_id: number;
  name: string;
  start_date?: string;
  end_date?: string;
  is_current?: number;
}

interface AcademicPeriodContextType {
  years: AcademicYear[];
  termsByYear: Record<number, AcademicTerm[]>;
  loading: boolean;
  selectedYearId: number | null;
  selectedTermId: number | null;
  /** True once a year AND term are selected. When false, scoped data is
   *  effectively unfiltered — pages should surface a warning. */
  hasSelection: boolean;
  /** False only once we've actively confirmed the MIS has no year/term flagged
   *  `is_current` at all (as opposed to just not having checked yet). */
  misHasActivePeriod: boolean;
  /** Bumped every time the period changes — use as a remount key to force
   *  dependent pages to refetch. */
  academicPeriodVersion: number;
  fetchTermsForYear: (yearId: number) => Promise<AcademicTerm[]>;
  switchPeriod: (yearId: number, termId: number) => Promise<void>;
}

const AcademicPeriodContext = createContext<AcademicPeriodContextType | undefined>(undefined);

async function apiGet(path: string, token: string) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const result = await res.json();
  if (!res.ok || !result.success) throw new Error(result.message || `Request to ${path} failed.`);
  return result.data;
}

export const AcademicPeriodProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, user, permissions, setSession } = useAuth();
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [termsByYear, setTermsByYear] = useState<Record<number, AcademicTerm[]>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [academicPeriodVersion, setAcademicPeriodVersion] = useState<number>(0);
  const [misHasActivePeriod, setMisHasActivePeriod] = useState<boolean>(true);

  const fetchTermsForYear = useCallback(async (yearId: number): Promise<AcademicTerm[]> => {
    if (!token) return [];
    const cached = termsByYear[yearId];
    if (cached) return cached;
    try {
      const data = await apiGet(`/api/academics/terms?academic_year_id=${yearId}`, token);
      const terms = Array.isArray(data) ? data : [];
      setTermsByYear((prev) => ({ ...prev, [yearId]: terms }));
      return terms;
    } catch (err) {
      console.error('Error fetching academic terms:', err);
      return [];
    }
  }, [token, termsByYear]);

  const switchPeriod = useCallback(async (yearId: number, termId: number) => {
    if (!token) return;
    const res = await fetch('/api/academics/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ academic_year_id: yearId, academic_term_id: termId }),
    });
    const result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Could not switch academic period.');
    }
    const { token: newToken, user: newUser } = result.data;
    setSession(newToken, newUser, permissions);
    setAcademicPeriodVersion((v) => v + 1);
  }, [token, permissions, setSession]);

  useEffect(() => {
    if (!token || !user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const data = await apiGet('/api/academics/years', token);
        if (!cancelled) setYears(Array.isArray(data) ? data : []);

        if (user.academicYearId != null) {
          if (!cancelled) await fetchTermsForYear(user.academicYearId);
        } else {
          // No period on this session's token yet — either it predates this
          // feature, or the earlier auto-select attempt failed. Ask the MIS
          // directly and self-heal by switching into it, so the user doesn't
          // have to log out/in to pick up the fix.
          const current = await apiGet('/api/academics/current', token);
          if (cancelled) return;
          if (current?.academicYearId != null && current?.academicTermId != null) {
            await fetchTermsForYear(current.academicYearId);
            if (!cancelled) await switchPeriod(current.academicYearId, current.academicTermId);
          } else {
            // The MIS genuinely has no year/term flagged as current right now.
            setMisHasActivePeriod(false);
          }
        }
      } catch (err) {
        console.error('Error fetching academic years:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id]);

  const selectedYearId = user?.academicYearId ?? null;
  const selectedTermId = user?.academicTermId ?? null;

  return (
    <AcademicPeriodContext.Provider
      value={{
        years,
        termsByYear,
        loading,
        selectedYearId,
        selectedTermId,
        hasSelection: selectedYearId != null && selectedTermId != null,
        misHasActivePeriod,
        academicPeriodVersion,
        fetchTermsForYear,
        switchPeriod,
      }}
    >
      {children}
    </AcademicPeriodContext.Provider>
  );
};

export const useAcademicPeriod = () => {
  const context = useContext(AcademicPeriodContext);
  if (!context) {
    throw new Error('useAcademicPeriod must be used within an AcademicPeriodProvider');
  }
  return context;
};
