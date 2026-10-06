import type { Agent, ModelProvider, Trigger } from '../domain/contracts.js';

/**
 * Where edge modules announce themselves.
 *
 * Core discovers providers, agents and triggers only through this registry —
 * it never imports them. Wiring happens once, in src/bootstrap.ts.
 */
export class Registry {
  readonly #providers = new Map<string, ModelProvider>();
  readonly #agents = new Map<string, Agent>();
  readonly #triggers = new Map<string, Trigger>();

  registerProvider(provider: ModelProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  registerAgent(agent: Agent): void {
    if (this.#agents.has(agent.id)) {
      throw new Error(`Duplicate agent id: ${agent.id}`);
    }
    this.#agents.set(agent.id, agent);
  }

  registerTrigger(trigger: Trigger): void {
    if (this.#triggers.has(trigger.id)) {
      throw new Error(`Duplicate trigger id: ${trigger.id}`);
    }
    this.#triggers.set(trigger.id, trigger);
  }

  getProvider(id: string): ModelProvider {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  getAgent(id: string): Agent {
    const agent = this.#agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  listProviders(): ModelProvider[] {
    return [...this.#providers.values()];
  }

  listAgents(): Agent[] {
    return [...this.#agents.values()];
  }

  listTriggers(): Trigger[] {
    return [...this.#triggers.values()];
  }
}
