import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="min-h-screen bg-surface-primary flex flex-col items-center justify-center gap-4 px-5 text-center">
      <span className="font-mono text-content-tertiary">404</span>
      <h1 className="text-2xl font-semibold text-content-primary">Page not found</h1>
      <p className="text-sm text-content-secondary">This address does not point to an Agent Kanban page.</p>
      <Link to="/" className="text-sm font-medium text-accent hover:underline">
        Return home
      </Link>
    </main>
  );
}
