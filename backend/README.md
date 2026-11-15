# Historical Python experiment

This directory preserves the old standalone Replicate/FastAPI experiment from
main's Vite-era history. It is not used by the Next application, CI, or the
production Cloudflare Worker.

Current recording processing uses the authorized Worker routes and durable
workflow described in `../docs/2026-11-14-recording-ux-reset.md`. This prototype
has no authentication or bounded-upload/recovery contract and is not a supported
production service. Its dependencies and run script are historical development
material.
