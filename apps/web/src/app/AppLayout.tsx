import { Outlet } from 'react-router-dom';
import { Sidebar } from '../components/layout/Sidebar';
import { Topbar } from '../components/layout/Topbar';
import { SystemDetailDrawer } from '../components/catalog/SystemDetailDrawer';
import { Toast } from '../components/ui/Toast';

export function AppLayout() {
  return (
    <div className="shell">
      <Sidebar />
      <div className="workarea" id="accueil">
        <Topbar />
        <Outlet />
        <SystemDetailDrawer />
        <Toast />
      </div>
    </div>
  );
}
