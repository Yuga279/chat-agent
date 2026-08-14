# Builds and launches the whole chat-agent stack in one command.
# Opens each service in its own PowerShell window so logs stay visible.
# Requires: MongoDB already running as a service, .env files present in
# System1.MCP/ and server/.

$root = $PSScriptRoot

function Start-Service($title, $workDir, $command) {
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "cd '$workDir'; `$Host.UI.RawUI.WindowTitle = '$title'; $command"
    )
}

Write-Host "Building System1.MCP..."
Push-Location "$root\System1.MCP"
npm run build
Pop-Location

Write-Host "Building server..."
Push-Location "$root\server"
npm run build
Pop-Location

Write-Host "Building web frontend..."
Push-Location "$root\web"
npm run build
Pop-Location

Write-Host "Launching System1.MCP (port 3100)..."
Start-Service "System1.MCP" "$root\System1.MCP" "node --env-file=.env dist/index.js"

Write-Host "Launching LangGraph dev (port 2024)..."
Start-Service "LangGraph" "$root\server" "npm run graph:dev"

Write-Host "Launching chat-agent server (port 3200)..."
Start-Service "Server" "$root\server" "node --env-file=.env dist/index.js"

Write-Host "Launching web dev server (port 5173)..."
Start-Service "Web" "$root\web" "npm run dev"

Write-Host "Launching MCP Inspector (port 6274)..."
Start-Sleep -Seconds 2
Start-Service "MCP Inspector" "$root\System1.MCP" "npx @modelcontextprotocol/inspector@latest --web --transport http --server-url http://localhost:3100/mcp --header 'x-external-user-id: test-user'"

Write-Host "Waiting for web dev server to be ready..."
$webReady = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 1 | Out-Null
        $webReady = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($webReady) {
    Write-Host "Opening app in browser..."
    Start-Process "http://localhost:5173"
} else {
    Write-Host "Web dev server didn't respond in time - open http://localhost:5173 manually."
}

Write-Host ""
Write-Host "All services launched."
Write-Host "MCP Inspector UI will open at http://localhost:6274, pre-connected to http://localhost:3100/mcp with the required x-external-user-id header."
