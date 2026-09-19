$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$scratchBase = Join-Path $projectDirectory '.test-brains'
$installationDirectory = Join-Path $scratchBase ('fresh-install-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $installationDirectory -Force | Out-Null
try {
  foreach ($item in @('package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','server','ui','scripts')) {
    Copy-Item -LiteralPath (Join-Path $projectDirectory $item) -Destination $installationDirectory -Recurse
  }
  Push-Location $installationDirectory
  try {
    npm ci --offline --cache (Join-Path $projectDirectory '.npm-cache')
    if ($LASTEXITCODE -ne 0) { throw 'Clean npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Clean build failed' }
    node scripts/smoke-install.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Clean smoke test failed' }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Path (Join-Path $projectDirectory 'artifacts') -Force | Out-Null
  [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); install = 'npm ci --offline (local package cache)'; build = 'passed'; smoke = 'passed'; node = (node --version) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectDirectory 'artifacts/fresh-install.json')
} finally {
  $resolvedTarget = [IO.Path]::GetFullPath($installationDirectory)
  $resolvedBase = [IO.Path]::GetFullPath($scratchBase) + [IO.Path]::DirectorySeparatorChar
  if (!$resolvedTarget.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside test workspace' }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}
