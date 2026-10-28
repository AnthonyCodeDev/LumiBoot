import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SystemPage } from './SystemPage';

/** Neutralized: its network probes are unrelated to variant selection. */
vi.mock('../components/network/NetworkProxyCard', () => ({
  NetworkProxyCard: () => null,
}));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderSystemPage(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/systems/${slug}`]}>
      <Routes>
        <Route path="/systems/:slug" element={<SystemPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('SystemPage — variant selector', () => {
  it('shows the parent content (Debian) and opens the best variant (XFCE)', async () => {
    const user = userEvent.setup();
    // The card opens the parent; the dropdown picks the variant to launch.
    renderSystemPage('debian-12-i386');

    const trigger = screen.getByRole('button', { name: 'Choose variant' });
    // Only the name is shown, never a "Variant" label.
    expect(trigger.textContent).toBe('Debian XFCE');
    expect(screen.queryByText('Variant')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // The hero shows the base, not the selected variant.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('XFCE');

    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const options = screen.getAllByRole('option').map((option) => option.textContent);
    // Order comes from `variantOrder`: the best variant first.
    expect(options).toEqual(['Debian XFCE', 'Debian X11', 'Debian CLI']);
  });

  it('choosing X11 changes the dropdown WITHOUT navigating or changing the content', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    await user.click(screen.getByRole('button', { name: 'Choose variant' }));
    await user.click(screen.getByRole('button', { name: 'Debian X11' }));

    // No navigation: we stay on the parent page.
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386');
    // The trigger reflects the variant to launch…
    expect(screen.getByRole('button', { name: 'Choose variant' }).textContent).toBe('Debian X11');
    // …but the page content stays the base one.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('Bureau');
  });

  it('a direct link to a child preselects its variant without changing the content', async () => {
    renderSystemPage('debian-12-i386-desktop');

    // Wait for the effect that syncs the selection onto the child.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Choose variant' }).textContent).toBe('Debian X11');
    });
    // The displayed content stays the parent one.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386-desktop');
  });

  it('closes the menu with Escape', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    const trigger = screen.getByRole('button', { name: 'Choose variant' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the Windows 7 parent selector, Professional as the default variant', async () => {
    const user = userEvent.setup();
    // Professional is the best variant of the group, so it is preselected.
    renderSystemPage('windows-7-x86');

    const trigger = screen.getByRole('button', { name: 'Choose variant' });
    expect(trigger.textContent).toBe('Windows 7 Professional');

    await user.click(trigger);
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Windows 7 Professional', 'Windows 7 Lite']);
  });

  it('shows no selector for a standalone system (Windows 10 x86)', () => {
    renderSystemPage('windows-10-x86');
    expect(screen.queryByRole('button', { name: 'Choose variant' })).toBeNull();
  });

  it('shows the Ubuntu 18.04 selector, XFCE as the default variant', async () => {
    const user = userEvent.setup();
    // XFCE is the best variant of the group, so it is preselected.
    renderSystemPage('ubuntu-18-i386');

    const trigger = screen.getByRole('button', { name: 'Choose variant' });
    expect(trigger.textContent).toBe('Ubuntu XFCE');
    // The hero shows the base, not the selected variant.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Ubuntu');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('XFCE');

    await user.click(trigger);
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    // Order comes from `variantOrder`: the best variant first.
    expect(options).toEqual(['Ubuntu XFCE', 'Ubuntu X11', 'Ubuntu CLI']);
  });

  it('reflects the selected variant in the spec table', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    // Debian XFCE defaults: 1024 MiB, virtio, disk boot.
    expect(screen.getByText('v86 / WebAssembly')).toBeTruthy();
    expect(screen.getByText('1024 MiB')).toBeTruthy();
    expect(screen.getByText('VirtIO')).toBeTruthy();
    expect(screen.getByText('Disk (hda)')).toBeTruthy();

    // The console CLI variant reduces memory to 512 MiB.
    await user.click(screen.getByRole('button', { name: 'Choose variant' }));
    await user.click(screen.getByRole('button', { name: 'Debian CLI' }));
    expect(screen.getByText('512 MiB')).toBeTruthy();
    expect(screen.queryByText('1024 MiB')).toBeNull();
  });

  it('shows the Windows 7 variant specs (NE2000, 1536 MiB)', () => {
    renderSystemPage('windows-7-x86');

    // Windows 7 Professional is the default variant of the group.
    expect(screen.getByText('Windows 7 Professional')).toBeTruthy();
    expect(screen.getByText('1536 MiB')).toBeTruthy();
    expect(screen.getByText('NE2000')).toBeTruthy();
  });
});

describe('SystemPage — user media import', () => {
  it('shows the import card for the generic custom image and refuses the launch until a media is imported', () => {
    renderSystemPage('custom-image');

    expect(screen.getByText('Required media (provided by you)')).toBeTruthy();
    // v86 is integrated, but nothing is distributed: the user must import a media.
    const launch = screen.getByRole('button', { name: 'Start session' });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    // The refusal comes from the missing media, not from a missing engine.
    expect(screen.getByRole('status').textContent).toMatch(
      /resource required.*import a disk media/i,
    );
  });

  it('shows no import card for a system that is not developed (Windows 11)', () => {
    renderSystemPage('windows-11-x64');

    // Not developed: neither media to import nor a launchable session.
    expect(screen.queryByText('Required media (provided by you)')).toBeNull();
    const launch = screen.getByRole('button', { name: 'Start session' });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
  });

  it('never shows the import card for Windows 7 (local disk from the codebase)', () => {
    renderSystemPage('windows-7-x86');
    expect(screen.queryByText('Required media (provided by you)')).toBeNull();
  });

  it('shows the picked media and only enables the import once the licence is acknowledged', async () => {
    const user = userEvent.setup();
    const { container } = renderSystemPage('custom-image');

    const mediaInput = container.querySelector(
      '.media-file-field input[type=file]',
    ) as HTMLInputElement;
    expect(mediaInput.getAttribute('accept')).toBe('.iso,.img,.raw');
    // The input stays inside the clickable tile (clipped, not `display: none`).
    const tile = mediaInput.closest('label.media-file-field') as HTMLElement;
    expect(tile).toBeTruthy();
    expect(tile.getAttribute('data-state')).toBe('empty');
    expect(mediaInput.getAttribute('aria-label')).toBe('Disk image file (.iso, .img, .raw)');

    await user.upload(mediaInput, new File(['payload'], 'custom.iso'));

    // The tile switches to its selected state and shows the file name and size.
    expect(tile.getAttribute('data-state')).toBe('selected');
    expect(screen.getByText('custom.iso')).toBeTruthy();
    expect(screen.getByText('7 bytes')).toBeTruthy();
    expect(screen.getByText('Replace')).toBeTruthy();

    const importButton = screen.getByRole('button', { name: 'Import media' }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);

    await user.click(screen.getByRole('checkbox'));
    expect(importButton.disabled).toBe(false);
  });
});
