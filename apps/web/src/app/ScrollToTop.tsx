import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scrolls the window back to the top on every route change (client navigation).
 * Forces an instant jump despite the global `scroll-behavior: smooth`.
 */
export function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    html.style.scrollBehavior = previous;
  }, [pathname]);
  return null;
}
