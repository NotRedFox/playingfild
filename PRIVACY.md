# PLAYINGFILD PRIVACY POLICY

**Version 1.10.0.0** | **Last Updated:** July 30, 2026  
**Contact:** AOEPlayingFild@protonmail.com

**Public URL:** https://gist.github.com/NotRedFox/e400c02894f215b20b805e16eda7aa88

---

## GOOGLE WEB STORE POLICY COMPLIANCE DECLARATION

In compliance with the Chrome Web Store Developer Program Policies, PlayingFild explicitly declares the following:

1. The extension only uses permissions and accesses data strictly required to provide and improve its core user facing functionality (mindful productivity, tab optimization, and attention management).

2. All data accessed, processed, or transmitted by this extension is used solely for the user's explicit benefit and to power the extension's stated features.

3. We do not sell, trade, rent, or transfer user data, browsing histories, web analytics, or personal profiles to any third-party advertising networks, data brokers, or monetization entities under any circumstances.

4. The extension does not utilize user data for the purposes of remote code execution, tracking user behavior across unrelated platforms, or establishing alternative monetization pipelines.

---

## PLAIN-ENGLISH SUMMARY

PlayingFild is a Chrome extension that helps you focus by classifying webpages as productive, neutral, or unproductive, and optionally closing tabs you've told it are unproductive. To do this well, it reads **page title and visible text on most sites** to classify tabs locally. It does **not** read page content on banking, login, payment, AI chat, or other sensitive surfaces. Those are handled with **hostname-only, Neutral classification and no content scraping**. We've designed the system so that PlayingFild requires you to sign in (with a verified email) before it classifies pages, closes tabs, or shows feedback cards. In Local mode, your personal classifier data stays on your device and we do not send Layer 2 telemetry or sync Layer 3 data to our servers. In Standard mode, selected training and telemetry data is sent as described below.

There are three layers of data described below. This document covers what we collect, how we operate, and your rights.

---

## HOW WE MAKE MONEY: HOW THE FREE TIER IS SUPPORTED

PlayingFild is free to use. To support development and maintain the infrastructure without user paywalls, PlayingFild is supported through a freemium model.

The standard tier uses on-device processing for classification. A paid enterprise tier may be offered in the future; it is not available today. If we launch a paid tier, we will update this policy before it goes live.

We do not sell, trade, or rent individual user browsing histories, personal identifiers, or sensitive profiles to third parties or advertising networks. We will never sell your data to:

- Advertising or retargeting networks
- Surveillance products or surveillance-adjacent companies
- Data brokers selling individual profiles
- Insurance underwriters or credit scoring services
- Employers or hiring platforms (without separate explicit consent)
- Government agencies, except in response to a valid legal order

If we ever consider expanding into a category not on this list, we will update this policy, email all signed-in users, and require fresh explicit opt-in.

---

## HOW WE DECIDE NOT TO READ A PAGE

PlayingFild uses three layers of protection before reading page content:

1. **Host blocklist** — Known sensitive categories (banks, webmail, healthcare, listed AI tools, etc.).

2. **URL path rules** — Auth and payment paths (`/login`, `/checkout`, `/oauth`, etc.).

3. **On-page detection** — If the page looks like a bare login form, payment form, or AI chat interface, we skip reading content even on unlisted sites.

When any layer triggers, you still see the site in your stats as **Neutral time**. We do not show “was this productive?” feedback cards on those pages, and we do not send Layer 2 telemetry for that visit in Standard mode.

---

## AGE REQUIREMENT

PlayingFild is not for users under 13. This is due to data protection laws including the UK GDPR, the EU GDPR, and the US Children's Online Privacy Protection Act (COPPA). At signup, you must confirm you are 13 or older by checking our age-verification box.

If you believe an underage user has signed up, contact AOEPlayingFild@protonmail.com.

We store a timestamp when you confirm your age (`agreed_to_age_at`). We do not ask for or store your birthdate.

---

## WHAT DATA WE COLLECT

### LAYER 1 — PROCESSED ON YOUR DEVICE

The following is computed and stored on your device. Some of it stays on your device only. Some of it is also synced to your account in Standard mode (see Layer 3).

**Stays on your device only (never synced to our servers):**

