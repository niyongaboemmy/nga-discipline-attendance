import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '../components/Layout/DashboardLayout';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { CalendarClock, MapPin, User } from 'lucide-react';

interface Period { time: string; subject: string; room: string; teacher: string }
interface DaySchedule { day: string; periods: Period[] }

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('sso_token')}` });
const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

export const Schedule: React.FC = () => {
  const [schedule, setSchedule] = useState<DaySchedule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Derive the student's class from their attendance, then fetch its timetable.
        let classId = '';
        const meRes = await fetch('/api/attendance/me', { headers: authHeaders() });
        if (meRes.ok) {
          const me = await meRes.json();
          if (me.success && me.data.length) classId = me.data[0].class_id || '';
        }
        const url = classId ? `/api/mis/schedule?class_id=${classId}` : '/api/mis/schedule';
        const res = await fetch(url, { headers: authHeaders() });
        if (res.ok) { const result = await res.json(); if (result.success) setSchedule(result.data); }
      } catch (err) { console.error('Error fetching schedule:', err); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Schedule</h1>
          <p className="page-subtitle">Your weekly class timetable.</p>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '80px 0' }}><LoadingSpinner /></div>
      ) : schedule.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: '64px 24px' }}>
            <CalendarClock size={32} />
            <span className="text-base font-semibold">No schedule available</span>
            <span className="text-sm" style={{ maxWidth: '360px' }}>
              Your class timetable hasn’t been published yet.
            </span>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
          {schedule.map((d) => {
            const isToday = d.day === todayName;
            return (
              <section key={d.day} className="card" style={isToday ? { borderColor: 'var(--primary)' } : undefined}>
                <div className="card-header">
                  <span className="section-title">{d.day}</span>
                  {isToday && <span className="badge badge-primary">Today</span>}
                </div>
                <div className="card-body flex flex-col gap-3">
                  {d.periods.map((p, i) => (
                    <div key={i} className="border rounded" style={{ padding: '10px 12px', background: 'var(--bg-subtle)' }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{p.subject}</span>
                        <span className="text-xs text-secondary mono">{p.time}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-secondary mt-1 flex-wrap">
                        <span className="flex items-center gap-1"><MapPin size={12} /> {p.room}</span>
                        <span className="flex items-center gap-1"><User size={12} /> {p.teacher}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </DashboardLayout>
  );
};
