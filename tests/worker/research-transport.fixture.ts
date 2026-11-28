import { createWorkerPublicSourceTransport } from "../../src/ai/research/worker-transport";

const fixture = {
  async fetch(request: Request) {
    try {
      if (new URL(request.url).pathname === "/pinned-request") {
        await createWorkerPublicSourceTransport().request(
          new URL("https://simonwillison.net/about/"),
          ["127.0.0.1"],
          48_000,
          AbortSignal.timeout(1000),
        );
        return Response.json({ unexpected: "retrieval permitted" });
      }
      const addresses = await createWorkerPublicSourceTransport().resolve(
        "simonwillison.net",
        AbortSignal.timeout(1000),
      );
      return Response.json({ addresses });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "unknown",
        },
        { status: 502 },
      );
    }
  },
};

export default fixture;