- Full page URLs, titles, headings, and visible text used for live classification
- Mode B banking source and target site lists
- Timer lengths, startup tab URLs, and other window settings not on the Layer 3 sync allowlist
- Daily WPM / typing-speed charts
- Raw click coordinates used for the local click-activity UI
- Sensitive-page detector evaluation metadata (category/reason/score) used only to gate scraping locally
- Banked tabs: when you go over your tab limit, the addresses of the tabs that were parked are stored on your device so you can reopen them. They are deleted after 24 hours, or when you clear them yourself, and are never uploaded

**Stored on your device and synced in Standard mode (Layer 3):**

- Your personal keyword weights and pairs
- Hostname bias and path scores
- Class counts and internal trust calibration (Elo)
- Allowlisted window preference fields (not banking sites or full timer config)

Layer 1 page text and URLs are used locally to classify tabs. We do not upload full page bodies to our servers in Layer 2 or Layer 3.

#### SENSITIVE PAGES — NO CONTENT SCRAPING (Layer 1, on-device)

On many sensitive surfaces, PlayingFild does not read page body text at all. Instead it classifies the tab as **Neutral** using hostname-level signals only, while still counting time on that site in your local stats.

Content scraping is skipped when **any** of the following apply:

**(A) Static excluded hosts** — A maintained list including webmail, major banks, healthcare portals, password managers, payment processors, government services, listed AI assistant tools, and adult content sites. See “Excluded and sensitive pages” in Layer 2.

**(B) Sensitive URL paths** — Login, sign-in, checkout, billing, OAuth, password-reset, and similar auth/payment paths (e.g. `/login`, `/checkout`, `/oauth`).

**(C) Sensitive-page detection (DOM-based)** — On pages that look like a login form, payment/checkout form, or AI chat interface (e.g. large prompt box plus message thread), the extension skips content scraping even if the hostname is not on the static list. Examples: unlisted AI tools (e.g. kimi.com), regional bank dashboards, Slack/Discord/Teams chat surfaces.

**(D) Settings carve-out** — Logged-in settings pages with a password-change field are **not** treated as login pages; only bare login/checkout surfaces are gated.

When content scraping is skipped:

- Full page body text is **not** read or used for keyword classification
- Feedback cards are **not** shown on that page
- The tab is classified as **Neutral** for stats and the closer indicator
- Time on site **is** still recorded locally in your stats dashboard as Neutral time
- In Standard mode, Layer 2 sends **nothing** for that page visit (same as excluded hosts)

---

### LAYER 2 — STANDARD MODE TELEMETRY (ONLY WHEN YOU CHOOSE STANDARD MODE)

#### URL Path Collection (Tiered Allowlist)

For Layer 2 telemetry we apply a per-site allowlist that determines what part of a URL is sent to our servers.

**PUBLIC CONTENT PATHS — Full path sent**

On a curated list of public content sites where URL paths identify public, shareable content rather than personal user state, we send the path because it materially improves classifier accuracy. The current list includes:

- YouTube video, shorts, channel, and playlist URLs
- Reddit subreddit and thread URLs
- Wikipedia article URLs
- GitHub public repository URLs (repo root and standard sub-pages only)
- Stack Overflow and Stack Exchange question URLs
- Medium article URLs
- Twitter/X public post URLs
- LinkedIn, Amazon, and Twitch URLs (full path on these hosts, per our internal allowlist)
- Additional ecommerce and documentation hosts at shallow path depth only (e.g. ebay.com, etsy.com, developer.mozilla.org, learn.microsoft.com), per our internal allowlist

**A NOTE ON CODE HOSTING**

GitHub URLs include user names, organization names, and repository names in the path. For public repositories these are already-public information. For private or enterprise repositories, the URL itself reveals organization and project names even though we never see the code.

If you work with private repositories whose names should stay private, please use Local mode (no remote telemetry or cloud sync).

Gists (`gist.github.com`) are excluded entirely from Layer 2 telemetry because they are often used for personal snippets, config files, and temporary content.

These are public content identifiers, equivalent to the link you would share with someone else.

**PERSONAL/ACCOUNT PATHS — Hostname only, even on allowlisted sites**

Even on sites where deep paths are otherwise sent, we strip paths that indicate personal user state. This includes settings pages, account pages, private message paths, user profile paths, billing pages, security pages, and notification pages. From these we send only the hostname.

