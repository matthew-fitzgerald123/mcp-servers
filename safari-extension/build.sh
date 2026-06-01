#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XCODE_OUT="$HOME/mcp-servers/safari-extension-xcode"

echo "Generating icons..."
node "$SCRIPT_DIR/icons/generate.js"

echo "Converting to Safari Web Extension..."
xcrun safari-web-extension-converter \
  "$SCRIPT_DIR" \
  --project-location "$XCODE_OUT" \
  --app-name "JobTracker" \
  --bundle-identifier "com.matthewfitzgerald.jobtracker" \
  --no-open

echo ""
echo "Done. Next steps:"
echo "  1. open $XCODE_OUT/JobTracker.xcodeproj"
echo "  2. In Xcode: Product > Run  (builds and installs to Safari)"
echo "  3. In Safari: Settings > Extensions > enable 'Job Tracker'"
echo "  4. In Safari: Develop > Allow Unsigned Extensions (first time only)"
