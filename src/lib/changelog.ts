import raw from "../../CHANGELOG.md?raw";

export interface ChangelogEntry {
  version: string;
  date: string;
  intro: string | null;
  items: string[];
}

// CHANGELOG.md is the single source of truth for releases: it is imported as
// raw text and parsed once at module load. `## [x.y.z] - date` starts an
// entry, `- ` lines are its bullets, a plain paragraph under the heading is
// the intro.
export const changelog: ChangelogEntry[] = parseChangelog(raw);

function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of text.split("\n")) {
    const heading = /^## \[(.+?)\]\s*-\s*(.+)$/.exec(line.trim());
    if (heading) {
      current = {
        version: heading[1]!,
        date: heading[2]!.trim(),
        intro: null,
        items: [],
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      current.items.push(trimmed.slice(2));
    } else if (trimmed && current.items.length === 0) {
      current.intro = current.intro ? `${current.intro} ${trimmed}` : trimmed;
    }
  }
  return entries;
}
