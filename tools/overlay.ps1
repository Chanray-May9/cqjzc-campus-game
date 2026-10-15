# Draw the ACTUAL layout.py polygons on the completed satellite photograph.
param([string]$Sat='reference/sat/sat_done.jpg',[string]$Out='reference/OVERLAY_ON_SATELLITE.png',
      [double]$PxPerM=1.465,[double]$Ox=337,[double]$Oy=690)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$layout = (& python -X utf8 tools/layout_snapshot.py | ConvertFrom-Json)
function Pixel([double]$x,[double]$y) {
  return [System.Drawing.PointF]::new([float]($Ox+($x+30)*$PxPerM),[float]($Oy-($y+132)*$PxPerM))
}
function Polygon($points,$pen) {
  $pts=[System.Drawing.PointF[]]@($points | ForEach-Object { Pixel $_[0] $_[1] })
  $gr.DrawPolygon($pen,$pts)
}
$source=[System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Sat))
$bitmap=[System.Drawing.Bitmap]::new($source.Width,$source.Height)
$gr=[System.Drawing.Graphics]::FromImage($bitmap)
$gr.DrawImage($source,0,0,$source.Width,$source.Height)
$gr.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$red=[System.Drawing.Pen]::new([System.Drawing.Color]::Red,1.8)
$yellow=[System.Drawing.Pen]::new([System.Drawing.Color]::Yellow,2)
$cyan=[System.Drawing.Pen]::new([System.Drawing.Color]::Cyan,1.5)
$green=[System.Drawing.Pen]::new([System.Drawing.Color]::Lime,1.5)
$font=[System.Drawing.Font]::new('Microsoft YaHei',8,[System.Drawing.FontStyle]::Bold)
foreach($b in $layout.buildings) {
  Polygon $b.points $red
  $cx=($b.points | ForEach-Object { $_[0] } | Measure-Object -Average).Average
  $cy=($b.points | ForEach-Object { $_[1] } | Measure-Object -Average).Average
  $pt=Pixel $cx $cy
  $gr.DrawString($b.name,$font,[System.Drawing.Brushes]::White,$pt)
}
Polygon $layout.boundary $yellow
foreach($road in $layout.roads) {
  $pts=[System.Drawing.PointF[]]@($road.pts | ForEach-Object { Pixel $_[0] $_[1] })
  if($road.closed){$gr.DrawPolygon($cyan,$pts)}else{$gr.DrawLines($cyan,$pts)}
}
foreach($st in $layout.steps) {
  $a=$st.rot*[Math]::PI/180
  $corners=@(@((-$st.length/2),(-$st.width/2)),@(($st.length/2),(-$st.width/2)),@(($st.length/2),($st.width/2)),@((-$st.length/2),($st.width/2)))
  $points=@($corners | ForEach-Object { ,@(($st.x+$_[0]*[Math]::Cos($a)-$_[1]*[Math]::Sin($a)),($st.y+$_[0]*[Math]::Sin($a)+$_[1]*[Math]::Cos($a))) })
  Polygon $points $green
}
$gr.Dispose()
$bitmap.Save([System.IO.Path]::GetFullPath($Out),[System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$source.Dispose()
$red.Dispose()
$yellow.Dispose()
$cyan.Dispose()
$green.Dispose()
$font.Dispose()
Write-Output "wrote $Out"
