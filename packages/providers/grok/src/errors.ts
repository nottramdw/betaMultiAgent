import { ProviderError, type ProviderErrorKind, type ProviderErrorOptions } from "@betamultiagent/core";
import {
  AbortError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  type ModelResponse,
} from "@xai-official/sdk";

export interface ClassifyContext {
  readonly signal: AbortSignal;
  readonly sawEvent: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorOptions(error: unknown): ProviderErrorOptions {
  const status = error instanceof APIError ? error.status : undefined;
  const requestId = error instanceof APIError ? error.requestId : null;
  return {
    cause: error,
    ...(status === undefined ? {} : { status }),
    ...(requestId === null ? {} : { requestId }),
  };
}

function kindOfStatus(status: number | undefined): ProviderErrorKind {
  if (status === 402) {
    return "quota";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status === 400 || status === 413 || status === 422) {
    return "invalid-request";
  }
  if (status !== undefined && status >= 500) {
    return "server";
  }
  return "unknown";
}

function kindOfApiError(error: APIError): ProviderErrorKind {
  if (error instanceof AuthenticationError) {
    return "auth";
  }
  if (error instanceof PermissionDeniedError || error instanceof NotFoundError) {
    return "permission";
  }
  if (error instanceof OverloadedError) {
    return "overloaded";
  }
  if (error instanceof RateLimitError) {
    return "rate-limit";
  }
  return kindOfStatus(error.status);
}

export function classifyGrokError(error: unknown, context: ClassifyContext): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (context.signal.aborted || error instanceof AbortError) {
    return new ProviderError("aborted", "request aborted", { cause: error });
  }
  const message = describe(error);
  if (context.sawEvent) {
    return new ProviderError("stream-interrupted", `stream interrupted: ${message}`, errorOptions(error));
  }
  if (error instanceof TimeoutError || error instanceof APIConnectionError) {
    return new ProviderError("network", message, errorOptions(error));
  }
  if (error instanceof APIError) {
    return new ProviderError(kindOfApiError(error), message, errorOptions(error));
  }
  return new ProviderError("unknown", message, errorOptions(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOfFailureCode(code: string): ProviderErrorKind {
  const normalized = code.toLowerCase();
  if (normalized.includes("rate_limit")) {
    return "rate-limit";
  }
  if (normalized.includes("overloaded")) {
    return "overloaded";
  }
  if (normalized === "server_error" || normalized === "internal_error") {
    return "server";
  }
  return "unknown";
}

export function failedResponseError(response: ModelResponse): ProviderError {
  const detail: unknown = response.error;
  const record = isRecord(detail) ? detail : undefined;
  const rawCode = record?.["code"];
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined;
  const rawMessage = record?.["message"];
  const message = typeof rawMessage === "string" && rawMessage.length > 0 ? rawMessage : "response failed";
  const requestId = response.http.requestId;
  return new ProviderError(code === undefined ? "unknown" : kindOfFailureCode(code), code === undefined ? message : `${code}: ${message}`, {
    ...(requestId === null ? {} : { requestId }),
  });
}
