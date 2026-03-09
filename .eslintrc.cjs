// @ts-check

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    // stdout is reserved for MCP stdio transport — all logging via console.error/warn
    "no-console": ["error", { allow: ["error", "warn"] }],
  },
  env: {
    node: true,
    es2022: true,
  },
};
