#!/usr/bin/env bash
# The scaffold every case runs, from the run's empty working directory: a
# checkout of the pinned head, with the pinned base beside it, and nothing
# from the current main.
#
#   checkout.sh <repo> <base> <head> <branch> <base-ref>
#
# <repo> is the local clone `scripts/eval-prompts.ts` already fetched both
# commits into. Fetched by SHA, which a local upload-pack serves only when told
# it may, so no ref is added to that clone. The branch is checked out at the
# head, `origin/<branch>` points at the head and `origin/<base-ref>` at the
# base, the refs a runner's checkout has. The dependencies are a copy of the
# clone's own where the lockfile matches, so a run that installs something
# cannot change the clone's, and are installed from the lockfile where it does
# not.
set -euo pipefail

repo=$1 base=$2 head=$3 branch=$4 base_ref=$5

git init -q .
git -c protocol.file.allow=always fetch -q --no-tags \
  --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' \
  "$repo" "$base" "$head"
git update-ref "refs/remotes/origin/$base_ref" "$base"
git update-ref "refs/remotes/origin/$branch" "$head"
git checkout -q -b "$branch" "$head"
git config user.name "eval"
git config user.email "eval@example.invalid"

if cmp -s package-lock.json "$repo/package-lock.json" && [ -d "$repo/node_modules" ]; then
  cp -R "$repo/node_modules" node_modules
else
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null
fi
