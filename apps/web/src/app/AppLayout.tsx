import { Outlet } from 'react-router-dom';
import { Topbar } from '../components/layout/Topbar';
import { Toast } from '../components/ui/Toast';

export function AppLayout() {
  return (
    <div className="shell">
      <div className="workarea" id="accueil">
        <Topbar />
        <Outlet />
        <Toast />
      </div>
    </div>
  );
}
