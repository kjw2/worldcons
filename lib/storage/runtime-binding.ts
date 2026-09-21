import type { ArtifactBlobR2Bucket } from "@/lib/storage/blob";

interface WorldconsRuntimeGlobal {
  __worldconsArtifactBlobR2BindingV1?: ArtifactBlobR2Bucket;
}

function runtimeGlobal(): typeof globalThis & WorldconsRuntimeGlobal {
  return globalThis as typeof globalThis & WorldconsRuntimeGlobal;
}

export function setRuntimeArtifactBlobR2Binding(binding: ArtifactBlobR2Bucket | null): void {
  const target = runtimeGlobal();
  if (binding) {
    target.__worldconsArtifactBlobR2BindingV1 = binding;
  } else {
    delete target.__worldconsArtifactBlobR2BindingV1;
  }
}

export function getRuntimeArtifactBlobR2Binding(): ArtifactBlobR2Bucket | null {
  return runtimeGlobal().__worldconsArtifactBlobR2BindingV1 ?? null;
}
