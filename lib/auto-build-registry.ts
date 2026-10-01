/**
 * Registry of in-flight automatic builds, keyed by buildId.
 * Lets the client cancel a running build: the DELETE handler flips
 * `cancelled` and deletes the sandbox, and the polling loop checks the
 * flag each iteration. Kept in its own module because Next.js route files
 * may only export HTTP method handlers.
 */
export interface ActiveBuild {
  sandboxId: string | null;
  cancelled: boolean;
}

const activeBuilds = new Map<string, ActiveBuild>();

export function registerBuild(buildId: string): ActiveBuild {
  const build: ActiveBuild = { sandboxId: null, cancelled: false };
  activeBuilds.set(buildId, build);
  return build;
}

export function getBuild(buildId: string): ActiveBuild | undefined {
  return activeBuilds.get(buildId);
}

export function unregisterBuild(buildId: string): void {
  activeBuilds.delete(buildId);
}

/** Mark every in-flight build cancelled and clear the registry. */
export function cancelAllActiveBuilds(): string[] {
  const ids: string[] = [];
  activeBuilds.forEach((b, buildId) => {
    b.cancelled = true;
    ids.push(buildId);
  });
  activeBuilds.clear();
  return ids;
}

/** Snapshot of in-flight builds for the status endpoint. */
export function listActiveBuilds(): Array<{
  buildId: string;
  sandboxId: string | null;
}> {
  const out: Array<{ buildId: string; sandboxId: string | null }> = [];
  activeBuilds.forEach((b, buildId) => {
    out.push({ buildId, sandboxId: b.sandboxId });
  });
  return out;
}

export function newBuildId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}
