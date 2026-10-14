import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/session-progress.css';

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable dans index.html.');

createRoot(container).render(<App />);
