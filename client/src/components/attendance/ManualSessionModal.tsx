import React, { useEffect, useState } from 'react';
import { Dialog } from '../common/Dialog';
import { SearchableSelect } from '../common/SearchableSelect';
import { apiGet } from '../../api/client';
import { getHomeroomClasses, type CalendarSession, type HomeroomClass } from '../../api/schedule';
import { isoDate } from '../../utils/time';

interface ClassRow { id: string; name: string; department: string }
interface SubjectRow { id: number; name: string; code: string | null }

/**
 * Ad-hoc register entry from the calendar — for a session the MIS timetable
 * doesn't carry (a make-up lesson, a correction, a club). Produces the same
 * synthetic CalendarSession the RegisterDrawer takes, so the workflow is
 * identical to opening a lesson block.
 */
export const ManualSessionModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onPick: (t: { session: CalendarSession; date: string }) => void;
}> = ({ open, onClose, onPick }) => {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [homeroomClasses, setHomeroomClasses] = useState<HomeroomClass[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  const [sessionType, setSessionType] = useState<'homeroom' | 'subject'>('homeroom');
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState<number | ''>('');
  const [dateStr, setDateStr] = useState(isoDate());
  const [period, setPeriod] = useState('Morning');

  useEffect(() => {
    if (!open) return;
    apiGet<ClassRow[]>('/api/mis/classes').then((r) => setClasses(r.data ?? [])).catch(() => setClasses([]));
    // Only the classes this teacher is the assigned Class Teacher of may take
    // a morning register — the subject picker below stays unrestricted.
    getHomeroomClasses().then(setHomeroomClasses).catch(() => setHomeroomClasses([]));
  }, [open]);

  // The class list depends on session type; drop a selection that no longer
  // belongs to the active list (e.g. switching to Homeroom after picking a
  // class you don't lead).
  useEffect(() => {
    const options = sessionType === 'homeroom' ? homeroomClasses : classes;
    if (classId && !options.some((c) => c.id === classId)) setClassId('');
  }, [sessionType, classes, homeroomClasses, classId]);

  useEffect(() => {
    if (!classId) { setSubjects([]); return; }
    let cancelled = false;
    setLoadingSubjects(true);
    apiGet<SubjectRow[]>(`/api/mis/class-subjects?class_id=${encodeURIComponent(classId)}`)
      .then((r) => { if (!cancelled) setSubjects(r.data ?? []); })
      .catch(() => { if (!cancelled) setSubjects([]); })
      .finally(() => { if (!cancelled) setLoadingSubjects(false); });
    return () => { cancelled = true; };
  }, [classId]);

  useEffect(() => {
    if (subjectId !== '' && !subjects.some((s) => s.id === subjectId)) setSubjectId('');
  }, [subjects, subjectId]);

  const classOptions = sessionType === 'homeroom' ? homeroomClasses : classes;
  const cls = classOptions.find((c) => c.id === classId);
  const subj = subjects.find((s) => s.id === subjectId);
  const ready = !!classId && (sessionType === 'homeroom' || subjectId !== '');

  const submit = () => {
    if (!ready || !cls) return;
    const effPeriod = sessionType === 'homeroom' ? period : (period || 'Session');
    const qs = new URLSearchParams({ classId, date: dateStr, sessionType, period: effPeriod });
    if (sessionType === 'subject' && subjectId !== '') qs.set('subjectId', String(subjectId));
    const session: CalendarSession = {
      kind: sessionType,
      classId,
      className: cls.name,
      subjectId: sessionType === 'subject' && subjectId !== '' ? Number(subjectId) : null,
      subjectName: subj?.name ?? null,
      subjectCode: subj?.code ?? null,
      color: null,
      startTime: '',
      endTime: '',
      room: '',
      status: 'missing',
      ownStatus: null,
      deepLink: `/attendance/mark?${qs.toString()}`,
      teacherId: null,
      teacherName: null,
      isMine: true,
    };
    onPick({ session, date: dateStr });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record a session"
      subtitle="For a lesson that isn't on your timetable — a make-up class, a correction, or an ad-hoc group."
      maxWidth={460}
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={submit}>Open register</button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="field">
          <label className="label">Session type</label>
          <div className="segmented">
            <button
              type="button"
              className={`segmented-btn${sessionType === 'homeroom' ? ' is-active' : ''}`}
              onClick={() => setSessionType('homeroom')}
            >
              Homeroom (daily)
            </button>
            <button
              type="button"
              className={`segmented-btn${sessionType === 'subject' ? ' is-active' : ''}`}
              onClick={() => setSessionType('subject')}
            >
              Subject / course
            </button>
          </div>
        </div>

        <div className="field">
          <label className="label">Class</label>
          <SearchableSelect
            aria-label="Class"
            placeholder={sessionType === 'homeroom' ? 'Select a class you lead…' : 'Select a class…'}
            value={classId}
            onChange={setClassId}
            options={classOptions.map((c) => ({ value: c.id, label: c.name, hint: (c as ClassRow).department }))}
          />
          {sessionType === 'homeroom' && homeroomClasses.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
              You aren't the assigned Class Teacher of any class, so there's no homeroom register for you to take.
            </p>
          )}
        </div>

        {sessionType === 'subject' && (
          <div className="field">
            <label className="label">Subject</label>
            <SearchableSelect
              aria-label="Subject"
              placeholder={loadingSubjects ? 'Loading subjects…' : 'Select a subject…'}
              value={subjectId === '' ? '' : String(subjectId)}
              onChange={(v) => setSubjectId(v ? Number(v) : '')}
              disabled={loadingSubjects || !classId}
              clearable
              options={subjects.map((s) => ({ value: String(s.id), label: s.name, hint: s.code || undefined }))}
            />
          </div>
        )}

        <div className="flex gap-3">
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Date</label>
            <input
              className="input"
              type="date"
              value={dateStr}
              max={isoDate()}
              onChange={(e) => setDateStr(e.target.value || isoDate())}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label className="label">Period</label>
            <SearchableSelect
              aria-label="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'Morning', label: 'Morning' },
                { value: 'Afternoon', label: 'Afternoon' },
                { value: 'Evening', label: 'Evening' },
              ]}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
};
