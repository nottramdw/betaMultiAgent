import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { ProviderError, type ProviderErrorKind, type ProviderErrorOptions } from "@betamultiagent/core";

export interface ClassifyContext {
  readonly signal: AbortSignal;
  readonly sawEvent: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function errorOptions(error: unknown): ProviderErrorOptions {
  const status = isApiError(error) ? error.status : undefined;
  const requestId = isApiError(error) ? error.requestID : undefined;
  return {
    cause: error,
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined || requestId === null ? {} : { requestId }),
  };
}

const KIND_BY_TYPE: Readonly<Record<string, ProviderErrorKind>> = {
  overloaded_error: "overloaded",
  rate_limit_error: "rate-limit",
  api_error: "server",
  authentication_error: "auth",
  permission_error: "permission",
  not_found_error: "permission",
  invalid_request_error: "invalid-request",
  request_too_large: "invalid-request",
};

function kindOfApiError(error: APIError): ProviderErrorKind {
  const status = error.status;
  const type: string | null = error.type;
  const text = (error.apiMessage ?? error.message).toLowerCase();
  if (status === 401) {
    return "auth";
  }
  if (status === 403 || status === 404) {
    return "permission";
  }
  if (status === 402) {
    return "quota";
  }
  if (status === 429) {
    return error.errorCode === "enforced_spend_limit_reached" ? "quota" : "rate-limit";
  }
  if (status === 400 && text.includes("prompt is too long")) {
    return "context-exceeded";
  }
  if (status === 400 || status === 413 || status === 422) {
    return "invalid-request";
  }
  if (status === 529 || type === "overloaded_error") {
    return "overloaded";
  }
  if (status !== undefined && status >= 500) {
    return "server";
  }
  return (type === null ? undefined : KIND_BY_TYPE[type]) ?? "unknown";
}

export function classifyClaudeError(error: unknown, context: ClassifyContext): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (context.signal.aborted || error instanceof APIUserAbortError) {
    return new ProviderError("aborted", "request aborted", { cause: error });
  }
  const message = describe(error);
  if (context.sawEvent) {
    return new ProviderError("stream-interrupted", `stream interrupted: ${message}`, errorOptions(error));
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("network", message, errorOptions(error));
  }
  if (isApiError(error)) {
    return new ProviderError(kindOfApiError(error), message, errorOptions(error));
  }
  return new ProviderError("unknown", message, errorOptions(error));
}
