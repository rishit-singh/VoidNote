import { createWorkerPublicSourceTransport } from "../../src/ai/research/worker-transport";
import { ResearchSourceError } from "../../src/ai/research/source-errors";

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
      if (new URL(request.url).pathname === "/oversized-limit") {
        await createWorkerPublicSourceTransport().request(
          new URL("https://simonwillison.net/about/"),
          ["8.8.8.8"],
          512_001,
          AbortSignal.timeout(1000),
        );
        return Response.json({ unexpected: "oversized limit permitted" });
      }
      const addresses = await createWorkerPublicSourceTransport().resolve(
        "simonwillison.net",
        AbortSignal.timeout(1000),
      );
      return Response.json({ addresses });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof ResearchSourceError ? error.code : "internal_error",
        },
        { status: 502 },
      );
    }
  },
};

export default fixture;
