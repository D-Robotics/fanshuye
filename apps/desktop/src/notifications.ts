import { sendNativeSummaryNotification } from './platform/native';

export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

export interface TaskAttentionNotification {
  taskTitle: string;
  taskCount: number;
}

export interface NotificationPrivacyPolicy {
  privacyMode: boolean;
  quietHoursEnabled: boolean;
}

export type NotificationDeliveryResult = 'sent' | 'quiet-hours' | 'unavailable';

export const DEFAULT_QUIET_HOURS: QuietHours = {
  startMinute: 22 * 60,
  endMinute: 8 * 60,
};

function normalizeTaskCount(taskCount: number): number {
  if (!Number.isFinite(taskCount)) return 1;
  return Math.min(1_000_000, Math.max(1, Math.trunc(taskCount)));
}

export function isWithinQuietHours(
  date: Date,
  quietHours: QuietHours = DEFAULT_QUIET_HOURS,
): boolean {
  const minute = date.getHours() * 60 + date.getMinutes();
  if (quietHours.startMinute === quietHours.endMinute) return true;
  if (quietHours.startMinute < quietHours.endMinute) {
    return minute >= quietHours.startMinute && minute < quietHours.endMinute;
  }
  return minute >= quietHours.startMinute || minute < quietHours.endMinute;
}

export function buildTaskAttentionNotification(
  input: TaskAttentionNotification,
  privacyMode: boolean,
): { title: string; body: string } {
  const count = normalizeTaskCount(input.taskCount);
  return {
    title: '番薯叶任务提醒',
    body: privacyMode
      ? `${count} 项团队任务需要关注`
      : count === 1
        ? `“${input.taskTitle.slice(0, 120)}”需要关注`
        : `“${input.taskTitle.slice(0, 100)}”等 ${count} 项任务需要关注`,
  };
}

export async function notifyTaskAttention(
  input: TaskAttentionNotification,
  policy: NotificationPrivacyPolicy,
  now = new Date(),
  deliver: (
    title: string,
    body: string,
    taskCount: number,
  ) => Promise<void> = sendNativeSummaryNotification,
): Promise<NotificationDeliveryResult> {
  if (policy.quietHoursEnabled && isWithinQuietHours(now)) return 'quiet-hours';
  const taskCount = normalizeTaskCount(input.taskCount);
  const notification = buildTaskAttentionNotification(input, policy.privacyMode);
  try {
    await deliver(notification.title, notification.body, taskCount);
    return 'sent';
  } catch {
    // Native notification errors are intentionally not copied to logs or UI.
    return 'unavailable';
  }
}
