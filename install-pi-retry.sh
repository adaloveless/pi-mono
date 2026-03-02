#!/usr/bin/env bash
set -e

# ============================================================
#  Install Pi with LLM retry resilience (adaloveless fork)
#
#  Prerequisites: Node.js >= 20, npm, git
#  Works on: Windows (Git Bash/MSYS2), macOS, Linux
# ============================================================

INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/pi-mono}"
BRANCH="feat/llm-retry-resilience"
REPO="https://github.com/adaloveless/pi-mono.git"

echo "=== Installing Pi (retry-resilient fork) ==="
echo "    Repo:   $REPO"
echo "    Branch: $BRANCH"
echo "    Dir:    $INSTALL_DIR"
echo ""

# Check prerequisites
if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js not found. Install Node.js >= 20 first."
    exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "ERROR: Node.js >= 20 required. Found: $(node --version)"
    exit 1
fi

if ! command -v git &>/dev/null; then
    echo "ERROR: git not found."
    exit 1
fi

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
    echo "[1/4] Updating existing clone..."
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
else
    echo "[1/4] Cloning..."
    git clone --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo "[2/4] Installing dependencies..."
npm install

# Build
echo "[3/4] Building..."
npm run build

# Uninstall any existing global pi, then link this one
echo "[4/4] Linking pi CLI globally..."
npm uninstall -g @mariozechner/pi-coding-agent 2>/dev/null || true
cd "$INSTALL_DIR/packages/coding-agent"
npm link

echo ""
echo "=== Done! ==="
echo ""
pi --version
echo ""
echo "Pi is ready. Configure your LM Studio endpoint:"
echo ""
echo '  mkdir -p ~/.pi/agent'
echo '  cat > ~/.pi/agent/models.json << '"'"'MODELS'"'"''
echo '  {'
echo '    "providers": {'
echo '      "lm-studio": {'
echo '        "baseUrl": "http://YOUR_LM_STUDIO_IP:1234/v1",'
echo '        "api": "openai-completions",'
echo '        "apiKey": "lm-studio",'
echo '        "compat": {'
echo '          "supportsUsageInStreaming": false,'
echo '          "maxTokensField": "max_tokens"'
echo '        },'
echo '        "models": ['
echo '          {'
echo '            "id": "qwen3.5-122b-a10b",'
echo '            "name": "Qwen3.5 122B MoE (Local)",'
echo '            "reasoning": true,'
echo '            "input": ["text", "image"],'
echo '            "contextWindow": 131072,'
echo '            "maxTokens": 16384,'
echo '            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }'
echo '          }'
echo '        ]'
echo '      }'
echo '    }'
echo '  }'
echo '  MODELS'
echo ""
echo "Then set default provider:"
echo ""
echo '  cat > ~/.pi/agent/settings.json << '"'"'SETTINGS'"'"''
echo '  {'
echo '    "defaultProvider": "lm-studio",'
echo '    "defaultModel": "qwen3.5-122b-a10b"'
echo '  }'
echo '  SETTINGS'
echo ""
echo "Test: pi --mode text 'say hello'"
