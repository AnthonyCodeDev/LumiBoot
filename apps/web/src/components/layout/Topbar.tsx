import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export function Topbar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the mobile menu on route change.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Close on outside click + Escape (focus returned to the button).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (
        target &&
        menuRef.current &&
        !menuRef.current.contains(target) &&
        toggleRef.current &&
        !toggleRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <header className="topbar">
      <Link to="/" className="wordmark" aria-label="LumiBoot, home">
        <svg
          width="35"
          height="35"
          viewBox="0 0 35 35"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <rect width="35" height="35" rx="10" fill="url(#paint0_linear_2715_1285)" />
          <path
            d="M10.6776 5.91009C13.5092 4.21114 16.9668 3.56351 20.1855 3.98333C23.407 4.40358 26.5169 5.91591 28.4931 8.68255C28.9784 9.36247 28.8211 10.3071 28.1415 10.7929C27.888 10.974 27.5972 11.0646 27.3075 11.0732C32.3412 15.1514 32.4945 22.9831 27.6151 27.4872C25.1134 29.7965 21.6348 30.9866 18.2001 31.124C14.765 31.2613 11.1958 30.3533 8.50382 28.2382V28.2372C4.81479 25.4957 3.43483 21.0645 3.89932 16.8369C4.36498 12.5994 6.69211 8.37719 10.6601 5.92083L10.6689 5.91595L10.6776 5.91009ZM19.7939 6.98529C17.2117 6.64849 14.4479 7.17824 12.2353 8.5058L12.2343 8.50482C9.15128 10.4219 7.28248 13.7609 6.90811 17.1669C6.54529 20.4686 7.59569 23.6559 10.0907 25.6415L10.3368 25.83L10.3554 25.8437L10.3739 25.8583C12.3896 27.442 15.2093 28.2152 18.079 28.1005C20.9495 27.9857 23.6925 26.9896 25.5624 25.2636C29.2609 21.8496 28.9237 15.9399 25.0526 13.1591C23.3832 12.0557 21.3537 11.7044 19.5331 12.0195C17.6963 12.3374 16.2163 13.3 15.4755 14.6581C14.7226 16.0385 14.7745 17.6262 15.3876 18.9169C15.9674 20.1373 16.9718 20.9528 18.0937 21.1406L18.3192 21.1699L18.3993 21.1767L18.4784 21.1923C20.7203 21.6407 22.0257 19.714 21.4823 18.1943C21.1949 17.5553 20.6464 17.1801 20.0292 17.0566C19.3533 16.9214 18.8144 17.1219 18.579 17.3574C17.988 17.948 17.0302 17.9482 16.4394 17.3574C15.8485 16.7665 15.8487 15.8087 16.4394 15.2177C17.5491 14.108 19.1972 13.8036 20.623 14.0888C22.0042 14.3652 23.3729 15.2254 24.1366 16.7275L24.2812 17.0361L24.2948 17.0683L24.3066 17.1015C25.7412 20.9279 22.4068 24.9874 17.9892 24.1767C15.5289 23.9306 13.6249 22.2603 12.6532 20.2148C11.6693 18.1429 11.5537 15.5274 12.8183 13.2089C14.0951 10.8681 16.4818 9.47581 19.0165 9.03705C21.2034 8.65855 23.6068 8.96646 25.7392 10.0615C24.3374 8.34613 22.2001 7.29918 19.7939 6.98529Z"
            fill="white"
          />
          <defs>
            <linearGradient
              id="paint0_linear_2715_1285"
              x1="0"
              y1="0"
              x2="35"
              y2="35"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#7882F8" />
              <stop offset="1" stopColor="#505DDE" />
            </linearGradient>
          </defs>
        </svg>
        <span className="wordmark-text">
          Lumi
          <span className="wordmark-dot" aria-hidden="true" />
          Boot
        </span>
      </Link>

      <div className="topbar-menu" id={menuId} ref={menuRef} data-open={open}>
        <a
          href="https://discord.gg/HcqduKt"
          className="btn btn-primary topbar-cta"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpen(false)}
        >
          Join the Discord
        </a>
      </div>

      <button
        type="button"
        className="topbar-toggle"
        ref={toggleRef}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
    </header>
  );
}
