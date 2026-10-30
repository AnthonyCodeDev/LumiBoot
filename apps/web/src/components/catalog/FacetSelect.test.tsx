import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FacetOption } from '../../features/catalog/catalog.selectors';
import { FacetSelect } from './FacetSelect';

const OPTIONS: readonly FacetOption[] = [
  { value: 'i386', label: '32 bits', count: 5 },
  { value: 'x86_64', label: '64 bits', count: 4 },
  { value: 'arm64', label: 'ARM 64 bits', count: 0 },
];

function Harness({ initial = [] as string[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <FacetSelect
      label="Architecture"
      options={OPTIONS}
      selected={selected}
      onToggle={(value) =>
        setSelected((current) =>
          current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
        )
      }
    />
  );
}

function trigger() {
  return screen.getByRole('button', { name: /^Architecture filter/ });
}

function option(name: RegExp) {
  return screen.getByRole('checkbox', { name }) as HTMLButtonElement;
}

describe('FacetSelect', () => {
  it('exposes the trigger as a collapsed popup without tags or count badge', () => {
    render(<Harness />);

    expect(trigger().getAttribute('aria-haspopup')).toBe('true');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBeTruthy();
    expect(trigger().textContent).toBe('Architecture');
    // No count badge in the trigger: the selection is exposed through the label only.
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Architecture filter, no selection');
    expect(document.querySelector('.facet-tag')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Architecture' })).toBeNull();
  });

  it('opens and closes with a click on the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('group', { name: 'Architecture' });
    expect(within(menu).getAllByRole('checkbox')).toHaveLength(OPTIONS.length);
    expect(within(menu).getByText('32 bits')).toBeTruthy();
    // The panel only holds options (role="checkbox"): no button, no Clear action.
    expect(within(menu).queryAllByRole('button')).toHaveLength(0);
    expect(within(menu).queryByRole('button', { name: 'Clear' })).toBeNull();

    await user.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Architecture' })).toBeNull();
  });

  it('closes on Escape and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Architecture' })).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on an outside pointerdown', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <p>Outside</p>
      </>,
    );

    await user.click(trigger());
    expect(screen.getByRole('group', { name: 'Architecture' })).toBeTruthy();

    await user.click(screen.getByText('Outside'));
    expect(screen.queryByRole('group', { name: 'Architecture' })).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('selects a value, keeps the menu open and updates the label', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    expect(option(/^64 bits/).getAttribute('aria-checked')).toBe('false');

    await user.click(option(/^64 bits/));

    expect(option(/^64 bits/).getAttribute('aria-checked')).toBe('true');
    expect(option(/^64 bits/).classList.contains('is-selected')).toBe(true);
    expect(screen.getByRole('group', { name: 'Architecture' })).toBeTruthy();
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Architecture filter, 1 selected');
    expect(trigger().classList.contains('is-active')).toBe(true);
    // The trigger never renders the selected values as tags.
    expect(document.querySelector('.facet-tag')).toBeNull();
  });

  it('deselects a value by clicking it again', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['x86_64']} />);

    expect(trigger().getAttribute('aria-label')).toBe('Architecture filter, 1 selected');

    await user.click(trigger());
    expect(option(/^64 bits/).getAttribute('aria-checked')).toBe('true');

    await user.click(option(/^64 bits/));

    expect(option(/^64 bits/).getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(document.querySelector('.facet-tag')).toBeNull();
    expect(screen.getByRole('group', { name: 'Architecture' })).toBeTruthy();

    // Closing the panel drops the active look: nothing is selected anymore.
    await user.keyboard('{Escape}');
    expect(trigger().classList.contains('is-active')).toBe(false);
  });

  it('disables a zero-count value without selecting it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    const empty = option(/^ARM 64 bits/);
    expect(empty.disabled).toBe(true);
    expect(empty.classList.contains('is-empty')).toBe(true);

    await user.click(empty);

    expect(empty.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('.facet-count')).toBeNull();
  });

  it('keeps a selected zero-count value clickable so it can be removed', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['arm64']} />);

    await user.click(trigger());
    const selected = option(/^ARM 64 bits/);
    expect(selected.disabled).toBe(false);
    expect(selected.getAttribute('aria-checked')).toBe('true');

    await user.click(selected);
    expect(selected.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles several values and reports the selection count in the label', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.click(option(/^32 bits/));
    await user.click(option(/^64 bits/));

    expect(trigger().getAttribute('aria-label')).toBe('Architecture filter, 2 selected');
    expect(document.querySelector('.facet-count')).toBeNull();
    expect(option(/^32 bits/).getAttribute('aria-checked')).toBe('true');
    expect(option(/^64 bits/).getAttribute('aria-checked')).toBe('true');
  });
});
