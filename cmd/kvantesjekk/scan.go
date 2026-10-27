package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/csv"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Status for et nettsted, fra best til dårligst.
const (
	StatusPQC     = "pqc"     // hybrid ML-KEM nøkkelutveksling
	StatusTLS13   = "tls13"   // TLS 1.3 uten PQC
	StatusLegacy  = "legacy"  // høyest TLS 1.2 eller eldre
	StatusNoHTTPS = "nohttps" // svarer bare på http
	StatusError   = "error"   // utilgjengelig
)

var allStatuses = []string{StatusPQC, StatusTLS13, StatusLegacy, StatusNoHTTPS, StatusError}

type Result struct {
	Host        string `json:"host"`
	FinalHost   string `json:"finalHost,omitempty"`
	Category    string `json:"category"`
	Orgs        []Org  `json:"orgs"`
	Status      string `json:"status"`
	Since       string `json:"since"`
	TLSVersion  string `json:"tlsVersion,omitempty"`
	Group       string `json:"group,omitempty"`
	Cipher      string `json:"cipher,omitempty"`
	CertKey     string `json:"certKey,omitempty"`
	CertSig     string `json:"certSig,omitempty"`
	CertIssuer  string `json:"certIssuer,omitempty"`
	CertExpires string `json:"certExpires,omitempty"`
	CertValid   bool   `json:"certValid"`
	HSTS        bool   `json:"hsts"`
	CDN         string `json:"cdn,omitempty"`
	Error       string `json:"error,omitempty"`
}

type Counts map[string]int

type Latest struct {
	Generated  time.Time         `json:"generated"`
	Date       string            `json:"date"`
	Total      int               `json:"total"`
	Counts     Counts            `json:"counts"`
	ByCategory map[string]Counts `json:"byCategory"`
	Results    []Result          `json:"results"`
}

type HistoryEntry struct {
	Date       string            `json:"date"`
	Total      int               `json:"total"`
	Counts     Counts            `json:"counts"`
	ByCategory map[string]Counts `json:"byCategory"`
}

type scanner struct {
	userAgent string
	timeout   time.Duration
}

func runScan(args []string) error {
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	in := fs.String("in", "data/domains.json", "liste over nettsteder")
	outDir := fs.String("out", "site/data", "katalog for latest.json, latest.csv og history.json")
	archiveDir := fs.String("archive", "data/archive", "katalog for daglig kompakt arkiv")
	workers := fs.Int("workers", 32, "antall samtidige skann")
	timeout := fs.Duration("timeout", 10*time.Second, "tidsavbrudd per tilkobling")
	ua := fs.String("ua", "KvanteSjekk/0.1 (+https://github.com/)", "User-Agent")
	limit := fs.Int("limit", 0, "skann bare de første N (for testing)")
	fs.Parse(args)

	var targets []Target
	if err := readJSON(*in, &targets); err != nil {
		return fmt.Errorf("les %s: %w (kjør 'kvantesjekk domains' først)", *in, err)
	}
	if *limit > 0 && *limit < len(targets) {
		targets = targets[:*limit]
	}

	s := &scanner{userAgent: *ua, timeout: *timeout}
	results := make([]Result, len(targets))
	jobs := make(chan int)
	var wg sync.WaitGroup
	var done atomic.Int32
	start := time.Now()
	for w := 0; w < *workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = s.scanWithRetry(targets[i])
				if n := done.Add(1); n%100 == 0 {
					fmt.Printf("%d/%d skannet (%s)\n", n, len(targets), time.Since(start).Round(time.Second))
				}
			}
		}()
	}
	for i := range targets {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	now := time.Now().UTC()
	today := now.Format("2006-01-02")

	// Behold "since" fra forrige kjøring hvis statusen er uendret.
	var prev Latest
	prevByHost := map[string]Result{}
	if readJSON(filepath.Join(*outDir, "latest.json"), &prev) == nil {
		for _, r := range prev.Results {
			prevByHost[r.Host] = r
		}
	}
	for i := range results {
		results[i].Since = today
		if p, ok := prevByHost[results[i].Host]; ok && p.Status == results[i].Status && p.Since != "" {
			results[i].Since = p.Since
		}
	}

	latest := Latest{
		Generated:  now,
		Date:       today,
		Total:      len(results),
		Counts:     Counts{},
		ByCategory: map[string]Counts{},
		Results:    results,
	}
	for _, r := range results {
		latest.Counts[r.Status]++
		if latest.ByCategory[r.Category] == nil {
			latest.ByCategory[r.Category] = Counts{}
		}
		latest.ByCategory[r.Category][r.Status]++
	}
	for _, st := range allStatuses {
		fmt.Printf("%-8s %5d\n", st, latest.Counts[st])
	}

	if err := writeJSON(filepath.Join(*outDir, "latest.json"), latest, false); err != nil {
		return err
	}
	if err := writeCSV(filepath.Join(*outDir, "latest.csv"), results); err != nil {
		return err
	}
	if err := appendHistory(filepath.Join(*outDir, "history.json"), HistoryEntry{
		Date: today, Total: latest.Total, Counts: latest.Counts, ByCategory: latest.ByCategory,
	}); err != nil {
		return err
	}
	archive := map[string]string{}
	for _, r := range results {
		archive[r.Host] = r.Status
	}
	return writeJSON(filepath.Join(*archiveDir, today+".json"), archive, false)
}

