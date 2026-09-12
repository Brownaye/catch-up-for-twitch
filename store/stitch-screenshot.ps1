# Builds a 1280x800 store screenshot from a taller capture by keeping chosen
# horizontal bands (in source pixels) and dropping the rest, so the frame can
# show the top of a list AND its footer without cutting a row in half.
#
#   powershell -ExecutionPolicy Bypass -File store/stitch-screenshot.ps1 <in.png> <out.png> "0-905,1178-1200"
#
# Bands are concatenated top to bottom, scaled to 1280 wide, then cropped or
# padded (with the page background) to 800 tall. Output is 24-bit PNG.

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Keep
)

Add-Type -AssemblyName System.Drawing

$W = 1280; $H = 800
$src = [System.Drawing.Image]::FromFile((Resolve-Path $In))

$bands = @()
foreach ($part in $Keep -split ",") {
  $a, $b = $part.Trim() -split "-"
  $y0 = [int]$a; $y1 = [Math]::Min([int]$b, $src.Height)
  if ($y1 -gt $y0) { $bands += ,@($y0, $y1) }
}
$totalH = ($bands | ForEach-Object { $_[1] - $_[0] } | Measure-Object -Sum).Sum

# 1. stitch at source resolution
$stitched = New-Object System.Drawing.Bitmap $src.Width, $totalH
$sg = [System.Drawing.Graphics]::FromImage($stitched)
$y = 0
foreach ($band in $bands) {
  $bandH = $band[1] - $band[0]
  $dest = New-Object System.Drawing.Rectangle 0, $y, $src.Width, $bandH
  $from = New-Object System.Drawing.Rectangle 0, $band[0], $src.Width, $bandH
  $sg.DrawImage($src, $dest, $from, [System.Drawing.GraphicsUnit]::Pixel)
  $y += $bandH
}
$sg.Dispose()

# 2. scale to 1280 wide onto a 1280x800 24-bit canvas
$scale = $W / $stitched.Width
$scaledH = [int][Math]::Round($stitched.Height * $scale)
$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::FromArgb(0x0E, 0x0E, 0x10))
$g.DrawImage($stitched, 0, 0, $W, $scaledH)
$g.Dispose()

$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("wrote {0}: bands {1} -> {2}px tall at source, scaled to {3}px (target 800)" -f $Out, $Keep, $totalH, $scaledH)
$bmp.Dispose(); $stitched.Dispose(); $src.Dispose()
