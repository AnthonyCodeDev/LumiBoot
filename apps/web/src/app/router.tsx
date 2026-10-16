import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { HomePage } from '../pages/HomePage';
import { SystemPage } from '../pages/SystemPage';
import { SessionPage } from '../pages/SessionPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { RouteError } from './RouteError';

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'systems/:slug', element: <SystemPage /> },
      { path: 'session/:id', element: <SessionPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