func appendHistory(path string, e HistoryEntry) error {
	var hist []HistoryEntry
	if err := readJSON(path, &hist); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	hist = append(filterOut(hist, e.Date), e)
	sort.Slice(hist, func(i, j int) bool { return hist[i].Date < hist[j].Date })
	return writeJSON(path, hist, false)
}

func filterOut(hist []HistoryEntry, date string) []HistoryEntry {
	var out []HistoryEntry
	for _, h := range hist {
		if h.Date != date {
			out = append(out, h)
		}
	}
	return out
}

func writeCSV(path string, results []Result) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	w.Write([]string{"vert", "endelig_vert", "virksomhet", "orgnr", "kategori", "status", "siden",
		"tls", "gruppe", "chiffer", "sert_nokkel", "sert_utsteder", "sert_utloper", "sert_gyldig", "hsts", "cdn", "feil"})
	for _, r := range results {
		name, orgnr := "", ""
		if len(r.Orgs) > 0 {
			name, orgnr = r.Orgs[0].Name, r.Orgs[0].OrgNr
		}
		w.Write([]string{r.Host, r.FinalHost, name, orgnr, r.Category, r.Status, r.Since,
			r.TLSVersion, r.Group, r.Cipher, r.CertKey, r.CertIssuer, r.CertExpires,
			strconv.FormatBool(r.CertValid), strconv.FormatBool(r.HSTS), r.CDN, r.Error})
	}
	w.Flush()
	return w.Error()
}

func (s *scanner) scanWithRetry(t Target) Result {
	r := s.scan(t)
	if r.Status == StatusError {
		time.Sleep(5 * time.Second)
		r = s.scan(t)
	}
	return r
}

func (s *scanner) scan(t Target) Result {
	r := Result{Host: t.Host, Category: t.Category, Orgs: t.Orgs, Status: StatusError}

	final, err := s.probeHTTP(t.Host, &r)
	if err != nil {
		r.Error = shortErr(err)
		return r
	}
	if final == "" { // svarer kun på http
		r.Status = StatusNoHTTPS
		return r
	}
	if final != t.Host {
		r.FinalHost = final
	}

	// 1. Vanlig handshake: samler TLS-versjon, sertifikat og valgt gruppe.
	st, err := s.handshake(final, nil, 0)
	if err != nil {
		r.Error = shortErr(err)
		return r
	}
	r.TLSVersion = tls.VersionName(st.Version)
	r.Cipher = tls.CipherSuiteName(st.CipherSuite)
	if st.CurveID != 0 {
		r.Group = st.CurveID.String()
	}
	describeCert(&r, final, st.PeerCertificates)

	if st.Version < tls.VersionTLS13 {
		r.Status = StatusLegacy
		return r
	}
	if isPQ(st.CurveID) {
		r.Status = StatusPQC
		return r
	}

	// 2. Streng sjekk: tilby kun hybrid ML-KEM. Lykkes handshaken, støtter
	// serveren PQC selv om den foretrakk en klassisk gruppe over.
	r.Status = StatusTLS13
	if pq, err := s.handshake(final, []tls.CurveID{tls.X25519MLKEM768}, tls.VersionTLS13); err == nil && isPQ(pq.CurveID) {
		r.Status = StatusPQC
		r.Group = pq.CurveID.String()
	}
	return r
}

func isPQ(id tls.CurveID) bool {
	return strings.Contains(id.String(), "MLKEM")
}

