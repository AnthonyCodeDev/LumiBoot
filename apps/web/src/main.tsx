import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { loadConfig } from './config/load-config';
import { setRuntimeConfig } from './config/runtime';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/session-progress.css';

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans index.html.');

const root = createRoot(container);

/**
 * La configuration globale publique est chargée **avant** le rendu React.
 * Un échec affiche un message d'erreur lisible plutôt qu'une application
 * silencieusement cassée.
 */
async function bootstrap(): Promise<void> {
  try {
    const config = await loadConfig();
    setRuntimeConfig(config);
    root.render(<App />);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue.';
    root.render(
      <main
        role="alert"
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: '48px 24px',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>LumiBoot n'a pas pu démarrer</h1>
        <p style={{ color: '#b3261e', lineHeight: 1.6, margin: 0 }}>{message}</p>
      </main>,
    );
  }
}

void bootstrap();
