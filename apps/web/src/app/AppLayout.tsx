import { Outlet } from 'react-router-dom';
import { Topbar } from '../components/layout/Topbar';
import { Toast } from '../components/ui/Toast';
import { ScrollToTop } from './ScrollToTop';

export function AppLayout() {
  return (
    <div className="shell">
      <ScrollToTop />
      <div className="workarea" id="accueil">
        <Topbar />
        <Outlet />
        <Toast />
      </div>
    </div>
  );
}
