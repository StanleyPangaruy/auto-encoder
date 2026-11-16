# Puts an "Auto-Encoder" shortcut on this user's desktop (and in the Start menu) that starts the app.
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) '')
)
foreach ($folder in $places) {
  $link = $shell.CreateShortcut((Join-Path $folder 'Auto-Encoder.lnk'))
  $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $link.Arguments = '"' + (Join-Path $root 'start-app.vbs') + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root 'assets\app.ico') + ',0'
  $link.Description = 'Encode purchases and BIR 2307 from scans'
  $link.Save()
  Write-Output "Shortcut created: $(Join-Path $folder 'Auto-Encoder.lnk')"
}
