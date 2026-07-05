export default function ReviewLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Review</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading review queue...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">Rate con</div>
          <div className="db-loading-card db-skel">Extracted</div>
          <div className="db-loading-card db-skel">Actions</div>
        </div>
      </section>
    </main>
  );
}
