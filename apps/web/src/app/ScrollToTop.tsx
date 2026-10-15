import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Remet la fenêtre en haut à chaque changement de route (navigation client).
 * Force un saut instantané malgré `scroll-behavior: smooth` global.
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
