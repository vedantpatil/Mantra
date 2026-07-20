/**
 * Inter-agent messaging behind one interface (ADR-9). In-process for MVP; the same
 * interface can be backed by NATS/Redis later without touching any call site.
 */
export interface Message<T = unknown> {
  readonly topic: string;
  readonly payload: T;
}

export type Handler<T = unknown> = (message: Message<T>) => void | Promise<void>;

export interface Bus {
  publish<T>(topic: string, payload: T): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe<T>(topic: string, handler: Handler<T>): () => void;
}

export class InProcessBus implements Bus {
  private readonly handlers = new Map<string, Set<Handler>>();

  async publish<T>(topic: string, payload: T): Promise<void> {
    const set = this.handlers.get(topic);
    if (!set) return;
    const message: Message<T> = { topic, payload };
    await Promise.all([...set].map((h) => h(message)));
  }

  subscribe<T>(topic: string, handler: Handler<T>): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as Handler);
    return () => {
      this.handlers.get(topic)?.delete(handler as Handler);
    };
  }
}
