"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { UserMenu } from "@/components/Auth";
import { LogoMark, Wordmark } from "@/components/Brand";

const STEPS = [
  {
    n: "1",
    title: "Drop in a tutorial",
    body: "Paste a YouTube piano tutorial link or upload an audio file. KeySync transcribes every note it hears.",
  },
  {
    n: "2",
    title: "Get falling notes",
    body: "Your song becomes a Synthesia-style falling-note track with note labels, a strike line, and a real piano sound.",
  },
  {
    n: "3",
    title: "Practice with your piano",
    body: "Mic wait-mode pauses the music until you play the right notes. Slow it to 0.25x, loop hard parts, track your streak.",
  },
];

const FEATURES = [
  {
    title: "Mic wait-mode",
    body: "The track waits for you to play the correct note before moving on. No rushing, no getting lost.",
  },
  {
    title: "Tempo control",
    body: "Practice at 0.25x speed and work your way up. A/B loop the bars that trip you up.",
  },
  {
    title: "Post-run reports",
    body: "Every run ends with note accuracy, mistake count, and a per-song mastery score.",
  },
  {
    title: "Cloud library",
    body: "Your songs sync to your account. Pick up practice on any device.",
  },
  {
    title: "Real piano sound",
    body: "Self-hosted grand piano samples. No buzzy synth fallback.",
  },
  {
    title: "Practice streaks",
    body: "A daily streak with a one-day grace period keeps you coming back.",
  },
];

export default function Landing() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace("/app");
  }, [loading, user, router]);

  return (
    <main className="bg-bg text-ink">
      {/* Top bar */}
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="inline-flex items-center gap-2.5">
          <LogoMark size={28} />
          <Wordmark className="text-lg" />
        </span>
        <div className="flex items-center gap-3">
          {!loading &&
            (user ? (
              <UserMenu email={user.email || ""} onSignOut={signOut} />
            ) : (
              <Link href="/app" className="btn-outline h-11 px-5 text-sm">
                Sign in
              </Link>
            ))}
        </div>
      </div>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-4 pb-16 pt-10 text-center sm:px-6 sm:pt-16">
        <LogoMark size={72} className="animate-pop mx-auto mb-6" />
        <h1 className="mx-auto max-w-2xl text-balance font-display text-4xl font-bold tracking-tight sm:text-5xl">
          Learn any piano song from a <span className="text-accent">YouTube tutorial</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-balance text-base text-ink-dim sm:text-lg">
          KeySync listens to the tutorial, transcribes every note, and turns it
          into falling notes you can practice with your real piano.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/app" className="btn-primary h-12 px-8 text-base">
            Get started free
          </Link>
          <span className="text-sm text-ink-faint">
            Sign in to build your first song
          </span>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <h2 className="label-eyebrow mb-8 text-center">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="card animate-fade-up p-6">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-lg font-bold text-accent ring-1 ring-accent/40">
                {s.n}
              </div>
              <h3 className="text-base font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <h2 className="label-eyebrow mb-8 text-center">Made for practice</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <h3 className="text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6">
        <h2 className="mx-auto max-w-xl text-balance font-display text-3xl font-bold tracking-tight">
          Your next song is one tutorial away
        </h2>
        <p className="mx-auto mt-4 max-w-md text-balance text-sm text-ink-dim">
          Sign in, paste a link, and start practicing in minutes.
        </p>
        <Link href="/app" className="btn-primary mt-8 h-12 px-8 text-base">
          Start practicing
        </Link>
      </section>

      <footer className="border-t border-line py-6 text-center text-sm text-ink-faint">
        KeySync — learn piano from YouTube tutorials.
      </footer>
    </main>
  );
}
