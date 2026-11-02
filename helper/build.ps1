# Compila o Isekai Áudio com o compilador C# que já vem no Windows e coloca o .exe em resources/.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$dir = Join-Path $PSScriptRoot '..\resources'
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path $dir 'IsekaiAudio.exe'
& $csc /nologo /optimize+ /target:exe /platform:anycpu /codepage:65001 /out:$out (Join-Path $PSScriptRoot 'IsekaiAudio.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
