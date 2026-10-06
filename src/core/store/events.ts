import { EventEmitter } from 'node:events';
import type { RunEvent } from '../domain/types.js';

/**
 * In-process fan-out of committed events to live subscribers (the SSE stream).
 *
 * Events are published only after the transaction that wrote them commits, so
 * a subscriber can never observe state the database has not accepted.
 */
export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(0);
  }

  publish(event: RunEvent): void {
    this.#emitter.emit('event', event);
  }

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }
}
