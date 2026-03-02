# ============================================================
#  Install Pi with LLM retry resilience (adaloveless fork)
#
#  Prerequisites: Node.js >= 20, npm, git
#  Run in PowerShell: irm https://raw.githubusercontent.com/adaloveless/pi-mono/feat/llm-retry-resilience/install-pi-retry.ps1 | iex
# ============================================================

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\pi-mono"
$Branch = "feat/llm-retry-resilience"
$Repo = "https://github.com/adaloveless/pi-mono.git"

Write-Host ""
Write-Host "=== Installing Pi (retry-resilient fork) ===" -ForegroundColor Cyan
Write-Host "    Repo:   $Repo"
Write-Host "    Branch: $Branch"
Write-Host "    Dir:    $InstallDir"
Write-Host ""

# Check Node.js
try {
    $nodeVersion = (node --version 2>$null)
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 20) {
        Write-Host "ERROR: Node.js >= 20 required. Found: $nodeVersion" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Node.js $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (>= 20)" -ForegroundColor Red
    exit 1
}

# Check git
try {
    git --version | Out-Null
    Write-Host "[OK] git found" -ForegroundColor Green
} catch {
    Write-Host "ERROR: git not found. Install from https://git-scm.com" -ForegroundColor Red
    exit 1
}

# Clone or update
if (Test-Path $InstallDir) {
    Write-Host "[1/4] Updating existing clone..." -ForegroundColor Yellow
    Push-Location $InstallDir
    git fetch origin
    git checkout $Branch
    git pull origin $Branch
    Pop-Location
} else {
    Write-Host "[1/4] Cloning..." -ForegroundColor Yellow
    git clone --branch $Branch $Repo $InstallDir
}

# Install dependencies
Write-Host "[2/4] Installing dependencies..." -ForegroundColor Yellow
Push-Location $InstallDir
npm install

# Build
Write-Host "[3/4] Building..." -ForegroundColor Yellow
npm run build

# Link globally
Write-Host "[4/4] Linking pi CLI globally..." -ForegroundColor Yellow
npm uninstall -g @mariozechner/pi-coding-agent 2>$null
Push-Location "$InstallDir\packages\coding-agent"
npm link
Pop-Location
Pop-Location

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Green
$version = pi --version
Write-Host "Pi version: $version" -ForegroundColor Green
Write-Host ""

# Create config directory
$piAgentDir = "$env:USERPROFILE\.pi\agent"
if (!(Test-Path $piAgentDir)) {
    New-Item -ItemType Directory -Path $piAgentDir -Force | Out-Null
}

# Write models.json if it doesn't exist
$modelsFile = "$piAgentDir\models.json"
if (!(Test-Path $modelsFile)) {
    Write-Host "Creating default models.json..." -ForegroundColor Yellow
    $lmStudioIP = Read-Host "Enter your LM Studio server IP (e.g. 192.168.1.100, or localhost)"
    @"
{
  "providers": {
    "lm-studio": {
      "baseUrl": "http://${lmStudioIP}:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "qwen3.5-122b-a10b",
          "name": "Qwen3.5 122B MoE (Local)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
"@ | Set-Content -Path $modelsFile -Encoding UTF8
    Write-Host "Wrote $modelsFile" -ForegroundColor Green
} else {
    Write-Host "models.json already exists, skipping." -ForegroundColor DarkGray
}

# Write settings.json if it doesn't exist
$settingsFile = "$piAgentDir\settings.json"
if (!(Test-Path $settingsFile)) {
    @"
{
  "defaultProvider": "lm-studio",
  "defaultModel": "qwen3.5-122b-a10b"
}
"@ | Set-Content -Path $settingsFile -Encoding UTF8
    Write-Host "Wrote $settingsFile" -ForegroundColor Green
} else {
    Write-Host "settings.json already exists, skipping." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Ready! Test with: pi --mode text 'say hello' ===" -ForegroundColor Cyan
Write-Host ""
