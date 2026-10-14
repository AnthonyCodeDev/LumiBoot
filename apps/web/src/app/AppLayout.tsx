import { Outlet } from 'react-router-dom';
import { Topbar } from '../components/layout/Topbar';
import { SystemDetailDrawer } from '../components/catalog/SystemDetailDrawer';
import { Toast } from '../components/ui/Toast';

export function AppLayout() {
  return (
    <div className="shell">
      <div className="workarea" id="accueil">
        <Topbar />
        <Outlet />
        <SystemDetailDrawer />
        <Toast />
      </div>
    </div>
  );
}
