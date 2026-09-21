import {
  ARTIFACT_BLOB_PROVIDER_ENV,
  ARTIFACT_BLOB_PROVIDER_R2,
  ARTIFACT_BLOB_READ_FALLBACK_ENV,
  ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV,
  createArtifactBlobStore,
  createArtifactBlobTransport,
  type ArtifactBlobR2Bucket,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";
import { getRuntimeArtifactBlobR2Binding } from "@/lib/storage/runtime-binding";

export function createRuntimeArtifactBlobStore(
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobStore {
  const binding = getRuntimeArtifactBlobR2Binding();
  if (binding) return createR2BindingRuntimeArtifactBlobStore(binding, environment);
  return createArtifactBlobStore(createArtifactBlobTransport(environment));
}

export function createR2BindingRuntimeArtifactBlobStore(
  r2Binding: ArtifactBlobR2Bucket,
  environment: Record<string, string | undefined> = process.env,
): ArtifactBlobStore {
  const runtimeEnvironment = {
    ...environment,
    [ARTIFACT_BLOB_PROVIDER_ENV]: ARTIFACT_BLOB_PROVIDER_R2,
    [ARTIFACT_BLOB_READ_FALLBACK_ENV]: "false",
    [ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS_ENV]: "",
  };
  return createArtifactBlobStore(
    createArtifactBlobTransport(runtimeEnvironment, { r2Binding }),
  );
}
