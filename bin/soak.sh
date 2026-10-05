#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

# Soak matrix for a published @monte3l/groundwork version (dist-tag or exact).
# Runs entirely outside the repo checkout; writes nothing but temp dirs.
#   soak.sh [-v VERSION] [-w WORKDIR] [-s SECTION]   SECTION: negative|fresh|adopt|all
# Exits 1 if any row is FAIL or SKIP, so a CI job cannot go green on a partial soak.
set -u

VERSION="rc"
WORK=""
SECTION="all"
while getopts "v:w:s:" o; do
  case $o in v) VERSION=$OPTARG ;; w) WORK=$OPTARG ;; s) SECTION=$OPTARG ;; *) exit 2 ;; esac
done
case "$VERSION" in
  ""|*[!0-9A-Za-z.+-]*) echo "soak: invalid version '$VERSION'" >&2; exit 2 ;;
esac
case "$SECTION" in
  all|negative|fresh|adopt) ;;
  *) echo "soak: invalid section '$SECTION'" >&2; exit 2 ;;
esac
RESOLVED_OUT=$(npm view "@monte3l/groundwork@$VERSION" version 2>&1); rc=$?
if [ "$rc" != 0 ] || [ -z "$RESOLVED_OUT" ]; then
  echo "soak: could not resolve @monte3l/groundwork@$VERSION on the registry:" >&2
  printf '%s\n' "$RESOLVED_OUT" | tail -3 >&2
  exit 2
fi
if [ "$(printf '%s\n' "$RESOLVED_OUT" | wc -l | tr -d ' ')" != 1 ]; then
  echo "soak: '$VERSION' matches several versions; pass an exact version or a dist-tag" >&2
  exit 2
fi
RESOLVED=$RESOLVED_OUT
PKG="@monte3l/groundwork@$RESOLVED"
[ -n "$WORK" ] || WORK=$(mktemp -d "${TMPDIR:-/tmp}/soak.XXXXXX")
mkdir -p "$WORK/logs"
PLATFORM="$(uname -sm)"
RESULTS="$WORK/results.tsv"
[ -e "$RESULTS" ] || : >"$RESULTS"

# Throwaway repos: do not sign or hook against the host's real git config.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
export CI=1 NO_COLOR=1

row() { # name status detail; replaces an earlier row of the same name
  awk -F'\t' -v n="$1" '$1 != n' "$RESULTS" >"$RESULTS.tmp" && mv "$RESULTS.tmp" "$RESULTS"
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS"
  printf '%-34s %-5s %s\n' "$1" "$2" "$3"
}

cli() { npx -y "$PKG" "$@"; }

echo "== $PKG on $PLATFORM; work dir $WORK"
got=$(cli --version 2>&1 | tail -1)
[ "$got" = "$RESOLVED" ] && row "version" PASS "$got" || row "version" FAIL "expected $RESOLVED, got: $got"

negative() {
  local d
  d="$WORK/neg-bogus"; rm -rf "$d"
  cli "$d" --pack bogus >"$WORK/logs/neg-bogus.log" 2>&1; rc=$?
  n=$(ls -A "$d" 2>/dev/null | wc -l | tr -d ' ')
  [ "$rc" = 2 ] && [ "$n" = 0 ] && row "neg: --pack bogus" PASS "exit 2, target empty" \
    || row "neg: --pack bogus" FAIL "exit $rc, $n entries in target"

  d="$WORK/neg-statusline"; rm -rf "$d"
  cli "$d" --pack statusline >"$WORK/logs/neg-statusline.log" 2>&1; rc=$?
  grep -q 'harness-extras' "$WORK/logs/neg-statusline.log" && hint=yes || hint=no
  [ "$rc" = 2 ] && [ "$hint" = yes ] && row "neg: --pack statusline" PASS "exit 2, hints harness-extras" \
    || row "neg: --pack statusline" FAIL "exit $rc, hint=$hint"

  d="$WORK/neg-nested-adopt"; rm -rf "$d"
  mkdir -p "$d" && (cd "$d" && git init -q && echo '{"name":"x"}' >package.json)
  cli "$d" --adopt --pack github >"$WORK/logs/neg-adopt-pack.log" 2>&1; rc=$?
  [ "$rc" != 0 ] && [ -z "$(git -C "$d" status --porcelain | grep -v '^?? package.json')" ] \
    && row "neg: --adopt --pack" PASS "rejected (exit $rc), nothing written" \
    || row "neg: --adopt --pack" FAIL "exit $rc"
}

