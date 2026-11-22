/**
 * Template sync guard: EXAMPLE_CONFIG_YAML (what `ensureConfigFile` spawns as
 * a fresh config.yaml) must stay BYTE-IDENTICAL to config.example.yaml — the
 * human-readable source of truth. Drift between the two is how the removed
 * /api/v3 REST faces survived in the spawned template (review 2026-11-22).
 * Also parse-checks the spawned content through the real loader so a template
 * edit can never ship a config.yaml the loader rejects.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_CONFIG_YAML } from "./template.js";
import { loadConfig } from "./loader.js";

const EXAMPLE_PATH = new URL("../../config.example.yaml", import.meta.url);

describe("config template sync", () => {
  it("EXAMPLE_CONFIG_YAML is byte-identical to config.example.yaml", () => {
    const onDisk = readFileSync(EXAMPLE_PATH, "utf-8");
    expect(EXAMPLE_CONFIG_YAML).toBe(onDisk);
  });

  it("the spawned template parses through the real loader with every section", () => {
    const dir = mkdtempSync(join(tmpdir(), "template-test-"));
    try {
      const path = join(dir, "config.yaml");
      writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
      const config = loadConfig(path);
      // Section presence — a template edit that drops a section fails here.
      expect(config.plan).toBe("coding-plan");
      expect(config.responses.enabled).toBe(true);
      expect(config.mcp.gateway.enabled).toBe(true);
      expect(config.media.enabled).toBe(true);
      expect(config.async.enabled).toBe(false);
      expect(config.claim.enabled).toBe(true);
      expect(config.endpointRouting.enabled).toBe(true);
      expect(config.clientSigning.enabled).toBe(true);
      expect(config.highspeed.enabled).toBe(true);
      expect(config.models).toContain("glm-5.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
