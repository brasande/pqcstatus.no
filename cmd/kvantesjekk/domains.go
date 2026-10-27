package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	brregURL    = "https://data.brreg.no/enhetsregisteret/api/enheter"
	wikidataURL = "https://query.wikidata.org/sparql"
)

// Kilder for et nettsted.
const (
	SourceBrreg    = "brreg"
	SourceWikidata = "wikidata"
	SourceManual   = "manuell"
)

type Org struct {
	OrgNr        string `json:"orgnr,omitempty"`
	Name         string `json:"name"`
	OrgForm      string `json:"orgForm"`
	Sector       string `json:"sector,omitempty"`
	Municipality string `json:"municipality,omitempty"`
	Source       string `json:"source"`
	Category     string `json:"category,omitempty"` // overstyrer automatisk kategori
	Parent       string `json:"parent,omitempty"`   // overordnet virksomhet når nettstedet er knyttet via Wikidata
}

type Target struct {
	Host     string `json:"host"`
	Category string `json:"category"`
	Orgs     []Org  `json:"orgs"`
}

type brregPage struct {
	Embedded struct {
		Enheter []brregEnhet `json:"enheter"`
	} `json:"_embedded"`
	Page struct {
		TotalPages int `json:"totalPages"`
	} `json:"page"`
}

type brregEnhet struct {
	OrgNr             string `json:"organisasjonsnummer"`
	Navn              string `json:"navn"`
	Hjemmeside        string `json:"hjemmeside"`
	Konkurs           bool   `json:"konkurs"`
	UnderAvvikling    bool   `json:"underAvvikling"`
	Slettedato        string `json:"slettedato"`
	Organisasjonsform struct {
		Kode string `json:"kode"`
	} `json:"organisasjonsform"`
	Sektor struct {
		Kode string `json:"kode"`
	} `json:"institusjonellSektorkode"`
	Forretningsadresse struct {
		Kommune string `json:"kommune"`
	} `json:"forretningsadresse"`
}

