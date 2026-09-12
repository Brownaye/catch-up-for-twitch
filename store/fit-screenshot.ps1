# Fits any screenshot to the Chrome Web Store spec: 1280x800, 24-bit PNG, no alpha.
# Scales to 1280 wide, then crops from the top to 800 tall (pads with the
# page background if the capture is too short).
#
#   powershell -ExecutionPolicy Bypass -File store/fit-screenshot.ps1 <input.png> <output.png>

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 800
$src = [System.Drawing.Image]::FromFile((Resolve-Path $In))
$scale = $W / $src.Width
$scaledH = [int][Math]::Round($src.Height * $scale)

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::FromArgb(0x0E, 0x0E, 0x10))   # --bg-deep
$g.DrawImage($src, 0, 0, $W, $scaledH)
$g.Dispose()

$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $src.Dispose()
Write-Host ("wrote {0} (1280x800 from {1}x{2}, kept top {3}%)" -f $Out, $src.Width, $src.Height, [int](100 * $H / $scaledH))
