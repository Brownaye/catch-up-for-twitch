# Fits any screenshot to the Chrome Web Store spec: 1280x800, 24-bit PNG, no alpha.
#
# Default: scale to 1280 wide, crop from the top to 800 tall.
# -Center: keep the capture at its own size (or scaled down if too big) and
#          place it in the middle of a 1280x800 canvas with the app's purple
#          gradient background. Use this for the toolbar popup.
#
#   powershell -ExecutionPolicy Bypass -File store/fit-screenshot.ps1 <input.png> <output.png> [-Center]

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Center
)

Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 800
$src = [System.Drawing.Image]::FromFile((Resolve-Path $In))

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::FromArgb(0x0E, 0x0E, 0x10))   # --bg-deep

if ($Center) {
  # Same two purple glows as welcome.html / app.html
  foreach ($glow in @(
      @{ x = 0.85; y = -0.10; rx = 0.9; ry = 1.6; c = [System.Drawing.Color]::FromArgb(150, 100, 44, 165) },
      @{ x = -0.10; y = 1.10; rx = 0.7; ry = 1.6; c = [System.Drawing.Color]::FromArgb(110, 70, 30, 120) })) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rw = $W * $glow.rx; $rh = $H * $glow.ry
    $path.AddEllipse([float]($W * $glow.x - $rw / 2), [float]($H * $glow.y - $rh / 2), [float]$rw, [float]$rh)
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
    $brush.CenterColor = $glow.c
    $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 14, 14, 16))
    $g.FillPath($brush, $path)
  }
  $maxW = $W - 160; $maxH = $H - 120
  $s = [Math]::Min(1.0, [Math]::Min($maxW / $src.Width, $maxH / $src.Height))
  $dw = [int]($src.Width * $s); $dh = [int]($src.Height * $s)
  $dx = [int](($W - $dw) / 2); $dy = [int](($H - $dh) / 2)
  # soft shadow
  $sh = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sh.AddEllipse([float]($dx - 40), [float]($dy - 10), [float]($dw + 80), [float]($dh + 80))
  $sb = New-Object System.Drawing.Drawing2D.PathGradientBrush $sh
  $sb.CenterColor = [System.Drawing.Color]::FromArgb(160, 0, 0, 0)
  $sb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.FillPath($sb, $sh)
  $g.DrawImage($src, $dx, $dy, $dw, $dh)
  $mode = "centred at {0}x{1}" -f $dw, $dh
} else {
  $scale = $W / $src.Width
  $scaledH = [int][Math]::Round($src.Height * $scale)
  $g.DrawImage($src, 0, 0, $W, $scaledH)
  $mode = "kept top {0}%" -f [int](100 * [Math]::Min(1.0, $H / $scaledH))
}
$g.Dispose()

$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$w0 = $src.Width; $h0 = $src.Height
$bmp.Dispose(); $src.Dispose()
Write-Host ("wrote {0} (1280x800 from {1}x{2}, {3})" -f $Out, $w0, $h0, $mode)