func runDomains(args []string) error {
	fs := flag.NewFlagSet("domains", flag.ExitOnError)
	out := fs.String("out", "data/domains.json", "utfil")
	sectors := fs.String("sectors", "6100,6500", "institusjonelle sektorkoder (6100 statsforvaltningen, 6500 kommuneforvaltningen)")
	extra := fs.String("extra", "data/extra-domains.txt", "ekstra nettsteder (vert;orgnr;navn;kategori)")
	exclude := fs.String("exclude", "data/exclude-domains.txt", "verter som skal utelates")
	wikidata := fs.Bool("wikidata", true, "hent også nettsteder fra Wikidata for de offentlige virksomhetene")
	ua := fs.String("ua", "KvanteSjekk/0.1 (+https://github.com/brasande/pqcstatus.no)", "User-Agent (Wikidata krever kontaktinfo)")
	fs.Parse(args)

	excluded, err := readExcludes(*exclude)
	if err != nil {
		return err
	}

	targets := map[string]*Target{}
	add := func(host string, o Org) {
		if excluded[host] {
			return
		}
		t, ok := targets[host]
		if !ok {
			t = &Target{Host: host}
			targets[host] = t
		}
		for i, existing := range t.Orgs {
			if (o.OrgNr != "" && existing.OrgNr == o.OrgNr) || strings.EqualFold(existing.Name, o.Name) {
				if o.Source == SourceManual { // manuelle oppføringer overstyrer navn og kategori
					t.Orgs[i] = o
				}
				return
			}
		}
		t.Orgs = append(t.Orgs, o)
	}

	// Alle offentlige virksomheter, også de uten hjemmeside, slik at Wikidata
	// og den manuelle listen kan knyttes til dem via organisasjonsnummer.
	public := map[string]Org{}
	hasSite := map[string]bool{} // orgnr med hjemmeside i Brreg
	client := &http.Client{Timeout: 90 * time.Second}
	userAgent = *ua
	skipped := 0
	for _, sector := range strings.Split(*sectors, ",") {
		enheter, err := fetchSector(client, strings.TrimSpace(sector))
		if err != nil {
			return err
		}
		withSite := 0
		for _, e := range enheter {
			if e.Konkurs || e.UnderAvvikling || e.Slettedato != "" {
				continue
			}
			o := Org{
				OrgNr:        e.OrgNr,
				Name:         e.Navn,
				OrgForm:      e.Organisasjonsform.Kode,
				Sector:       e.Sektor.Kode,
				Municipality: e.Forretningsadresse.Kommune,
				Source:       SourceBrreg,
			}
			public[o.OrgNr] = o
			if e.Hjemmeside == "" {
				continue
			}
			host, ok := normalizeHost(e.Hjemmeside)
			if !ok {
				skipped++
				continue
			}
			withSite++
			hasSite[o.OrgNr] = true
			add(host, o)
		}
		fmt.Printf("brreg sektor %s: %d enheter, %d med gyldig hjemmeside\n", sector, len(enheter), withSite)
	}

	if *wikidata {
		sites, err := fetchWikidata(client)
		if err != nil {
			return fmt.Errorf("wikidata: %w", err)
		}
		before := len(targets)
		matched := 0
		for _, s := range sites {
			o, ok := public[s.orgnr]
			if !ok || (!s.via && hasSite[s.orgnr]) {
				// Brreg er fasit for virksomhetens egen hjemmeside; Wikidata
				// brukes bare når den mangler, ellers blir alias-domener talt dobbelt.
				continue
			}
			host, ok := normalizeHost(s.site)
			if !ok || !strings.HasSuffix(host, ".no") {
				continue
			}
			if s.via && known(targets, host) {
				// En tjeneste på et nettsted som allerede tilhører en virksomhet
				// (f.eks. Nasjonale festningsverk på forsvarsbygg.no) gir ingen ny info.
				continue
			}
			matched++
			o.Source = SourceWikidata
			if s.via {
				// Nettstedet tilhører en tjeneste eller underenhet (f.eks. Skyss
				// under Vestland fylkeskommune). Den skal ikke telle som selve
				// kommunen/fylket, så kategori settes kun ut fra sektor.
				o.Parent, o.OrgNr, o.OrgForm = o.Name, "", ""
				if s.label != "" {
					o.Name = s.label
				}
			}
			add(host, o)
		}
		fmt.Printf("wikidata: %d nettsteder knyttet til offentlige virksomheter, %d nye verter\n", matched, len(targets)-before)
	}

	extras, err := readExtras(*extra, public)
	if err != nil {
		return err
	}
	for _, x := range extras {
		add(x.host, x.org)
	}

	// "x.no" og "www.x.no" er i praksis samme nettsted.
	for host, t := range targets {
		if www, ok := targets["www."+host]; ok {
			for _, o := range t.Orgs {
				add(www.Host, o)
			}
			delete(targets, host)
		}
	}

	list := make([]Target, 0, len(targets))
	for _, t := range targets {
		sort.SliceStable(t.Orgs, func(i, j int) bool { return orgRank(t.Orgs[i]) < orgRank(t.Orgs[j]) })
		t.Category = category(t.Orgs[0])
		list = append(list, *t)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Host < list[j].Host })

	fmt.Printf("%d unike nettsteder (%d ugyldige hjemmesider hoppet over)\n", len(list), skipped)
	return writeJSON(*out, list, true)
}

// known sier om verten, med eller uten "www.", allerede er registrert.
func known(targets map[string]*Target, host string) bool {
	bare := strings.TrimPrefix(host, "www.")
	return targets[bare] != nil || targets["www."+bare] != nil
}

func fetchSector(client *http.Client, sector string) ([]brregEnhet, error) {
	const size = 1000
	var all []brregEnhet
	for page := 0; ; page++ {
		url := fmt.Sprintf("%s?institusjonellSektorkode=%s&size=%d&page=%d", brregURL, sector, size, page)
		resp, err := get(client, url, "application/json")
		if err != nil {
			return nil, err
		}
		var p brregPage
		err = json.NewDecoder(resp.Body).Decode(&p)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("brreg svarte %s for %s", resp.Status, url)
		}
		if err != nil {
			return nil, err
		}
		all = append(all, p.Embedded.Enheter...)
		if page+1 >= p.Page.TotalPages {
			return all, nil
		}
	}
}

// wikidataQuery finner nettsteder der elementet selv, eller den som driver,
// utgir eller er overordnet det, har et norsk organisasjonsnummer. Eierskap
// (P127) er utelatt for å unngå statseide selskaper.
const wikidataQuery = `SELECT DISTINCT ?site ?orgnr ?via ?xLabel WHERE {
  { ?x wdt:P2333 ?orgnr; wdt:P856 ?site . BIND("0" AS ?via) }
  UNION
  { ?x wdt:P856 ?site; (wdt:P137|wdt:P123|wdt:P749) ?op . ?op wdt:P2333 ?orgnr . BIND("1" AS ?via) }
  FILTER NOT EXISTS { ?x wdt:P576 [] }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "nb,nn,no,en". }
}`

type wikidataSite struct {
	site, orgnr, label string
	via                bool
}

