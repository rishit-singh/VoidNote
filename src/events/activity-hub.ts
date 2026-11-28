import { DurableObject } from "cloudflare:workers";

import { ACTIVITY_LEASE_MS, ACTIVITY_PROTOCOL, ACTIVITY_TICKET_MS } from "../contracts/activity";

const MAX_CONNECTIONS = 12;
const MAX_TICKETS = 24;

/** Ephemeral wakeups only. Product data and cursor catch-up stay in Postgres. */
export class ActivityHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tickets (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
  }

  async issueTicket() {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
    const count = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM tickets")
      .one().count;
    if (count >= MAX_TICKETS) throw new Error("Too many pending activity connections.");
    const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const expiresAt = now + ACTIVITY_TICKET_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO tickets (token, expires_at) VALUES (?, ?)",
      ticket,
      expiresAt,
    );
    await this.#scheduleExpiry(expiresAt);
    return { ticket, expiresAt };
  }

  override async fetch(request: Request) {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    const parts = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim());
    if (
      parts?.length !== 2 ||
      parts[0] !== ACTIVITY_PROTOCOL ||
      !/^[a-f0-9]{64}$/.test(parts[1]!)
    ) {
      return new Response("Invalid subscription.", { status: 400 });
    }
    const rows = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "DELETE FROM tickets WHERE token = ? RETURNING expires_at",
        parts[1]!,
      )
      .toArray();
    if (!rows[0] || rows[0].expires_at <= Date.now()) {
      return new Response("Subscription expired.", { status: 403 });
    }
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Too many activity connections.", { status: 429 });
    }
    const pair = new WebSocketPair();
    const expiresAt = Date.now() + ACTIVITY_LEASE_MS;
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ expiresAt });
    await this.#scheduleExpiry(expiresAt);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: {
        "Sec-WebSocket-Protocol": ACTIVITY_PROTOCOL,
        "Cache-Control": "private, no-store",
      },
    });
  }

  publish() {
    for (const socket of this.ctx.getWebSockets()) {
      const value: unknown = socket.deserializeAttachment();
      if (
        !value ||
        typeof value !== "object" ||
        !("expiresAt" in value) ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt <= Date.now()
      ) {
        socket.close(1000, "Renew subscription.");
        continue;
      }
      try {
        socket.send('{"type":"changed"}');
      } catch {
        socket.close(1011, "Reconnect for saved updates.");
      }
    }
  }

  override webSocketMessage(socket: WebSocket) {
    socket.close(1008, "Activity subscriptions are read-only.");
  }

  override webSocketClose(socket: WebSocket) {
    socket.close(1000);
  }

  override async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now);
    let next: number | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      const value: unknown = socket.deserializeAttachment();
      const expiry =
        value &&
        typeof value === "object" &&
        "expiresAt" in value &&
        typeof value.expiresAt === "number"
          ? value.expiresAt
          : 0;
      if (expiry <= now) socket.close(1000, "Renew subscription.");
      else next = next === undefined ? expiry : Math.min(next, expiry);
    }
    const pending = this.ctx.storage.sql
      .exec<{ expiry: number | null }>("SELECT min(expires_at) AS expiry FROM tickets")
      .one().expiry;
    if (pending !== null) next = next === undefined ? pending : Math.min(next, pending);
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
  }

  async #scheduleExpiry(expiresAt: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt < current) await this.ctx.storage.setAlarm(expiresAt);
  }
}
