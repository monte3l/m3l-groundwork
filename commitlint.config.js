/**
 * Conventional Commits, enforced on `commit-msg` via lefthook.
 *
 * `feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major.
 * Other types (`docs`, `refactor`, `test`, `chore`, ...) do not release.
 *
 * `trailer-exists` enforces the DCO locally: every commit made here needs a
 * `Signed-off-by:` trailer (`git commit -s`, or `git config commit.template`
 * plus `--signoff`). See CONTRIBUTING.md, "Developer Certificate of
 * Origin". This only covers commits that pass through the hook -- a squash
 * merge or the release bot's own commit isn't linted here, which is why the
 * PR template also carries a sign-off checkbox.
 *
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "trailer-exists": [2, "always", "Signed-off-by:"],
  },
};
