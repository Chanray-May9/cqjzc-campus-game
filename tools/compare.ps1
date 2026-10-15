# Stack a reference photograph and the matching model render into one sheet so
# every building can be checked side by side.
#
#   pwsh -File tools/compare.ps1 -Photo <img> -Render <img> -Out <png> [-Labels "a,b,c"]
param(
  [Parameter(Mandatory=$true)][string]$Photo,
  [Parameter(Mandatory=$true)][string]$Render,
  [Parameter(Mandatory=$true)][string]$Out,
  [string[]]$Labels = @()
)
Add-Type -AssemblyName System.Drawing

$W = 1600
function Fit($img, $w) {
  $h = [int]($img.Height * $w / $img.Width)
  $b = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose()
  return $b
}

$p = [System.Drawing.Image]::FromFile((Resolve-Path $Photo))
$r = [System.Drawing.Image]::FromFile((Resolve-Path $Render))
$pb = Fit $p $W
$rb = Fit $r $W
$H = $pb.Height + $rb.Height + 44
$sheet = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::FromArgb(24,24,28))
$g.DrawImage($pb, 0, 22)
$g.DrawImage($rb, 0, $pb.Height + 44)
$font  = New-Object System.Drawing.Font("Microsoft YaHei", 13, [System.Drawing.FontStyle]::Bold)
$white = [System.Drawing.Brushes]::White
$amber = [System.Drawing.Brushes]::Orange
$g.DrawString("官方实景 / OFFICIAL PHOTO", $font, $white, 8, 2)
$g.DrawString("我的模型 / MY MODEL", $font, $amber, 8, ($pb.Height + 24))
if ($Labels.Count) {
  $f2 = New-Object System.Drawing.Font("Microsoft YaHei", 11)
  $y = 6
  foreach ($l in $Labels) { $g.DrawString($l, $f2, $white, ($W - 360), $y); $y += 20 }
}
$g.Dispose()
$sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"wrote $Out  ${W}x${H}"
$pb.Dispose(); $rb.Dispose(); $p.Dispose(); $r.Dispose(); $sheet.Dispose()
