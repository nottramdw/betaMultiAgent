import type { ModelInfo } from "@betamultiagent/core";
import { models as claudeModels, PRICING_AS_OF as CLAUDE_PRICING_AS_OF } from "@betamultiagent/provider-claude";
import { models as grokModels, PRICING_AS_OF as GROK_PRICING_AS_OF } from "@betamultiagent/provider-grok";
import { parseArgs } from "node:util";
import { EXIT_OK, usageError } from "../cli-error.js";
import { JsonlWriter } from "../output/jsonl.js";
import type { CommandContext } from "./command-context.js";

const CATALOGS: Readonly<Record<string, { readonly models: readonly ModelInfo[]; readonly pricingAsOf: string }>> = {
  claude: { models: claudeModels, pricingAsOf: CLAUDE_PRICING_AS_OF },
  grok: { models: grokModels, pricingAsOf: GROK_PRICING_AS_OF },
};

function price(info: ModelInfo): string {
  const first = info.pricing?.[0];
  if (first === undefined) {
    return "price unknown";
  }
  return `$${String(first.inputPerMTok)}/$${String(first.outputPerMTok)} per MTok`;
}

export function modelsCommand(context: CommandContext, args: readonly string[]): number {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { provider: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const providers = values.provider === undefined ? Object.keys(CATALOGS) : [values.provider];
  for (const provider of providers) {
    if (CATALOGS[provider] === undefined) {
      throw usageError(`unknown provider ${JSON.stringify(provider)}; expected claude or grok`);
    }
  }
  const rows = providers.flatMap((provider) =>
    (CATALOGS[provider]?.models ?? []).map((info) => ({ provider, ...info, ref: `${provider}:${info.id}` })),
  );
  if (values.json) {
    new JsonlWriter(context.io.stdout, context.redactor).writeResult("models", { models: rows });
    return EXIT_OK;
  }
  for (const provider of providers) {
    context.out.line(`${provider} (prices as of ${CATALOGS[provider]?.pricingAsOf ?? "unknown"}):`);
    for (const row of rows.filter((entry) => entry.provider === provider)) {
      const effort = row.effortLevels.length === 0 ? "" : `, effort ${row.effortLevels.join("/")}`;
      context.out.line(`  ${row.ref}  context ${String(row.contextWindow)}, max output ${String(row.maxOutput)}, ${price(row)}${effort}`);
    }
  }
  return EXIT_OK;
}
