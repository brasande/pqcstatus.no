# KvanteSjekk

Daglig oversikt over hvilke offentlige nettsider i Norge som støtter post-kvante nøkkelutveksling
(hybrid ML-KEM, `X25519MLKEM768`) i TLS.

## Slik fungerer det

1. **`kvantesjekk domains`** setter sammen listen over offentlige nettsteder i `data/domains.json` fra tre kilder:
   - **Enhetsregisteret:** alle enheter i statsforvaltningen (sektorkode 6100) og kommuneforvaltningen (6500),
     med feltet `hjemmeside`
   - **Wikidata:** nettsteder der virksomheten selv, eller den som driver, utgir eller er overordnet nettstedet,
     har et organisasjonsnummer fra listen over. Slik kommer tjenester som norgeskart.no, valg.no og helfo.no med.
     Bare .no-domener tas med, og «eies av» brukes ikke, slik at statseide selskaper holdes utenfor.
   - **`data/extra-domains.txt`:** en kuratert liste på formen `vert;orgnr;navn;kategori`, for eksempel minid.no
     knyttet til Digdir

   Virksomheter som deler nettsted slås sammen, og det samme gjør `x.no` og `www.x.no`.
   Verter som skal holdes utenfor, legges i `data/exclude-domains.txt`.
2. **`kvantesjekk scan`** sjekker hvert nettsted:
   - følger videresendinger fra `https://vert/` (eller `http://`) til endelig vert
   - gjør en vanlig TLS-handshake og registrerer versjon, gruppe, chiffer, sertifikat, HSTS og CDN
   - gjør så en handshake som **kun** tilbyr `X25519MLKEM768`. Lykkes den, settes status `pqc`
   - skriver `site/data/latest.json`, `latest.csv`, `history.json` og et kompakt arkiv i `data/archive/`
3. **`site/`** er en statisk nettside som leser disse filene.

| Status    | Betydning                                  |
|-----------|--------------------------------------------|
| `pqc`     | Hybrid ML-KEM støttes                      |
| `tls13`   | TLS 1.3, men ikke PQC                      |
| `legacy`  | Høyest TLS 1.2 eller eldre                 |
| `nohttps` | Svarer bare på http                        |
| `error`   | Utilgjengelig (DNS, tidsavbrudd, feil)     |

## Oppsett på GitHub

1. Opprett et repo og push koden.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Actions → Daglig skann → Run workflow** (sett gjerne `limit` til `50` første gang for en rask test).
4. Deretter kjører skanningen automatisk hver natt kl. 03:00 UTC, legger resultatene i repoet og
   publiserer siden.

`CI`-arbeidsflyten bygger koden og kjører en røyktest mot noen nettsteder ved hver push.

## Kjøre lokalt med Docker

```powershell
docker compose run --rm scanner          # hent domener og skann alt (sett $env:LIMIT='50' for rask test)
docker compose up -d web                 # http://localhost:8088  ($env:PORT for annen port)
```

Resultatene skrives til `site/data/` og `data/`, akkurat som i GitHub Actions.

## Kjøre lokalt uten Docker

Krever Go 1.25 eller nyere.

```sh
go run ./cmd/kvantesjekk domains
go run ./cmd/kvantesjekk scan -limit 50
cd site && python -m http.server   # åpne http://localhost:8000
```

## Videre ideer

- Egen side per virksomhet med historikk (data finnes i `data/archive/`)
- E-post (STARTTLS på MX), DNSSEC og ASN/hosting-oppslag
- Varsling (RSS/e-post) når en virksomhet endrer status
