# Generates icons/icon{16,32,48,128}.png.
# Same composition as the Uptime Badges icon (purple rounded tile, black
# disc, red dot top-right) with an inbox tray + play triangle instead of a
# clock. Rendered at 512px and downscaled so the small sizes stay crisp.
#
#   powershell -ExecutionPolicy Bypass -File icons/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$S = 512

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$purple = [System.Drawing.Color]::FromArgb(255, 0x91, 0x47, 0xFF)
$black  = [System.Drawing.Color]::FromArgb(255, 0x0E, 0x0E, 0x10)
$white  = [System.Drawing.Color]::FromArgb(255, 0xFF, 0xFF, 0xFF)
$red    = [System.Drawing.Color]::FromArgb(255, 0xE9, 0x19, 0x16)

# Tile
$tile = New-RoundedRect 0 0 $S $S 112
$g.FillPath((New-Object System.Drawing.SolidBrush $purple), $tile)

# Disc
$cx = 256; $cy = 262; $r = 164
$g.FillEllipse((New-Object System.Drawing.SolidBrush $black), $cx - $r, $cy - $r, $r * 2, $r * 2)

# Inbox tray (open-top U with the classic notch)
$pen = New-Object System.Drawing.Pen $white, 30
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$tray = New-Object System.Drawing.Drawing2D.GraphicsPath
$tray.AddLine(160, 250, 160, 330)
$tray.AddArc(160, 300, 60, 60, 180, -90)   # bottom-left corner
$tray.AddLine(190, 360, 322, 360)
$tray.AddArc(292, 300, 60, 60, 90, -90)    # bottom-right corner
$tray.AddLine(352, 330, 352, 250)
$g.DrawPath($pen, $tray)

$notch = New-Object System.Drawing.Drawing2D.GraphicsPath
$notch.AddLine(160, 290, 208, 290)
$notch.AddLine(208, 290, 228, 318)
$notch.AddLine(228, 318, 284, 318)
$notch.AddLine(284, 318, 304, 290)
$notch.AddLine(304, 290, 352, 290)
$g.DrawPath($pen, $notch)

# Play triangle above the tray
$tri = New-Object System.Drawing.Drawing2D.GraphicsPath
$tri.AddPolygon([System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF 226, 150),
  (New-Object System.Drawing.PointF 226, 236),
  (New-Object System.Drawing.PointF 302, 193)
))
$g.FillPath((New-Object System.Drawing.SolidBrush $white), $tri)
$triPen = New-Object System.Drawing.Pen $white, 18
$triPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawPath($triPen, $tri)

# Red unread dot, top-right, with a purple ring so it sits on the disc edge
$dr = 44; $dx = 398; $dy = 118
$g.FillEllipse((New-Object System.Drawing.SolidBrush $purple), $dx - $dr - 12, $dy - $dr - 12, ($dr + 12) * 2, ($dr + 12) * 2)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $red), $dx - $dr, $dy - $dr, $dr * 2, $dr * 2)

$g.Dispose()

foreach ($size in 16, 32, 48, 128) {
  $out = New-Object System.Drawing.Bitmap $size, $size
  $og = [System.Drawing.Graphics]::FromImage($out)
  $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $og.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $og.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $og.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $og.Clear([System.Drawing.Color]::Transparent)
  $og.DrawImage($bmp, 0, 0, $size, $size)
  $og.Dispose()
  $path = Join-Path $here "icon$size.png"
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host "wrote $path"
}
$bmp.Dispose()
