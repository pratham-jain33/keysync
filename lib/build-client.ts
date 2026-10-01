import type { BuildEvent, BuildPhase } from "@/lib/build-song";

export type { BuildEvent, BuildPhase };

export interface StreamCallbacks {
  onLog?: (line: string) => void;
  onProgress?: (pct: number, phase: BuildPhase | undefined, detail?: string) => void;
  /** Fired once the backend identifies the in-flight build (for cancellation). */
  onBuildId?: (buildId: string) => void;
}

/**
 * POST to a streaming build endpoint and consume its Server-Sent Events,
 * dispatching progress/log events through the callbacks as they arrive.
 * Resolves with the finished song once the `done` event lands; rejects with
 * the backend's message on an `error` event. The returned error carries the
 * http-like status (422 = no notes) on `.status` when the backend sent one.
 *
 * Pass an AbortSignal via `init.signal` to cancel mid-build: the fetch is
 * aborted and the reader loop exits. The caller is responsible for telling
 * the backend to clean up (e.g. DELETE /api/auto-build?buildId=…).
 */
export async function runStreamingBuild<T>(
  input: RequestInfo,
  init: RequestInit,
  cb: StreamCallbacks
): Promise<T> {
  const res = await fetch(input, init);

  // A validation failure comes back as a normal JSON error, not a stream.
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream")) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Build failed (HTTP ${res.status})`);
    throw err;
  }
  if (!res.body) throw new Error("No response stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: T | undefined;
  let done = false;

  const handle = (ev: BuildEvent) => {
    if (ev.buildId) cb.onBuildId?.(ev.buildId);
    switch (ev.type) {
      case "log":
        if (ev.line) cb.onLog?.(ev.line);
        break;
      case "progress":
        cb.onProgress?.(ev.pct ?? 0, ev.phase, ev.detail);
        break;
      case "done":
        result = ev.song as unknown as T;
        done = true;
        break;
      case "error": {
        const err = new Error(ev.message || "Build failed") as Error & {
          status?: number;
        };
        if (ev.status) err.status = ev.status;
        throw err;
      }
    }
  };

  // SSE frames are separated by a blank line; each frame has `data:` lines.
  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!dataLine) continue;
        handle(JSON.parse(dataLine) as BuildEvent);
      }
      if (streamDone) break;
    }
  } catch (e) {
    // Aborted by the caller (cancel button): surface a clean cancellation.
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Build cancelled.");
    }
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (!done || result === undefined) {
    throw new Error("Build ended without a result");
  }
  return result;
}
