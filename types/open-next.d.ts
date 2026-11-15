// OpenNext generates JavaScript only at build time. Declare its public fetch
// contract so source checks do not require a stale generated build to exist.
declare module "*/.open-next/worker.js" {
  const handler: ExportedHandler<CloudflareEnv>;
  export default handler;
}
