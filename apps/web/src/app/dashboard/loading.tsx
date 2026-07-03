export default function DashboardLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">KPI Dashboard</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading KPI tracker data...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">Cards</div>
          <div className="db-loading-card db-skel">Lanes</div>
          <div className="db-loading-card db-skel">Trend</div>
        </div>
      </section>
    </main>
  );
}
