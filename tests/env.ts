// Test fixtures (novels, PDFs) are private files that live outside the repo.
// Browser smokes take their locations from env vars — see tests/README.md.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `missing ${name} — point it at a local fixture (see tests/README.md)`,
    );
  return value;
}
