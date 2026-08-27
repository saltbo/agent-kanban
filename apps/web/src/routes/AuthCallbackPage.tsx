import { useEffect, useState } from "react";
import { completeSignIn } from "../lib/auth-client";

export function AuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void completeSignIn()
      .then((returnTo) => window.location.replace(returnTo))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Realmroot sign-in failed."));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-primary px-6">
      <p role={error ? "alert" : undefined} className={error ? "text-sm text-error" : "text-sm text-content-secondary"}>
        {error ?? "Completing Realmroot sign-in…"}
      </p>
    </main>
  );
}
