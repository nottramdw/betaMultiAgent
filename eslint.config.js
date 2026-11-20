import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/node_modules/", "**/dist/", "target/", "coverage/", "plans/", "docs/"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.check.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
  },
]);
