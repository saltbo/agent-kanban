import { ExternalLink } from "lucide-react";
import { Header } from "../components/Header";
import { Button } from "../components/ui/button";
import { useSession } from "../lib/auth-client";

const realmrootConsole = "https://id.realmroot.dev";

export function AccountSettingsPage() {
  const { data: session } = useSession();
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-8 md:px-8">
        <div className="border-b border-border pb-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-content-tertiary">Identity</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-content-primary">Realmroot account</h1>
          <p className="mt-1 text-sm text-content-secondary">Profile, organization membership, sessions, and security are managed by Realmroot.</p>
        </div>
        <section className="mt-6 rounded-lg bg-surface-secondary p-5">
          <dl className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <dt className="text-xs text-content-tertiary">Name</dt>
              <dd className="mt-1 text-content-primary">{session?.user.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-tertiary">Email</dt>
              <dd className="mt-1 font-mono text-content-primary">{session?.user.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-tertiary">Tenant</dt>
              <dd className="mt-1 font-mono text-content-primary">{session?.user.tenantId}</dd>
            </div>
          </dl>
          <Button className="mt-6" onClick={() => window.open(realmrootConsole, "_blank", "noopener,noreferrer")}>
            Manage in Realmroot <ExternalLink className="size-3.5" />
          </Button>
        </section>
      </main>
    </div>
  );
}
