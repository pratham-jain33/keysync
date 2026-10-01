import type { BuildEvent } from "@/lib/build-song";

/**
 * Wrap an async producer in a Server-Sent Events response. The producer gets
 * an `emit` it can call as work happens; each event is flushed to the client
 * immediately as `data: <json>\n\n`. Errors (including thrown ones) arrive as
 * a final `{ type: "error" }` event so the client always learns the outcome.
 */
export function sseResponse(
  run: (emit: (ev: BuildEvent) => void) => Promise<void>
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (ev: BuildEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };
      try {
        await run(emit);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Build failed";
        const status =
          e instanceof Error && e.name === "NoNotesError" ? 422 : 500;
        emit({ type: "error", message, status });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (Render/nginx) so events arrive in real time.
      "X-Accel-Buffering": "no",
    },
  });
}
