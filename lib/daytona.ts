/**
 * Server-side Daytona client for the automatic song pipeline.
 *
 * The API key stays server-side. We talk to the control plane at
 * app.daytona.io for sandbox lifecycle, and to the sandbox itself via the
 * toolbox proxy (proxy.app.daytona.io) for file upload and process execution.
 * No preview URLs: the pipeline runs as a background process and we poll
 * for its output files.
 */

const API = "https://app.daytona.io";
const TOOLBOX = "https://proxy.app.daytona.io/toolbox";
const SNAPSHOT = "keysync-pipeline-v6";

function apiKey(): string {
  const k = process.env.DAYTONA_API_KEY;
  if (!k) {
    throw new Error(
      "DAYTONA_API_KEY is not set. Add it as an environment variable on the server to enable automatic builds."
    );
  }
  return k;
}

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<Record<string, unknown> | null> {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Daytona API ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Call the toolbox API inside a sandbox (file upload, process exec). */
async function toolbox(
  sandboxId: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${TOOLBOX}/${sandboxId}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${apiKey()}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Daytona toolbox ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

export async function createPipelineSandbox(): Promise<string> {  const sb = await api("POST", "/api/sandbox", {
    snapshot: SNAPSHOT,
    name: `keysync-auto-${Date.now().toString(36)}`,
    autoStopInterval: 45,
  });
  if (!sb?.id) throw new Error("Daytona did not return a sandbox id");
  return sb.id as string;
}

/** Poll until the sandbox is started (or fail clearly). */
export async function waitForSandbox(
  id: string,
  onLog?: (line: string) => void
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const sb = await api("GET", `/api/sandbox/${id}`);
    if (sb?.state === "started") return;
    if (sb?.state === "error") {
      throw new Error(
        `Sandbox failed to start: ${sb.errorReason || "unknown error"}`
      );
    }
    if (i === 6)
      onLog?.("Sandbox is still starting, this can take a minute on a cold snapshot");
    await sleep(10000);
  }
  throw new Error("Sandbox took too long to start. Try again in a minute.");
}

/**
 * Wait until the toolbox daemon inside the sandbox answers.
 * Fresh sandboxes need a minute or two before the daemon is ready.
 */
export async function waitForDaemon(
  id: string,
  onLog?: (line: string) => void
): Promise<void> {
  for (let i = 0; i < 24; i++) {
    try {
      const out = await execCommand(id, "echo daemon-ready", 15000);
      if (out.includes("daemon-ready")) return;
    } catch {
      // Not ready yet; retry.
    }
    if (i === 4) onLog?.("Waiting for the sandbox worker to come online");
    await sleep(10000);
  }
  throw new Error("Sandbox worker did not come online in time. Try again.");
}

/** Run a command inside the sandbox via the toolbox process API. */
export async function execCommand(
  sandboxId: string,
  command: string,
  timeoutMs = 60000
): Promise<string> {
  const res = await toolbox(sandboxId, "/process/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, timeout: Math.ceil(timeoutMs / 1000) }),
  });
  const data = await res.json();
  if (data.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${data.exitCode}): ${String(data.result || "").slice(0, 500)}`
    );
  }
  return String(data.result || "");
}

/** Upload a file into the sandbox. Returns the sandbox-side path. */
export async function uploadFile(
  sandboxId: string,
  destPath: string,
  data: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(data)], { type: contentType }),
    filename
  );
  await toolbox(
    sandboxId,
    `/files/upload-v2?path=${encodeURIComponent(destPath)}`,
    { method: "POST", body: form }
  );
  return destPath;
}

/** Read a (small) text file from the sandbox. Returns null if missing. */
export async function readTextFile(
  sandboxId: string,
  path: string
): Promise<string | null> {
  try {
    const res = await toolbox(
      sandboxId,
      `/files/download?path=${encodeURIComponent(path)}`
    );
    return await res.text();
  } catch {
    return null;
  }
}

export async function deleteSandbox(id: string): Promise<void> {
  try {
    await api("DELETE", `/api/sandbox/${id}`);
  } catch {
    // Best effort: the sandbox auto-stops, but only delete removes it.
    // Production should alert if deletes fail repeatedly.
  }
}

export interface SandboxInfo {
  id: string;
  state: string;
  snapshot: string;
  createdAt: string;
}

/** List all sandboxes on the account (the ground truth for running work). */
export async function listSandboxes(): Promise<SandboxInfo[]> {
  const data = await api("GET", "/api/sandbox");
  const items = (data as Record<string, unknown> | null)?.items;
  const arr = Array.isArray(items) ? items : [];
  return arr.map((sb) => {
    const s = sb as Record<string, unknown>;
    return {
      id: String(s.id ?? ""),
      state: String(s.state ?? "unknown"),
      snapshot: String(s.snapshot ?? ""),
      createdAt: String(s.createdAt ?? s.created_at ?? ""),
    };
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
