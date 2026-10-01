const GOOGLE_VERIFICATION_BODY = "google-site-verification: googlebc13342811fc3fd7.html\n";

export const dynamic = "force-static";

export function GET() {
  return new Response(GOOGLE_VERIFICATION_BODY, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
