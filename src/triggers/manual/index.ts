import type { ObjectiveRequest, Trigger } from '../../core/domain/contracts.js';

/**
 * The operator submitting an objective from the interface.
 *
 * The only Trigger implementation in M1. Scheduled automation (M12) is another
 * implementation of the same contract, emitting the same ObjectiveRequest — the
 * orchestrator cannot tell the difference, which is why automation needs no
 * core change to arrive.
 */

export const MANUAL_TRIGGER_ID = 'manual';

export interface ManualTrigger extends Trigger {
  fire(request: ObjectiveRequest): Promise<unknown>;
}

export function createManualTrigger(): ManualTrigger {
  let emit: ((req: ObjectiveRequest) => Promise<unknown>) | null = null;

  return {
    id: MANUAL_TRIGGER_ID,

    start(fn) {
      emit = fn;
    },

    async fire(request) {
      if (!emit) throw new Error('Manual trigger used before start()');
      return emit(request);
    },
  };
}
