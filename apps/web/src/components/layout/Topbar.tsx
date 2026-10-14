export function Topbar() {
  return (
    <header className="topbar">
      <div className="wordmark">
        <img className="wordmark-logo" src="/logo.png" alt="" width={35} height={35} />
        <span className="wordmark-text">
          Lumi
          <span className="wordmark-dot" aria-hidden="true" />
          Boot
        </span>
      </div>
    </header>
  );
}
