import { createHmac, timingSafeEqual } from "node:crypto";

const maxLifetime = 24 * 60 * 60;
export function signedRecordingURL(
  origin: string,
  path: string,
  secret: string,
  lifetimeSeconds: number,
) {
  if (secret.length < 32) throw new Error("Configure a strong RECORDING_CAPABILITY_SECRET.");
  if (lifetimeSeconds <= 0 || lifetimeSeconds > maxLifetime)
    throw new Error("Invalid capability lifetime.");
  const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds;
  const url = new URL(path, origin);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set(
    "signature",
    createHmac("sha256", secret).update(`${path}\n${expires}`).digest("hex"),
  );
  return url.href;
}
export function verifyRecordingURL(url: URL, secret: string) {
  if (secret.length < 32) return false;
  const expires = Number(url.searchParams.get("expires"));
  const now = Math.floor(Date.now() / 1000);
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + maxLifetime ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret).update(`${url.pathname}\n${expires}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
