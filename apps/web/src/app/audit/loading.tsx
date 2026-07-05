export default function AuditLoading() {
  return (
    <main className="db-root db-fallback-main">
      <section className="db-loading-shell" aria-live="polite" aria-busy="true">
        <div className="db-loading-line db-skel">Audit Log</div>
        <div className="db-loading-line db-loading-line-wide db-skel">Loading audit entries...</div>
        <div className="db-loading-grid">
          <div className="db-loading-card db-skel">Filters</div>
          <div className="db-loading-card db-skel">Entries</div>
          <div className="db-loading-card db-skel">Detail</div>
        </div>
      </section>
    </main>
  );
}
