export default function DeliveriesLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Deliveries</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading open deliveries...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">Overdue</div>
          <div className="db-loading-card db-skel">Due today</div>
          <div className="db-loading-card db-skel">Upcoming</div>
        </div>
      </section>
    </main>
  );
}
