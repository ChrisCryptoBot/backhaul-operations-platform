// Flat config that reads the legacy .eslintrc.json next to it. It exists so ESLint stops walking up into the TrueLane phone
// app's own eslint.config.js (this project is nested inside that folder); .eslintrc.json stays the one place the rules live.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const dir = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: dir });
const legacy = JSON.parse(fs.readFileSync(path.join(dir, ".eslintrc.json"), "utf8"));

const config = [{ ignores: [".next/**", "node_modules/**"] }, ...compat.config(legacy)];

export default config;
