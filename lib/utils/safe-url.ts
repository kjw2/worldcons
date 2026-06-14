export function safeExternalUrl(value?: string | null) {
  const text = value?.trim();
  if (!text) return null;

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
