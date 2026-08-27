import { describe, expect, it, vi } from 'vitest';
import { EventHub, type EventEnvelope, type RealtimeSocket } from '../src/modules/sync/event-hub';

function event(workspaceId: string): EventEnvelope {
  return {
    eventId: '80000000-0000-4000-8000-000000000001',
    workspaceId,
    workspaceSequence: 1,
    aggregateType: 'Task',
    aggregateId: '50000000-0000-4000-8000-000000000001',
    aggregateVersion: 1,
    eventType: 'TaskCreated',
    schemaVersion: 1,
    actorType: 'human',
    actorId: '10000000-0000-4000-8000-000000000001',
    occurredAt: '2026-01-01T00:00:00.000Z',
    commandId: '70000000-0000-4000-8000-000000000001',
    correlationId: null,
    causationId: null,
    payload: {},
  };
}

describe('workspace-isolated realtime events', () => {
  it('publishes only to authorized workspace subscriptions and closes revoked members', () => {
    const workspaceA = '20000000-0000-4000-8000-000000000001';
    const workspaceB = '20000000-0000-4000-8000-000000000002';
    const userA = '10000000-0000-4000-8000-000000000001';
    const hub = new EventHub();
    const first = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies RealtimeSocket;
    const second = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies RealtimeSocket;
    hub.subscribe({
      workspaceId: workspaceA,
      userId: userA,
      sessionId: 'session-a',
      socket: first,
    });
    hub.subscribe({
      workspaceId: workspaceB,
      userId: 'user-b',
      sessionId: 'session-b',
      socket: second,
    });

    hub.publish([event(workspaceA)]);
    expect(first.send).toHaveBeenCalledOnce();
    expect(second.send).not.toHaveBeenCalled();

    hub.disconnectMember(workspaceA, userA);
    expect(first.close).toHaveBeenCalledWith(4003, 'workspace access revoked');
    expect(hub.connectionCount).toBe(1);
  });

  it('revokes every socket for a session even when one broken transport throws on close', () => {
    const hub = new EventHub();
    const broken = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(() => {
        throw new Error('socket is already broken');
      }),
    } satisfies RealtimeSocket;
    const healthy = { readyState: 1, send: vi.fn(), close: vi.fn() } satisfies RealtimeSocket;
    for (const socket of [broken, healthy]) {
      hub.subscribe({
        workspaceId: '20000000-0000-4000-8000-000000000001',
        userId: '10000000-0000-4000-8000-000000000001',
        sessionId: '30000000-0000-4000-8000-000000000001',
        socket,
      });
    }

    expect(() => hub.disconnectSession('30000000-0000-4000-8000-000000000001')).not.toThrow();
    expect(broken.close).toHaveBeenCalledWith(4001, 'session revoked');
    expect(healthy.close).toHaveBeenCalledWith(4001, 'session revoked');
    expect(hub.connectionCount).toBe(0);
  });
});
