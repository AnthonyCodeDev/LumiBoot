import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Scrolls to top on route change, bypassing the global `scroll-behavior: smooth`. */
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
