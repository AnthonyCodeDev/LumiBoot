import { afterEach, describe, expect, it } from 'vitest';
import { STANDARD_VM_DISPLAY, STANDARD_VM_INPUT } from '@lumiboot/vm-core';
import { DomConsoleAdapter } from './console-adapter';

describe('DomConsoleAdapter — contrat d’affichage/entrée', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('balise l’écran et la sortie texte avec le marqueur standard', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const adapter = new DomConsoleAdapter();
    const mount = adapter.attach(container);

    // La cible écran est trouvable via le contrat, sans connaître v86.
    const screen = container.querySelector(STANDARD_VM_DISPLAY.screenSelector);
    const text = container.querySelector(STANDARD_VM_DISPLAY.textSelector);
    expect(screen).not.toBeNull();
    expect(text).not.toBeNull();
    expect(mount.screenContainer).toBe(screen);
    expect(adapter.screen).toBe(screen);

    adapter.detach();
  });

  it('conserve la structure attendue par v86 (div texte puis canvas)', () => {
    const container = document.createElement('div');
    document.body.append(container);

    const adapter = new DomConsoleAdapter();
    const { screenContainer } = adapter.attach(container);

    expect(screenContainer.children).toHaveLength(2);
    expect(screenContainer.children[0]?.tagName).toBe('DIV');
    expect(screenContainer.children[1]?.tagName).toBe('CANVAS');

    adapter.detach();
  });

  it('expose les contrats d’affichage et d’entrée standard', () => {
    const adapter = new DomConsoleAdapter();
    expect(adapter.display).toEqual(STANDARD_VM_DISPLAY);
    expect(adapter.input).toEqual(STANDARD_VM_INPUT);
  });

  it('détache réellement le sous-arbre injecté', () => {
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
