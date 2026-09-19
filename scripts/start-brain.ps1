param([string]$BrainDirectory = '', [int]$Port = 4589)
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $projectDirectory 'dist\server\cli.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Build the application first with npm ci and npm run build.' }
if (-not $BrainDirectory) { $BrainDirectory = Join-Path $projectDirectory '.brain' }
& node $entry serve --brain $BrainDirectory --port $Port --open
