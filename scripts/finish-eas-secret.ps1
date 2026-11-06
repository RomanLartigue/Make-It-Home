# Finishes the secret rotation on EAS (the build system).
# The main rotation script already updated the local files and the live server;
# only the build system failed because the variable existed TWICE and the
# delete command needed a human to pick from a list. This script runs the two
# deletes interactively (you pick), then re-creates the single new entry using
# the new secret already stored in .env - the value is never shown on screen.

$root = 'C:\Users\roman\Downloads\MakeItHome'
Set-Location $root

# Read the new secret from .env (never displayed).
$line = (Get-Content (Join-Path $root '.env')) | Where-Object { $_ -match '^EXPO_PUBLIC_REGISTRATION_SECRET=' } | Select-Object -First 1
$sec = ($line -replace '^EXPO_PUBLIC_REGISTRATION_SECRET=', '').Trim()
if (-not $sec -or $sec.Length -lt 20) {
  Write-Host 'Could not read the new secret from .env - tell Claude.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Deleting the two OLD copies. For each prompt: pick "production" if asked,' -ForegroundColor Yellow
Write-Host 'pick the variable (either row), and confirm with y. This runs TWICE.' -ForegroundColor Yellow
Write-Host ''
npx eas-cli env:delete --variable-name EXPO_PUBLIC_REGISTRATION_SECRET
npx eas-cli env:delete --variable-name EXPO_PUBLIC_REGISTRATION_SECRET

Write-Host ''
Write-Host 'Creating the single new copy...' -ForegroundColor Yellow
npx eas-cli env:create --name EXPO_PUBLIC_REGISTRATION_SECRET --value $sec --environment production --visibility sensitive --scope project | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Create FAILED - tell Claude. (The build system may have no secret right now.)' -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host 'EAS DONE - the build system now holds only the new secret.' -ForegroundColor Green
