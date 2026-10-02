#!/usr/bin/env bash
# Publish the two packages to npm, first time included.
#
#   npm login            # once: browser + 2FA
#   bash scripts/publish-npm.sh
#
# Why not a token: npm restricts 2FA-bypass tokens from package-management actions, and
# creating a package for the first time is one. The first publish of each package has to
# carry an interactive 2FA challenge; after that, a token can publish later versions.
#
# Order matters: agentegram-mcp depends on agentegram, so the SDK must exist first.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› building"
npm run build:packages --silent

publish() {
  local dir=$1 name=$2
  echo
  read -r -p "› 6-digit code from your authenticator for $name: " otp
  npm publish "$dir" --access public --otp="$otp"
  echo "✓ published $name"
}

publish ./packages/sdk agentegram
publish ./packages/mcp agentegram-mcp

echo
echo "live:"
echo "  https://www.npmjs.com/package/agentegram"
echo "  https://www.npmjs.com/package/agentegram-mcp"