**ALL OTHER SITES — Hostname only**

Any site not on the allowlist is reduced to its hostname before transit (e.g., `example.com` instead of `example.com/some/deep/path`).

**EXCLUDED AND SENSITIVE PAGES — Nothing sent in Layer 2**

Layer 2 telemetry is **not** sent for:

1. **Static excluded hosts** — webmail, listed major banks, healthcare portals, password managers, payment processors, government services, listed AI assistant tools (e.g. Claude, ChatGPT, Gemini, Perplexity, Copilot), and adult content sites.

2. **Sensitive URL paths** — login, checkout, billing, OAuth, and similar auth/payment paths.

3. **DOM-detected sensitive pages** — pages classified as login, payment/checkout, or AI-chat surfaces by on-device page inspection (including unlisted AI tools such as kimi.com and team chat tools such as Slack, Discord, and Microsoft Teams).

For all of the above: we send **no** hostname, path, keywords, or engagement telemetry for that page visit in Layer 2.

**Local stats:** Time on these sites still appears in your dashboard as **Neutral time**. Only remote telemetry and content reading are suppressed.

**Exception (Mode B earn only):** If you explicitly add an excluded or sensitive AI/private host (e.g. `claude.ai`) as a Mode B source site, we credit earn time using active-tab hostname match and elapsed time on your device only. We do not scrape page content, extract keywords, or send Layer 2 URL telemetry for that host. Banking source/target lists are stored locally and are never synced.

**Limitation:** The static excluded-host list cannot cover every bank or AI tool worldwide. DOM-based sensitive-page detection provides additional protection for unlisted sites that present as login, payment, or chat surfaces. It is not a guarantee against every possible sensitive page layout.

**QUERY PARAMETERS**

