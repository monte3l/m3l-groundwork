/**
 * Covers main()'s own body (parseArgs and templatesCoreDir are covered
 * separately in main.test.ts). git.js and plugin.js are mocked so this
 * exercises real emitTemplate() against a real temp directory without
 * spawning real git/pnpm processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
}));

const { main } = await import("../src/main.js");

describe("main", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-run-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("emits the template, installs the skill, inits git, and installs deps by default", () => {
    // main() targets an empty subdirectory it creates itself.
    const emptyTarget = join(targetDir, "sub");

    main([emptyTarget, "--name", "widgets"]);

    expect(existsSync(join(emptyTarget, "package.json"))).toBe(true);
    expect(installCustomizeSkillMock).toHaveBeenCalledWith(emptyTarget);
    expect(gitInitMock).toHaveBeenCalledWith(emptyTarget);
    expect(runInstallMock).toHaveBeenCalledWith(emptyTarget);
  });

  it("skips the install step when --skip-install is passed", () => {
    const emptyTarget = join(targetDir, "sub2");

    main([emptyTarget, "--skip-install"]);

    expect(gitInitMock).toHaveBeenCalledWith(emptyTarget);
    expect(runInstallMock).not.toHaveBeenCalled();
  });

  it("throws rather than overwrite a non-empty directory without --force", () => {
    mkdirSync(join(targetDir, "occupied"));
    writeFileSync(join(targetDir, "occupied", "existing.txt"), "hi");

    expect(() => main([join(targetDir, "occupied")])).toThrow(
      /already exists and is not empty/,
    );
    expect(gitInitMock).not.toHaveBeenCalled();
  });

  it("proceeds into a non-empty directory when --force is passed", () => {
    mkdirSync(join(targetDir, "occupied2"));
    writeFileSync(join(targetDir, "occupied2", "existing.txt"), "hi");

    main([join(targetDir, "occupied2"), "--skip-install", "--force"]);

    expect(gitInitMock).toHaveBeenCalled();
  });
});
