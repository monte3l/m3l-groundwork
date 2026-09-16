/**
 * Conventional Commits, enforced on `commit-msg` via lefthook.
 *
 * `feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major.
 * Other types (`docs`, `refactor`, `test`, `chore`, ...) do not release.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
