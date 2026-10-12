import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { VERSION } from "../src/index.js";

it("matches package.json", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(VERSION).toBe(manifest.version);
});
