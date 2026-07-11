import {
  CAP_KINDS,
  isValidName,
  MAX_NAME_LENGTH,
  type CapKind,
  type CreateGroupRequest,
  type IngestRequest,
  type JoinGroupRequest,
  type LoginRequest,
  type MessageUsage,
  type ResetEvent,
  type UsageMarker,
  type UsageSample,
} from "@ccpool/core";
import { MIN_PASSWORD_LENGTH } from "./auth.js";

/**
 * Hand-rolled body guards (the repo's parseUsage style — six small endpoints
 * don't warrant a validation dependency). Each returns the typed body or a
 * human-readable problem string.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isOptStr = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCap = (v: unknown): v is CapKind => isStr(v) && (CAP_KINDS as string[]).includes(v);

function checkPassword(v: unknown, label: string): string | null {
  if (!isStr(v)) return `${label} is required`;
  if (v.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

function checkMemberName(v: unknown): string | null {
  if (isStr(v) && v.length > MAX_NAME_LENGTH) {
    return `memberName must be at most ${MAX_NAME_LENGTH} characters`;
  }
  if (!isStr(v) || !isValidName(v)) {
    return "memberName must be letters, digits, and hyphens (and not 'unknown')";
  }
  return null;
}

export function parseCreateGroup(body: unknown): Result<CreateGroupRequest> {
  if (!isRecord(body)) return bad("expected a JSON object");
  if (!isStr(body.accountId) || body.accountId.length === 0) return bad("accountId is required");
  const pw = checkPassword(body.groupPassword, "groupPassword");
  if (pw) return bad(pw);
  const name = checkMemberName(body.memberName);
  if (name) return bad(name);
  const mpw = checkPassword(body.memberPassword, "memberPassword");
  if (mpw) return bad(mpw);
  return {
    ok: true,
    value: {
      accountId: body.accountId,
      groupPassword: body.groupPassword as string,
      memberName: body.memberName as string,
      memberPassword: body.memberPassword as string,
    },
  };
}

export function parseJoinGroup(body: unknown): Result<JoinGroupRequest> {
  return parseCreateGroup(body); // identical shape
}

export function parseLogin(body: unknown): Result<LoginRequest> {
  if (!isRecord(body)) return bad("expected a JSON object");
  if (!isStr(body.accountId) || body.accountId.length === 0) return bad("accountId is required");
  const name = checkMemberName(body.memberName);
  if (name) return bad(name);
  const mpw = checkPassword(body.memberPassword, "memberPassword");
  if (mpw) return bad(mpw);
  return {
    ok: true,
    value: {
      accountId: body.accountId,
      memberName: body.memberName as string,
      memberPassword: body.memberPassword as string,
    },
  };
}

function parseSample(v: unknown): UsageSample | null {
  if (!isRecord(v) || !isCap(v.cap) || !isNum(v.pct)) return null;
  if (!isOptStr(v.resetsAt ?? null) || !isStr(v.capturedAt)) return null;
  return {
    cap: v.cap,
    pct: v.pct,
    resetsAt: (v.resetsAt as string | null) ?? null,
    capturedAt: v.capturedAt,
  };
}

function parseReset(v: unknown): ResetEvent | null {
  if (!isRecord(v) || !isCap(v.cap) || !isStr(v.at) || !isNum(v.previousPct)) return null;
  return { cap: v.cap, at: v.at, previousPct: v.previousPct };
}

function parseMessage(v: unknown): MessageUsage | null {
  if (!isRecord(v) || !isStr(v.uuid) || !isStr(v.timestamp)) return null;
  if (!isOptStr(v.model ?? null)) return null;
  if (
    !isNum(v.inputTokens) ||
    !isNum(v.outputTokens) ||
    !isNum(v.cacheCreationTokens) ||
    !isNum(v.cacheReadTokens)
  ) {
    return null;
  }
  return {
    uuid: v.uuid,
    user: isStr(v.user) ? v.user : "", // overwritten with the authed member anyway
    timestamp: v.timestamp,
    model: (v.model as string | null) ?? null,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cacheCreationTokens: v.cacheCreationTokens,
    cacheReadTokens: v.cacheReadTokens,
  };
}

function parseMarker(v: unknown): UsageMarker | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.at) || !isNum(v.weight)) return null;
  if (!isOptStr(v.model ?? null)) return null;
  return {
    id: v.id,
    user: isStr(v.user) ? v.user : "", // overwritten with the authed member anyway
    at: v.at,
    model: (v.model as string | null) ?? null,
    weight: v.weight,
  };
}

function parseArray<T>(v: unknown, parse: (x: unknown) => T | null, label: string): Result<T[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return bad(`${label} must be an array`);
  const out: T[] = [];
  for (const item of v) {
    const parsed = parse(item);
    if (parsed === null) return bad(`${label} contains an invalid row`);
    out.push(parsed);
  }
  return { ok: true, value: out };
}

export function parseIngest(body: unknown): Result<IngestRequest> {
  if (!isRecord(body)) return bad("expected a JSON object");
  if (!isStr(body.at)) return bad("at (ISO timestamp) is required");
  if (body.accountId !== null && !isStr(body.accountId)) {
    return bad("accountId must be a string or null");
  }
  const samples = parseArray(body.samples, parseSample, "samples");
  if (!samples.ok) return samples;
  const resets = parseArray(body.resets, parseReset, "resets");
  if (!resets.ok) return resets;
  const messages = parseArray(body.messages, parseMessage, "messages");
  if (!messages.ok) return messages;
  const markers = parseArray(body.markers, parseMarker, "markers");
  if (!markers.ok) return markers;
  return {
    ok: true,
    value: {
      at: body.at,
      accountId: (body.accountId as string | null) ?? null,
      samples: samples.value,
      resets: resets.value,
      messages: messages.value,
      markers: markers.value,
    },
  };
}
