import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const MAX_STATEMENT_CHARS = 600;
export const MAX_EVIDENCE_CHARS = 800;
export const MAX_SOURCE_TEXT_CHARS = 8_000;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function normalizeStatement(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("en-US")
    .replace(/[.!?]+$/gu, "");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 32)).trimEnd()} …[truncated]`;
}

export function boundedText(value: unknown, maxChars: number): string {
  return truncateText(normalizeWhitespace(typeof value === "string" ? value : ""), maxChars);
}

export function clampScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, 0, 1);
}

export function recencyScore(createdAt: number, now: number): number {
  const ageMs = Math.max(0, now - createdAt);
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
  return Math.exp(-Math.log(2) * ageMs / halfLifeMs);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clamp(dot / Math.sqrt(leftNorm * rightNorm), -1, 1);
}

export function vectorToBlob(vector: readonly number[]): Uint8Array {
  const values = Float32Array.from(vector);
  return new Uint8Array(values.buffer.slice(0));
}

export function blobToVector(value: unknown): number[] {
  if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) return [];
  const bytes = value as Uint8Array;
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return [];
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(
    new Float32Array(copy.buffer, 0, copy.byteLength / Float32Array.BYTES_PER_ELEMENT),
  );
}

export function buildFtsQuery(query: string): string {
  const terms = query
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12);

  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

export function stableId(...parts: readonly string[]): string {
  return sha256(parts.join("\u001f"));
}