// allCipherSuites inkluderer også usikre chiffer slik at gamle servere gir
// "legacy" i stedet for en handshake-feil.
var allCipherSuites = func() []uint16 {
	var ids []uint16
	for _, c := range tls.CipherSuites() {
		ids = append(ids, c.ID)
	}
	for _, c := range tls.InsecureCipherSuites() {
		ids = append(ids, c.ID)
	}
	return ids
}()

func (s *scanner) tlsConfig(host string) *tls.Config {
	return &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: true, // sertifikatet verifiseres separat i describeCert
		MinVersion:         tls.VersionTLS10,
		CipherSuites:       allCipherSuites,
	}
}

func (s *scanner) handshake(host string, groups []tls.CurveID, minVersion uint16) (tls.ConnectionState, error) {
	cfg := s.tlsConfig(host)
	if groups != nil {
		cfg.CurvePreferences = groups
	}
	if minVersion != 0 {
		cfg.MinVersion = minVersion
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: s.timeout}, "tcp", net.JoinHostPort(host, "443"), cfg)
	if err != nil {
		return tls.ConnectionState{}, err
	}
	defer conn.Close()
	return conn.ConnectionState(), nil
}

// probeHTTP følger videresendinger og returnerer vertsnavnet der nettstedet
// faktisk ligger over https. Tom streng betyr at nettstedet kun svarer på http.
func (s *scanner) probeHTTP(host string, r *Result) (string, error) {
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: s.timeout}).DialContext,
		TLSClientConfig:       s.tlsConfig(""),
		TLSHandshakeTimeout:   s.timeout,
		ResponseHeaderTimeout: 2 * s.timeout,
		DisableKeepAlives:     true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport: tr,
		Timeout:   4 * s.timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("for mange videresendinger")
			}
			return nil
		},
	}
	get := func(url string) (*http.Response, error) {
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", s.userAgent)
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		return resp, nil
	}

	resp, httpsErr := get("https://" + host + "/")
	if httpsErr != nil {
		var err error
		resp, err = get("http://" + host + "/")
		if err != nil {
			return "", httpsErr
		}
	}
	r.CDN = detectCDN(resp.Header)
	if resp.Request.URL.Scheme != "https" {
		return "", nil
	}
	r.HSTS = resp.Header.Get("Strict-Transport-Security") != ""
	return resp.Request.URL.Hostname(), nil
}

func describeCert(r *Result, host string, chain []*x509.Certificate) {
	if len(chain) == 0 {
		return
	}
	leaf := chain[0]
	switch k := leaf.PublicKey.(type) {
	case *rsa.PublicKey:
		r.CertKey = fmt.Sprintf("RSA-%d", k.N.BitLen())
	case *ecdsa.PublicKey:
		r.CertKey = "ECDSA-" + k.Curve.Params().Name
	case ed25519.PublicKey:
		r.CertKey = "Ed25519"
	default:
		r.CertKey = leaf.PublicKeyAlgorithm.String()
	}
	r.CertSig = leaf.SignatureAlgorithm.String()
	r.CertIssuer = leaf.Issuer.CommonName
	if len(leaf.Issuer.Organization) > 0 {
		r.CertIssuer = leaf.Issuer.Organization[0]
	}
	r.CertExpires = leaf.NotAfter.UTC().Format("2006-01-02")

	inter := x509.NewCertPool()
	for _, c := range chain[1:] {
		inter.AddCert(c)
	}
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Intermediates: inter})
	r.CertValid = err == nil
}

func detectCDN(h http.Header) string {
	server := strings.ToLower(h.Get("Server"))
	switch {
	case h.Get("Cf-Ray") != "" || server == "cloudflare":
		return "Cloudflare"
	case h.Get("X-Amz-Cf-Id") != "":
		return "CloudFront"
	case h.Get("X-Azure-Ref") != "":
		return "Azure Front Door"
	case strings.Contains(server, "akamai") || h.Get("X-Akamai-Transformed") != "":
		return "Akamai"
	case h.Get("X-Fastly-Request-Id") != "" || strings.HasPrefix(strings.ToLower(h.Get("X-Served-By")), "cache-"):
		return "Fastly"
	}
	return ""
}

func shortErr(err error) string {
	var dnsErr *net.DNSError
	var opErr *net.OpError
	msg := err.Error()
	switch {
	case errors.As(err, &dnsErr):
		return "DNS: " + dnsErr.Err
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline exceeded"):
		return "tidsavbrudd"
	case strings.Contains(msg, "connection refused"):
		return "tilkobling avvist"
	case errors.As(err, &opErr) && opErr.Err != nil:
		msg = opErr.Err.Error()
	}
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return msg
}
