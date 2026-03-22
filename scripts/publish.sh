#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Source NPM_TOKEN from .env if present
if [ -f "${REPO_ROOT}/.env" ]; then
  NPM_TOKEN=$(grep -E '^NPM_TOKEN=' "${REPO_ROOT}/.env" | head -1 | cut -d'=' -f2- | tr -d '"'"'" || true)
  if [ -n "$NPM_TOKEN" ]; then
    export NPM_TOKEN
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "${REPO_ROOT}/.npmrc"
    echo "==> Using NPM_TOKEN from .env"
  fi
fi

# --- Parse arguments ---
BUMP_TYPE="patch"  # default

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch) BUMP_TYPE="patch"; shift ;;
    --minor) BUMP_TYPE="minor"; shift ;;
    --major) BUMP_TYPE="major"; shift ;;
    --version)
      OVERRIDE_VERSION="$2"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--patch|--minor|--major|--version X.Y.Z]"
      exit 1
      ;;
  esac
done

# --- Detect current version ---
CURRENT_VERSION=$(jq -r '.version' "${REPO_ROOT}/package.json")
echo "Current version: ${CURRENT_VERSION}"

# --- Determine new version ---
if [ -n "${OVERRIDE_VERSION:-}" ]; then
  NEW_VERSION="$OVERRIDE_VERSION"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  case "$BUMP_TYPE" in
    major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    minor) NEW_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
    patch) NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  esac
fi

echo "New version: ${NEW_VERSION}"
echo ""

# --- Run tests ---
echo "==> Running tests..."
cd "$REPO_ROOT"
npx vitest run
echo ""

# --- Bump version in package.json ---
echo "==> Bumping version..."
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
echo ""

# --- Publish to npm ---
echo "==> Publishing @umgbhalla/pi-gigaplan@${NEW_VERSION}..."
npm publish --access public
echo ""

# --- Git commit and tag ---
echo "==> Creating git commit and tag..."
git add package.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
echo ""

echo "==> Done! Published @umgbhalla/pi-gigaplan@${NEW_VERSION}"
echo ""
echo "Next steps:"
echo "  git push origin main --tags"
echo "  pi install npm:@umgbhalla/pi-gigaplan"

# --- Cleanup .npmrc if we created it ---
if [ -f "${REPO_ROOT}/.npmrc" ]; then
  rm -f "${REPO_ROOT}/.npmrc"
fi
