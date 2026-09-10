import { apiGet, apiPut, apiDelete } from './client';

export type NotificationType =
  | 'register_missing'
  | 'homeroom_missing'
  | 'lesson_soon'
  | 'excuse_decided'
  | 'low_attendance'
  | 'reminder'
  | 'system';

export type NotificationSeverity = 'info' | 'warning' | 'critical' | 'success';

export interface AppNotification {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  severity: NotificationSeverity;
  read: number | boolean;
  created_at: string;
}

export const getNotifications = () =>
  apiGet<AppNotification[]>('/api/notifications').then((r) => r.data ?? []);

export const markNotificationRead = (id: number) => apiPut(`/api/notifications/${id}/read`);
export const markAllNotificationsRead = () => apiPut('/api/notifications/read-all');
export const clearNotifications = () => apiDelete('/api/notifications');