func fetchWikidata(client *http.Client) ([]wikidataSite, error) {
	resp, err := get(client, wikidataURL+"?query="+url.QueryEscape(wikidataQuery), "application/sparql-results+json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("svarte %s", resp.Status)
	}
	var r struct {
		Results struct {
			Bindings []struct {
				Site  struct{ Value string } `json:"site"`
				OrgNr struct{ Value string } `json:"orgnr"`
				Via   struct{ Value string } `json:"via"`
				Label struct{ Value string } `json:"xLabel"`
			} `json:"bindings"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	out := make([]wikidataSite, 0, len(r.Results.Bindings))
	for _, b := range r.Results.Bindings {
		label := b.Label.Value
		if isQID(label) { // mangler etikett på norsk/engelsk
			label = ""
		}
		out = append(out, wikidataSite{b.Site.Value, digitsOnly(b.OrgNr.Value), label, b.Via.Value == "1"})
	}
	return out, nil
}

func isQID(s string) bool {
	return len(s) > 1 && s[0] == 'Q' && digitsOnly(s[1:]) == s[1:]
}

func digitsOnly(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, s)
}

var hostRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$`)

// normalizeHost gjør om et fritekst hjemmeside-felt ("https://www.x.no/abc",
// "www.x.no", "x.no/") til et rent vertsnavn.
func normalizeHost(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, `\`, "/")
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	s = strings.TrimPrefix(s, "//")
	if i := strings.IndexAny(s, "/?# "); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndex(s, "@"); i >= 0 {
		s = s[i+1:]
	}
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	s = strings.TrimSuffix(s, ".")
	return s, hostRe.MatchString(s)
}

// orgRank sørger for at hovedenheten (kommune, fylke, stat eller en manuell
// oppføring) står først når flere virksomheter deler samme nettsted.
func orgRank(o Org) int {
	if o.Source == SourceManual {
		return 0
	}
	switch o.OrgForm {
	case "KOMM", "FYLK", "STAT":
		return 1
	}
	return 2
}

func category(o Org) string {
	switch {
	case o.Category != "":
		return o.Category
	case o.OrgForm == "KOMM":
		return "kommune"
	case o.OrgForm == "FYLK":
		return "fylkeskommune"
	case o.OrgForm == "KIRK":
		return "kirke"
	case o.Sector == "6500":
		return "kommunal-annen"
	}
	return "stat"
}

func readExcludes(path string) (map[string]bool, error) {
	m := map[string]bool{}
	err := eachLine(path, func(line string) {
		if h, ok := normalizeHost(line); ok {
			m[h] = true
		}
	})
	return m, err
}

type extraSite struct {
	host string
	org  Org
}

// readExtras leser linjer på formen "vert;orgnr;navn;kategori". Er orgnr en
// kjent offentlig virksomhet, hentes navn og kategori derfra; navn og
// kategori i fila overstyrer.
func readExtras(path string, public map[string]Org) ([]extraSite, error) {
	var out []extraSite
	err := eachLine(path, func(line string) {
		parts := strings.Split(line, ";")
		for len(parts) < 4 {
			parts = append(parts, "")
		}
		h, ok := normalizeHost(parts[0])
		if !ok {
			fmt.Fprintf(os.Stderr, "ugyldig vert i %s: %q\n", path, line)
			return
		}
		orgnr := digitsOnly(parts[1])
		o, known := public[orgnr]
		if orgnr != "" && !known {
			fmt.Fprintf(os.Stderr, "merk: orgnr %s for %s er ikke i de valgte sektorene, bruker navn/kategori fra %s\n", orgnr, h, path)
		}
		if !known {
			o = Org{OrgNr: orgnr, Name: h, OrgForm: "MANUELL"}
		}
		o.Source = SourceManual
		if name := strings.TrimSpace(parts[2]); name != "" {
			o.Name = name
		}
		if cat := strings.TrimSpace(parts[3]); cat != "" {
			o.Category = cat
		}
		out = append(out, extraSite{h, o})
	})
	return out, err
}

func eachLine(path string, fn func(string)) error {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fn(line)
	}
	return sc.Err()
}

var userAgent = "KvanteSjekk/0.1"

// get prøver opptil tre ganger ved nettverksfeil, 429 og 5xx, siden både
// Brreg og Wikidata av og til struper forespørsler fra skytjenester.
func get(client *http.Client, url, accept string) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt*attempt) * 10 * time.Second)
		}
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", accept)
		req.Header.Set("User-Agent", userAgent)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			resp.Body.Close()
			lastErr = fmt.Errorf("svarte %s", resp.Status)
			continue
		}
		return resp, nil
	}
	return nil, lastErr
}
