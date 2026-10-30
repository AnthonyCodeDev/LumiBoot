import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { systems } from '@lumiboot/catalog';
import { useCatalogStore } from '../../features/catalog/catalog.store';
import { CatalogueTop } from './CatalogueTop';
import { Filters } from './Filters';
import { SystemGrid } from './SystemGrid';

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <CatalogueTop />
      <Filters />
      <SystemGrid />
    </MemoryRouter>,
  );
}

function cardIds(): string[] {
  return screen.getAllByRole('article').map((card) => card.getAttribute('data-id') ?? '');
}

function architectureTrigger() {
  return screen.getByRole('button', { name: /^Architecture filter/ });
}

beforeEach(() => {
  useCatalogStore.setState({
    systems,
    family: 'all',
    query: '',
    architectures: [],
    engines: [],
  });
});

describe('Filters', () => {
  it('renders the four family chips, without a Custom chip', () => {
    renderLibrary();

    const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-filter]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(['All', 'Linux', 'Windows', 'macOS']);
    expect(document.querySelector('[data-filter="custom"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Custom' })).toBeNull();
    // The custom image keeps its card: it stays visible under All.
    expect(cardIds()).toContain('custom-image');
    expect(cardIds()).toHaveLength(10);
  });

  it('narrows the grid to 64-bit systems, then widens it back when the option is unchecked', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(architectureTrigger());
    await user.click(screen.getByRole('checkbox', { name: /^64 bits/ }));

    expect(cardIds()).toEqual([
      'fedora-44-x86-64',
      'alpine-3-24-x86-64',
      'windows-8-1-x64',
      'windows-11-x64',
    ]);
    expect(useCatalogStore.getState().architectures).toEqual(['x86_64']);

    // No tag in the trigger: the selection is only visible through the count badge.
    const trigger = architectureTrigger();
    expect(trigger.getAttribute('aria-label')).toBe('Architecture filter, 1 selected');
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(document.querySelector('.facet-tag')).toBeNull();

    // Unchecking the option from the still-open panel restores the whole library.
    await user.click(screen.getByRole('checkbox', { name: /^64 bits/ }));

    expect(cardIds()).toHaveLength(10);
    expect(useCatalogStore.getState().architectures).toEqual([]);
  });

  it('combines the search with a facet', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.type(screen.getByLabelText('Search for a system'), 'windows');
    await user.click(architectureTrigger());
    await user.click(screen.getByRole('checkbox', { name: /^64 bits/ }));

    expect(cardIds()).toEqual(['windows-8-1-x64', 'windows-11-x64']);
  });

  it('combines the family chip with a facet', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole('button', { name: 'Windows' }));
    expect(cardIds()).toHaveLength(4);

    await user.click(architectureTrigger());
    await user.click(screen.getByRole('checkbox', { name: /^64 bits/ }));

    expect(cardIds()).toEqual(['windows-8-1-x64', 'windows-11-x64']);
  });

  it('resets every filter from the empty state', async () => {
    const user = userEvent.setup();
    renderLibrary();

    act(() => {
      useCatalogStore.getState().toggleArchitecture('arm64');
      useCatalogStore.getState().toggleEngine('v86');
      useCatalogStore.getState().setFamily('windows');
      useCatalogStore.getState().setQuery('debian');
    });

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));

    expect(cardIds()).toHaveLength(10);
    const state = useCatalogStore.getState();
    expect(state.family).toBe('all');
    expect(state.query).toBe('');
    expect(state.architectures).toEqual([]);
    expect(state.engines).toEqual([]);
  });

  it('offers both facets, each with its option list', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(architectureTrigger());
    expect(screen.getByRole('group', { name: 'Architecture' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Architecture' })).getAllByRole('checkbox'),
    ).toHaveLength(3);

    // Opening the engine facet folds the architecture panel.
    await user.click(screen.getByRole('button', { name: /^Engine filter/ }));
    expect(screen.queryByRole('group', { name: 'Architecture' })).toBeNull();
    const engineMenu = screen.getByRole('group', { name: 'Engine' });
    expect(within(engineMenu).getAllByRole('checkbox')).toHaveLength(4);
    expect(within(engineMenu).getByText('v86 / WebAssembly')).toBeTruthy();
  });

  it('selects an engine through its label and count badge', async () => {
    const user = userEvent.setup();
    renderLibrary();

    await user.click(screen.getByRole('button', { name: /^Engine filter/ }));
    await user.click(screen.getByRole('checkbox', { name: /^v86 / }));

    expect(useCatalogStore.getState().engines).toEqual(['v86']);
    // v86 systems: Debian, Ubuntu, Windows 7, Windows 10 x86, Custom image.
    expect(cardIds()).toEqual([
      'debian-12-i386',
      'ubuntu-18-i386',
      'windows-7-x86',
      'windows-10-x86',
      'custom-image',
    ]);

    const engineTrigger = screen.getByRole('button', { name: /^Engine filter/ });
    expect(engineTrigger.getAttribute('aria-label')).toBe('Engine filter, 1 selected');
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(within(engineTrigger).queryByText('v86')).toBeNull();
  });
});
