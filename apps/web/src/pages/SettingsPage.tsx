import { NetworkPanel } from '../components/settings/NetworkPanel';

export function SettingsPage() {
  return (
    <main className="settings">
      <header className="settings-header">
        <h1>Paramètres</h1>
        <p>Configurez le comportement de LumiBoot. Les préférences sont enregistrées localement.</p>
      </header>
      <NetworkPanel />
    </main>
  );
}
