import { afterEach, describe, expect, it } from 'vitest';
import { STANDARD_VM_DISPLAY, STANDARD_VM_INPUT } from '@lumiboot/vm-core';
import { DomConsoleAdapter } from './console-adapter';

describe('DomConsoleAdapter — display/input contract', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('tags the screen and the text output with the standard marker', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const adapter = new DomConsoleAdapter();
    const mount = adapter.attach(container);

    // The screen target is findable through the contract, without knowing v86.
    const screen = container.querySelector(STANDARD_VM_DISPLAY.screenSelector);
    const text = container.querySelector(STANDARD_VM_DISPLAY.textSelector);
    expect(screen).not.toBeNull();
    expect(text).not.toBeNull();
    expect(mount.screenContainer).toBe(screen);
    expect(adapter.screen).toBe(screen);

    adapter.detach();
  });

  it('keeps the structure expected by v86 (text div then canvas)', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const adapter = new DomConsoleAdapter();
    const { screenContainer } = adapter.attach(container);

    expect(screenContainer.children).toHaveLength(2);
    expect(screenContainer.children[0]?.tagName).toBe('DIV');
    expect(screenContainer.children[1]?.tagName).toBe('CANVAS');

    adapter.detach();
  });

  it('exposes the standard display and input contracts', () => {
    const adapter = new DomConsoleAdapter();
    expect(adapter.display).toEqual(STANDARD_VM_DISPLAY);
    expect(adapter.input).toEqual(STANDARD_VM_INPUT);
  });

  it('really detaches the injected subtree', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const adapter = new DomConsoleAdapter();
    adapter.attach(container);
    expect(container.children.length).toBeGreaterThan(0);

    adapter.detach();
    expect(container.children).toHaveLength(0);
    expect(adapter.screen).toBeNull();
  });
});
