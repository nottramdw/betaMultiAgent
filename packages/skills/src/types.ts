export type SkillSource = "repo" | "user";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly origin: string;
  readonly dir: string;
  readonly file: string;
  readonly body: string;
}

export type ManifestFormat = ".grok-plugin" | ".cursor-plugin" | ".claude-plugin";

export interface PluginSummary {
  readonly name: string;
  readonly directory: string;
  readonly format: ManifestFormat;
  readonly version: string | undefined;
  readonly unsupported: readonly string[];
}

export interface SkillRegistry {
  readonly skills: readonly Skill[];
  readonly plugins: readonly PluginSummary[];
  readonly warnings: readonly string[];
  find(name: string): Skill | undefined;
  readRoots(): readonly string[];
}

export interface DiscoverOptions {
  readonly root: string;
  readonly userConfigDir: string;
  readonly trusted: boolean;
  readonly extraRoots?: readonly string[];
}
