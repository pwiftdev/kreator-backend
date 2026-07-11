import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

function isPrivateAddress(address: string) {
  if (
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80:")
  )
    return true;
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice(7));
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

async function assertPublicUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP image URLs are allowed");
  if (url.username || url.password)
    throw new Error("Image URLs cannot contain credentials");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("Private network image URLs are not allowed");
  }
  return url;
}

export async function fetchRemoteImage(
  rawUrl: string,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  let url = await assertPublicUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Kreator-Backend/1.0", Accept: "image/*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS)
        throw new Error("Too many image redirects");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok)
      throw new Error(`Failed to fetch image: ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();
    if (!contentType.startsWith("image/"))
      throw new Error("Remote URL did not return an image");
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("Remote image is too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Remote image response was empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Remote image is too large");
      }
      chunks.push(value);
    }
    return {
      buffer: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      mime: contentType,
    };
  }
  throw new Error("Unable to fetch remote image");
}
