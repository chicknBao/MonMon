import tsParser from "@typescript-eslint/parser";
import * as tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: 2022,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...(tsPlugin.configs?.recommended?.rules ?? {}),
    },
  },
];

