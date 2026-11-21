import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".cache/**",
      ".crawlee-storage/**",
      ".git/**",
      ".next/**",
      "cache/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "**/worker-configuration.d.ts",
      "*.tsbuildinfo",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // CommonJS operator CLIs legitimately use require(); the TypeScript rule is
    // meant for ESM/TS modules, not explicit .cjs entrypoints.
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
    },
  },
];

export default eslintConfig;
