import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // This helper is distributed byte-for-byte from its canonical source.
    files: ["src/response-diagnostics.ts"],
    rules: { "no-useless-escape": "off" },
  },
  {
    rules: {
      // Compile-time type assertions are declared and never referenced.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_" },
      ],
    },
  },
);
