$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) { Write-Host '.env already exists; preserved.'; exit 0 }
function New-RandomBase64([int]$length) {
    $bytes = New-Object byte[] $length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes)
}
$appKey = New-RandomBase64 32
$dbPassword = New-RandomBase64 24
$webhookToken = New-RandomBase64 32
$content = "APP_KEY=base64:$appKey`nDB_PASSWORD=$dbPassword`nWEBHOOK_TOKEN=$webhookToken`nAPP_PORT=8180`nWEB_PORT=5180`n"
[System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Generated .env with random local secrets. It is ignored by Git.'
