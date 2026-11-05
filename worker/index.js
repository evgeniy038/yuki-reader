// A room only introduces two browsers. Neither pairing secrets nor library
// data reach this service; SDP and ICE are encrypted by the browsers.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ service: "yuki-pairing", version: 1 });
    const origin = request.headers.get("Origin");
    if (!env.ALLOWED_ORIGINS.split(",").includes(origin)) return new Response("Forbidden", { status: 403 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const match = /^\/v1\/rooms\/([a-f0-9]{64})$/.exec(url.pathname);
    if (!match || !["0", "1"].includes(url.searchParams.get("side"))) return new Response("Invalid room", { status: 400 });
    const { success } = await env.CONNECTIONS.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
    if (!success) return new Response("Try again later", { status: 429 });
    return env.ROOMS.getByName(match[1]).fetch(request);
  },
};

export class PairingRoom {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const side = url.searchParams.get("side");
    const temporary = url.searchParams.get("temporary") === "1";
    let expires = await this.ctx.storage.get("expires");
    if (temporary && expires && expires < Date.now()) return new Response("Expired", { status: 410 });
    if (!expires || !temporary) {
      expires = Date.now() + (temporary ? 5 * 60_000 : 24 * 60 * 60_000);
      await this.ctx.storage.put("expires", expires);
      await this.ctx.storage.setAlarm(expires);
    }
    // A reconnect replaces only its own side. A third participant never
    // receives a broadcast, and the opposite endpoint has to reauthenticate.
    for (const old of this.ctx.getWebSockets(side)) old.close(4001, "Reconnected");
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ side, start: Date.now(), count: 0 });
    this.ctx.acceptWebSocket(server, [side]);
    const peers = this.ctx.getWebSockets(side === "0" ? "1" : "0");
    if (peers.length) {
      server.send(JSON.stringify({ type: "ready" }));
      for (const peer of peers) if (peer.readyState === 1) peer.send(JSON.stringify({ type: "ready" }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const info = ws.deserializeAttachment();
    if (!info || typeof message !== "string" || message.length > 32_768) {
      ws.close(1009, "Invalid signaling message");
      return;
    }
    if (Date.now() - info.start > 60_000) { info.start = Date.now(); info.count = 0; }
    info.count++;
    ws.serializeAttachment(info);
    if (info.count > 200) { ws.close(1008, "Too many messages"); return; }
    for (const peer of this.ctx.getWebSockets(info.side === "0" ? "1" : "0")) {
      if (peer.readyState === 1) peer.send(message);
    }
  }

  webSocketClose(ws, code) {
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code);
  }

  webSocketError(ws) { ws.close(1011, "Connection error"); }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "Room expired");
    await this.ctx.storage.deleteAll();
  }
}
