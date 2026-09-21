import vinextHandler from "vinext/server/fetch-handler";
import type { ArtifactBlobR2Bucket } from "@/lib/storage/blob";
import { setRuntimeArtifactBlobR2Binding } from "@/lib/storage/runtime-binding";

interface WorldconsWorkerEnv {
  WORLDCONS_RAW: ArtifactBlobR2Bucket;
  [key: string]: unknown;
}

interface WorkerExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

interface VinextWorkerHandler {
  fetch(
    request: Request,
    env: WorldconsWorkerEnv,
    ctx: WorkerExecutionContextLike,
  ): Response | Promise<Response>;
}

const handler = vinextHandler as unknown as VinextWorkerHandler;

export default {
  fetch(request: Request, env: WorldconsWorkerEnv, ctx: WorkerExecutionContextLike) {
    setRuntimeArtifactBlobR2Binding(env.WORLDCONS_RAW);
    return handler.fetch(request, env, ctx);
  },
};