On allowlisted sites we keep a small set of query parameters that serve as content identifiers (e.g., YouTube's `v=` for video ID, `list=` for playlist, `t=` for timestamp). All other query parameters — including tracking codes (`utm_*`, `fbclid`, `gclid`), session tokens, and authentication state — are stripped before transit.

**Never sent in Layer 2:**

- Full page body text
- URLs containing email addresses
- OAuth callback URLs with tokens or state parameters
- Session identifiers, authentication tokens, or API keys
- Anything from excluded hosts (except Mode B time-on-tab earn counting described above, which does not send URLs to our servers)
- Dedicated search-history exports (we do not upload your search history as a separate dataset)
- Page visits where sensitive-page detection blocked content scraping (treated the same as excluded hosts for Layer 2)

**Note:** On some allowlisted sites, sanitized search-related query parameters (e.g. `q=`, `search=`) may be included in URL telemetry after stripping tracking and auth parameters.

### ANALYTICS MANAGEMENT AND OPT-IN CONTROL

PlayingFild has two data modes, chosen in Profile → Settings (or during onboarding):

- **Local Mode:** No Layer 2 remote telemetry and no Layer 3 cloud sync. You must still sign in with a verified email for core features (classification, tab closing, feedback cards). Layer 1 data is still processed on your device.

- **Standard Mode:** Enables Layer 2 telemetry and Layer 3 sync as described in this policy. Until you choose Local mode, your selection may be stored as "pending" and treated as Standard in the UI.

There is no per-field telemetry toggle in the dashboard today — only Standard vs Local. A paid enterprise tier is not available yet.

### SESSION REPLAY (DASHBOARD ONLY, MASKED)

To find bugs we cannot reproduce, we record masked session replays of the extension dashboard only. We do not record any website you visit.

Every text node and every input is masked before it leaves your device, so we see layout and clicks, not words. Some panels are blocked from recording entirely rather than masked: the productive vs unproductive chart, the per-site time list, your most-used sites, the settings drawer (which shows your display name and email), your saved startup URLs, Wrapped cards, and the earn/spend site fields. Network request headers and bodies are not recorded, and content inside cross-origin frames is not recorded.

Replays are keyed to a random per-install identifier, never your account ID, email or display name. They are processed by PostHog on EU infrastructure.

The "Send anonymous product analytics" switch in Profile -> Settings turns replay off as well, and takes effect immediately rather than at the next restart. Replay also does not run where that switch cannot be read, or where the install has been flagged as automated.

### ANONYMOUS EVENTS BEFORE SIGN-IN

A fixed set of events is recorded before you have an account, so we can see where setup goes wrong: installation, each onboarding step reached, reaching the sign-in screen, submitting a sign-up or sign-in, requesting a password reset, and choosing a theme.

These carry a random per-install identifier and no personal information, and are not linked to an account afterwards. Every other analytics event requires you to be signed in. Each event also carries a build channel label so we can separate our own development builds from real usage.

### ON THE TERM "PSEUDO-ANONYMOUS"

Layer 2 telemetry does not include your email or display name, but it does include your Supabase `user_id` and a device `telemetry_id` so we can honor deletion requests and prevent abuse. Because it includes behavioral patterns (engagement scores, time on site, feedback keywords), it is pseudo-anonymous rather than fully anonymous. With enough behavioral signal, an individual could in theory be re-identified. We design our systems to minimize this risk and apply small-cell suppression in aggregated reporting.

We do not collect your birthdate or an age bracket. At signup you confirm you are 13 or older; we store `agreed_to_age_at` (timestamp only).

Session replay and pre-sign-in events are separate from Layer 2 and are keyed to a random per-install identifier rather than your account. They are not joined to your Layer 2 or Layer 3 data.

### WHY WE COLLECT A PURE ENGAGEMENT SCORE AND NOT RAW SIGNALS

The pure engagement score is a single number we use to detect automated traffic (bots). A user whose pure engagement score is consistently near zero across many domains is statistically likely a bot, and we exclude their contributions from the global model. We do not need the raw clicks, scrolls, or keystrokes — only the derived score. The raw signals stay on your device.

### WHAT LAYER 2 SENDS AND DOES NOT SEND

**NOT sent in Layer 2:**

- Full page body text
- Your email or display name
- Raw mouse click coordinates
- Keystroke content (typing-speed metadata stays local only)
- URLs or engagement from excluded hosts, sensitive URL paths, or DOM-detected sensitive pages (banking, healthcare, webmail, AI/chat tools, login/checkout surfaces, etc.), except Mode B earn time counting on your device as described above
- Anything from session replay or pre-sign-in analytics, which are described separately above and are not part of Layer 2

**May be sent in Layer 2 (Standard mode only):**

- `user_id` (Supabase account UUID) and `telemetry_id`
- Sanitized hostname and, on allowlisted sites, sanitized path and limited query parameters
- PII-filtered content keywords from feedback events
- Engagement scores, bot-confidence signals, and time-on-site aggregates
- Feedback verdicts and contributor Elo at time of event

**Also sent via anonymous global model updates (Standard mode):** aggregated keyword and URL weight adjustments derived from feedback (RPC updates), separate from your personal `user_data` row.

### LAYER 3: AUTHENTICATED SYNC (ACTIVE WHEN YOU SIGN IN)

When you create an account and sign in, your personal scores, vocabulary, and learned data sync between your devices. This data is stored in our database, associated with your verified email address, and protected by row level security.

Your Layer 3 data is linked to your verified email account and protected by database row-level security so other users cannot read your row. Operational access by PlayingFild staff or our infrastructure providers (e.g. Supabase) may exist for support, security, and legal compliance under internal access controls.

Layer 3 sync does **NOT** include: Mode B banking source/target site lists, startup tab URLs, or full timer/limit configuration — only allowlisted window preference fields sync.

---

## WHAT WE DO WITH THE DATA

- **Layer 1 (on-device processing):** Used by your local classifier. On non-sensitive pages, title and visible text are processed on your device only — not uploaded as page bodies. On sensitive pages (excluded hosts, auth paths, or DOM-detected login/payment/chat surfaces), body text is not read; the tab is classified as Neutral and time is logged locally. See the Layer 1 section above for what stays local vs what syncs in Standard mode.

- **Layer 2 (Pseudo-Anonymous Telemetry):** Data processed under Layer 2 is used strictly for the following system operations:
  1. To improve the global classifier engine so new users receive optimized focus defaults.
  2. To detect automated traffic (bots) and exclude their contributions from our global models.
  3. To evaluate high-level domain categories to train our local classification engine's accuracy scores and verify baseline system performance.

  Layer 2 data is also used to download global default model weights (`url_scores`, `keyword_weights`) to your device in Standard mode. Layer 2 is pseudo-anonymous, not fully anonymous (see above). Small-cell suppression protocols apply to aggregated reporting.

- **Layer 3 (authenticated sync):** Used solely to sync your personal data across your devices. Not used for analytics, not used for product decisions, not shared, not sold.

---

## BROWSER PERMISSIONS

PlayingFild requests the following Chrome permissions to operate:

- **tabs, scripting, webNavigation:** tab management, classification, and in-page UI (feedback cards, closer indicator)
- **storage, unlimitedStorage:** local classifier data, settings, and daily stats
- **alarms, idle:** timers, break/study sessions, and idle-aware time tracking
- **notifications:** optional alerts when tabs are closed
- **host_permissions (`http://*/*`, `https://*/*`):** required to run content scripts on pages you visit for classification

Content scripts run on http(s) pages you visit. On most pages they read page title and visible text locally for classification. On excluded hosts, sensitive URL paths, and pages detected as login/payment/AI-chat surfaces, content scraping is skipped: only the hostname is used, the tab is classified as Neutral, and time is still counted in local stats. Password fields and payment inputs are never included in scraped text.

---

## YOUR RIGHTS AND DATA DELETION MECHANICS

You have the following rights:

- The right to know what data we have about you. This document is the answer; specific questions can be sent to AOEPlayingFild@protonmail.com.
- The right to delete your account data (Layer 3). Email AOEPlayingFild@protonmail.com with your request. We will process deletion within 30 days.
- The right to delete your Layer 2 telemetry contributions. To delete past Layer 2 contributions, email AOEPlayingFild@protonmail.com with your current telemetry ID. We will delete all raw historical rows matching that specific ID from our production database within 30 days. Future contributions can be stopped by signing out.

### IRREVERSIBLE DATA AGGREGATION EXCLUSION

Please note that while requesting a deletion removes your personal account data (Layer 3) and your specific historical telemetry rows (Layer 2) from our databases, it does not alter or erase calculations that have already been compiled into our multi-user macro trends or the global model weights.

Once individual telemetry metrics are processed, stripped of their telemetry IDs, and mathematically fused into multi-user group averages (e.g., broad website category metrics), they cease to be personal or identifiable data. It is mathematically impossible to extract or isolate an individual user's data from these combined structural trend calculations, and these aggregated, completely anonymous macro datasets are retained permanently solely to maintain the operational performance, default weights, and structural stability of the local classification engine.

If you live in the EU, UK, California, or Australia, you also have the rights granted by GDPR, UK GDPR, CCPA, and the Privacy Act 1988. To exercise any of these, email AOEPlayingFild@protonmail.com.

---

## DATA RETENTION

- **Layer 1** stays on your device until you uninstall the extension or clear browser storage.
- **Layer 2** raw rows are retained while you have an active signed-in account on the free tier. Past individual contributions are purged upon deletion request as described above. Aggregated macro trends are kept permanently.
- **Layer 3** account data is retained while your account exists. Account deletion removes data within 30 days of request.

---

## SECURITY INFRASTRUCTURE

All data in transit between the extension and our servers is secured via encrypted HTTPS / TLS protocols. Authenticated user data is structurally isolated using database row-level security managed via industry-standard hashed credentials on our backend infrastructure.

We protect your data against unauthorized access, alteration, disclosure, or destruction by restricting server-side access exclusively to programmatic APIs required for global model updates. Authentication uses Supabase Auth with industry standard hashed credentials.

---

## CHANGES TO THIS POLICY

If we change this policy, we will:

- Update the "last updated" date at the top.
- Email all signed-in users.
- Show a notice inside the extension on next dashboard open.

Material changes (new data uses, new selling categories) require fresh explicit opt-in.
The in-extension notice is shown to existing installations only. A new installation is not shown it, because the current policy is the one in force when they installed.


---

## CONTACT

For any privacy questions, requests, or concerns, email AOEPlayingFild@protonmail.com.

The developer of PlayingFild is currently a solo developer based in Australia.

---

## LIMITED USE COMPLIANCE DISCLOSURE

PlayingFild's use and transfer to any other app of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. We do not sell, trade, lease, or rent user data, browsing metrics, or telemetry to third parties, advertising networks, or data brokers under any circumstances.
