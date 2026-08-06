// Shelf-level transient messages, error first, then the informational note.
export function PageMessages({
  error,
  notice,
}: {
  error: string | null;
  notice: string | null;
}) {
  return (
    <>
      {error ? (
        <p className="mb-6 text-sm text-muted-content">{error}</p>
      ) : null}
      {notice ? (
        <p className="mb-6 text-sm text-muted-content">{notice}</p>
      ) : null}
    </>
  );
}
