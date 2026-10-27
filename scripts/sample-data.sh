#!/usr/bin/env bash
# Lager eksempeldata for lokal visning ved å måle et lite utvalg ekte nettsteder
# med openssl (krever OpenSSL 3.5+, f.eks. fra Git for Windows).
# Bruk: scripts/sample-data.sh [utkatalog]   (standard: .local-data)
set -u
out="${1:-.local-data}"
mkdir -p "$out"

sites=(
  "www.regjeringen.no;Regjeringen;stat"
  "www.nav.no;Arbeids- og velferdsetaten;stat"
  "www.skatteetaten.no;Skatteetaten;stat"
  "www.udir.no;Utdanningsdirektoratet;stat"
  "www.politiet.no;Politiet;stat"
  "www.digdir.no;Digitaliseringsdirektoratet;stat"
  "nsm.no;Nasjonal sikkerhetsmyndighet;stat"
  "www.helsenorge.no;Helsenorge;stat"
  "www.oslo.kommune.no;Oslo kommune;kommune"
  "www.bergen.kommune.no;Bergen kommune;kommune"
  "www.trondheim.kommune.no;Trondheim kommune;kommune"
  "www.stavanger.kommune.no;Stavanger kommune;kommune"
  "www.tromso.kommune.no;Tromsø kommune;kommune"
  "www.vestlandfylke.no;Vestland fylkeskommune;fylkeskommune"
  "www.trondelagfylke.no;Trøndelag fylkeskommune;fylkeskommune"
  "www.ivar.no;IVAR IKS;kommunal-annen"
  "www.bir.no;BIR;kommunal-annen"
)

handshake() { # vert [ekstra openssl-argumenter]
  local h=$1; shift
  echo | timeout 10 openssl s_client -connect "$h:443" -servername "$h" "$@" 2>&1
}

today=$(date -u +%F)
now=$(date -u +%FT%TZ)
declare -A counts=() catcounts=()
results=""
for line in "${sites[@]}"; do
  IFS=';' read -r host name cat <<<"$line"
  echo "måler $host" >&2
  base=$(handshake "$host" -brief)
  status=error tls="" group="" key="" issuer="" expires="" err=""
  if grep -q "Protocol version" <<<"$base"; then
    tls=$(sed -n 's/^Protocol version: //p' <<<"$base" | tr -d '\r')
    group=$(sed -n 's/^Negotiated TLS1.3 group: //p' <<<"$base" | tr -d '\r')
    cert=$(handshake "$host" | openssl x509 -noout -enddate -issuer -text 2>/dev/null)
    expires=$(date -u -d "$(sed -n 's/^notAfter=//p' <<<"$cert")" +%F 2>/dev/null)
    issuer=$(sed -n 's/^issuer=.*O *= *\([^,]*\).*/\1/p' <<<"$cert" | head -1)
    bits=$(grep -o 'Public-Key: ([0-9]* bit)' <<<"$cert" | grep -o '[0-9]*')
    if grep -q "rsaEncryption" <<<"$cert"; then key="RSA-$bits"; else key="ECDSA-$bits"; fi
    if [[ "$tls" != "TLSv1.3" ]]; then
      status=legacy
    elif [[ "$group" == *MLKEM* ]] || handshake "$host" -groups X25519MLKEM768 -brief | grep -q "MLKEM"; then
      status=pqc; group=X25519MLKEM768
    else
      status=tls13
    fi
  else
    err=$(grep -m1 -oE "(Connection refused|Name or service not known|timeout|alert [a-z ]+)" <<<"$base")
    [[ -z "$err" ]] && err="ingen kontakt"
  fi
  counts[$status]=$(( ${counts[$status]:-0} + 1 ))
  catcounts[$cat.$status]=$(( ${catcounts[$cat.$status]:-0} + 1 ))
  results+="${results:+,}{\"host\":\"$host\",\"category\":\"$cat\",\"orgs\":[{\"name\":\"$name\",\"orgForm\":\"MANUELL\"}],\"status\":\"$status\",\"since\":\"$today\",\"tlsVersion\":\"${tls/TLSv/TLS }\",\"group\":\"$group\",\"certKey\":\"$key\",\"certIssuer\":\"$issuer\",\"certExpires\":\"$expires\",\"certValid\":true,\"hsts\":false,\"error\":\"$err\"}"
done

countsjson() { # prefiks
  local s first=1 o="{"
  for s in pqc tls13 legacy nohttps error; do
    local v
    if [[ -n "$1" ]]; then v=${catcounts[$1.$s]:-0}; else v=${counts[$s]:-0}; fi
    o+="$([[ $first == 1 ]] || echo ,)\"$s\":$v"; first=0
  done
  echo "$o}"
}
bycat="{"
for c in stat kommune fylkeskommune kommunal-annen; do
  bycat+="$([[ $bycat == "{" ]] || echo ,)\"$c\":$(countsjson "$c")"
done
bycat+="}"
total=${#sites[@]}

echo "{\"generated\":\"$now\",\"date\":\"$today\",\"total\":$total,\"counts\":$(countsjson ""),\"byCategory\":$bycat,\"results\":[$results]}" >"$out/latest.json"
echo "[{\"date\":\"$today\",\"total\":$total,\"counts\":$(countsjson ""),\"byCategory\":$bycat}]" >"$out/history.json"
echo "skrev $out/latest.json og $out/history.json" >&2
