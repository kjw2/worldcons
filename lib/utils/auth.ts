import { headers } from "next/headers";

export function isAuthorizedRequest(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret && process.env.NODE_ENV !== "production") {
    return true;
  }

  const auth = request.headers.get("authorization");
  const querySecret = new URL(request.url).searchParams.get("secret");
  return auth === `Bearer ${secret}` || Boolean(secret && querySecret === secret);
}

export function isAuthorizedSecret(secretValue?: string | null) {
  const secret = process.env.CRON_SECRET;

  if (!secret && process.env.NODE_ENV !== "production") {
    return true;
  }

  return Boolean(secret && secretValue === secret);
}

export async function isAuthorizedPageRequest(secretValue?: string | null) {
  if (isAuthorizedSecret(secretValue)) {
    return true;
  }

  const secret = process.env.CRON_SECRET;
  const headerStore = await headers();
  return headerStore.get("authorization") === `Bearer ${secret}`;
}
