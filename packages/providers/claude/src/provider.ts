import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { ProviderError, type Provider, type ProviderEvent, type ProviderRequest } from "@betamultiagent/core";
import { classifyClaudeError } from "./errors.js";
import { parseModelRef } from "./models.js";
import { buildMessageParams, CLAUDE_PROVIDER_ID } from "./request.js";
import { ClaudeStreamState } from "./stream.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_RETRIES = 4;

export interface ClaudeProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly fetch?: ClientOptions["fetch"];
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createClaudeProvider(options: ClaudeProviderOptions): Provider {
  if (options.apiKey.length === 0) {
    throw new TypeError("claude provider requires a non-empty apiKey");
  }
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    logLevel: "off",
    openTelemetry: false,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: CLAUDE_PROVIDER_ID,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      const model = parseModelRef({ id: request.model, ...(request.effort === undefined ? {} : { effort: request.effort }) });
      const params = buildMessageParams(request, model);
      const state = new ClaudeStreamState(model);
      let sawEvent = false;
      try {
        const events = await client.messages.create(params, { signal });
        for await (const event of events) {
          sawEvent = true;
          yield* state.accept(event);
        }
        if (signal.aborted) {
          throw new ProviderError("aborted", "request aborted");
        }
        yield { type: "complete", message: state.finish() };
      } catch (error) {
        throw classifyClaudeError(error, { signal, sawEvent });
      }
    },
  };
}
