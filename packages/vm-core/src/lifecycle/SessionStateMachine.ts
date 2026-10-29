import type { VMState } from '@lumiboot/contracts';
import { VMError } from '../errors/VMError';
import { allowedTransitions } from './SessionState';

export type StateListener = (state: VMState) => void;

export class SessionStateMachine {
  #state: VMState = 'idle';
  readonly #listeners = new Set<StateListener>();

  get state(): VMState {
    return this.#state;
  }

  canTransition(next: VMState): boolean {
    return (allowedTransitions[this.#state] ?? []).includes(next);
  }

  transition(next: VMState): VMState {
    if (!this.canTransition(next)) {
      throw new VMError('INVALID_TRANSITION', `Invalid transition: ${this.#state} -> ${next}.`);
    }
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
    return this.#state;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reset(): void {
    this.#state = 'idle';
  }
}
