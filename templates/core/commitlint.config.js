/**
 * Conventional Commits, enforced on `commit-msg` via lefthook.
 *
 * `feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major.
 * Other types (`docs`, `refactor`, `test`, `chore`, ...) do not release.
 *
 * A project that asks for a DCO sign-off adds the rule below, so a commit
 * without a `Signed-off-by:` trailer fails here (`git commit -s`) instead of in
 * CI. `bin/lint-commit.mjs` then asks for it on merge, revert and `fixup!` /
 * `squash!` messages too, which commitlint itself ignores.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
  // rules: {
  //   "trailer-exists": [2, "always", "Signed-off-by:"],
  // },
};
