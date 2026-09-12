# Generates the Chrome Web Store promo tiles (24-bit PNG, no alpha):
#   store/small-promo-tile.png   440x280
#   store/marquee-promo-tile.png 1400x560
#
#   powershell -ExecutionPolicy Bypass -File store/make-promo.ps1

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$icon = [System.Drawing.Image]::FromFile((Join-Path $here "..\icons\icon128.png"))

function New-Tile([int]$w, [int]$h, [string]$out, [float]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  # Background: --bg-deep plus the two purple radial glows from welcome.html
  $g.Clear([System.Drawing.Color]::FromArgb(0x0E, 0x0E, 0x10))
  foreach ($glow in @(
      @{ x = 0.85; y = -0.10; rx = 0.9; ry = 1.6; c = [System.Drawing.Color]::FromArgb(150, 100, 44, 165) },
      @{ x = -0.10; y = 1.10; rx = 0.7; ry = 1.6; c = [System.Drawing.Color]::FromArgb(110, 70, 30, 120) })) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rw = $w * $glow.rx; $rh = $h * $glow.ry
    $path.AddEllipse([float]($w * $glow.x - $rw / 2), [float]($h * $glow.y - $rh / 2), [float]$rw, [float]$rh)
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
    $brush.CenterColor = $glow.c
    $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 14, 14, 16))
    $g.FillPath($brush, $path)
  }

  # Icon with a soft purple shadow. Small tile stacks icon over text; marquee is a row.
  $stack = $w -lt 800
  $size = [int](128 * $scale)
  $pad = [int](40 * $scale)
  if ($stack) { $size = 96; $ix = [int](($w - $size) / 2); $iy = 34 }
  else { $ix = $pad; $iy = [int](($h - $size) / 2) }
  $shadow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shadow.AddEllipse([float]($ix - 10 * $scale), [float]($iy + 10 * $scale), [float]($size + 20 * $scale), [float]($size + 20 * $scale))
  $sb = New-Object System.Drawing.Drawing2D.PathGradientBrush $shadow
  $sb.CenterColor = [System.Drawing.Color]::FromArgb(120, 145, 71, 255)
  $sb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 14, 14, 16))
  $g.FillPath($sb, $shadow)
  $g.DrawImage($icon, $ix, $iy, $size, $size)

  # Text
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xEF, 0xEF, 0xF1))
  $muted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xAD, 0xAD, 0xB8))
  $title = "Catch Up for Twitch"
  $tag1 = "Never miss a stream again."
  $tag2 = "An inbox of the VODs you slept through."
  if ($stack) {
    $titleFont = New-Object System.Drawing.Font "Segoe UI", ([float]22), ([System.Drawing.FontStyle]::Bold)
    $tagFont = New-Object System.Drawing.Font "Segoe UI", ([float]12)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $cx = [float]($w / 2)
    $g.DrawString($title, $titleFont, $white, $cx, [float]150, $fmt)
    $g.DrawString($tag1, $tagFont, $muted, $cx, [float]192, $fmt)
    $g.DrawString($tag2, $tagFont, $muted, $cx, [float]214, $fmt)
  } else {
    $titleFont = New-Object System.Drawing.Font "Segoe UI", ([float](30 * $scale)), ([System.Drawing.FontStyle]::Bold)
    $tagFont = New-Object System.Drawing.Font "Segoe UI", ([float](15 * $scale))
    $tx = $ix + $size + [int](28 * $scale)
    $th = $g.MeasureString($title, $titleFont).Height
    $gh = $g.MeasureString($tag1, $tagFont).Height
    $blockH = $th + $gh * 2
    $ty = ($h - $blockH) / 2
    $g.DrawString($title, $titleFont, $white, [float]$tx, [float]$ty)
    $g.DrawString($tag1, $tagFont, $muted, [float]($tx + 3 * $scale), [float]($ty + $th - 2 * $scale))
    $g.DrawString($tag2, $tagFont, $muted, [float]($tx + 3 * $scale), [float]($ty + $th + $gh - 4 * $scale))
  }

  $g.Dispose()
  $bmp.Save((Join-Path $here $out), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote store/$out ($w x $h)"
}

New-Tile 440 280 "small-promo-tile.png" 1.0
New-Tile 1400 560 "marquee-promo-tile.png" 2.2
$icon.Dispose()
