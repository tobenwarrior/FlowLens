import type { Address } from "../src/domain/types.ts";

/** Shared boundaries for indexed wallet-history providers. Provider strings stay data. */
export class ProviderError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export type Row = Record<string, unknown>;
export const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export const address = (value: unknown): Address => {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Provider returned a malformed address.",
    );
  return value.toLowerCase() as Address;
};
export const uint = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 80)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Provider returned a malformed integer amount.",
    );
  return BigInt(value).toString();
};
export const integer = (
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > max)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Provider returned a malformed numeric field.",
    );
  return result;
};
export const tokenSymbol = (value: unknown): string =>
  (typeof value === "string"
    ? value
        .replace(
          // eslint-disable-next-line no-control-regex -- Untrusted symbols must not retain control or bidi characters.
          /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
          "",
        )
        .slice(0, 24)
    : "") || "TOKEN";
export async function boundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const oversized = () =>
    new ProviderError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      `Provider response exceeds the ${maxBytes / 1_000_000} MB byte budget; no page was committed.`,
    );
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw oversized();
  }
  if (!response.body)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Provider returned an empty response body; no page was committed.",
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw oversized();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Provider returned malformed JSON; no page was committed.",
    );
  }
}
