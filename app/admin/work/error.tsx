"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

export default function AdminWorkError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="px-4 py-12 sm:px-6" role="alert">
      <div className="border-y border-court/25 bg-court/5 px-4 py-8 text-center">
        <AlertTriangle className="mx-auto size-5 text-court" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-ink">The work snapshot could not be loaded</h1>
        <p className="mt-2 text-sm text-ink/60">No action was performed. Retry the bounded read or use a retained specialized page.</p>
        <button type="button" onClick={reset} className="focus-ring mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white"><RotateCcw className="size-4" aria-hidden="true" />Retry</button>
      </div>
    </div>
  );
}
