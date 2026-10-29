import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SYSTEM_RUNTIME_CHECK_TIMEOUT_MS, SystemPage } from './SystemPage';

const checkRuntime = vi.hoisted(() => vi.fn());

vi.mock('../lib/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/launch')>();
  return { ...actual, checkSystemRuntimeAvailability: checkRuntime };
});

vi.mock('../components/network/NetworkProxyCard', () => ({
  NetworkProxyCard: () => null,
}));

beforeEach(() => {
  checkRuntime.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/systems/debian-12-i386']}>
      <Routes>
        <Route path="/systems/:slug" element={<SystemPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SystemPage runtime availability', () => {
  it('requires a fresh availability result after switching variants', async () => {
    checkRuntime.mockResolvedValueOnce({ available: true });
    checkRuntime.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderPage();

    const launch = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
    await waitFor(() => expect(launch.disabled).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Choose variant' }));
    await user.click(screen.getByRole('button', { name: 'Debian X11 · 32 bits' }));

    expect(launch.disabled).toBe(true);
    expect(checkRuntime).toHaveBeenCalledTimes(2);
  });

  it('times out a hung media check instead of checking forever', async () => {
    vi.useFakeTimers();
    try {
      checkRuntime.mockImplementation(() => new Promise(() => {}));
      renderPage();

      const launch = screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement;
      expect(screen.getByText('Checking media availability…')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SYSTEM_RUNTIME_CHECK_TIMEOUT_MS);
      });

      expect(launch.disabled).toBe(true);
      expect(screen.getByText('The media check timed out.')).toBeTruthy();
      expect(screen.queryByText('Checking media availability…')).toBeNull();
      // The probe received an abort signal so the network request can be dropped.
      const options = checkRuntime.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
      expect(options?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
