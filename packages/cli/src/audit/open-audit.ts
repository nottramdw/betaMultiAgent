import { auditDir } from "../config/paths.js";
import type { CommandContext } from "../commands/command-context.js";
import type { Workspace } from "../wiring.js";
import { AuditLedger } from "./audit-ledger.js";
import { AuditRecorder } from "./audit-recorder.js";

export interface OpenedAudit {
  readonly ledger: AuditLedger;
  readonly recorder: AuditRecorder;
}

export async function openAudit(context: CommandContext, workspace: Workspace, runId: string): Promise<OpenedAudit> {
  const ledger = await AuditLedger.open({
    dir: auditDir(workspace.dirs, workspace.root),
    runId,
    redactor: context.redactor,
    retentionDays: workspace.config.auditRetentionDays,
    now: context.io.now,
    warn: (message) => {
      context.err.line(`bma: ${message}`);
    },
  });
  return { ledger, recorder: new AuditRecorder(ledger, workspace.root) };
}
