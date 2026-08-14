import { MAX_SOURCE_TEXT_CHARS, boundedText, normalizeWhitespace } from "./text.ts";
import type { ExtractorInput, TurnSnapshot } from "./types.ts";

export type RedactionKind =
  | "bearer-token"
  | "jwt"
  | "pem-private-key"
  | "credential-assignment"
  | "credential-path"
  | "high-entropy-token"
  | "injection";

export interface RedactionFinding {
  kind: RedactionKind;
  start: number;
  end: number;
}

export interface SanitizedText {
  text: string;
  findings: readonly RedactionFinding[];
  injectionDetected: boolean;
}

const REDACTED = "[REDACTED]";

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/iu,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/iu,
  /system\s+(?:message|prompt)\s*:/iu,
  /reveal\s+(?:the\s+)?(?:system\s+)?prompt/iu,
  /exfiltrat(?:e|ion)|send\s+secrets?/iu,
  /do\s+not\s+(?:tell|show)\s+(?:the\s+)?user/iu,
  /assistant\s*:\s*(?:you|must|should)/iu,
];

const SECRET_PATTERNS: readonly { kind: RedactionKind; pattern: RegExp }[] = [
  {
    kind: "pem-private-key",
    pattern: /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?-----END[^\n]*PRIVATE KEY-----/giu,
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\b/gu,
  },
  {
    kind: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|cookie|session[_-]?token|token)\b\s*[:=]\s*["']?[^\s"',;]{8,}["']?/giu,
  },
  {
    kind: "credential-path",
    pattern: /(?<![A-Za-z0-9_])(?:\.env(?:\.[A-Za-z0-9_.-]+)?|credentials(?:\.[A-Za-z0-9_.-]+)?|id_rsa|\.aws\/credentials)(?![A-Za-z0-9_])/giu,
  },
  {
    kind: "high-entropy-token",
    pattern: /\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}\b/gu,
  },
];

function mergeFindings(findings: RedactionFinding[]): RedactionFinding[] {
  const sorted = [...findings].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: RedactionFinding[] = [];
  for (const finding of sorted) {
    const previous = merged.at(-1);
    if (previous && finding.start <= previous.end) {
      previous.end = Math.max(previous.end, finding.end);
      continue;
    }
    merged.push({ ...finding });
  }
  return merged;
}

export function scanPromptInjection(value: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactText(value: string, maxChars = MAX_SOURCE_TEXT_CHARS): SanitizedText {
  const bounded = boundedText(value, maxChars);
  const findings: RedactionFinding[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of bounded.matchAll(pattern)) {
      if (match.index === undefined) continue;
      findings.push({ kind, start: match.index, end: match.index + match[0].length });
    }
  }

  const merged = mergeFindings(findings);
  let text = "";
  let cursor = 0;
  for (const finding of merged) {
    text += bounded.slice(cursor, finding.start);
    text += REDACTED;
    cursor = finding.end;
  }
  text += bounded.slice(cursor);

  const injectionDetected = scanPromptInjection(bounded);
  return {
    text: normalizeWhitespace(text),
    findings: [
      ...merged,
      ...(injectionDetected
        ? [{ kind: "injection" as const, start: 0, end: bounded.length }]
        : []),
    ],
    injectionDetected,
  };
}

export function sanitizeToolNames(toolNames: readonly string[]): string[] {
  return toolNames
    .map((toolName) => toolName.replace(/[^A-Za-z0-9_.:-]/gu, "").slice(0, 80))
    .filter(Boolean)
    .slice(0, 32);
}

export function buildSanitizedExtractorInput(snapshot: TurnSnapshot): ExtractorInput {
  const user = redactText(snapshot.userText, 4_000);
  const assistant = redactText(snapshot.assistantText, 4_000);
  const recent = snapshot.recentDigest ? redactText(snapshot.recentDigest, 3_000) : undefined;

  return {
    projectKey: snapshot.projectKey.slice(0, 1_000),
    sessionId: snapshot.sessionId.slice(0, 200),
    userText: user.text,
    assistantText: assistant.text,
    toolNames: sanitizeToolNames(snapshot.toolNames),
    recentDigest: recent?.text,
  };
}

export function buildSanitizedSourcePayload(snapshot: TurnSnapshot): {
  payload: string;
  findings: readonly RedactionFinding[];
} {
  const input = buildSanitizedExtractorInput(snapshot);
  const serialized = JSON.stringify({
    projectKey: input.projectKey,
    sessionId: input.sessionId,
    branchId: snapshot.branchId.slice(0, 200),
    sourceEntryIds: snapshot.sourceEntryIds.slice(0, 64),
    turnIndex: snapshot.turnIndex,
    userText: input.userText,
    assistantText: input.assistantText,
    toolNames: input.toolNames,
    recentDigest: input.recentDigest,
    capturedAt: snapshot.capturedAt,
  });
  const final = redactText(serialized, 12_000);
  return { payload: final.text, findings: final.findings };
}

export function isSafeMemoryText(value: string): boolean {
  if (scanPromptInjection(value)) return false;
  return !SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
