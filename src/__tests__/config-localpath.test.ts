/**
 * Tests for project-local storage via pi-session-search.localPath
 * and pi-total-recall.localPath cascade.
 *
 * Resolution order (highest priority first):
 *   1. {cwd}/.pi/settings.json → "pi-session-search".localPath
 *   2. {cwd}/.pi/settings.json → "pi-total-recall".localPath → {base}/session-search
 *   3. Global default under ~/.pi/session-search
 *
 * NOTE: Source directories (~/.pi/agent/sessions) are intentionally NOT
 * relocated — only the config file and derived index location are.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolveLocalBase,
  getConfigPath,
  getIndexDir,
  loadConfig,
  saveConfig,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
} from "../config";

const originalHome = process.env.HOME;
let tmpHome: string;
let tmpProject: string;
let tmpLocal: string;
let tmpCascade: string;

function writeProjectSettings(obj: Record<string, unknown>): void {
  const dir = path.join(tmpProject, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(obj), "utf-8");
}

describe("config.localPath resolution", () => {
  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ss-home-"));
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ss-proj-"));
    tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), "ss-local-"));
    tmpCascade = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cascade-"));
    process.env.HOME = tmpHome;
  });

  beforeEach(() => {
    try {
      fs.rmSync(path.join(tmpProject, ".pi"), { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(path.join(tmpHome, ".pi"), { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(path.join(tmpLocal, "config.json"), { force: true });
    } catch {}
    try {
      fs.rmSync(path.join(tmpCascade, "session-search", "config.json"), { force: true });
    } catch {}
  });

  after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpLocal, { recursive: true, force: true });
    fs.rmSync(tmpCascade, { recursive: true, force: true });
  });

  // ─── resolveLocalBase ──────────────────────────────────────────────

  it("resolveLocalBase returns null when cwd is undefined", () => {
    assert.equal(resolveLocalBase(undefined), null);
  });

  it("resolveLocalBase returns null when no settings.json", () => {
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null for malformed settings.json", () => {
    fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, ".pi", "settings.json"), "{ not json }", "utf-8");
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null for empty settings.json", () => {
    writeProjectSettings({});
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null when pi-session-search has empty localPath", () => {
    writeProjectSettings({ "pi-session-search": { localPath: "" } });
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns null when localPath is wrong type", () => {
    writeProjectSettings({ "pi-session-search": { localPath: ["nope"] } });
    assert.equal(resolveLocalBase(tmpProject), null);
  });

  it("resolveLocalBase returns pi-session-search.localPath when set", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    assert.equal(resolveLocalBase(tmpProject), tmpLocal);
  });

  it("resolveLocalBase cascades from pi-total-recall.localPath", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(resolveLocalBase(tmpProject), path.join(tmpCascade, "session-search"));
  });

  it("resolveLocalBase: package-specific wins over cascade", () => {
    writeProjectSettings({
      "pi-session-search": { localPath: tmpLocal },
      "pi-total-recall": { localPath: tmpCascade },
    });
    assert.equal(resolveLocalBase(tmpProject), tmpLocal);
  });

  // ─── getConfigPath ─────────────────────────────────────────────────

  it("getConfigPath: global default when no cwd", () => {
    assert.equal(getConfigPath(), path.join(tmpHome, ".pi", "session-search", "config.json"));
  });

  it("getConfigPath: global default when cwd has no settings", () => {
    assert.equal(
      getConfigPath(tmpProject),
      path.join(tmpHome, ".pi", "session-search", "config.json")
    );
  });

  it("getConfigPath: resolves {localPath}/config.json", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    assert.equal(getConfigPath(tmpProject), path.join(tmpLocal, "config.json"));
  });

  it("getConfigPath: cascade → {base}/session-search/config.json", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(
      getConfigPath(tmpProject),
      path.join(tmpCascade, "session-search", "config.json")
    );
  });

  // ─── getIndexDir ───────────────────────────────────────────────────

  it("getIndexDir: global default when no cwd", () => {
    assert.equal(getIndexDir(), path.join(tmpHome, ".pi", "session-search", "index"));
  });

  it("getIndexDir: resolves {localPath}/index", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    assert.equal(getIndexDir(tmpProject), path.join(tmpLocal, "index"));
  });

  it("getIndexDir: cascade → {base}/session-search/index", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    assert.equal(
      getIndexDir(tmpProject),
      path.join(tmpCascade, "session-search", "index")
    );
  });

  // ─── loadConfig / saveConfig integration ───────────────────────────

  it("loadConfig: returns null when no config file at resolved path", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    assert.equal(loadConfig(tmpProject), null);
  });

  it("loadConfig: returns null without cwd when no global config", () => {
    assert.equal(loadConfig(), null);
  });

  it("loadConfig: reads from package-local path", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    fs.writeFileSync(
      path.join(tmpLocal, "config.json"),
      JSON.stringify({
        extraSessionDirs: ["/tmp/extra-sessions"],
        extraArchiveDirs: [],
      }),
      "utf-8"
    );

    const config = loadConfig(tmpProject);
    assert.ok(config);
    assert.deepStrictEqual(config.extraSessionDirs, ["/tmp/extra-sessions"]);
  });

  it("loadConfig: reads from cascade sub-path", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });
    fs.mkdirSync(path.join(tmpCascade, "session-search"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpCascade, "session-search", "config.json"),
      JSON.stringify({
        extraSessionDirs: ["/tmp/cascade-sessions"],
        extraArchiveDirs: [],
      }),
      "utf-8"
    );

    const config = loadConfig(tmpProject);
    assert.ok(config);
    assert.deepStrictEqual(config.extraSessionDirs, ["/tmp/cascade-sessions"]);
  });

  it("loadConfig: returns null for corrupt JSON (back-compat behavior)", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    fs.writeFileSync(path.join(tmpLocal, "config.json"), "{ bad json", "utf-8");
    assert.equal(loadConfig(tmpProject), null);
  });

  it("saveConfig: writes to package-local path", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });

    saveConfig({ extraSessionDirs: ["/tmp/saved"] }, tmpProject);

    const written = path.join(tmpLocal, "config.json");
    assert.ok(fs.existsSync(written));
    const parsed = JSON.parse(fs.readFileSync(written, "utf-8"));
    assert.deepStrictEqual(parsed.extraSessionDirs, ["/tmp/saved"]);
  });

  it("saveConfig: writes to cascade sub-path", () => {
    writeProjectSettings({ "pi-total-recall": { localPath: tmpCascade } });

    saveConfig({ extraSessionDirs: ["/tmp/cascade-saved"] }, tmpProject);

    const written = path.join(tmpCascade, "session-search", "config.json");
    assert.ok(fs.existsSync(written));
    const parsed = JSON.parse(fs.readFileSync(written, "utf-8"));
    assert.deepStrictEqual(parsed.extraSessionDirs, ["/tmp/cascade-saved"]);
  });

  it("saveConfig: creates parent directories automatically", () => {
    const freshBase = fs.mkdtempSync(path.join(os.tmpdir(), "ss-fresh-"));
    try {
      writeProjectSettings({
        "pi-total-recall": { localPath: path.join(freshBase, "deep", "path") },
      });
      saveConfig({ extraSessionDirs: ["/tmp/deep"] }, tmpProject);
      assert.ok(
        fs.existsSync(path.join(freshBase, "deep", "path", "session-search", "config.json"))
      );
    } finally {
      fs.rmSync(freshBase, { recursive: true, force: true });
    }
  });

  // ─── Back-compat ───────────────────────────────────────────────────

  it("back-compat: loadConfig without cwd reads from global default", () => {
    const globalDir = path.join(tmpHome, ".pi", "session-search");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({ extraSessionDirs: ["/tmp/global"], extraArchiveDirs: [] }),
      "utf-8"
    );

    const config = loadConfig();
    assert.ok(config);
    assert.deepStrictEqual(config.extraSessionDirs, ["/tmp/global"]);
  });

  it("back-compat: saveConfig without cwd writes to global default", () => {
    saveConfig({ extraSessionDirs: ["/tmp/global-save"] });
    const globalFile = path.join(tmpHome, ".pi", "session-search", "config.json");
    assert.ok(fs.existsSync(globalFile));
    const parsed = JSON.parse(fs.readFileSync(globalFile, "utf-8"));
    assert.deepStrictEqual(parsed.extraSessionDirs, ["/tmp/global-save"]);
  });

  it("back-compat: unrelated cwd doesn't leak settings from another project", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ss-other-"));
    try {
      assert.equal(
        getConfigPath(other),
        path.join(tmpHome, ".pi", "session-search", "config.json")
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("loadConfig: sync node absent means no sync config", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({}, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync, undefined);
  });

  it("loadConfig: reads custom interval from nested sync node", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { interval: 10 * 60 * 1000 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.interval, 10 * 60 * 1000);
  });

  it("loadConfig: -1 interval preserved for disabling auto-sync", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { interval: -1 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.interval, -1);
  });

  it("loadConfig: ignores invalid sync.interval and omits sync node", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    // Write raw JSON with a string value (not a number)
    const configFile = getConfigPath(tmpProject);
    fs.writeFileSync(configFile, JSON.stringify({ sync: { interval: "fast" } }), "utf-8");
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync, undefined);
    // nullish coalesce to DEFAULT would yield 300000 — same as before
  });

  it("loadConfig: 0 interval passed through (index.ts treats 0 as invalid → fallback)", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { interval: 0 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.interval, 0);
    // index.ts decides timer behaviour:
    //   -1 → disabled, >0 → timer, <=0 (other than -1) → warning + default
  });

  it("DEFAULT_SYNC_INTERVAL_MS is exported from config module", () => {
    assert.equal(DEFAULT_SYNC_INTERVAL_MS, 5 * 60 * 1000);
  });

  it("DEFAULT_INITIAL_DELAY_MS is exported and defaults to 0", () => {
    assert.equal(DEFAULT_INITIAL_DELAY_MS, 0);
  });

  it("loadConfig: reads initialDelay from nested sync node", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { initialDelay: 30_000 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.initialDelay, 30_000);
  });

  it("loadConfig: -1 initialDelay preserved for skipping initial sync", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { initialDelay: -1 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.initialDelay, -1);
  });

  it("loadConfig: both interval and initialDelay loaded together", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { interval: 600_000, initialDelay: 10_000 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.interval, 600_000);
    assert.equal(cfg.sync?.initialDelay, 10_000);
  });

  it("loadConfig: initialDelay alone (no interval) still produces sync node", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { initialDelay: 5_000 } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.ok(cfg.sync);
    assert.equal(cfg.sync!.initialDelay, 5_000);
    assert.equal(cfg.sync!.interval, undefined);
  });

  it("loadConfig: disableForChild=true is passed through", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { disableForChild: true } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.disableForChild, true);
  });

  it("loadConfig: disableForChild=false is passed through", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { disableForChild: false } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.disableForChild, false);
  });

  it("loadConfig: disableForChild ignored when non-boolean", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    const configFile = getConfigPath(tmpProject);
    fs.writeFileSync(configFile, JSON.stringify({ sync: { disableForChild: "yes" } }), "utf-8");
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.disableForChild, undefined);
  });

  it("loadConfig: all three sync fields loaded together", () => {
    writeProjectSettings({ "pi-session-search": { localPath: tmpLocal } });
    saveConfig({ sync: { interval: -1, initialDelay: -1, disableForChild: true } }, tmpProject);
    const cfg = loadConfig(tmpProject);
    assert.ok(cfg);
    assert.equal(cfg.sync?.interval, -1);
    assert.equal(cfg.sync?.initialDelay, -1);
    assert.equal(cfg.sync?.disableForChild, true);
  });
});
