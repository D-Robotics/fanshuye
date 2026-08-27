import { RealtimeServerMessageSchema, type EventEnvelope } from '@fanshuye/contracts';

export type { EventEnvelope } from '@fanshuye/contracts';

export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Subscription {
  workspaceId: string;
  userId: string;
  sessionId: string;
  socket: RealtimeSocket;
}

export class EventHub {
  readonly #subscriptions = new Set<Subscription>();
  #connectionObserver: ((count: number) => void) | undefined;

  setConnectionObserver(observer: (count: number) => void): void {
    this.#connectionObserver = observer;
    observer(this.#subscriptions.size);
  }

  subscribe(subscription: Subscription): () => void {
    this.#subscriptions.add(subscription);
    this.#notifyConnectionCount();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (this.#subscriptions.delete(subscription)) this.#notifyConnectionCount();
    };
  }

  publish(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      const message = JSON.stringify(RealtimeServerMessageSchema.parse({ type: 'event', event }));
      for (const subscription of this.#subscriptions) {
        if (subscription.workspaceId !== event.workspaceId) continue;
        if (subscription.socket.readyState !== 1) continue;
        try {
          subscription.socket.send(message);
        } catch {
          this.#subscriptions.delete(subscription);
          this.#notifyConnectionCount();
          try {
            subscription.socket.close(1011, 'realtime delivery failed');
          } catch {
            // A broken connection must never change an already committed command result.
          }
        }
      }
    }
  }

  disconnectSession(sessionId: string): void {
    this.#disconnect(
      (subscription) => subscription.sessionId === sessionId,
      4001,
      'session revoked',
    );
  }

  disconnectMember(workspaceId: string, userId: string): void {
    this.#disconnect(
      (subscription) => subscription.workspaceId === workspaceId && subscription.userId === userId,
      4003,
      'workspace access revoked',
    );
  }

  get connectionCount(): number {
    return this.#subscriptions.size;
  }

  #disconnect(
    predicate: (subscription: Subscription) => boolean,
    code: number,
    reason: string,
  ): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!predicate(subscription)) continue;
      this.#subscriptions.delete(subscription);
      this.#notifyConnectionCount();
      try {
        subscription.socket.close(code, reason);
      } catch {
        // Revocation is authoritative once the subscription is removed. A
        // broken transport must not prevent other matching sockets closing or
        // turn an already committed revocation command into an HTTP failure.
      }
    }
  }

  #notifyConnectionCount(): void {
    this.#connectionObserver?.(this.#subscriptions.size);
  }
}
