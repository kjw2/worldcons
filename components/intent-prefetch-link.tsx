"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, type ComponentProps } from "react";

type IntentPrefetchLinkProps = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & {
  href: string;
};

export function IntentPrefetchLink({
  href,
  onFocus,
  onMouseEnter,
  onTouchStart,
  ...props
}: IntentPrefetchLinkProps) {
  const router = useRouter();
  const prefetchedHref = useRef<string | null>(null);
  const ariaDisabled = props["aria-disabled"];

  const prefetch = useCallback(() => {
    if (
      prefetchedHref.current === href
      || !href.startsWith("/")
      || href.startsWith("//")
      || ariaDisabled === true
      || ariaDisabled === "true"
    ) {
      return;
    }

    prefetchedHref.current = href;
    router.prefetch(href);
  }, [ariaDisabled, href, router]);

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) prefetch();
      }}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (!event.defaultPrevented) prefetch();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        if (!event.defaultPrevented) prefetch();
      }}
    />
  );
}
