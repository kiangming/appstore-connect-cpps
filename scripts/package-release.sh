#!/bin/bash
# Tạo release package để distribute cho user
# Usage: ./scripts/package-release.sh [version]
# Output: dist/cpp-manager-v{version}.zip

set -e
cd "$(dirname "$0")/.."

VERSION=${1:-"1.0.0"}
DIST_DIR="dist"
PACKAGE_NAME="cpp-manager-v${VERSION}"
PACKAGE_DIR="${DIST_DIR}/${PACKAGE_NAME}"

echo "📦  Building CPP Manager v${VERSION}..."

# ── 1. Build Next.js ──────────────────────────────────────────────────────────
echo "🔨  Running next build..."
npm run build

# ── 2. Prepare package directory ─────────────────────────────────────────────
rm -rf "${PACKAGE_DIR}"
mkdir -p "${PACKAGE_DIR}"

# Copy standalone server
cp -r .next/standalone/. "${PACKAGE_DIR}/"

# Copy static assets (required, not included in standalone)
mkdir -p "${PACKAGE_DIR}/.next/static"
cp -r .next/static/. "${PACKAGE_DIR}/.next/static/"

# Copy public folder
cp -r public/. "${PACKAGE_DIR}/public/"

# Copy startup script + env loader + env example
cp start.command "${PACKAGE_DIR}/start.command"
cp load-env.cjs "${PACKAGE_DIR}/load-env.cjs"
cp .env.example "${PACKAGE_DIR}/.env.example"
chmod +x "${PACKAGE_DIR}/start.command"

# ── 3. Zip ────────────────────────────────────────────────────────────────────
echo "🗜️   Creating zip..."
cd "${DIST_DIR}"
zip -r "${PACKAGE_NAME}.zip" "${PACKAGE_NAME}" -x "*.DS_Store"
cd ..

echo ""
echo "✅  Package ready: ${DIST_DIR}/${PACKAGE_NAME}.zip"
echo ""
echo "    Gửi file zip này cho user."
echo "    User cần:"
echo "    1. Unzip"
echo "    2. Copy .env.example → .env.local, điền thông tin"
echo "    3. Double-click start.command"
