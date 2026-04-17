// ── argv parsing ────────────────────────────────────────────────────
//
// A tiny, dependency-free parser. Supports:
//   • Long flags with attached value:  --daemon-url=http://...
//   • Long flags with separate value:  --status UPLOADING
//   • Boolean flags:                   --json
//
// Short flags (-h/-v) are only used as aliases for help/version.

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that accept a value (either `--key value` or `--key=value`). */
const VALUE_FLAGS = new Set(["daemon-url", "status", "channel", "page", "per-page"]);

/** Flags that are always boolean. Used only when the next token looks like a flag. */
const BOOLEAN_FLAGS = new Set(["json", "help", "version", "no-watch"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "-h") { flags.help = true; continue; }
    if (a === "-v") { flags.version = true; continue; }

    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }

    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = inline === undefined ? true : inline;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`flag --${name} requires a value`);
        }
        flags[name] = next;
        i++;
      }
      continue;
    }
    // Unknown flag — keep for backwards-compat echo but warn by throwing.
    throw new Error(`unknown flag --${name}`);
  }

  return { positional, flags };
}
