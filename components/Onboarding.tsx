"use client";

import { useState } from "react";
import { LogoMark } from "@/components/Brand";

const LS_KEY = "keysync-onboarding";

export interface OnboardingAnswers {
  experience: string;
  goal: string;
  firstSong: string;
}

const EXPERIENCES = ["Just starting", "Play a bit", "Advanced"];
const GOALS = ["Learn a specific song", "Practice daily", "Just exploring"];

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "done";
  } catch {
    return true;
  }
}

function markDone(answers: OnboardingAnswers) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ done: true, ...answers }));
  } catch {
    /* ignore */
  }
}

export function getOnboardingAnswers(): OnboardingAnswers | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw || raw === "done") return null;
    const p = JSON.parse(raw);
    return p.done ? p : null;
  } catch {
    return null;
  }
}

export function Onboarding({ onDone }: { onDone: (a: OnboardingAnswers) => void }) {
  const [step, setStep] = useState(0);
  const [experience, setExperience] = useState("");
  const [goal, setGoal] = useState("");
  const [firstSong, setFirstSong] = useState("");

  const finish = () => {
    const answers = { experience, goal, firstSong: firstSong.trim() };
    markDone(answers);
    onDone(answers);
  };

  const canNext = step === 0 ? experience !== "" : step === 1 ? goal !== "" : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm">
      <div className="animate-pop card w-full max-w-md p-6 sm:p-8">
        <div className="flex items-center justify-between">
          <LogoMark size={36} />
          <button
            onClick={finish}
            className="btn-ghost h-11 min-w-[44px] text-sm"
          >
            Skip
          </button>
        </div>

        {/* progress dots */}
        <div className="mt-5 flex gap-2">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= step ? "bg-accent" : "bg-line"
              }`}
            />
          ))}
        </div>

        {step === 0 && (
          <div className="animate-fade mt-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
              How experienced are you?
            </h2>
            <p className="mt-2 text-sm text-ink-dim">
              We will tune the practice tips to your level.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {EXPERIENCES.map((e) => (
                <button
                  key={e}
                  onClick={() => setExperience(e)}
                  className={`h-12 rounded-xl border px-4 text-left text-sm font-medium transition active:scale-[0.99] ${
                    experience === e
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-line-strong text-ink-dim hover:border-accent/60 hover:text-ink"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="animate-fade mt-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
              What brings you here?
            </h2>
            <p className="mt-2 text-sm text-ink-dim">
              One tap — this shapes your home screen tips.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {GOALS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGoal(g)}
                  className={`h-12 rounded-xl border px-4 text-left text-sm font-medium transition active:scale-[0.99] ${
                    goal === g
                      ? "border-accent bg-accent/10 text-ink"
                      : "border-line-strong text-ink-dim hover:border-accent/60 hover:text-ink"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="animate-fade mt-6">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
              What is the first song you want to learn?
            </h2>
            <p className="mt-2 text-sm text-ink-dim">
              Optional — we will remind you on the home screen.
            </p>
            <input
              value={firstSong}
              onChange={(e) => setFirstSong(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && finish()}
              placeholder="e.g. Für Elise"
              maxLength={80}
              className="field mt-5 w-full"
            />
          </div>
        )}

        <div className="mt-6 flex gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="btn-outline h-12 px-5 text-sm"
            >
              Back
            </button>
          )}
          {step < 2 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext}
              className="btn-primary h-12 flex-1 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue
            </button>
          ) : (
            <button onClick={finish} className="btn-primary h-12 flex-1 text-sm">
              Start practicing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
