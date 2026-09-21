import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarRange,
  CalendarClock,
  Sun,
  BookOpen,
  MapPin,
  Clock,
  PenLine,
  RotateCcw,
  Plus,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  X,
  User,
  PartyPopper,
} from "lucide-react";
import { DashboardLayout } from "../components/Layout/DashboardLayout";
import { ErrorState } from "../components/common/ErrorState";
import { StatusChip } from "../components/attendance/StatusChip";
import { useToast } from "../context/ToastContext";
import {
  RegisterDrawer,
  type DrawerTarget,
} from "../components/attendance/RegisterDrawer";
import { ManualSessionModal } from "../components/attendance/ManualSessionModal";
import {
  EventHoverCard,
  type HoverTarget,
} from "../components/attendance/EventHoverCard";
import { usePermissions } from "../hooks/usePermissions";
import {
  getScheduleMonth,
  getScheduleWeek,
  getScheduleDay,
  sessionDetailLink,
  type MonthResponse,
  type WeekResponse,
  type DayResponse,
  type CalendarSession,
} from "../api/schedule";
import { ApiError } from "../api/client";
import { isoDate, clock, DOW_LABEL } from "../utils/time";

type View = "month" | "week" | "day";

const addDays = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() + n);
  return isoDate(x);
};
const addMonths = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00");
  x.setMonth(x.getMonth() + n);
  return isoDate(x);
};
const mondayOf = (d: string) => {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return isoDate(x);
};
const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const nowMin = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
};

