import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, CheckCheck, Trash2, PenLine, Sun, Clock3, FileCheck2, TrendingDown, Info, UserX,
} from 'lucide-react';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead, clearNotifications,
  type AppNotification, type NotificationType,
} from '../../api/notifications';
import { relativeTime, isoDate } from '../../utils/time';

/** Exported so other surfaces (the Dashboard's alerts panel) can render
 *  notifications with the same visual language as this dropdown, instead
 *  of drifting into their own icon set over time. */
export const NOTIFICATION_ICONS: Record<NotificationType, React.ReactNode> = {
  register_missing: <PenLine size={15} />,
  homeroom_missing: <Sun size={15} />,
  lesson_soon: <Clock3 size={15} />,
  attendance_marked: <UserX size={15} />,
  excuse_decided: <FileCheck2 size={15} />,
  low_attendance: <TrendingDown size={15} />,
  reminder: <Info size={15} />,
  system: <Info size={15} />,
};

export const isUnreadNotification = (n: AppNotification) => !n.read || n.read === 0;
const isUnread = isUnreadNotification;
const ICONS = NOTIFICATION_ICONS;

interface Props {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export const NotificationCenter: React.FC<Props> = ({ open, onToggle, onClose }) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);

  const refresh = useCallback(async () => {
    try { setItems(await getNotifications()); } catch { /* transient */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const unread = items.filter(isUnread).length;

  const openItem = async (n: AppNotification) => {
    if (isUnread(n)) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)));
      markNotificationRead(n.id).catch(() => {});
    }
    onClose();
    if (n.link) navigate(n.link);
  };

  const allRead = async () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: 1 })));
    try { await markAllNotificationsRead(); } catch { /* ignore */ }
  };
  const clearAll = async () => {
    try { await clearNotifications(); } finally { refresh(); }
  };

  const today = isoDate();
  const groups: { label: string; rows: AppNotification[] }[] = [
    { label: 'Today', rows: items.filter((n) => (n.created_at || '').slice(0, 10) === today) },
    { label: 'Earlier', rows: items.filter((n) => (n.created_at || '').slice(0, 10) !== today) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div style={{ position: 'relative' }}>
      <button className="icon-btn" onClick={onToggle} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Bell size={18} />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="popover notif-panel animate-fade-in">
          <div className="card-header">
            <span className="section-title text-base">Notifications</span>
            {items.length > 0 && (
              <div className="flex items-center gap-1">
                <button className="icon-btn" onClick={allRead} disabled={unread === 0} title="Mark all as read" aria-label="Mark all as read">
                  <CheckCheck size={16} />
                </button>
                <button className="icon-btn" onClick={clearAll} title="Clear" aria-label="Clear notifications">
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>

          <div className="notif-list">
            {items.length === 0 ? (
              <div className="empty-state" style={{ padding: 32 }}>
                <Bell size={24} />
                <span className="text-sm">You're all caught up</span>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <div className="notif-group-label">{g.label}</div>
                  {g.rows.map((n) => (
                    <button
                      key={n.id}
                      className={`notif-item${isUnread(n) ? ' is-unread' : ''}`}
                      onClick={() => openItem(n)}
                    >
                      <span className={`notif-sevbar is-${n.severity || 'info'}`} />
                      <span className="notif-icon">{ICONS[n.type] ?? <Info size={15} />}</span>
                      <span className="notif-text">
                        <span className="notif-title">{n.title}</span>
                        <span className="notif-body">{n.message}</span>
                        <span className="notif-time">{relativeTime(n.created_at)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
