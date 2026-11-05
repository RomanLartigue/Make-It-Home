# Rotates the Make It Home registration secret everywhere it lives.
# Run AFTER deploying the server (the deploy removes the old leak at /app).
# The new secret is never printed to the screen.
#
# What it touches:
#   1. .env and server\.env on this computer (so local work keeps working)
#   2. Railway (the live server) - Railway restarts itself with the new value
#   3. EAS (the build system) - so build 49 bakes the new value into the app
#
# The EAS steps may ask "Are you sure?" - answer y. There are two delete
# prompts because the old variable existed twice.

$root = 'C:\Users\roman\Downloads\MakeItHome'

# Generate a strong random secret (64 characters, never displayed).
$bytes = New-Object byte[] 48
(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
$sec = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')

# 1) Local files ---------------------------------------------------------------
$appEnv = Join-Path $root '.env'
(Get-Content $appEnv) -replace '^EXPO_PUBLIC_REGISTRATION_SECRET=.*', "EXPO_PUBLIC_REGISTRATION_SECRET=$sec" |
  Set-Content $appEnv -Encoding ascii
$srvEnv = Join-Path $root 'server\.env'
(Get-Content $srvEnv) -replace '^REGISTRATION_SECRET=.*', "REGISTRATION_SECRET=$sec" |
  Set-Content $srvEnv -Encoding ascii
Write-Host ''
Write-Host 'Step 1 of 3 done: local files updated.' -ForegroundColor Green

# 2) Railway (live server) -----------------------------------------------------
Set-Location (Join-Path $root 'server')
railway variables --set "REGISTRATION_SECRET=$sec" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Railway update FAILED. Run "railway login" and then run this script again.' -ForegroundColor Red
  exit 1
}
Write-Host 'Step 2 of 3 done: live server updated (it restarts itself in ~1 minute).' -ForegroundColor Green

# 3) EAS (build system, used by the next TestFlight build) ---------------------
Set-Location $root
# Two deletes: the variable existed twice. A "not found" on the second is fine.
npx eas-cli env:delete --variable-name EXPO_PUBLIC_REGISTRATION_SECRET --variable-environment production
npx eas-cli env:delete --variable-name EXPO_PUBLIC_REGISTRATION_SECRET --variable-environment production
npx eas-cli env:create --name EXPO_PUBLIC_REGISTRATION_SECRET --value $sec --environment production --visibility sensitive --scope project | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'EAS update FAILED. Tell Claude - the build system still has the old secret.' -ForegroundColor Red
  exit 1
}
Write-Host 'Step 3 of 3 done: build system updated.' -ForegroundColor Green
Write-Host ''
Write-Host 'ROTATION COMPLETE - the old leaked secret is now useless everywhere.' -ForegroundColor Green
Write-Host 'Heads up: new installs of build 48 cannot register anymore; build 49 fixes that.'
