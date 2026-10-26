param(
  [Parameter(Mandatory=$true)][string]$TextB64,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$Voice = 'Microsoft Huihui Desktop',
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { if ($Voice) { $s.SelectVoice($Voice) } } catch { }
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$s.Speak($text)
$s.Dispose()
if (-not (Test-Path $OutFile)) { throw "synthesis failed: no output" }
