import { ProviderError, type Provider, type ProviderEvent, type ProviderRequest } from "@betamultiagent/core";
import { SpaceXSI, type ClientOptions } from "@xai-official/sdk";
import { classifyGrokError } from "./errors.js";
import { parseModelRef } from "./models.js";
import { buildCreateParams, GROK_PROVIDER_ID } from "./request.js";
import { GrokStreamState, isOutputEvent } from "./stream.js";

const DEFAULT_MAX_RETRIES = 4;

export interface GrokProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly fetch?: ClientOptions["fetch"];
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export function createGrokProvider(options: GrokProviderOptions): Provider {
  if (options.apiKey.length === 0) {
    throw new TypeError("grok provider requires a non-empty apiKey");
  }
  const client = new SpaceXSI({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBeforeOutput: true,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: GROK_PROVIDER_ID,
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      const model = parseModelRef({ id: request.model, ...(request.effort === undefined ? {} : { effort: request.effort }) });
      const params = buildCreateParams(request, model);
      const state = new GrokStreamState(model);
      let sawEvent = false;
      try {
        const stream = await client.responses.create(params, { signal });
        for await (const event of stream) {
          sawEvent ||= isOutputEvent(event);
          yield* state.accept(event);
        }
        const response = await stream.done();
        if (signal.aborted) {
          throw new ProviderError("aborted", "request aborted");
        }
        yield { type: "complete", message: state.finish(response) };
      } catch (error) {
        throw classifyGrokError(error, { signal, sawEvent });
      }
    },
  };
}
