import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Vinext writes .next/types/routes.d.ts using global VinextRouteTypes.
 * Next.js generates an incompatible validator.ts that imports AppRoutes,
 * LayoutRoutes and ParamMap from that same module. Delete ONLY this known
 * generated Next.js file before tsc; never remove route types or source files.
 */
for (const relativePath of [
  ".next/types/validator.ts",
  ".next/dev/types/validator.ts",
]) {
  const file = join(process.cwd(), relativePath);
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  if (!source.startsWith("// This file is generated automatically by Next.js\n")
    || !source.includes('from "./routes.js"')) {
    throw new Error("Refusing to remove nonstandard file: " + relativePath);
  }
  unlinkSync(file);
  console.log("Removed stale Next.js-generated route validator: " + relativePath);
}
