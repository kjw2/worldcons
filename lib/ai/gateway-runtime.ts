import type { GatewaySummaryEnv } from "@/lib/ai/gateway-summary";

// Mirrors the existing Worker-local runtime binding registry for D1/R2.
// No provider keys or request bodies are stored in this registry.
let activeWorkerEnv: GatewaySummaryEnv | null = null;

export function setRuntimeGatewayEnvironment(env: GatewaySummaryEnv | null) {
  // Do not retain the full WorkerEnv: it also contains unrelated secret values.
  activeWorkerEnv = env ? {
    AI: env.AI,
    WORLDCONS_SUMMARY_BACKEND: env.WORLDCONS_SUMMARY_BACKEND,
    WORLDCONS_SUMMARY_BACKEND_G1: env.WORLDCONS_SUMMARY_BACKEND_G1,
    WORLDCONS_SUMMARY_BACKEND_G2: env.WORLDCONS_SUMMARY_BACKEND_G2,
    WORLDCONS_SUMMARY_BACKEND_G3: env.WORLDCONS_SUMMARY_BACKEND_G3,
    WORLDCONS_SUMMARY_BACKEND_G4: env.WORLDCONS_SUMMARY_BACKEND_G4,
    WORLDCONS_AI_GATEWAY_ID: env.WORLDCONS_AI_GATEWAY_ID,
    WORLDCONS_AI_GATEWAY_ROUTE: env.WORLDCONS_AI_GATEWAY_ROUTE,
  } : null;
}

export function getRuntimeGatewayEnvironment(): GatewaySummaryEnv {
  return activeWorkerEnv ?? {
    WORLDCONS_SUMMARY_BACKEND: process.env.WORLDCONS_SUMMARY_BACKEND,
    WORLDCONS_SUMMARY_BACKEND_G1: process.env.WORLDCONS_SUMMARY_BACKEND_G1,
    WORLDCONS_SUMMARY_BACKEND_G2: process.env.WORLDCONS_SUMMARY_BACKEND_G2,
    WORLDCONS_SUMMARY_BACKEND_G3: process.env.WORLDCONS_SUMMARY_BACKEND_G3,
    WORLDCONS_SUMMARY_BACKEND_G4: process.env.WORLDCONS_SUMMARY_BACKEND_G4,
    WORLDCONS_AI_GATEWAY_ID: process.env.WORLDCONS_AI_GATEWAY_ID,
    WORLDCONS_AI_GATEWAY_ROUTE: process.env.WORLDCONS_AI_GATEWAY_ROUTE,
  };
}
