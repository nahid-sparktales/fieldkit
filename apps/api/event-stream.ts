import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../../packages/platform/src/config.js";

type Event = { id: string | number; kind: string; data: unknown };

// One limiter per application process. Polls never overlap or outrun the socket.
export class EventStreams {
  private clients = new Map<string, number>();
  private total = 0;
  constructor(
    private limits = {
      perActor: 8,
      total: 128,
      pollMs: 1000,
      lifetimeMs: 300000,
    },
  ) {}

  async open(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    actor: string,
    source: {
      authorize: () => Promise<void>;
      latest: () => Promise<string | number>;
      read: (
        after: number,
      ) => Promise<Event[] | { events: Event[]; cursor: number }>;
    },
  ) {
    const cursor =
      url.searchParams.get("after") ?? req.headers["last-event-id"];
    let after =
      cursor === undefined || cursor === null ? undefined : Number(cursor);
    if (
      after !== undefined &&
      (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(after))
    )
      throw new HttpError(400, "Invalid event cursor");
    const count = this.clients.get(actor) ?? 0;
    if (this.total >= this.limits.total || count >= this.limits.perActor) {
      res.setHeader("Retry-After", "5");
      throw new HttpError(
        429,
        "Too many event streams; close an unused tab and retry",
      );
    }
    this.total++;
    this.clients.set(actor, count + 1);
    let closed = false,
      busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(expiry);
      this.total--;
      const remaining = (this.clients.get(actor) ?? 1) - 1;
      if (remaining) this.clients.set(actor, remaining);
      else this.clients.delete(actor);
    };
    res.once("close", release);
    try {
      await source.authorize();
      const fresh = after === undefined;
      after ??= Number(await source.latest());
      if (res.destroyed || closed) {
        release();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Refresh once after subscribing to close the snapshot/subscription race.
      res.write(
        fresh
          ? `id: ${after}\ndata: {"kind":"stream.connected","data":{}}\n\n`
          : ": connected\n\n",
      );
      timer = setInterval(async () => {
        if (closed || busy || res.writableNeedDrain) return;
        busy = true;
        try {
          await source.authorize();
          const batch = await source.read(after!);
          const events = Array.isArray(batch) ? batch : batch.events;
          if (closed) return;
          for (const event of events) {
            after = Number(event.id);
            if (
              !res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
            )
              break;
          }
          if (!res.writableNeedDrain && !Array.isArray(batch)) {
            after = batch.cursor;
            res.write(`id: ${after}\n: heartbeat\n\n`);
          } else if (!events.length) res.write(": heartbeat\n\n");
        } catch {
          release();
          res.end();
        } finally {
          busy = false;
        }
      }, this.limits.pollMs);
      expiry = setTimeout(() => {
        release();
        if (res.writableNeedDrain) res.destroy();
        else res.end();
      }, this.limits.lifetimeMs);
    } catch (error) {
      release();
      throw error;
    }
  }
}
