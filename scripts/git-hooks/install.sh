#!/bin/sh
# Installs trm's tracked git hooks into .git/hooks (untracked by git itself).
set -e
ROOT="$(git rev-parse --show-toplevel)"
cp "$ROOT/scripts/git-hooks/pre-push" "$ROOT/.git/hooks/pre-push"
chmod +x "$ROOT/.git/hooks/pre-push"
echo "installed pre-push hook (full jest suite gate)"
