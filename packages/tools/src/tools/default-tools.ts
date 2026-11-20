import type { Environment, ToolDefinition } from "@betamultiagent/core";
import { createEditFileTool } from "./edit-file.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool, type GrepToolOptions } from "./grep.js";
import { createReadFileTool } from "./read-file.js";
import { createRunCommandTool } from "./run-command.js";
import { createWriteFileTool } from "./write-file.js";

export interface DefaultToolsOptions {
  readonly environment: Environment;
  readonly grep?: GrepToolOptions;
}

export function createDefaultTools(options: DefaultToolsOptions): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createEditFileTool(),
    createGlobTool(),
    createGrepTool(options.grep),
    createReadFileTool(),
    createRunCommandTool(options.environment),
    createWriteFileTool(),
  ];
  return tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
