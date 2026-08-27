import {
  buildTaskAttentionNotification,
  isWithinQuietHours,
  notifyTaskAttention,
} from './notifications';

describe('desktop notification privacy policy', () => {
  it('handles an overnight quiet-hours interval without suppressing daytime reminders', () => {
    expect(isWithinQuietHours(new Date(2030, 0, 1, 23, 0))).toBe(true);
    expect(isWithinQuietHours(new Date(2030, 0, 2, 7, 59))).toBe(true);
    expect(isWithinQuietHours(new Date(2030, 0, 2, 8, 0))).toBe(false);
    expect(isWithinQuietHours(new Date(2030, 0, 2, 15, 0))).toBe(false);
  });

  it('removes the task title from every notification field in privacy mode', () => {
    const secretTitle = '修复机密客户刷新令牌';
    const notification = buildTaskAttentionNotification(
      { taskTitle: secretTitle, taskCount: 3 },
      true,
    );

    expect(notification).toEqual({
      title: '番薯叶任务提醒',
      body: '3 项团队任务需要关注',
    });
    expect(JSON.stringify(notification)).not.toContain(secretTitle);
  });

  it('suppresses native delivery during enabled quiet hours', async () => {
    const deliver = vi.fn(() => Promise.resolve());

    await expect(
      notifyTaskAttention(
        { taskTitle: '夜间任务', taskCount: 1 },
        { privacyMode: false, quietHoursEnabled: true },
        new Date(2030, 0, 1, 23, 30),
        deliver,
      ),
    ).resolves.toBe('quiet-hours');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a privacy-safe count outside quiet hours and absorbs native errors', async () => {
    const secretTitle = '屏幕共享时不能出现的标题';
    const deliver = vi.fn(() => Promise.resolve());
    const unavailable = vi.fn(() => Promise.reject(new Error(`provider echoed ${secretTitle}`)));

    await expect(
      notifyTaskAttention(
        { taskTitle: secretTitle, taskCount: 2 },
        { privacyMode: true, quietHoursEnabled: true },
        new Date(2030, 0, 1, 14, 0),
        deliver,
      ),
    ).resolves.toBe('sent');
    expect(JSON.stringify(deliver.mock.calls)).not.toContain(secretTitle);
    expect(deliver).toHaveBeenCalledWith('番薯叶任务提醒', '2 项团队任务需要关注', 2);

    await expect(
      notifyTaskAttention(
        { taskTitle: secretTitle, taskCount: 1 },
        { privacyMode: false, quietHoursEnabled: false },
        new Date(2030, 0, 1, 14, 0),
        unavailable,
      ),
    ).resolves.toBe('unavailable');
  });

  it('normalizes an invalid count before passing it to the native privacy gate', async () => {
    const deliver = vi.fn(() => Promise.resolve());

    await notifyTaskAttention(
      { taskTitle: '普通任务', taskCount: Number.NaN },
      { privacyMode: true, quietHoursEnabled: false },
      new Date(2030, 0, 1, 14, 0),
      deliver,
    );

    expect(deliver).toHaveBeenCalledWith('番薯叶任务提醒', '1 项团队任务需要关注', 1);
  });
});
