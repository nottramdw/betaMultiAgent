import { execRuleMatches, type CommandPolicy, type ExecRule, type PermissionRequest, type PermissionVerdict } from "@betamultiagent/core";

export const UNATTENDED_REASON = "unattended runs only commands listed exactly in a user exec allow rule";

export function exactUserCommands(rules: readonly ExecRule[]): ExecRule[] {
  return rules.filter((rule) => rule.decision === "allow" && rule.match.at(-1) !== "*");
}

export function unattendedCommandPolicy(inner: CommandPolicy, rules: readonly ExecRule[], platform: NodeJS.Platform): CommandPolicy {
  const exact = exactUserCommands(rules);
  return {
    evaluate: async (request: PermissionRequest): Promise<PermissionVerdict> => {
      const verdict = await inner.evaluate(request);
      if (verdict.decision === "deny" || request.kind !== "exec") {
        return verdict;
      }
      if (exact.some((rule) => execRuleMatches(rule, request.argv, platform))) {
        return { decision: "allow", source: "rule", reason: "exact user exec allow rule", sensitive: verdict.sensitive };
      }
      return { decision: "ask", source: "default", reason: UNATTENDED_REASON, sensitive: verdict.sensitive };
    },
  };
}
