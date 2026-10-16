import { Outlet } from 'react-router-dom';
import { Topbar } from '../components/layout/Topbar';
import { Toast } from '../components/ui/Toast';
import { ScrollToTop } from './ScrollToTop';

export function AppLayout() {
  return (
    <div className="shell">
      <ScrollToTop />
      <a className="skip-link" href="#contenu-principal">
        Aller au contenu principal
      </a>
      <div className="workarea" id="accueil">
        <Topbar />
        <div id="contenu-principal">
          <Outlet />
        </div>
        <Toast />
      </div>
    </div>
  );
}
