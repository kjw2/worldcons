import { articleLifecycleError } from "@/lib/article-lifecycle/errors";
import { postgresArticleLifecycleRepository } from "@/lib/article-lifecycle/repository";
import type { ArticleLifecycleRepository } from "@/lib/article-lifecycle/types";
import { articlePublicationError } from "@/lib/article-publication/errors";
import { postgresArticlePublicationRepository } from "@/lib/article-publication/repository";
import type { ArticlePublicationRepository } from "@/lib/article-publication/types";
import {
  getRuntimeCoreWriteAuthorityConfig,
  readArticleLifecycleFromD1,
  readArticlePublicationSnapshotFromD1,
  shouldUseD1CoreWrite,
  transitionArticleLifecycleInD1,
  transitionArticlePublicationInD1,
} from "@/lib/cloudflare/core-write/authority";
import {
  readLifecycleViaCoreBoundary,
  readPublicationViaCoreBoundary,
  transitionLifecycleViaCoreBoundary,
  transitionPublicationViaCoreBoundary,
} from "@/lib/cloudflare/core-write/boundary-client";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

function selected() {
  return shouldUseD1CoreWrite(getRuntimeCoreWriteAuthorityConfig());
}

export const coreAuthorityArticleLifecycleRepository: ArticleLifecycleRepository = {
  async get(articleId) {
    if (!selected()) return postgresArticleLifecycleRepository.get(articleId);
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return readArticleLifecycleFromD1(binding, articleId);
    try {
      return await readLifecycleViaCoreBoundary(articleId);
    } catch {
      return { ok: false, error: articleLifecycleError("unavailable") };
    }
  },
  async transition(input) {
    if (!selected()) return postgresArticleLifecycleRepository.transition(input);
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return transitionArticleLifecycleInD1(binding, input);
    try {
      return await transitionLifecycleViaCoreBoundary(input);
    } catch {
      return { ok: false, error: articleLifecycleError("unavailable") };
    }
  },
};

export const coreAuthorityArticlePublicationRepository: ArticlePublicationRepository = {
  async getSnapshot(articleId) {
    if (!selected()) return postgresArticlePublicationRepository.getSnapshot(articleId);
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return readArticlePublicationSnapshotFromD1(binding, articleId);
    try {
      return await readPublicationViaCoreBoundary(articleId);
    } catch {
      return { ok: false, error: articlePublicationError("unavailable") };
    }
  },
  async transition(input) {
    if (!selected()) return postgresArticlePublicationRepository.transition(input);
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return transitionArticlePublicationInD1(binding, input);
    try {
      return await transitionPublicationViaCoreBoundary(input);
    } catch {
      return { ok: false, error: articlePublicationError("unavailable") };
    }
  },
};
