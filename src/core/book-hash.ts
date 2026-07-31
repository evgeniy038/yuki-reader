// Stable content fingerprint of a parsed book, used to reject duplicate
// imports. Derived from the PARSED chapters (not the file bytes) so it can be
// backfilled for books already in storage — parsing is deterministic, so
// re-importing the same file always yields the same hash.
export async function bookContentHash(
  title: string,
  author: string | undefined,
  chapters: { html: string }[],
): Promise<string> {
  const material = [
    title,
    author ?? "",
    ...chapters.map((chapter) => `${chapter.html.length}:${chapter.html.slice(0, 128)}`),
  ].join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
