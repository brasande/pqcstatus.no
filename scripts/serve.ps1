# Enkel lokal webserver for site/ uten Python eller Node.
# Bruk: .\scripts\serve.ps1 [-Port 8000] [-DataDir .local-data]
# -DataDir lar /data/* hentes fra en annen katalog (f.eks. eksempeldata) uten å røre site/data.
param(
  [int]$Port = 8000,
  [string]$DataDir = ""
)

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\site")).Path
if ($DataDir) { $DataDir = (Resolve-Path $DataDir).Path }
$types = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"
  ".css" = "text/css; charset=utf-8"; ".json" = "application/json; charset=utf-8"
  ".csv" = "text/csv; charset=utf-8"; ".svg" = "image/svg+xml"
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serverer $root på http://localhost:$Port/  (Ctrl+C for å stoppe)"
if ($DataDir) { Write-Host "Data hentes fra $DataDir" }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
    if ($path -eq "") { $path = "index.html" }
    $file = Join-Path $root $path
    if ($DataDir -and $path -like "data/*") { $file = Join-Path $DataDir $path.Substring(5) }
    $full = [System.IO.Path]::GetFullPath($file)
    $allowed = $full.StartsWith($root) -or ($DataDir -and $full.StartsWith($DataDir))
    if ($allowed -and (Test-Path $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full)
      $ctx.Response.ContentType = if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" }
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop()
}
