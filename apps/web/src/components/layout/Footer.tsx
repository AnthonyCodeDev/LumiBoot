export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <span className="footer-brand">
        Lumi<span className="wordmark-dot" aria-hidden="true" />Boot
      </span>
      <span className="footer-copy">© {year} LumiBoot</span>
    </footer>
  );
}
