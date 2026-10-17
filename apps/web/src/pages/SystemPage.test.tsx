import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SystemPage } from './SystemPage';

/**
 * La carte « Internet via votre connexion » déclenche des sondes réseau
 * (fetch `/health`, manifeste de téléchargement) sans rapport avec ce test :
 * on la neutralise pour isoler la sélection de variante.
 */
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

describe('SystemPage — sélecteur de variante', () => {
  it('affiche le contenu de la mère (Debian) et ouvre la meilleure variante (XFCE)', async () => {
    const user = userEvent.setup();
    // La carte du catalogue ouvre désormais la MÈRE : le contenu affiché est
    // celui de la base, le dropdown sélectionne la variante à lancer.
    renderSystemPage('debian-12-i386');

    const trigger = screen.getByRole('button', { name: 'Choisir la variante' });
    // Le libellé « Variante » n'est pas visible : seul le nom est affiché.
    expect(trigger.textContent).toBe('Debian XFCE');
    expect(screen.queryByText('Variante')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // Le hero affiche la base, PAS la variante sélectionnée.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('XFCE');

    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const options = screen.getAllByRole('option').map((option) => option.textContent);
    // Ordre piloté par `variantOrder` : meilleure variante (XFCE) en premier.
    // Libellés « nom de base + spécificité ».
    expect(options).toEqual(['Debian XFCE', 'Debian X11', 'Debian CLI']);
  });

  it('choisir X11 change le dropdown SANS naviguer ni changer le contenu', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    await user.click(screen.getByRole('button', { name: 'Choisir la variante' }));
    await user.click(screen.getByRole('button', { name: 'Debian X11' }));

    // Aucune navigation : on reste sur la fiche de la mère.
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386');
    // Le déclencheur reflète la variante à lancer…
    expect(screen.getByRole('button', { name: 'Choisir la variante' }).textContent).toBe(
      'Debian X11',
    );
    // …mais le contenu de la page reste celui de la base.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('Bureau');
  });

  it('un lien direct sur un enfant présélectionne sa variante sans changer le contenu', async () => {
    renderSystemPage('debian-12-i386-desktop');

    // Le temps que le `useEffect` synchronise la sélection sur l'enfant.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Choisir la variante' }).textContent).toBe(
        'Debian X11',
      );
    });
    // Le contenu affiché reste celui de la mère.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Debian');
    expect(screen.getByTestId('location').textContent).toBe('/systems/debian-12-i386-desktop');
  });

  it('ferme le menu avec Échap', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    const trigger = screen.getByRole('button', { name: 'Choisir la variante' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('affiche le sélecteur de la mère Windows 7, variante par défaut Professionnel', async () => {
    const user = userEvent.setup();
    // La carte catalogue Windows 7 ouvre la MÈRE neutre ; Professionnel est la
    // meilleure variante (variantOrder 1), donc présélectionnée.
    renderSystemPage('windows-7-x86');

    const trigger = screen.getByRole('button', { name: 'Choisir la variante' });
    expect(trigger.textContent).toBe('Windows 7 Professionnel');

    await user.click(trigger);
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Windows 7 Professionnel', 'Windows 7 Lite']);
  });

  it('n’affiche aucun sélecteur pour un système autonome (Ubuntu 18.04)', () => {
    renderSystemPage('ubuntu-18-i386');
    expect(screen.queryByRole('button', { name: 'Choisir la variante' })).toBeNull();
  });

  it('reflète la variante sélectionnée dans le tableau de spécifications', async () => {
    const user = userEvent.setup();
    renderSystemPage('debian-12-i386');

    // Debian XFCE (variante par défaut) : 1024 Mio, virtio, démarrage disque.
    expect(screen.getByText('v86 / WebAssembly')).toBeTruthy();
    expect(screen.getByText('1024 Mio')).toBeTruthy();
    expect(screen.getByText('VirtIO')).toBeTruthy();
    expect(screen.getByText('Disque (hda)')).toBeTruthy();

    // La variante console CLI réduit la mémoire à 512 Mio.
    await user.click(screen.getByRole('button', { name: 'Choisir la variante' }));
    await user.click(screen.getByRole('button', { name: 'Debian CLI' }));
    expect(screen.getByText('512 Mio')).toBeTruthy();
    expect(screen.queryByText('1024 Mio')).toBeNull();
  });

  it('affiche les specs de la variante Windows 7 (NE2000, 1536 Mio)', () => {
    renderSystemPage('windows-7-x86');

    // Windows 7 Professionnel est la variante par défaut du groupe.
    expect(screen.getByText('Windows 7 Professionnel')).toBeTruthy();
    expect(screen.getByText('1536 Mio')).toBeTruthy();
    expect(screen.getByText('NE2000')).toBeTruthy();
  });
});

describe('SystemPage — import de média utilisateur', () => {
  it('affiche la carte d’import pour un système user-import et refuse le lancement', () => {
    renderSystemPage('windows-11-x64');

    expect(screen.getByText('Média requis (fourni par vous)')).toBeTruthy();
    // Le moteur de ce système n'est pas intégré : refus explicite.
    const launch = screen.getByRole('button', { name: 'Lancer une session' });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/n'est pas encore intégré|non prise en charge/i)).toBeTruthy();
  });

  it('n’affiche jamais la carte d’import pour Windows 7 (disque local de la codebase)', () => {
    renderSystemPage('windows-7-x86');
    expect(screen.queryByText('Média requis (fourni par vous)')).toBeNull();
  });
});
