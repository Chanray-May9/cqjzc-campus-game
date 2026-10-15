# Draw a coordinate grid on a reference image crop so features can be measured
# instead of eyeballed.
#
#   pwsh -File tools/ruler.ps1 -Src <img> -OutDir <dir> -Zoom 2.0 `
#        -Regions name:x0,y0,x1,y1, name2:...
param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [double]$Zoom = 2.0,
  [Parameter(Mandatory=$true)][string[]]$Regions,
  [int]$Grid = 100
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))
Write-Host ("src {0}x{1}" -f $img.Width, $img.Height)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$font = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Yellow
$pen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140,0,0,0)), 1
$edge  = New-Object System.Drawing.Pen ([System.Drawing.Color]::Yellow), 1

foreach ($spec in $Regions) {
  $i = $spec.IndexOf(':'); $name = $spec.Substring(0,$i)
  $b = $spec.Substring($i+1) -split ','
  $x0=[int]$b[0]; $y0=[int]$b[1]; $x1=[int]$b[2]; $y1=[int]$b[3]
  $x0=[Math]::Max(0,$x0); $y0=[Math]::Max(0,$y0)
  $x1=[Math]::Min($img.Width,$x1); $y1=[Math]::Min($img.Height,$y1)
  $w=$x1-$x0; $h=$y1-$y0
  $ow=[int]($w*$Zoom); $oh=[int]($h*$Zoom)
  $bmp = New-Object System.Drawing.Bitmap($ow,$oh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img,(New-Object System.Drawing.Rectangle(0,0,$ow,$oh)),
                    (New-Object System.Drawing.Rectangle($x0,$y0,$w,$h)),
                    [System.Drawing.GraphicsUnit]::Pixel)
  # grid in source-pixel coordinates
  $gs = [int]($Grid*$Zoom)
  for ($px = ($Grid - ($x0 % $Grid)) % $Grid; $px -lt $ow; $px += $gs) {
    $g.DrawLine($pen, $px, 0, $px, $oh); $g.DrawString("$([int]($x0+$px/$Zoom))", $font, $brush, ($px+2), 2)
  }
  for ($py = ($Grid - ($y0 % $Grid)) % $Grid; $py -lt $oh; $py += $gs) {
    $g.DrawLine($pen, 0, $py, $ow, $py); $g.DrawString("$([int]($y0+$py/$Zoom))", $font, $brush, 2, ($py+2))
  }
  $g.DrawRectangle($edge,0,0,($ow-1),($oh-1))
  $g.Dispose()
  $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("{0,-16} x[{1}..{2}] y[{3}..{4}] -> {5}x{6}" -f $name,$x0,$x1,$y0,$y1,$ow,$oh)
}
$img.Dispose()
