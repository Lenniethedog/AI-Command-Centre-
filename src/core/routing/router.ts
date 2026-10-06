import {
  meetsTier,
  type ModelDescriptor,
  type ModelRequirement,
} from '../domain/contracts.js';
import type { Registry } from '../registry/registry.js';

/** A model made available by configuration. */
export interface EnabledModel {
  provider: string;
  model: string;
}

export interface Resolution {
  providerId: string;
  modelId: string;
  descriptor: ModelDescriptor;
  /** False when the operator's chosen model could not serve this requirement. */
  preferenceHonoured: boolean;
}

export class NoModelAvailableError extends Error {
  constructor(requirement: ModelRequirement) {
    super(
      `No configured model satisfies requirement: ${JSON.stringify(requirement)}. ` +
        'Check config/models.json and that the provider has an API key.',
    );
    this.name = 'NoModelAvailableError';
  }
}

/**
 * Resolves a capability requirement to a concrete model.
 *
 * Core asks for "strong reasoning, long context, structured output" — never for
 * a vendor by name. M1 has one enabled model, so this picks the only candidate;
 * the point is that the seam is real, so M5 adds a policy here rather than
 * unpicking provider names from the rest of the system.
 */
export class ModelRouter {
  readonly #registry: Registry;
  readonly #enabled: readonly EnabledModel[];

  constructor(registry: Registry, enabled: readonly EnabledModel[]) {
    this.#registry = registry;
    this.#enabled = enabled;
  }

  /**
   * @param preferredModelId Operator's chosen model. It is honoured only if it
   *   also satisfies the agent's requirement — a preference filters the
   *   candidates, it never overrides capability matching. If the preference
   *   cannot serve the task, routing falls back and `preferenceHonoured` is
   *   false so the interface can say why.
   */
  resolve(requirement: ModelRequirement, preferredModelId?: string): Resolution {
    if (preferredModelId && preferredModelId !== 'auto') {
      const preferred = this.#match(requirement, (entry) => entry.model === preferredModelId);
      if (preferred) return { ...preferred, preferenceHonoured: true };
    }

    const resolved = this.#match(requirement, () => true);
    if (!resolved) throw new NoModelAvailableError(requirement);
    return { ...resolved, preferenceHonoured: !preferredModelId || preferredModelId === 'auto' };
  }

  #match(
    requirement: ModelRequirement,
    accept: (entry: EnabledModel) => boolean,
  ): Omit<Resolution, 'preferenceHonoured'> | null {
    for (const entry of this.#enabled) {
      if (!accept(entry)) continue;
      if (requirement.mustDifferFromProvider === entry.provider) continue;

      let provider;
      try {
        provider = this.#registry.getProvider(entry.provider);
      } catch {
        continue; // configured but not registered — e.g. no API key present
      }

      const descriptor = provider.models.find((m) => m.id === entry.model);
      if (!descriptor) continue;

      const caps = descriptor.capabilities;
      if (!meetsTier(caps.reasoning, requirement.reasoning)) continue;
      if (requirement.minContextTokens && caps.contextTokens < requirement.minContextTokens) {
        continue;
      }
      if (requirement.structuredOutput && !caps.structuredOutput) continue;
      if (requirement.thinking && !caps.thinking) continue;

      return { providerId: provider.id, modelId: descriptor.id, descriptor };
    }

    return null;
  }
}
