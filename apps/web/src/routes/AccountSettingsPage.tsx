import { CheckCircle2, CircleAlert } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { authClient, useSession } from "../lib/auth-client";
import { cn } from "../lib/utils";
import { AccountPage } from "./AccountPage";
import { SchedulingSettingsPage } from "./SchedulingSettingsPage";

type SettingsUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  emailVerified?: boolean;
};

const settingsLinks = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/account", label: "Account" },
  { to: "/settings/scheduling", label: "Scheduling" },
];

function ProfileSettingsPage() {
  const { data: session, refetch } = useSession();
  const user = session?.user as SettingsUser | undefined;
  const [name, setName] = useState(user?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  const trimmedName = name.trim();
  const isDirty = trimmedName !== (user?.name ?? "");
  const canSave = isDirty && trimmedName.length > 0 && !isSaving;
  const fallback = profileInitial(trimmedName || user?.email || "?");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;

    setError(null);
    setIsSaving(true);
    const { error } = await authClient.updateUser({
      name: trimmedName,
    });
    setIsSaving(false);

    if (error) {
      setError(error.message || "Failed to save profile");
      toast.error("Failed to save profile");
      return;
    }

    await refetch();
    toast.success("Profile saved");
  }

  return (
    <main className="min-w-0 flex-1 space-y-6">
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-content-primary">Profile</h1>
        <p className="mt-1 text-sm text-content-secondary">Manage the identity shown across Agent Kanban.</p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <section className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[96px_1fr]">
            <div>
              <Label className="mb-2 text-xs uppercase tracking-[0.06em] text-content-tertiary">Preview</Label>
              <Avatar size="lg" className="size-14">
                {user?.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback className="text-base font-semibold">{fallback}</AvatarFallback>
              </Avatar>
            </div>

            <div className="space-y-4">
              <Field label="Display name" htmlFor="profile-name">
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={trimmedName.length === 0}
                  autoComplete="name"
                />
                {trimmedName.length === 0 && <p className="text-xs text-error">Display name is required.</p>}
              </Field>
            </div>
          </div>
        </section>

        <section className="grid gap-4 border-t border-border pt-5 md:grid-cols-2">
          <Field label="Email" htmlFor="profile-email">
            <Input id="profile-email" value={user?.email ?? ""} readOnly className="text-content-secondary" />
          </Field>

          <div>
            <Label className="mb-2 text-xs uppercase tracking-[0.06em] text-content-tertiary">Email verification</Label>
            <EmailVerificationBadge verified={user?.emailVerified === true} />
          </div>
        </section>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={!canSave}>
            {isSaving ? "Saving..." : "Save profile"}
          </Button>
          {!isDirty && <p className="text-xs text-content-tertiary">No unsaved changes</p>}
        </div>
      </form>
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-xs uppercase tracking-[0.06em] text-content-tertiary">
        {label}
      </Label>
      {children}
    </div>
  );
}

function EmailVerificationBadge({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
        <CheckCircle2 className="size-3" />
        Verified
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
      <CircleAlert className="size-3" />
      Unverified
    </Badge>
  );
}

function profileInitial(value: string) {
  return value.trim().charAt(0).toUpperCase() || "?";
}

export function AccountSettingsPage() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8 md:flex-row md:px-8">
        <aside className="w-full shrink-0 md:w-48">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-content-tertiary">Settings</h2>
          <nav aria-label="Settings" className="space-y-1">
            {settingsLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive ? "bg-accent-soft text-accent" : "text-content-secondary hover:bg-surface-secondary hover:text-content-primary",
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <Routes>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<ProfileSettingsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="scheduling" element={<SchedulingSettingsPage />} />
          <Route path="*" element={<Navigate to="profile" replace />} />
        </Routes>
      </div>
    </div>
  );
}
