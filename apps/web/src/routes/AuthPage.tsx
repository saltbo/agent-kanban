import { useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";

export function AuthPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const returnTo = params.get("returnTo");

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-primary px-6">
      <section className="w-full max-w-sm rounded-lg border border-border bg-surface-secondary p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Agent Kanban</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-content-primary">Sign in with Realmroot</h1>
        <p className="mt-2 text-sm text-content-secondary">Realmroot owns your identity, organization, sessions, and security settings.</p>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {error}
          </p>
        ) : null}
        <Button
          className="mt-6 w-full"
          onClick={() => window.location.assign(`/api/auth/login${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`)}
        >
          Continue to Realmroot
        </Button>
      </section>
    </main>
  );
}
