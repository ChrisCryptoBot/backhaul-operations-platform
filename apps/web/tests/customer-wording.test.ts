import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desk says "customer": a dispatcher works with brokers, shippers and direct customers, and a broker is one kind of customer. This keeps
 * the word from creeping back into anything a person reads. It looks at the desk's own source (not the phone's vendored code) for the
 * capitalised word "Broker" outside comments, and for the lowercase word inside a sentence in a quoted string. Code names, URL query
 * parameters, ids and keys are not text and are not looked at (a quoted string with no space in it is a key, not a sentence).
 *
 * "Broker" stays only where it is deliberately the kind: what FMCSA says about an MC number, the MC field's own label, and the hint that
 * names the kinds. Add to ALLOWED on purpose, never to get a test to pass.
 */
const SRC = path.join(__dirname, "..", "src");
const SKIP_DIRS = new Set(["truelane"]);
const SKIP_FILES = new Set([path.join("server", "ratecon", "fixtures.ts")]); // demo documents, with their invented broker companies

// "label: \"Broker\"" is the name of a kind of customer in the list of kinds, which is what a broker is.
const ALLOWED = ["Broker authority active", "not a broker", "A broker, shipper or direct customer", "brokers and carriers", 'label: "Broker"'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);
// A template string's `${...}` parts are code, not words. They are cut out, however deeply they nest, before the quoted strings are read.
function withoutExpressions(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "$" && line[i + 1] === "{") {
      let depth = 0;
      for (i += 1; i < line.length; i += 1) {
        if (line[i] === "{") depth += 1;
        else if (line[i] === "}" && (depth -= 1) === 0) break;
      }
      continue;
    }
    out += line[i];
  }
  return out;
}
const literals = (line: string) => [...withoutExpressions(line).matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? "");

describe("customer wording", () => {
  it("has no visible 'Broker' in the desk's own source outside the allowed places", () => {
    const found: string[] = [];
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file);
      if (SKIP_FILES.has(rel)) continue;
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((raw, i) => {
          if (isComment(raw)) return;
          const line = ALLOWED.reduce((s, a) => s.split(a).join(""), raw);
          if (/\bBrokers?\b/.test(line)) found.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 110)}`);
          else if (literals(line).some((t) => t.includes(" ") && /\bbrokers?\b/i.test(t))) found.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 110)}`);
        });
    }
    expect(found).toEqual([]);
  });
});
