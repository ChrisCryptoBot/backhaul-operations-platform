import fs from "node:fs";
import path from "node:path";

const buildDir = path.resolve(process.cwd(), ".next");
const markers = [
  "Autofill Test Login",
  "NEXT_PUBLIC_DEV_TEST_LOGIN_EMAIL",
  "NEXT_PUBLIC_DEV_TEST_LOGIN_PASSWORD"
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(resolved));
      continue;
    }
    files.push(resolved);
  }
  return files;
}

if (!fs.existsSync(buildDir)) {
  console.error("Missing .next build output. Run `npm run build --workspace apps/web` first.");
  process.exit(1);
}

const files = walk(buildDir).filter((file) => file.endsWith(".js"));
for (const file of files) {
  const contents = fs.readFileSync(file, "utf8");
  for (const marker of markers) {
    if (contents.includes(marker)) {
      console.error(`Found dev-helper marker in production build output: ${marker}`);
      console.error(`File: ${file}`);
      process.exit(1);
    }
  }
}

console.log("Verified: no dev-helper markers found in production build output.");
