import { Outlet } from 'react-router-dom';
import { Topbar } from '../components/layout/Topbar';
import { Toast } from '../components/ui/Toast';
import { ScrollToTop } from './ScrollToTop';

export function AppLayout() {
  return (
    <div className="shell">
      <ScrollToTop />
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="workarea" id="home">
        <Topbar />
        <div id="main-content">
          <Outlet />
        </div>
        <Toast />
      </div>
    </div>
  );
}
