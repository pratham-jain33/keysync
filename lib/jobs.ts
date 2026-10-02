"use client";

import { supabase } from "./supabase";
import type { Section, SongData } from "./types";

export type JobStatus = "queued" | "processing" | "done" | "failed";

export interface BuildJob {
  id: string;
  kind: "youtube" | "audio";
  title: string;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** Present on GET /api/jobs/[id] once the build is done. */
  song_data?: SongData | null;
}

async function authedFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in required.");
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (res.status === 401) throw new Error("Sign in required.");
  return res;
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(
    body && typeof body.error === "string" ? body.error : fallback
  );
}

/** Start a background build from a YouTube tutorial link. Returns the job id. */
export async function createYoutubeJob(
  youtubeUrl: string,
  title: string,
  sections: Section[]
): Promise<string> {
  const res = await authedFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "youtube", youtubeUrl, title, sections }),
  });
  if (!res.ok) throw await readError(res, "Could not start the build.");
  const body = (await res.json()) as { jobId?: string };
  if (!body.jobId) throw new Error("Could not start the build.");
  return body.jobId;
}

/** Start a background build from an uploaded audio file. Returns the job id. */
export async function createAudioJob(
  file: File,
  title: string,
  sections: Section[]
): Promise<string> {
  const form = new FormData();
  form.append("audio", file);
  form.append("title", title);
  form.append("sections", JSON.stringify(sections));
  const res = await authedFetch("/api/jobs", { method: "POST", body: form });
  if (!res.ok) throw await readError(res, "Could not start the build.");
  const body = (await res.json()) as { jobId?: string };
  if (!body.jobId) throw new Error("Could not start the build.");
  return body.jobId;
}

/** Newest-first list of the signed-in user's build jobs. */
export async function listJobs(): Promise<BuildJob[]> {
  const res = await authedFetch("/api/jobs");
  if (!res.ok) throw await readError(res, "Could not load builds.");
  const body = (await res.json()) as { jobs?: BuildJob[] };
  return body.jobs ?? [];
}

/** Full job detail, including song_data once done. */
export async function getJob(id: string): Promise<BuildJob> {
  const res = await authedFetch(`/api/jobs/${id}`);
  if (!res.ok) throw await readError(res, "Could not load build.");
  return (await res.json()) as BuildJob;
}