fresh() { # name pack...
  local name=$1; shift
  local d="$WORK/fresh-$name" args=() p
  for p in "$@"; do args+=(--pack "$p"); done
  rm -rf "$d"
  local t=$SECONDS
  cli "$d" ${args[@]+"${args[@]}"} >"$WORK/logs/fresh-$name.cli.log" 2>&1; rc=$?
  if [ "$rc" != 0 ]; then row "fresh: $name" FAIL "CLI exit $rc (logs/fresh-$name.cli.log)"; return; fi
  (cd "$d" && pnpm verify) >"$WORK/logs/fresh-$name.verify.log" 2>&1; vrc=$?
  note=""; vlog="fresh-$name.verify.log"
  case " $* " in *" publishing "*)
    if [ "$vrc" != 0 ]; then # the pack's documented required setup (its adoptNotes)
      (cd "$d" && pnpm add -D @changesets/cli && node bin/check-license-headers.mjs --fix) >"$WORK/logs/fresh-$name.setup.log" 2>&1
      (cd "$d" && pnpm verify) >"$WORK/logs/fresh-$name.verify2.log" 2>&1; vrc=$?
      note=" (first verify failed; passes after the pack's documented setup)"
      vlog="fresh-$name.verify2.log"
    fi ;;
  esac
  left=$(grep -rIlE '__[A-Z][A-Z_]+__' "$d" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=customize --exclude=pnpm-lock.yaml 2>/dev/null | head -3 | tr '\n' ' ')
  staged=$(find "$d" -name '*.staged' -not -path '*/node_modules/*' | head -3 | tr '\n' ' ')
  if [ "$vrc" = 0 ] && [ -z "$left" ] && [ -z "$staged" ]; then
    row "fresh: $name" PASS "verify ok, $((SECONDS - t))s$note"
  else
    row "fresh: $name" FAIL "verify=$vrc tokens=[${left}] staged=[${staged}] (logs/$vlog)"
  fi
}

adopt() { # name git-url
  local name=$1 url=$2 d="$WORK/adopt-$1"
  rm -rf "$d"
  if ! git clone -q --depth 1 -- "$url" "$d" >"$WORK/logs/adopt-$name.clone.log" 2>&1; then
    row "adopt: $name" SKIP "clone failed"; return
  fi
  cli "$d" --adopt >"$WORK/logs/adopt-$name.cli.log" 2>&1; rc=$?
  modified=$(git -C "$d" status --porcelain | grep -vE '^\?\?' | head -3 | tr '\n' ' ')
  stray=$(git -C "$d" status --porcelain -uall | grep -E '^\?\?' | sed 's/^?? //' \
    | grep -vE '^(\.groundwork/|\.claude/skills/customize/)' | head -3 | tr '\n' ' ')
  inv=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("schema "+j.schemaVersion)}catch(e){console.log("BAD")}' "$d/.groundwork/inventory.json" 2>/dev/null)
  cli "$d" --adopt >"$WORK/logs/adopt-$name.rerun.log" 2>&1; rrc=$?
  if [ "$rc" = 0 ] && [ "$rrc" = 0 ] && [ -z "$modified" ] && [ -z "$stray" ] && [ "$inv" != BAD ]; then
    row "adopt: $name" PASS "$inv, only .groundwork + customize skill written, rerun ok"
  else
    row "adopt: $name" FAIL "exit=$rc rerun=$rrc modified=[${modified}] stray=[${stray}] inv=$inv"
  fi
}

if [ "$SECTION" = all ] || [ "$SECTION" = negative ]; then negative; fi
if [ "$SECTION" = all ] || [ "$SECTION" = fresh ]; then
  fresh baseline
  for p in github harness-extras publishing quality supply-chain worktrees; do fresh "$p" "$p"; done
  fresh all-six github harness-extras publishing quality supply-chain worktrees
  fresh hooks-overlap harness-extras worktrees quality
  fresh ci-overlap github supply-chain publishing
fi
if [ "$SECTION" = all ] || [ "$SECTION" = adopt ]; then
  adopt ky https://github.com/sindresorhus/ky.git
  adopt tsup https://github.com/egoist/tsup.git
  adopt ni https://github.com/antfu-collective/ni.git
  # add your own project: ADOPT_URLS="name=url name2=url2"
  set -f
  for kv in ${ADOPT_URLS:-}; do
    n=${kv%%=*}; u=${kv#*=}
    case "$n" in ""|*[!0-9A-Za-z._-]*|-*) row "adopt: $n" FAIL "invalid name in ADOPT_URLS"; continue ;; esac
    case "$u" in ""|-*) row "adopt: $n" FAIL "invalid url in ADOPT_URLS"; continue ;; esac
    adopt "$n" "$u"
  done
  set +f
fi

echo
echo "== summary ($PKG, $PLATFORM)"
awk -F'\t' '{c[$2]++} END{for(k in c) printf "%s=%d  ", k, c[k]; print ""}' "$RESULTS"
echo "results: $RESULTS"
echo "logs:    $WORK/logs"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Soak: $PKG on $PLATFORM"
    echo
    echo "| Scenario | Status | Detail |"
    echo "| --- | --- | --- |"
    awk -F'\t' '{ gsub(/\|/, "\\|", $3); printf "| %s | %s | %s |\n", $1, $2, $3 }' "$RESULTS"
  } >>"$GITHUB_STEP_SUMMARY"
fi

bad=$(awk -F'\t' '$2 != "PASS" { n++ } END { print n + 0 }' "$RESULTS")
[ "$bad" = 0 ] || { echo "soak: $bad row(s) not PASS" >&2; exit 1; }
