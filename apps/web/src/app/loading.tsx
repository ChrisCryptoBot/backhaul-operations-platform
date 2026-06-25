export default function LoadingPage() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Daily Load Tracker</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading board data...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">Totals</div>
          <div className="db-loading-card db-skel">Sections</div>
          <div className="db-loading-card db-skel">Drop Bucket</div>
        </div>
      </section>
    </main>
  );
}
