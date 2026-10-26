import { describe, expect, it, vi } from 'vitest';
import { SessionStateMachine } from './SessionStateMachine';
import { VMError } from '../errors/VMError';

describe('SessionStateMachine', () => {
  it('starts at idle', () => {
    expect(new SessionStateMachine().state).toBe('idle');
  });

  it('allows the nominal path up to running', () => {
    const machine = new SessionStateMachine();
    machine.transition('preparing');
    machine.transition('booting');
    machine.transition('running');
    expect(machine.state).toBe('running');
  });

  it('rejects an invalid transition', () => {
    const machine = new SessionStateMachine();
    expect(machine.canTransition('running')).toBe(false);
    expect(() => machine.transition('running')).toThrow(VMError);
  });

  it('notifies subscribers and unsubscribes', () => {
    const machine = new SessionStateMachine();
    const listener = vi.fn();
    const unsubscribe = machine.subscribe(listener);
    machine.transition('preparing');
    expect(listener).toHaveBeenCalledWith('preparing');
    unsubscribe();
    machine.transition('downloading');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resets to idle', () => {
    const machine = new SessionStateMachine();
    machine.transition('preparing');
    machine.reset();
    expect(machine.state).toBe('idle');
  });
});