const monthTitle = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
const dayTitle = (d: string) =>
  d === isoDate()
    ? "Today"
    : new Date(d + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
const rangeTitle = (a: string, b: string) => {
  const f = (s: string) =>
    new Date(s + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  return `${f(a)} – ${f(b)}`;
};

/** Build a drawer target for `session`, resolving the next un-recorded lesson
 *  that same day so the drawer can offer "take the next one" after a save. */
function buildTarget(
  daySessions: CalendarSession[],
  session: CalendarSession,
  date: string,
): DrawerTarget {
  const start = toMin(session.startTime || "00:00");
  const nxt = daySessions
    .filter(
      (x) =>
        x.kind === "subject" &&
        x.status === "missing" &&
        toMin(x.startTime) > start &&
        x !== session,
    )
    .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0];
  return {
    session,
    date,
    next: nxt
      ? {
          session: nxt,
          date,
          label: `${nxt.subjectName ?? "Lesson"} · ${nxt.className}`,
        }
      : null,
  };
}

/** A session is "overdue" once its window has passed with nothing recorded —
 *  this is the one state that deserves an unmissable warning, as distinct
 *  from a lesson that just hasn't happened yet. */
function isOverdue(s: CalendarSession, date: string, today: string): boolean {
  if (s.status !== "missing") return false;
  if (date < today) return true;
  if (date > today) return false;
  const end = toMin(s.endTime || s.startTime) || toMin(s.startTime) + 40;
  return nowMin() > end;
}

/** Distinct subjects (id, name, colour) *assigned to the signed-in user* —
 *  drawn from whatever session list is currently loaded, filtered to lessons
 *  they actually teach. On a calendar that also shows co-teachers' lessons
 *  (an admin/coordinator view), this is what "your subjects" should mean —
 *  not every subject visible on screen. Powers the chip strip and the
 *  highlight/dim interaction on the grid. */
function collectSubjects(sessions: CalendarSession[]) {
  const map = new Map<number, { id: number; name: string; color: string }>();
  for (const s of sessions) {
    if (s.kind !== "subject" || s.subjectId == null || !s.isMine) continue;
    if (!map.has(s.subjectId)) {
      map.set(s.subjectId, {
        id: s.subjectId,
        name: s.subjectName || "Subject",
        color: s.color || "var(--subject-fallback)",
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** done / total registers for one day, counting the subject lessons plus the
 *  first homeroom entry (mirrors the server's `progress` for the day view). */
function dayProgress(sessions: CalendarSession[]) {
  let seenHr = false;
  const recordable = sessions.filter((s) => {
    if (s.kind === "subject") return true;
    if (seenHr) return false;
    seenHr = true;
    return true;
  });
  return {
    done: recordable.filter((s) => s.status === "recorded").length,
    total: recordable.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Month                                                                     */
/* -------------------------------------------------------------------------- */
const MonthView: React.FC<{
  data: MonthResponse;
  cursor: string;
  onPickDay: (d: string) => void;
}> = ({ data, cursor, onPickDay }) => {
  const byDate = useMemo(
    () => new Map(data.days.map((d) => [d.date, d])),
    [data],
  );
  const first = data.first;
  const lead = (new Date(first + "T00:00:00").getDay() + 6) % 7; // Mon=0
  const gridStart = addDays(first, -lead);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = isoDate();
  const curMonth = cursor.slice(0, 7);

  return (
    <div className="cal-month">
      <div className="cal-month-dows">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="cal-month-grid">
        {cells.map((date) => {
          const d = byDate.get(date);
          const outside = date.slice(0, 7) !== curMonth;
          const dow = new Date(date + "T00:00:00").getDay();
          const weekend = dow === 0 || dow === 6;
          const total = d?.progress.total ?? 0;
          const done = d?.progress.done ?? 0;
          const past = date < today;
          const isToday = date === today;
          const pct = total ? Math.round((done / total) * 100) : 0;
          let meterCls = "is-future";
          let ringColor = "var(--border-strong)";
          if (total > 0) {
            if (done === total) {
              meterCls = "is-done";
              ringColor = "var(--success)";
            } else if (done > 0) {
              meterCls = "is-partial";
              ringColor = "var(--warning)";
            } else if (past || isToday) {
              meterCls = "is-none";
              ringColor = "var(--danger)";
            } else {
              meterCls = "is-future";
              ringColor = "var(--border-strong)";
            }
          }
          return (
            <button
              key={date}
              className={`cal-daycell${outside ? " is-outside" : ""}${weekend ? " is-weekend" : ""}${isToday ? " is-today" : ""}${!past && !isToday ? " is-future" : ""}`}
              onClick={() => onPickDay(date)}
            >
              <span className="cal-daynum">
                {new Date(date + "T00:00:00").getDate()}
              </span>
              {total > 0 && (
                <span className={`cal-daymeter ${meterCls}`}>
                  <span
                    className="cal-ring"
                    style={{
                      ["--ring" as string]: String(pct),
                      ["--ring-color" as string]: ringColor,
                    }}
                  />
                  <span>
                    {done}/{total}
                  </span>
                </span>
              )}
              {(d?.colors.length ?? 0) > 0 && (
                <span className="cal-daydots">
                  {d!.colors.map((c, i) => (
                    <span
                      key={i}
                      className="cal-daydot"
                      style={{ ["--dot" as string]: c }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Week                                                                      */
/* -------------------------------------------------------------------------- */
const HOUR_H = 62;

/** Assign overlapping events to side-by-side lanes so their text never
 *  collides — the standard calendar column-packing approach. */
function packLanes<T extends { startTime: string; endTime: string }>(
  events: T[],
) {
  const items = [...events]
    .map((ev) => ({
      ev,
      s: toMin(ev.startTime),
      e: Math.max(toMin(ev.startTime) + 20, toMin(ev.endTime || ev.startTime)),
    }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const laneEnds: number[] = [];
  const placed = items.map((it) => {
    let lane = laneEnds.findIndex((end) => end <= it.s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.e);
    } else {
      laneEnds[lane] = it.e;
    }
    return { ...it, lane };
  });
  return placed.map((p) => {
    const clash = placed.filter((q) => q.s < p.e && q.e > p.s);
    return {
      ev: p.ev,
      s: p.s,
      e: p.e,
      lane: p.lane,
      lanes: Math.max(...clash.map((q) => q.lane)) + 1,
    };
  });
}

const WeekView: React.FC<{
  data: WeekResponse;
  onOpen: (t: DrawerTarget) => void;
  focusSubject: number | null;
}> = ({ data, onOpen, focusSubject }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canMark = can("ATTENDANCE_MARK");
  const today = isoDate();

  // Hover preview — a short intent delay so a mouse just passing over the
  // grid doesn't pop cards open, and a matching delay on hide so moving from
  // the trigger onto the card itself (to click its action) doesn't close it.
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const scheduleShow = (
    session: CalendarSession,
    date: string,
    rect: DOMRect,
  ) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(
      () => setHover({ session, date, rect }),
      150,
    );
  };
  const scheduleHide = () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 150);
  };
  const cancelHide = () => clearTimeout(hideTimer.current);
  useEffect(
    () => () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    },
    [],
  );
  // The card is positioned from a one-off getBoundingClientRect snapshot, not
  // tracked live — close it on scroll rather than let it drift from its trigger.
  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [hover]);

  // Always show the working week (Mon–Fri), plus any weekend day that has
  // lessons and always today — an empty weekday stays as an empty column
  // rather than collapsing the grid and looking like a skipped day.
  const days = data.days.filter(
    (d) =>
      (d.dayOfWeek >= 1 && d.dayOfWeek <= 5) ||
      d.date === today ||
      d.sessions.some((s) => s.kind === "subject"),
  );
  const sessionsForHoverDate = (date: string) =>
    days.find((d) => d.date === date)?.sessions ?? [];
  const cols = days.length || 1;

  const allSubjects = days.flatMap((d) =>
    d.sessions.filter((s) => s.kind === "subject"),
  );
  const hasAny = allSubjects.length > 0;

  // Grid window: fit the lessons, falling back to a normal school day.
  const minStart = hasAny
    ? Math.min(...allSubjects.map((s) => toMin(s.startTime))) - 15
    : 7 * 60;
  const maxEnd = hasAny
    ? Math.max(...allSubjects.map((s) => toMin(s.endTime || s.startTime) + 25))
    : 15 * 60;
  const startHour = Math.max(0, Math.floor(minStart / 60));
  const endHour = Math.min(24, Math.ceil(maxEnd / 60));
  const hours = Array.from(
    { length: endHour - startHour },
    (_, i) => startHour + i,
  );
  const gridTop = startHour * 60;
  const bodyH = (endHour - startHour) * HOUR_H;

  const style = {
    ["--cols" as string]: String(cols),
    ["--hour-h" as string]: `${HOUR_H}px`,
  };
  const showNow =
    days.some((d) => d.date === today) &&
    nowMin() >= gridTop &&
    nowMin() <= endHour * 60;
  const anyHomeroom = days.some((d) =>
    d.sessions.some((s) => s.kind === "homeroom"),
  );

  return (
    <div className="cal-week">
      <div className="cal-week-scroll">
        <div className="cal-week-inner" style={style}>
          <div className="cal-week-head">
            <span />
            {days.map((d) => {
              const pg = dayProgress(d.sessions);
              const cls =
                pg.total === 0
                  ? ""
                  : pg.done === pg.total
                    ? "is-done"
                    : pg.done > 0
                      ? "is-partial"
                      : "is-none";
              return (
                <div
                  key={d.date}
                  className={`cal-dh${d.date === today ? " is-today" : ""}`}
                >
                  <div className="cal-dh-dow">{DOW_LABEL[d.dayOfWeek]}</div>
                  <div className="cal-dh-date">
                    {new Date(d.date + "T00:00:00").getDate()}
                  </div>
                  {pg.total > 0 && (
                    <span
                      className={`cal-dh-prog ${cls}`}
                      title={`${pg.done} of ${pg.total} registers taken`}
                    >
                      {pg.done}/{pg.total}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {anyHomeroom && (
            <div className="cal-week-homeroom">
              <span className="hr-label">
                <Sun size={11} /> AM
              </span>
              {days.map((d) => {
                const hr = d.sessions.find((s) => s.kind === "homeroom");
                if (!hr) return <div key={d.date} className="cal-hr-cell" />;
                const past =
                  d.date < today ||
                  (d.date === today && nowMin() > toMin(hr.startTime) + 15);
                const st =
                  hr.status === "recorded"
                    ? "is-recorded"
                    : past
                      ? "is-missing-past"
                      : "";
                return (
                  <div key={d.date} className="cal-hr-cell">
                    <button
                      className={`cal-hr-pill ${st}`}
                      onClick={() =>
                        onOpen(buildTarget(d.sessions, hr, d.date))
                      }
                      onMouseEnter={(e) =>
                        scheduleShow(
                          hr,
                          d.date,
                          e.currentTarget.getBoundingClientRect(),
                        )
                      }
                      onMouseLeave={scheduleHide}
                      onFocus={(e) =>
                        scheduleShow(
                          hr,
                          d.date,
                          e.currentTarget.getBoundingClientRect(),
                        )
                      }
                      onBlur={scheduleHide}
                    >
                      {hr.status === "recorded" ? (
                        <StatusChip kind="recorded" label="Done" />
                      ) : st === "is-missing-past" ? (
                        <>
                          <AlertTriangle size={12} /> <span>Overdue</span>
                        </>
                      ) : (
                        <>
                          <PenLine size={12} /> <span>Check</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="cal-week-body" style={{ ...style, height: bodyH }}>
            <div className="cal-hours">
              {hours.map((h) => (
                <div key={h} className="cal-hour" style={{ height: HOUR_H }}>
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {days.map((d) => {
              const subjects = d.sessions.filter((s) => s.kind === "subject");
              const laid = packLanes(subjects);
              return (
                <div
                  key={d.date}
                  className={`cal-daycol${d.date === today ? " is-today" : ""}`}
                >
                  {subjects.length === 0 && (
                    <span className="cal-daycol-empty">No lessons</span>
                  )}
                  {laid.map(({ ev: s, s: sMin, e: eMin, lane, lanes }, i) => {
                    const top = ((sMin - gridTop) / 60) * HOUR_H;
                    const h = Math.max(30, ((eMin - sMin) / 60) * HOUR_H);
                    const overdue = isOverdue(s, d.date, today);
                    const isNow =
                      d.date === today && nowMin() >= sMin && nowMin() < eMin;
                    const cls =
                      s.status === "recorded"
                        ? "is-recorded"
                        : overdue
                          ? "is-missing-past"
                          : "is-future";
                    const isDim =
                      focusSubject != null && s.subjectId !== focusSubject;
                    const isFocus =
                      focusSubject != null && s.subjectId === focusSubject;
                    return (
                      <button
                        key={i}
                        className={`cal-event ${cls}${isNow ? " is-now" : ""}${lanes > 1 ? " is-narrow" : ""}${isDim ? " is-dimmed" : ""}${isFocus ? " is-focused" : ""}${s.isMine ? " is-mine" : " is-other"}`}
                        style={{
                          top,
                          height: h,
                          left: `calc(${(lane / lanes) * 100}% + 2px)`,
                          width: `calc(${100 / lanes}% - 4px)`,
                          ...(s.color
                            ? { ["--spine" as string]: s.color }
                            : {}),
                        }}
                        onClick={() => navigate(sessionDetailLink(s, d.date))}
                        onMouseEnter={(e) =>
                          scheduleShow(
                            s,
                            d.date,
                            e.currentTarget.getBoundingClientRect(),
                          )
                        }
                        onMouseLeave={scheduleHide}
                        onFocus={(e) =>
                          scheduleShow(
                            s,
                            d.date,
                            e.currentTarget.getBoundingClientRect(),
                          )
                        }
                        onBlur={scheduleHide}
                        aria-label={`${s.subjectName ?? "Lesson"} · ${clock(s.startTime)}–${clock(s.endTime)} · ${s.className}`}
                      >
                        <span
                          className={`cal-badge ${cls}${isNow ? " is-now" : ""}`}
                        >
                          {s.status === "recorded" ? (
                            <CheckCircle2 size={10} />
                          ) : overdue ? (
                            <AlertTriangle size={10} />
                          ) : isNow ? (
                            <Clock size={10} />
                          ) : null}
                        </span>
                        <div className="ev-time">
                          {clock(s.startTime)}–{clock(s.endTime)}
                        </div>
                        <div className="ev-title">{s.subjectName}</div>
                        <div className="ev-sub">
                          {s.className}
                          {s.room ? ` · ${s.room}` : ""}
                        </div>
                        {!s.isMine && s.teacherName && (
                          <div className="ev-owner">
                            <User size={9} /> {s.teacherName}
                          </div>
                        )}
                        {overdue && (
                          <div className="ev-warning">
                            <AlertTriangle size={10} /> Register overdue
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {showNow && (
              <div
                className="cal-nowline"
                style={{ top: ((nowMin() - gridTop) / 60) * HOUR_H }}
              />
            )}
          </div>
        </div>
      </div>
      {hover && (
        <EventHoverCard
          target={hover}
          overdue={isOverdue(hover.session, hover.date, today)}
          isNow={
            hover.date === today &&
            nowMin() >= toMin(hover.session.startTime) &&
            nowMin() < toMin(hover.session.endTime || hover.session.startTime)
          }
          canMark={canMark}
          onOpen={() => {
            setHover(null);
            onOpen(
              buildTarget(
                sessionsForHoverDate(hover.date),
                hover.session,
                hover.date,
              ),
            );
          }}
          onNavigate={() => {
            setHover(null);
            navigate(sessionDetailLink(hover.session, hover.date));
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Day (agenda)                                                              */
/* -------------------------------------------------------------------------- */
const DayView: React.FC<{
  data: DayResponse;
  canMark: boolean;
  onOpen: (t: DrawerTarget) => void;
  focusSubject: number | null;
}> = ({ data, canMark, onOpen, focusSubject }) => {
  const navigate = useNavigate();
  const isToday = data.date === isoDate();
  const now = nowMin();
  const homeroom = data.sessions.filter((s) => s.kind === "homeroom");
  const lessons = data.sessions.filter((s) => s.kind === "subject");
  const open = (s: CalendarSession) =>
    onOpen(buildTarget(data.sessions, s, data.date));
  const nextMissing =
    [...lessons]
      .filter((s) => s.status === "missing")
      .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0] ??
    homeroom.find((s) => s.status === "missing");
  const pg = dayProgress(data.sessions);

  // A quick, low-key celebration when a day's registers go from incomplete to
  // fully recorded during this visit — not on cold-loading an already-done day.
  const toast = useToast();
  const seenIncomplete = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (pg.total === 0) return;
    if (pg.done < pg.total) {
      seenIncomplete.current.add(data.date);
    } else if (seenIncomplete.current.has(data.date)) {
      seenIncomplete.current.delete(data.date);
      toast.success(
        "All registers done",
        `Every register for ${dayTitle(data.date).toLowerCase()} is recorded.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.date, pg.done, pg.total]);

  if (!data.timetableAvailable) {
    return (
      <div className="cal-empty">
        <CalendarDays size={30} />
        <span className="text-sm">No timetable for this day.</span>
        <span className="text-xs">
          Read live from the Central MIS calendar — check the academic term in
          the top bar.
        </span>
        {canMark && (
          <button
            className="btn btn-outline btn-sm mt-2"
            onClick={() => navigate("/attendance/mark")}
          >
            <PenLine size={14} /> Record manually
          </button>
        )}
      </div>
    );
  }
  if (data.sessions.length === 0) {
    return (
      <div className="cal-empty">
        <Sun size={30} />
        <span className="text-sm">Nothing scheduled.</span>
      </div>
    );
  }

  const Card: React.FC<{ s: CalendarSession }> = ({ s }) => {
    const start = toMin(s.startTime);
    const end = s.endTime ? toMin(s.endTime) : start + 40;
    const isNow = isToday && now >= start && now < end;
    const isFuture = isToday && now < start;
    const isPastMissing = isOverdue(s, data.date, isoDate());
    const isDim =
      focusSubject != null &&
      s.kind === "subject" &&
      s.subjectId !== focusSubject;
    const isFocus =
      focusSubject != null &&
      s.kind === "subject" &&
      s.subjectId === focusSubject;
    const cls = [
      "agenda-card",
      "is-clickable",
      isNow && "is-now",
      isFuture && "is-future",
      isPastMissing && "is-past-missing",
      isDim && "is-dimmed",
      isFocus && "is-focused",
      s.isMine && "is-mine",
    ]
      .filter(Boolean)
      .join(" ");
    const detail = sessionDetailLink(s, data.date);
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
      <div
        className={cls}
        style={s.color ? { ["--spine" as string]: s.color } : undefined}
        role="link"
        tabIndex={0}
        aria-label={`${s.kind === "homeroom" ? "Morning check" : s.subjectName || "Lesson"} · ${s.className} — view details`}
        onClick={() => navigate(detail)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate(detail);
          }
        }}
      >
        <div className="agenda-time">
          <span className="t-start">{clock(s.startTime)}</span>
          {s.endTime && <span className="t-end">{clock(s.endTime)}</span>}
        </div>
        <span className="agenda-spine" />
        <div className="agenda-body">
          <div className="agenda-title">
            {s.kind === "homeroom" ? (
              <>
                <Sun size={14} className="agenda-icon-inline" /> Morning check ·{" "}
                {s.className}
              </>
            ) : (
              <>
                <BookOpen size={14} className="agenda-icon-inline" />{" "}
                {s.subjectName || "Lesson"}
              </>
            )}
            {isNow && (
              <span className="ta-now">
                <Clock size={11} /> Now
              </span>
            )}
          </div>
          <div className="agenda-meta flex flex-row items-center gap-2">
            {s.kind === "subject" && <span>{s.className}</span>}
            {s.room && (
              <div className="flex flex-row items-center gap-1">
                <span>
                  <MapPin size={11} />
                </span>{" "}
                <span>{s.room}</span>
              </div>
            )}
            {s.kind === "subject" && (
              <span className={`agenda-owner${s.isMine ? " is-me" : ""}`}>
                <User size={11} />{" "}
                {s.isMine ? "You" : s.teacherName || "Another teacher"}
              </span>
            )}
          </div>
          {s.status === "recorded" && s.stats && (
            <div className="agenda-recorded-line">
              <StatusChip kind="present" label={`${s.stats.present} present`} />
              {s.stats.absent > 0 && (
                <StatusChip kind="absent" label={`${s.stats.absent} absent`} />
              )}
              {s.stats.late > 0 && (
                <StatusChip kind="late" label={`${s.stats.late} late`} />
              )}
              {s.stats.excused > 0 && (
                <StatusChip
                  kind="excused"
                  label={`${s.stats.excused} excused`}
                />
              )}
            </div>
          )}
        </div>
        <div className="agenda-action" onClick={stop}>
          {s.status === "recorded" ? (
            <>
              <span className="agenda-done">
                <CheckCircle2 size={13} /> Done
              </span>
              {canMark && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => open(s)}
                >
                  <PenLine size={13} /> Edit
                </button>
              )}
            </>
          ) : isPastMissing ? (
            <>
              <span className="agenda-late">
                <AlertTriangle size={13} /> Overdue
              </span>
              {canMark && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => open(s)}
                >
                  <PenLine size={13} /> Take register
                </button>
              )}
            </>
          ) : canMark ? (
            <button className="btn btn-primary btn-sm" onClick={() => open(s)}>
              <PenLine size={13} /> Take register
            </button>
          ) : (
            <StatusChip
              kind={s.ownStatus ?? "missing"}
              label={s.ownStatus ? undefined : "Awaiting"}
            />
          )}
          <ChevronRight size={15} className="agenda-chevron" />
        </div>
      </div>
    );
  };

  return (
    <div className="agenda">
      {pg.total > 0 && (
        <div className="agenda-progress">
          <div className="agenda-progress-text">
            {pg.done === pg.total ? (
              <>
                <PartyPopper size={15} style={{ color: "var(--success)" }} />{" "}
                All {pg.total} registers done
              </>
            ) : (
              <>
                <strong>{pg.done}</strong> of {pg.total} registers done
              </>
            )}
          </div>
          <div className="progress" style={{ flex: 1, maxWidth: 260 }}>
            <div
              className={`progress-fill ${pg.done === pg.total ? "is-success" : pg.done > 0 ? "is-warning" : "is-danger"}`}
              style={{ width: `${(pg.done / pg.total) * 100}%` }}
            />
          </div>
          {canMark && nextMissing && pg.done < pg.total && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => open(nextMissing)}
            >
              Next register <ArrowRight size={14} />
            </button>
          )}
        </div>
      )}
      {homeroom.length > 0 && (
        <>
          <div className="agenda-group-label">Morning check</div>
          {homeroom.map((s) => (
            <Card key={`hr-${s.classId}`} s={s} />
          ))}
        </>
      )}
      {lessons.length > 0 && (
        <>
          <div className="agenda-group-label">Lessons</div>
          {lessons.map((s) => (
            <Card
              key={`sl-${s.slotId ?? `${s.classId}-${s.subjectId}-${s.startTime}`}`}
              s={s}
            />
          ))}
        </>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Page                                                                      */
/* -------------------------------------------------------------------------- */
export const AttendanceCalendar: React.FC = () => {
  const { can } = usePermissions();
  const canMark = can("ATTENDANCE_MARK");
  const [params, setParams] = useSearchParams();

  const [view, setView] = useState<View>(
    (params.get("view") as View) || "week",
  );
  const [cursor, setCursor] = useState(params.get("date") || isoDate());
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [focusSubject, setFocusSubject] = useState<number | null>(null);

  const [month, setMonth] = useState<MonthResponse | null>(null);
  const [week, setWeek] = useState<WeekResponse | null>(null);
  const [day, setDay] = useState<DayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set("view", view);
    next.set("date", cursor);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "month")
        setMonth(await getScheduleMonth(cursor.slice(0, 7)));
      else if (view === "week")
        setWeek(await getScheduleWeek(mondayOf(cursor)));
      else setDay(await getScheduleDay(cursor));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not load the calendar.",
      );
    } finally {
      setLoading(false);
    }
  }, [view, cursor]);

  useEffect(() => {
    load();
  }, [load]);

  // The day's full session list, from whichever payload is loaded — lets the
  // drawer's "next register" chain keep resolving the one after that.
  const sessionsForDate = useCallback(
    (date: string): CalendarSession[] => {
      if (day && day.date === date) return day.sessions;
      if (week) return week.days.find((d) => d.date === date)?.sessions ?? [];
      return [];
    },
    [day, week],
  );

  // "Your subjects" strip + overdue-register banner only make sense once we
  // have per-session data (week/day) — month view is too coarse.
  const visibleSessions: CalendarSession[] = useMemo(() => {
    if (view === "day") return day?.sessions ?? [];
    if (view === "week") return week?.days.flatMap((d) => d.sessions) ?? [];
    return [];
  }, [view, day, week]);
  const subjects = useMemo(
    () => collectSubjects(visibleSessions),
    [visibleSessions],
  );
  // Drop a stale filter (e.g. left over from a subject not taught on the day
  // just navigated to) without a setState-in-effect render cascade.
  const activeFocusSubject =
    focusSubject != null && subjects.some((sub) => sub.id === focusSubject)
      ? focusSubject
      : null;

  const overdue = useMemo(() => {
    const today = isoDate();
    if (view === "day" && day) {
      return day.sessions
        .filter((s) => isOverdue(s, day.date, today))
        .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))
        .map((s) => ({ session: s, date: day.date }));
    }
    if (view === "week" && week) {
      return week.days
        .flatMap((d) =>
          d.sessions
            .filter((s) => isOverdue(s, d.date, today))
            .map((s) => ({ session: s, date: d.date })),
        )
        .sort((a, b) =>
          (a.date + a.session.startTime).localeCompare(
            b.date + b.session.startTime,
          ),
        );
    }
    return [];
  }, [view, day, week]);

  const step = (dir: -1 | 1) => {
    if (view === "month") setCursor(addMonths(cursor, dir));
    else if (view === "week") setCursor(addDays(cursor, dir * 7));
    else setCursor(addDays(cursor, dir));
  };

  const title =
    view === "month"
      ? monthTitle(cursor)
      : view === "week"
        ? week
          ? rangeTitle(week.weekStart, week.weekEnd)
          : monthTitle(cursor)
        : dayTitle(cursor);

  const isDefaultCursor =
    view === "month"
      ? cursor.slice(0, 7) === isoDate().slice(0, 7)
      : view === "week"
        ? mondayOf(cursor) === mondayOf(isoDate())
        : cursor === isoDate();

  return (
    <DashboardLayout>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle">
            {canMark
              ? "Your calendar is the register. Click any lesson for its details, or take attendance straight from it."
              : "Your lessons and their attendance status. Click any lesson for its details."}
          </p>
        </div>
      </div>

      <div className="cal-shell">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button
              className="icon-btn"
              aria-label="Previous"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="icon-btn"
              aria-label="Next"
              onClick={() => step(1)}
            >
              <ChevronRight size={18} />
            </button>
            {!isDefaultCursor && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setCursor(isoDate())}
              >
                Today
              </button>
            )}
          </div>
          <div className="cal-title">{title}</div>
          <div className="cal-spacer" />
          <div className="cal-viewtabs" role="tablist">
            {(
              [
                ["month", CalendarDays, "Month"],
                ["week", CalendarRange, "Week"],
                ["day", CalendarClock, "Day"],
              ] as const
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={`cal-viewtab${view === v ? " is-active" : ""}`}
                onClick={() => setView(v)}
              >
                <Icon size={14} /> <span className="hide-mobile">{label}</span>
              </button>
            ))}
          </div>
          {canMark && (
            <button
              className="btn btn-outline btn-sm"
              onClick={() => setManualOpen(true)}
            >
              <Plus size={14} />{" "}
              <span className="hide-mobile">Record a session</span>
            </button>
          )}
          <button className="icon-btn" aria-label="Refresh" onClick={load}>
            <RotateCcw size={15} />
          </button>
        </div>

        <div className="cal-legend">
          <span>
            <span className="swatch is-recorded" /> Register taken
          </span>
          <span>
            <span className="swatch is-missing" /> Overdue — needs attention
          </span>
          <span>
            <span className="swatch is-future" /> Upcoming
          </span>
          <span>
            <span className="swatch is-now" /> Now
          </span>
        </div>

        {subjects.length > 0 && (
          <div
            className="cal-subjects"
            role="group"
            aria-label="Filter by your subjects"
          >
            <span className="cal-subjects-label">Your subjects</span>
            {subjects.map((sub) => (
              <button
                key={sub.id}
                className={`subject-chip${focusSubject === sub.id ? " is-active" : ""}`}
                style={{ ["--c" as string]: sub.color }}
                onClick={() =>
                  setFocusSubject((cur) => (cur === sub.id ? null : sub.id))
                }
                aria-pressed={focusSubject === sub.id}
              >
                <span className="dot" /> {sub.name}
              </button>
            ))}
            {focusSubject != null && (
              <button
                className="subject-chip subject-chip-clear"
                onClick={() => setFocusSubject(null)}
              >
                <X size={12} /> Clear
              </button>
            )}
          </div>
        )}

        {overdue.length > 0 && (
          <div className="cal-alert">
            <AlertTriangle size={16} />
            <span>
              <strong>{overdue.length}</strong> register
              {overdue.length === 1 ? "" : "s"} overdue — attendance wasn't
              taken in time
            </span>
            {canMark && (
              <button
                className="cal-alert-btn"
                onClick={() =>
                  setDrawer(
                    buildTarget(
                      sessionsForDate(overdue[0].date),
                      overdue[0].session,
                      overdue[0].date,
                    ),
                  )
                }
              >
                Take next <ArrowRight size={13} />
              </button>
            )}
          </div>
        )}

        {loading ? (
          <div
            className="cal-skel"
            style={{ height: view === "day" ? 320 : 520 }}
          />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : view === "month" && month ? (
          <MonthView
            data={month}
            cursor={cursor}
            onPickDay={(d) => {
              setCursor(d);
              setView("day");
            }}
          />
        ) : view === "week" && week ? (
          <WeekView
            data={week}
            onOpen={setDrawer}
            focusSubject={activeFocusSubject}
          />
        ) : view === "day" && day ? (
          <DayView
            data={day}
            canMark={canMark}
            onOpen={setDrawer}
            focusSubject={activeFocusSubject}
          />
        ) : null}
      </div>

      {drawer && (
        <RegisterDrawer
          key={drawer.session.deepLink}
          target={drawer}
          onClose={() => setDrawer(null)}
          onSaved={load}
          onOpenNext={(t) =>
            setDrawer(buildTarget(sessionsForDate(t.date), t.session, t.date))
          }
        />
      )}

      <ManualSessionModal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        onPick={(t) => {
          setManualOpen(false);
          setDrawer({ ...t, next: null });
        }}
      />
    </DashboardLayout>
  );
};

export default AttendanceCalendar;
