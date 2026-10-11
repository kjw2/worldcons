import { unstable_cache } from "next/cache";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { hasE2ETable } from "@/lib/cloudflare/e2e/generation-state";

// Schema presence is read every request: rollout/withdrawal must not wait for
// a cached flag or a stale-while-revalidate window. Existing tag invalidation
// remains useful for legacy reads. Protected rollout uses uncached content.
export const freshnessAwarePublicCache:typeof unstable_cache=(callback,keyParts,options)=>{
  const cached=unstable_cache(callback,keyParts,options);
  const guarded=async (...args:Parameters<typeof callback>)=>{
    const core=getRuntimeD1Binding("worldcons_core");
    if (!core) throw new Error("e2e.public_core_unavailable");
    if (await hasE2ETable(core,"e2e_generation_heads_v1")) return callback(...args);
    return cached(...args);
  };
  return guarded as typeof cached;
};
