export default function LanesLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Lanes</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading reference data...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">List</div>
          <div className="db-loading-card db-skel">List</div>
          <div className="db-loading-card db-skel">List</div>
        </div>
      </section>
    </main>
  );
}
