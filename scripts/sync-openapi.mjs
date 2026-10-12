#!/usr/bin/env node
// Extracts the request and response shapes used by the SDK endpoints from the
// API's OpenAPI document and writes them to openapi/tukupay.json.
//
//   node scripts/sync-openapi.mjs https://test.api.tuku.money/openapi.json
//   node scripts/sync-openapi.mjs ./openapi_full.json
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PREFIX = "/api/v1";

// The libraries call only the /sdk routes. This is how many there should be;
// a drop means an endpoint was removed from the API.
const EXPECTED_OPERATIONS = 39;

const source = process.argv[2];
if (!source) {
  console.error("usage: sync-openapi.mjs <url-or-file>");
  process.exit(1);
}

const full = /^https?:/.test(source)
  ? await (await fetch(source, { headers: { "User-Agent": "tukupay-sdk-sync/1.0" } })).json()
  : JSON.parse(await readFile(source, "utf8"));

const paths = {};
let operations = 0;
for (const [path, item] of Object.entries(full.paths)) {
  if (!path.startsWith(`${PREFIX}/sdk/`)) continue;
  paths[path] = item;
  operations += Object.keys(item).length;
}

if (operations < EXPECTED_OPERATIONS) {
  console.error(`Expected at least ${EXPECTED_OPERATIONS} /sdk operations, found ${operations}`);
  process.exit(1);
}

// Keep only the schemas these paths reach, following $ref transitively.
const schemas = {};
const visit = (node) => {
  if (Array.isArray(node)) return node.forEach(visit);
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")) {
      const name = value.split("/").pop();
      if (!schemas[name]) {
        schemas[name] = full.components.schemas[name];
        visit(schemas[name]);
      }
    } else {
      visit(value);
    }
  }
};
visit(paths);

// Only the data shapes are published: names, types and allowed values. The
// endpoint list and all prose stay with the API.
const ANNOTATIONS = ["description", "example", "examples", "title"];
const strip = (schema) => {
  if (Array.isArray(schema)) return schema.map(strip);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.includes(key)) continue;
    if (key === "properties" || key === "$defs") {
      // Keys here are field names (one is literally called "description"), not annotations.
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strip(child)]));
    } else if (["enum", "required", "const", "default"].includes(key)) {
      out[key] = value;
    } else {
      out[key] = strip(value);
    }
  }
  return out;
};

const published = Object.fromEntries(
  Object.entries(schemas)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => [name, strip(schema)]),
);

const out = {
  openapi: full.openapi,
  info: { title: "TukuPay SDK data types", version: full.info.version },
  paths: {},
  components: { schemas: published },
};

const target = fileURLToPath(new URL("../openapi/tukupay.json", import.meta.url));
await writeFile(target, JSON.stringify(out, null, 2) + "\n");
console.log(`${operations} operations checked, ${Object.keys(schemas).length} schemas -> openapi/tukupay.json`);
