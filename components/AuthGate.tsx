"use client";

import type { ReactNode } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AuthPanel } from "@/components/Auth";
import { LogoMark, Wordmark } from "@/components/Brand";

/** Branded full-screen shell used while the auth state is being resolved. */
function GateShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="animate-fade-up w-full max-w-md text-center">{children}</div>
    </main>
  );
}

function GateLoading() {
  return (
    <GateShell>
      <LogoMark size={48} className="animate-pulse mx-auto mb-4" />
      <p className="text-sm text-ink-dim">Loading KeySync…</p>
    </GateShell>
  );
}

/**
 * Full-screen sign-in gate. Rendered instead of any app content when there
 * is no session. No guest mode, no bypass.
 */
export function SignInGate() {
  return (
    <GateShell>
      <LogoMark size={56} className="animate-pop mx-auto mb-5" />
      <Wordmark className="text-2xl" />
      <p className="mt-3 text-balance text-sm text-ink-dim">
        Sign in to turn YouTube piano tutorials into falling-note practice
        tracks.
      </p>
      <div className="mt-8 text-left">
        <AuthPanel onAuth={() => {}} />
      </div>
    </GateShell>
  );
}

/**
 * Wrap any protected page: shows a branded loading state, then the sign-in
 * gate when signed out, otherwise the page content.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <GateLoading />;
  if (!user) return <SignInGate />;
  return <>{children}</>;
}
