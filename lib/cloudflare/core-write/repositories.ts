import { articleLifecycleError } from "@/lib/article-lifecycle/errors";
import type { ArticleLifecycleRepository } from "@/lib/article-lifecycle/types";
import { articlePublicationError } from "@/lib/article-publication/errors";
import type { ArticlePublicationRepository } from "@/lib/article-publication/types";
import {
  readArticleLifecycleFromD1,
  readArticlePublicationSnapshotFromD1,
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

export const coreAuthorityArticleLifecycleRepository: ArticleLifecycleRepository = {
  async get(articleId) {
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return readArticleLifecycleFromD1(binding, articleId);
    try {
      return await readLifecycleViaCoreBoundary(articleId);
    } catch {
      return { ok: false, error: articleLifecycleError("unavailable") };
    }
  },
  async transition(input) {
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
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return readArticlePublicationSnapshotFromD1(binding, articleId);
    try {
      return await readPublicationViaCoreBoundary(articleId);
    } catch {
      return { ok: false, error: articlePublicationError("unavailable") };
    }
  },
  async transition(input) {
    const binding = getRuntimeD1Binding("worldcons_core");
    if (binding) return transitionArticlePublicationInD1(binding, input);
    try {
      return await transitionPublicationViaCoreBoundary(input);
    } catch {
      return { ok: false, error: articlePublicationError("unavailable") };
    }
  },
};
