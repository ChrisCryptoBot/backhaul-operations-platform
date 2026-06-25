export default function DashboardLoading() {
  return (
    <main className="db-root db-dashboard-loading">
      <div className="db-dashboard-loading-card">
        <span className="db-spinner" aria-hidden="true" />
        <div>
          <h1 className="db-dashboard-loading-title">KPI Dashboard</h1>
          <p className="db-dashboard-loading-copy">Loading KPI tracker data...</p>
        </div>
      </div>
    </main>
  );
}
