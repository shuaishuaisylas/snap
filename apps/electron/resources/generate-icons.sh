#!/bin/bash
# 用现有 Sharp 依赖，将用户提供的 Snap 原图适配为各平台图标。
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
exec bun run scripts/generate-brand-assets.ts
