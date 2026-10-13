import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  { ignores: ["dist/**", "public/**", "node_modules/**", ".wrangler/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { rules: { complexity: ["error", 10] } },
);
