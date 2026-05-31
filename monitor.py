#!/usr/bin/env python3
"""
nassrwrites.com security monitor
=================================

A self-contained daily watchdog for the static site https://www.nassrwrites.com.

It discovers every page from the sitemap, scans each one for malware /
defacement / injection indicators using purely *local* heuristics (no external
threat-intel APIs), maintains a SHA-256 content baseline to catch any change,
and emails an alert only when something is wrong.

Designed to run unattended from cron with zero arguments:

    python3 monitor.py

Exit codes:
    0  -> site is clean
    1  -> at least one anomaly was detected (lets cron trigger a notification)

Dependencies (standard library + two packages):
    pip install requests beautifulsoup4

See the USAGE block at the very bottom of this file for cron + email setup.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import logging
import os
import random
import re
import smtplib
import sys
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup, Comment

# ======================================================================
# CONFIGURATION  — edit these constants without reading the rest of the file
# ======================================================================

# Root of the site to monitor.
SITE_URL = "https://www.nassrwrites.com"

# Where the sitemap lives. Supports a plain sitemap, a sitemap index that
# nests other sitemaps, and gzipped sitemaps (.xml.gz).
SITEMAP_URL = f"{SITE_URL}/sitemap.xml"

# Hostname we consider "ourselves". Anything else is "external".
SITE_HOST = urlparse(SITE_URL).hostname or "www.nassrwrites.com"

# Script src domains that are trusted. An external <script src> is flagged
# UNLESS its domain matches SITE_HOST exactly or appears in this list exactly.
# NOTE: matching is exact — subdomains are NOT wildcarded. If you need
# maps.googleapis.com, add it explicitly.
ALLOWED_SCRIPT_DOMAINS = [
    "cdnjs.cloudflare.com",
    "ajax.googleapis.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "fonts.googleapis.com",
    "www.googletagmanager.com",
    "code.jquery.com",
]

# Elements/attributes whose contents are excluded from the integrity hash so
# that legitimately dynamic fragments don't cause false defacement alerts.
# CSS-style selectors understood by BeautifulSoup.select().
EXCLUDE_HASH_ELEMENTS = [
    ".dynamic-content",
    ".current-time",
    ".random-token",
    "[data-timestamp]",
    "[data-dynamic]",
]

# Rotate through a small set of realistic desktop + mobile User-Agents so the
# monitor looks like ordinary traffic and isn't trivially fingerprinted.
USER_AGENTS = [
    # Desktop Chrome (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # Desktop Safari (macOS)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    # Desktop Firefox (Linux)
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    # Mobile Safari (iPhone)
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    # Mobile Chrome (Android)
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
]

# Minimum seconds between any two HTTP requests (politeness). robots.txt
# Crawl-Delay, if larger, overrides this at runtime.
REQUEST_DELAY = 2.0

# Persistence + logging files (written next to this script).
HASH_FILE = "page_hashes.json"
LOG_FILE = "monitor.log"

# HTTP behaviour.
REQUEST_TIMEOUT = 20          # seconds per request
MAX_RETRIES = 3               # attempts per URL before giving up
BACKOFF_BASE = 2              # exponential backoff base: 2s, 4s, 8s

# --- Email alerting (read from the environment so secrets never live in code) -
# Set both ALERT_EMAIL and ALERT_SMTP_PASSWORD to enable email. For Gmail use
# an App Password (not your normal password) with 2FA enabled.
ALERT_EMAIL = os.environ.get("ALERT_EMAIL")            # recipient + sender
ALERT_SMTP_PASSWORD = os.environ.get("ALERT_SMTP_PASSWORD")
SMTP_SERVER = os.environ.get("ALERT_SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("ALERT_SMTP_PORT", "587"))
SMTP_FROM = os.environ.get("ALERT_SMTP_FROM", ALERT_EMAIL or "")

# Phishing-style keywords to flag in external link domains.
PHISHING_KEYWORDS = ["login", "verify", "account", "secure", "signin", "update", "confirm"]

# Known-good spellings of our brand; any near-miss in a domain is suspicious.
BRAND_TOKENS = ["nassrwrites"]

# Heuristic thresholds.
LONG_BASE64_MIN = 100          # base64 strings longer than this are suspicious
FROMCHARCODE_MIN_ARGS = 20     # fromCharCode with this many numeric args is suspicious

# ======================================================================
# LOGGING  — write timestamped output to both stdout and LOG_FILE
# ======================================================================

_HERE = os.path.dirname(os.path.abspath(__file__))


def _setup_logging() -> logging.Logger:
    logger = logging.getLogger("nassrwrites-monitor")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    try:
        fileh = logging.FileHandler(os.path.join(_HERE, LOG_FILE), encoding="utf-8")
        fileh.setFormatter(fmt)
        logger.addHandler(fileh)
    except OSError as exc:  # logging must never crash the run
        stream.handle(logging.LogRecord(
            "nassrwrites-monitor", logging.WARNING, __file__, 0,
            "Could not open log file %s: %s", (LOG_FILE, exc), None))
    return logger


log = _setup_logging()


# ======================================================================
# HTTP helpers — rotating UA, polite delay, retry with exponential backoff
# ======================================================================

class Fetcher:
    """Thin wrapper around requests that enforces delay, UA rotation, retries."""

    def __init__(self, delay: float = REQUEST_DELAY):
        self.delay = delay
        self.session = requests.Session()
        self._last_request_ts = 0.0

    def _respect_delay(self) -> None:
        elapsed = time.monotonic() - self._last_request_ts
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)

    def get(self, url: str) -> requests.Response | None:
        """GET a URL with retries. Returns the Response or None on total failure."""
        if not _is_valid_http_url(url):
            log.warning("Skipping non-HTTP(S) URL: %s", url)
            return None

        for attempt in range(1, MAX_RETRIES + 1):
            self._respect_delay()
            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
            try:
                resp = self.session.get(url, headers=headers,
                                        timeout=REQUEST_TIMEOUT, allow_redirects=True)
                self._last_request_ts = time.monotonic()
                if resp.status_code >= 500:
                    raise requests.HTTPError(f"server returned {resp.status_code}")
                return resp
            except requests.RequestException as exc:
                self._last_request_ts = time.monotonic()
                if attempt < MAX_RETRIES:
                    wait = BACKOFF_BASE ** attempt  # 2s, 4s, 8s
                    log.warning("Request failed (%s) for %s — retry %d/%d in %ds",
                                exc, url, attempt, MAX_RETRIES, wait)
                    time.sleep(wait)
                else:
                    log.error("Giving up on %s after %d attempts: %s",
                              url, MAX_RETRIES, exc)
        return None


def _is_valid_http_url(url: str) -> bool:
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def _domain_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def _is_external(url: str) -> bool:
    """True if url points to a host other than our own site host."""
    host = _domain_of(url)
    return bool(host) and host != SITE_HOST.lower()


# ======================================================================
# robots.txt — optionally pick up a larger Crawl-Delay
# ======================================================================

def read_crawl_delay(fetcher: Fetcher) -> float:
    """Return REQUEST_DELAY, or a larger Crawl-Delay from robots.txt if present."""
    url = urljoin(SITE_URL, "/robots.txt")
    resp = fetcher.get(url)
    if not resp or resp.status_code != 200:
        return REQUEST_DELAY
    delay = REQUEST_DELAY
    for line in resp.text.splitlines():
        line = line.strip()
        if line.lower().startswith("crawl-delay:"):
            try:
                value = float(line.split(":", 1)[1].strip())
                delay = max(delay, value)
            except ValueError:
                pass
    if delay != REQUEST_DELAY:
        log.info("Using Crawl-Delay of %.1fs from robots.txt", delay)
    return delay


# ======================================================================
# PAGE DISCOVERY — sitemap (+ index + gzip), homepage fallback
# ======================================================================

# XML sitemap namespace; tags are namespaced like {http://...}loc
_SM_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


def _decode_sitemap_bytes(url: str, content: bytes) -> str | None:
    """Return XML text from raw bytes, transparently gunzipping when needed."""
    if url.endswith(".gz") or content[:2] == b"\x1f\x8b":  # gzip magic number
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(content)) as gz:
                return gz.read().decode("utf-8", errors="replace")
        except OSError as exc:
            log.error("Failed to gunzip sitemap %s: %s", url, exc)
            return None
    return content.decode("utf-8", errors="replace")


def discover_urls(fetcher: Fetcher) -> list[str]:
    """
    Discover all page URLs by parsing the sitemap (recursively following
    sitemap-index entries and gzipped sitemaps). The homepage is always
    included. Falls back to homepage-only if the sitemap is unreachable.
    """
    discovered: set[str] = set()
    discovered.add(SITE_URL.rstrip("/") + "/")  # always include the homepage

    to_visit = [SITEMAP_URL]
    seen_sitemaps: set[str] = set()

    while to_visit:
        sm_url = to_visit.pop()
        if sm_url in seen_sitemaps:
            continue
        seen_sitemaps.add(sm_url)

        resp = fetcher.get(sm_url)
        if not resp or resp.status_code != 200:
            log.warning("Sitemap unreachable: %s (status %s)",
                        sm_url, getattr(resp, "status_code", "n/a"))
            continue

        xml_text = _decode_sitemap_bytes(sm_url, resp.content)
        if not xml_text:
            continue

        try:
            root = ElementTree.fromstring(xml_text)
        except ElementTree.ParseError as exc:
            log.error("Could not parse sitemap %s: %s", sm_url, exc)
            continue

        tag = root.tag.split("}")[-1]  # strip namespace
        if tag == "sitemapindex":
            # Nested sitemaps — queue each <sitemap><loc> for recursion.
            for loc in root.findall(".//sm:sitemap/sm:loc", _SM_NS) or root.iter():
                text = (loc.text or "").strip() if loc.tag.endswith("loc") else ""
                if text and _is_valid_http_url(text):
                    to_visit.append(text)
            log.info("Sitemap index %s -> queued nested sitemaps", sm_url)
        else:
            # Regular urlset — collect <url><loc> entries.
            count_before = len(discovered)
            for loc in root.iter():
                if loc.tag.endswith("loc") and loc.text:
                    text = loc.text.strip()
                    if _is_valid_http_url(text):
                        discovered.add(text)
            log.info("Sitemap %s -> %d URLs", sm_url, len(discovered) - count_before)

    if len(discovered) <= 1:
        log.warning("Sitemap yielded no pages — falling back to homepage only.")

    return sorted(discovered)


# ======================================================================
# CONTENT INTEGRITY — normalize + SHA-256, ignoring dynamic fragments
# ======================================================================

# Heuristic patterns for dynamic tokens we strip before hashing so that
# nonces/timestamps don't trigger false "changed page" alerts.
_DYNAMIC_PATTERNS = [
    re.compile(r'name=["\']_?csrf["\'][^>]*value=["\'][^"\']+["\']', re.I),
    re.compile(r'(csrf[-_]?token|nonce)["\']?\s*[:=]\s*["\'][^"\']+["\']', re.I),
    re.compile(r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b'),   # ISO timestamps
    re.compile(r'\b\d{10,13}\b'),                            # epoch ms/seconds
]


def compute_content_hash(soup: BeautifulSoup) -> str:
    """
    Produce a stable SHA-256 over the page body with dynamic bits removed:
      - HTML comments stripped
      - elements matching EXCLUDE_HASH_ELEMENTS removed
      - <script> tags carrying data-timestamp/data-dynamic removed
      - residual dynamic tokens (csrf/nonce/timestamps) regex-scrubbed
    """
    # Work on a copy so scanning still sees the original DOM.
    work = BeautifulSoup(str(soup), "html.parser")

    # Drop comments.
    for c in work.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()

    # Drop configured dynamic elements.
    for selector in EXCLUDE_HASH_ELEMENTS:
        try:
            for el in work.select(selector):
                el.decompose()
        except Exception:  # bad selector shouldn't abort hashing
            pass

    # Drop scripts explicitly marked dynamic.
    for s in work.find_all("script"):
        if s.has_attr("data-timestamp") or s.has_attr("data-dynamic"):
            s.decompose()

    body = work.body or work
    text = str(body)

    # Scrub residual dynamic tokens.
    for pat in _DYNAMIC_PATTERNS:
        text = pat.sub("", text)

    # Collapse whitespace so cosmetic reflow doesn't change the hash.
    text = re.sub(r"\s+", " ", text).strip()

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_hashes() -> dict:
    path = os.path.join(_HERE, HASH_FILE)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        log.error("Could not read %s (%s) — treating as empty baseline.", HASH_FILE, exc)
        return {}


def save_hashes(hashes: dict) -> None:
    path = os.path.join(_HERE, HASH_FILE)
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(hashes, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except OSError as exc:
        log.error("Could not write %s: %s", HASH_FILE, exc)


# ======================================================================
# THREAT HEURISTICS — all local, no external lookups
# ======================================================================

class Issue:
    """A single finding on a page."""
    __slots__ = ("url", "category", "detail")

    def __init__(self, url: str, category: str, detail: str):
        self.url = url
        self.category = category
        self.detail = detail

    def __str__(self) -> str:
        return f"[{self.category}] {self.url}\n        {self.detail}"


# Inline-JS suspicious-pattern detectors.
_RE_FROMCHARCODE = re.compile(r"fromCharCode\s*\(([^)]*)\)", re.I)
_RE_ATOB_BTOA = re.compile(r"\b(?:atob|btoa)\s*\(\s*[\"']([A-Za-z0-9+/=]+)[\"']", re.I)
_RE_BARE_BASE64 = re.compile(r"[\"']([A-Za-z0-9+/]{100,}={0,2})[\"']")
_RE_EVAL = re.compile(r"\b(?:eval|new\s+Function)\s*\(", re.I)
_RE_URL_IN_CODE = re.compile(r"https?://[^\s\"'<>]+", re.I)
_RE_DOC_WRITE = re.compile(r"document\.write\s*\(", re.I)
_RE_LOCATION_ASSIGN = re.compile(
    r"(?:window|document)\.location(?:\.href)?\s*=\s*[\"'](https?://[^\"']+)[\"']", re.I)


def _hidden_by_style(style: str) -> bool:
    """True if an inline style string hides the element."""
    if not style:
        return False
    s = style.lower().replace(" ", "")
    markers = ["display:none", "visibility:hidden", "opacity:0",
               "width:0", "height:0"]
    if any(m in s for m in markers):
        return True
    # position:absolute pushed far off-screen
    if "position:absolute" in s and re.search(r"left:-?\d{4,}px", s):
        return True
    return False


def scan_scripts(url: str, soup: BeautifulSoup, issues: list[Issue]) -> None:
    """Rule A (external scripts) + Rule C (suspicious inline JS)."""
    allowed = set(d.lower() for d in ALLOWED_SCRIPT_DOMAINS)
    allowed.add(SITE_HOST.lower())

    for script in soup.find_all("script"):
        src = script.get("src")
        if src:
            full = urljoin(url, src)
            dom = _domain_of(full)
            if dom and dom not in allowed:
                issues.append(Issue(url, "EXTERNAL_SCRIPT",
                                    f"<script src> from untrusted domain '{dom}': {full}"))
            continue

        # Inline script — Rule C.
        code = script.string or script.get_text() or ""
        if not code.strip():
            continue

        m = _RE_FROMCHARCODE.search(code)
        if m and m.group(1).count(",") >= FROMCHARCODE_MIN_ARGS:
            issues.append(Issue(url, "OBFUSCATED_JS",
                                "String.fromCharCode() with a long numeric sequence "
                                "(likely encoded payload)"))

        for m in _RE_ATOB_BTOA.finditer(code):
            if len(m.group(1)) > LONG_BASE64_MIN:
                issues.append(Issue(url, "OBFUSCATED_JS",
                                    f"atob/btoa on a {len(m.group(1))}-char base64 string"))
        for m in _RE_BARE_BASE64.finditer(code):
            issues.append(Issue(url, "OBFUSCATED_JS",
                                f"long base64-looking literal ({len(m.group(1))} chars) in inline JS"))

        if _RE_EVAL.search(code) and (_RE_URL_IN_CODE.search(code)
                                      or _RE_BARE_BASE64.search(code)
                                      or "atob" in code.lower()):
            issues.append(Issue(url, "DANGEROUS_EVAL",
                                "eval()/new Function() combined with a URL or encoded data"))

        if _RE_DOC_WRITE.search(code):
            for m in _RE_URL_IN_CODE.finditer(code):
                if _is_external(m.group(0)):
                    issues.append(Issue(url, "DOC_WRITE_EXTERNAL",
                                        f"document.write() referencing external URL: {m.group(0)}"))
                    break

        m = _RE_LOCATION_ASSIGN.search(code)
        if m and _is_external(m.group(1)):
            issues.append(Issue(url, "OFFSITE_REDIRECT",
                                f"location assigned to off-site URL: {m.group(1)}"))


def scan_iframes(url: str, soup: BeautifulSoup, issues: list[Issue]) -> None:
    """Rule B — hidden / zero-size / cross-domain iframes."""
    for iframe in soup.find_all("iframe"):
        w = (iframe.get("width") or "").strip()
        h = (iframe.get("height") or "").strip()
        style = iframe.get("style", "")
        src = iframe.get("src", "")

        if w == "0" or h == "0":
            issues.append(Issue(url, "HIDDEN_IFRAME",
                                f"zero-size iframe (width={w!r} height={h!r}) src={src!r}"))
        elif _hidden_by_style(style):
            issues.append(Issue(url, "HIDDEN_IFRAME",
                                f"iframe hidden via inline style: {style!r} src={src!r}"))

        if src:
            full = urljoin(url, src)
            if _is_external(full):
                issues.append(Issue(url, "CROSS_DOMAIN_IFRAME",
                                    f"iframe loads external domain '{_domain_of(full)}': {full}"))


def scan_links_and_forms(url: str, soup: BeautifulSoup, issues: list[Issue]) -> None:
    """Rule D — hidden external links, hijacked forms, meta-refresh redirects."""
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"])
        if _is_external(href) and _hidden_by_style(a.get("style", "")):
            issues.append(Issue(url, "HIDDEN_LINK",
                                f"hidden link to external domain: {href}"))

    for form in soup.find_all("form", action=True):
        action = urljoin(url, form["action"])
        if _is_external(action):
            issues.append(Issue(url, "FORM_HIJACK",
                                f"<form action> posts to external domain '{_domain_of(action)}': {action}"))

    for meta in soup.find_all("meta", attrs={"http-equiv": re.compile("refresh", re.I)}):
        content = meta.get("content", "")
        m = re.search(r"url\s*=\s*(\S+)", content, re.I)
        if m:
            target = urljoin(url, m.group(1).strip("'\""))
            if _is_external(target):
                issues.append(Issue(url, "META_REFRESH_REDIRECT",
                                    f"meta-refresh redirects off-site: {target}"))


def scan_embeds(url: str, soup: BeautifulSoup, issues: list[Issue]) -> None:
    """Rule 7b — <object>/<embed>/<applet> pulling external data/src."""
    for tag in soup.find_all(["object", "embed", "applet"]):
        ref = tag.get("data") or tag.get("src") or tag.get("code") or ""
        if ref:
            full = urljoin(url, ref)
            if _is_external(full):
                issues.append(Issue(url, "EXTERNAL_EMBED",
                                    f"<{tag.name}> loads external resource: {full}"))


def scan_phishing_links(url: str, soup: BeautifulSoup, issues: list[Issue]) -> None:
    """Rule 7a — external link domains that look like phishing / brand spoofs."""
    flagged: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"])
        if not _is_external(href):
            continue
        dom = _domain_of(href)
        if not dom or dom in flagged:
            continue

        if any(kw in dom for kw in PHISHING_KEYWORDS):
            issues.append(Issue(url, "PHISHING_KEYWORD",
                                f"external link domain contains phishing keyword: {dom}"))
            flagged.add(dom)
            continue

        # Brand near-miss: contains our brand token spelled wrong, or is a
        # close-but-not-equal lookalike of our own host.
        for token in BRAND_TOKENS:
            if token in dom:
                continue  # exact token present is fine (could be legit mirror)
            if _looks_like(token, dom):
                issues.append(Issue(url, "BRAND_SPOOF",
                                    f"external domain resembles brand '{token}': {dom}"))
                flagged.add(dom)
                break


def _looks_like(token: str, domain: str) -> bool:
    """Cheap typo-squat check: a domain label within edit-distance 2 of token."""
    for label in domain.split("."):
        if label == token:
            return False
        if abs(len(label) - len(token)) <= 2 and _edit_distance(label, token) <= 2 \
                and len(token) >= 5:
            return True
    return False


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance (small strings, so the simple DP is fine)."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ======================================================================
# PER-PAGE PROCESSING
# ======================================================================

def scan_page(url: str, soup: BeautifulSoup) -> list[Issue]:
    """Run every heuristic against one page; never raise."""
    issues: list[Issue] = []
    for fn in (scan_scripts, scan_iframes, scan_links_and_forms,
               scan_embeds, scan_phishing_links):
        try:
            fn(url, soup, issues)
        except Exception as exc:  # one rule failing must not abort the page
            log.error("Rule %s failed on %s: %s", fn.__name__, url, exc)
    return issues


# ======================================================================
# ALERTING
# ======================================================================

def build_report(issues: list[Issue], changed: list[str],
                 scanned: int, errors: list[str], first_run: bool) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines = [
        "=" * 60,
        f"  SECURITY REPORT — {SITE_URL}",
        f"  Generated: {now}",
        f"  Pages scanned: {scanned}",
        "=" * 60,
        "",
    ]

    if first_run:
        lines.append("First run: integrity baseline created for all pages.")
        lines.append("")

    if changed:
        lines.append(f"CONTENT CHANGED on {len(changed)} page(s) "
                     f"(possible defacement / injection):")
        lines.extend(f"    - {u}" for u in changed)
        lines.append("")

    if issues:
        lines.append(f"HEURISTIC FINDINGS — {len(issues)} item(s):")
        by_cat: dict[str, list[Issue]] = {}
        for it in issues:
            by_cat.setdefault(it.category, []).append(it)
        for cat in sorted(by_cat):
            lines.append(f"  >> {cat} ({len(by_cat[cat])})")
            for it in by_cat[cat]:
                lines.append(f"     {it.url}")
                lines.append(f"         {it.detail}")
        lines.append("")

    if errors:
        lines.append(f"NON-FATAL ERRORS — {len(errors)}:")
        lines.extend(f"    - {e}" for e in errors)
        lines.append("")

    if not issues and not changed:
        lines.append("No anomalies detected. Site is clean.")
        lines.append("")

    lines.append("=" * 60)
    return "\n".join(lines)


def send_email_alert(report: str, issue_count: int) -> None:
    """Send the report via SMTP STARTTLS, only if credentials are configured."""
    if not (ALERT_EMAIL and ALERT_SMTP_PASSWORD):
        log.info("Email not configured (ALERT_EMAIL / ALERT_SMTP_PASSWORD unset) "
                 "— skipping email, report is on stdout/log.")
        return

    msg = EmailMessage()
    msg["Subject"] = f"[nassrwrites.com] SECURITY ALERT – {issue_count} issues found"
    msg["From"] = SMTP_FROM or ALERT_EMAIL
    msg["To"] = ALERT_EMAIL
    msg.set_content(report)

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=30) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(ALERT_EMAIL, ALERT_SMTP_PASSWORD)
            server.send_message(msg)
        log.info("Alert email sent to %s", ALERT_EMAIL)
    except Exception as exc:  # email failure must not crash the monitor
        log.error("Failed to send alert email: %s", exc)


# ======================================================================
# MAIN
# ======================================================================

def main() -> int:
    log.info("=== Starting security scan of %s ===", SITE_URL)
    fetcher = Fetcher()

    # Politeness: honour a larger Crawl-Delay if robots.txt sets one.
    try:
        fetcher.delay = read_crawl_delay(fetcher)
    except Exception as exc:
        log.warning("robots.txt check failed (%s) — using default delay.", exc)

    # 1. Discover pages.
    try:
        urls = discover_urls(fetcher)
    except Exception as exc:
        log.error("Page discovery failed (%s) — falling back to homepage.", exc)
        urls = [SITE_URL.rstrip("/") + "/"]
    log.info("Discovered %d page(s) to scan.", len(urls))

    # 2. Load the integrity baseline.
    baseline = load_hashes()
    first_run = len(baseline) == 0
    new_hashes: dict = {}

    all_issues: list[Issue] = []
    changed_pages: list[str] = []
    errors: list[str] = []
    scanned = 0

    # 3. Scan each page independently.
    for url in urls:
        try:
            resp = fetcher.get(url)
            if not resp:
                errors.append(f"could not fetch {url}")
                continue
            if resp.status_code != 200:
                errors.append(f"{url} returned HTTP {resp.status_code}")
                continue
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype.lower():
                log.info("Skipping non-HTML resource (%s): %s", ctype, url)
                continue

            soup = BeautifulSoup(resp.text, "html.parser")
            scanned += 1

            # Heuristic scan.
            all_issues.extend(scan_page(url, soup))

            # Integrity baseline.
            digest = compute_content_hash(soup)
            new_hashes[url] = digest
            if not first_run:
                old = baseline.get(url)
                if old is None:
                    log.info("New page (not in baseline): %s", url)
                elif old != digest:
                    changed_pages.append(url)
                    log.warning("Content hash changed: %s", url)

        except Exception as exc:  # never let one page abort the rest
            log.error("Unexpected error scanning %s: %s", url, exc)
            errors.append(f"error scanning {url}: {exc}")

    # 4. Persist updated baseline. On the first run this *creates* it; on later
    #    runs we keep the new hashes so a one-off change doesn't alert forever.
    save_hashes(new_hashes)

    # 5. Report + alert.
    report = build_report(all_issues, changed_pages, scanned, errors, first_run)
    print(report)
    log.info("Scan complete: %d issues, %d changed pages, %d errors.",
             len(all_issues), len(changed_pages), len(errors))

    anomaly = bool(all_issues) or (not first_run and bool(changed_pages))
    if anomaly:
        total = len(all_issues) + len(changed_pages)
        send_email_alert(report, total)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log.warning("Interrupted by user.")
        sys.exit(1)
    except Exception as exc:  # last-resort guard so cron always gets an exit code
        log.error("Fatal error: %s", exc)
        sys.exit(1)


# ======================================================================
# USAGE
# ======================================================================
#
# 1. Install dependencies (once):
#
#       pip3 install requests beautifulsoup4
#
# 2. First run — creates the integrity baseline (page_hashes.json) and reports
#    any heuristic findings. No "content changed" alerts fire on this run:
#
#       python3 monitor.py
#
# 3. Enable email alerts by exporting two environment variables. For Gmail,
#    turn on 2-Step Verification then create an App Password
#    (https://myaccount.google.com/apppasswords) and use that here:
#
#       export ALERT_EMAIL="you@gmail.com"
#       export ALERT_SMTP_PASSWORD="your-16-char-app-password"
#       # optional overrides:
#       # export ALERT_SMTP_SERVER="smtp.gmail.com"
#       # export ALERT_SMTP_PORT="587"
#       # export ALERT_SMTP_FROM="you@gmail.com"
#
# 4. Schedule it daily at 07:00 with cron. Because secrets must be present in
#    cron's environment, set them in the crontab itself (chmod 600 your crontab)
#    or source a protected env file. Example crontab line:
#
#       0 7 * * * cd /path/to/script && \
#         ALERT_EMAIL="you@gmail.com" ALERT_SMTP_PASSWORD="app-password" \
#         /usr/bin/python3 monitor.py >> cron.out 2>&1
#
#    The script also exits 1 on any anomaly, so you can let cron's MAILTO or a
#    wrapper trigger system notifications based on the exit code.
#
# 5. Logs accumulate in monitor.log (and stdout). The integrity baseline lives
#    in page_hashes.json — delete it to rebuild the baseline from scratch.
#
# ======================================================================
