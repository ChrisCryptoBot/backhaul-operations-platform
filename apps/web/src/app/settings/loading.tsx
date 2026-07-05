export default function SettingsLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Settings</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading settings...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">AI provider</div>
          <div className="db-loading-card db-skel">Region</div>
          <div className="db-loading-card db-skel">Preferences</div>
        </div>
      </section>
    </main>
  );
}
