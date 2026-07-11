# Browser Anti-Crawling Mechanisms and Multi-Tab Handling

> Research and recommendations for the deepseek-arch Playwright-based browser automation system.
> Created: 2026-07-14 · Updated: 2026-07-14

## Table of Contents

1. [Anti-Crawling Mechanisms Affecting Playwright](#1-anti-crawling-mechanisms-affecting-playwright)
2. [Existing Mitigations and Their Limitations](#2-existing-mitigations-and-their-limitations)
3. [Recommended Approach for This Project](#3-recommended-approach-for-this-project)
4. [Multi-Tab Handling](#4-multi-tab-handling)
5. [Practical Recommendations](#5-practical-recommendations)

---

## 1. Anti-Crawling Mechanisms Affecting Playwright

### 1.1 Browser Fingerprinting

Modern anti-bot systems (Cloudflare Turnstile, DataDome, Akamai Bot Manager, reCAPTCHA v3, PerimeterX) use a combination of signals to distinguish automated browsers from real users. These fall into several categories:

#### JavaScript Property Detection

The most well-known signal is `navigator.webdriver`. In Playwright (and Puppeteer), this property is set to `true` by default on the `window.navigator` object. Real browsers never have this property.

```javascript
// What Playwright exposes by default:
navigator.webdriver === true  // ← BOT DETECTED

// What a real user browser shows:
navigator.webdriver === undefined
```

Other detected properties include:

| Property | Automation Value | Real Browser |
|----------|-----------------|--------------|
| `navigator.webdriver` | `true` | `undefined` |
| `navigator.plugins` | May be empty or non-standard | Length > 0 for most users |
| `navigator.languages` | May be missing | `["en-US", "en"]` |
| `navigator.hardwareConcurrency` | Default (4) | Varies (4-16) |
| `chrome.runtime` (in Chrome) | Missing | Present in real Chrome |
| `window.chrome` | May be incomplete | Full Chrome API surface |
| `navigator.permissions` | May behave differently | Standard behavior |

#### Chrome DevTools Protocol (CDP) Detection

Some advanced bot detectors can detect the presence of CDP connections. When Playwright connects via CDP (`connectOverCDP`), there are subtle differences:

- CDP connections leave traces in `chrome://inspect`
- Some sites detect the `--remote-debugging-port` flag by checking `navigator` or rendering properties
- WebSocket-based CDP connections can be detected via timing analysis

#### User-Agent Analysis

Playwright's default User-Agent includes `HeadlessChrome` when running headless, which is an immediate red flag. Even in headed mode, the User-Agent may lack the "normal" version signature that real browsers have.

```
# Headless (detected):
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/XXX Safari/537.36

# Headed (still may be flagged):
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/XXX Safari/537.36
```

#### WebGL and Canvas Fingerprinting

Automated browsers may have different WebGL renderer strings (`ANGLE (Google, Vulkan 1.3.0, ...)` vs real GPU), different canvas fingerprinting results, and different font rendering. Headless mode often uses SwiftShader (software rendering) which leaves a unique fingerprint.

#### Behavioral Analysis

Bot detectors analyze interaction patterns:

- **Mouse movements**: Automated browsers often have no real mouse movement, or movements are too linear/perfect
- **Scroll behavior**: Human scrolling is non-uniform with acceleration/deceleration
- **Click timing**: Human clicks have micro-delays; automated clicks happen instantly
- **Network timing**: Request patterns, headers, timing between page loads
- **Viewport/resize**: Automated browsers often have fixed viewport without resizing events

#### IP Reputation and Rate Limiting

- Cloudflare, Google, and others maintain IP blacklists
- Datacenter IP ranges (common for cloud-hosted bots) are frequently blocked
- Rate limiting detects rapid, script-like access patterns

### 1.2 Specific Services and Their Detection Methods

| Service | Detection Methods | Playwright Impact |
|---------|------------------|-------------------|
| **Cloudflare Turnstile** | JS challenges, browser fingerprinting, behavior analysis, IP reputation | High — frequently blocks headless Chromium even with stealth patches |
| **Cloudflare JS Challenge (5s)** | JS execution capabilities, browser property checks | Moderate — Playwright passes JS execution but may fail property checks |
| **Google reCAPTCHA v3** | Behavioral scoring, browser signals, risk analysis | High — returns low scores for automated browsers, triggers challenges |
| **Google reCAPTCHA v2** | Image challenges, interaction patterns | Moderate — solvable but often triggered as additional check |
| **Akamai Bot Manager** | TLS fingerprinting, HTTP/2 fingerprints, JS challenges | High — very aggressive, uses multiple signal layers |
| **DataDome** | Real-time JS execution, mouse tracking, fingerprinting | High — actively monitors for Playwright/Puppeteer signatures |
| **PerimeterX (Human)** | Comprehensive JS challenge, behavioral analysis | High — similar to DataDome |
| **Shape Security (now F5)** | JS obfuscation, DOM manipulation detection | High — specifically targets automation frameworks |

### 1.3 Which Detection Methods Affect This Project Specifically?

For deepseek-arch, the relevant threat vectors depend on the browser mode:

| Mode | Vulnerability |
|------|--------------|
| **Mode B: Local headless Chromium** | Highest risk — `navigator.webdriver=true`, `<headless>` in User-Agent, WebGL surface differences, datacenter IP, no browser extensions or cookies |
| **Mode B: Local headed Chromium** | Moderate risk — `navigator.webdriver=true` still present, standard User-Agent, but visible window + real desktop environment helps behavioral signals slightly |
| **Mode A: CDP to host Edge** | Lower risk — real browser, real user profile, real User-Agent, real cookies, real GPU. But CDP connection itself can be detected by advanced scanners |

**Key vulnerabilities in the current codebase** (src/tools/browser-state.ts):

1. **No stealth patches**: `navigator.webdriver` remains `true`
2. **Launch args are minimal**: Only `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage` — none address fingerprinting
3. **Default User-Agent**: Headless mode uses HeadlessChrome UA
4. **No viewport randomization**: Hardcoded `1280x720` viewport
5. **No cookie/persistent profile**: Fresh context each launch (no session reuse)
6. **No request interception**: No route modification to strip identifying headers

---

## 2. Existing Mitigations and Their Limitations

### 2.1 playwright-extra / puppeteer-extra-plugin-stealth

The `playwright-extra` ecosystem provides a stealth plugin that patches many of the detectable properties:

```javascript
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
```

**What it patches:**
- `navigator.webdriver` → set to `undefined`
- `navigator.plugins` → adds real-looking plugin array
- `navigator.languages` → adds typical language array
- `window.chrome` → adds full Chrome runtime API surface
- `navigator.permissions` → normalizes permission behavior
- WebGL vendor/renderer → hides SwiftShader in headless mode
- `navigator.hardwareConcurrency` → randomizes CPU core count

**Limitations:**
- **Not actively maintained**: The `playwright-extra` package has lagged behind Playwright releases. As of 2024-2025, it's increasingly incompatible with latest Playwright versions.
- **Arms race**: Bot detectors are aware of stealth patches and check for the artifacts they leave (e.g., missing certain properties that should exist, or existing properties that shouldn't).
- **False sense of security**: Patches help with simple detection but don't fool advanced behavioral analysis.
- **Maintenance burden**: Each Chromium/Playwright update can break stealth patches.
- **Not available for `connectOverCDP`**: Stealth plugins only work when launching a new browser, not when connecting to an existing one.

### 2.2 Manual Launch Args

Common launch arguments that reduce detection:

```javascript
chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',  // Hides automation flags
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-web-security',  // (not recommended)
    '--disable-features=EnableEphemeralFlashPermission',
    '--disable-infobars',
    '--disable-notifications',
    '--window-size=1280,720',
  ]
});
```

`--disable-blink-features=AutomationControlled` is the most relevant — it removes the Chrome automation controller that sets `navigator.webdriver`. However, this flag alone is not sufficient against sophisticated detectors.

### 2.3 User-Agent Spoofing

Setting a custom User-Agent:

```javascript
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
});
```

**Limitations:** Only masks one signal. Detectors combine User-Agent with other properties to detect inconsistencies.

### 2.4 Viewport / Screen Fingerprint Randomization

```javascript
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
```

**Limitations:** Helps marginally. The LLM agent doesn't need visual consistency, but detectors can still match viewport to known automation patterns.

### 2.5 The CDP Approach (Connecting to a Real Browser)

This is the strongest mitigation. When connecting to a real user's browser (Edge/Chrome with a real profile):

- Real User-Agent (no `HeadlessChrome`)
- No `navigator.webdriver` flag
- Real cookies, localStorage, session data
- Real browser extensions (ad blockers, privacy tools)
- Real GPU and WebGL fingerprints
- Real user IP (not datacenter, if running on local machine)
- Normal `window.chrome` API surface

**However, even CDP has limitations:**
- Some advanced scanners can detect the CDP WebSocket connection itself
- The agent creates a **new context** (`browser.newContext()`), which inherits some properties from the browser but starts with no cookies
- If the user's browser has been used normally, the IP and TLS fingerprint are real — this is the biggest advantage

### 2.6 Summary of Mitigation Effectiveness

| Mitigation | Against Basic Detection | Against Advanced Detection (Cloudflare, Akamai) | Maintenance |
|-----------|:----------------------:|:----------------------------------------------:|:-----------:|
| No mitigation (current) | ❌ Fails | ❌ Fails | None |
| `--disable-blink-features=AutomationControlled` | ✅ Passes basic `navigator.webdriver` check | ❌ Still fails behavioral and multi-signal checks | Low |
| Playwright-extra stealth plugin | ✅ Passes most JS property checks | ⚠️ Partial — may pass some, fail others | High (compatibility breaks) |
| User-Agent spoofing | ✅ Hides headless UA | ❌ Insufficient alone | Low |
| Full fingerprint randomization | ⚠️ Partial improvement | ❌ Still fails advanced checks | Medium |
| **CDP to real browser** | ✅ Passes all JS property checks | ✅ Best chance against advanced detectors | None needed |
| **CDP + real user profile** | ✅✅ Strongest | ✅✅ Strongest | None needed |

---

## 3. Recommended Approach for This Project

### 3.1 Guiding Principles

This project is a **terminal AI agent** (not a web scraping tool or bot farm). The browser tools are used for:

- Reading documentation websites
- Searching for information
- Interacting with web-based tools (APIs, dashboards)
- Occasionally filling forms or logging into services

The agent makes **low-frequency, human-paced** requests (one page visit per LLM turn, with thinking time between actions). This is fundamentally different from a scraper that makes thousands of requests per minute.

Therefore, the recommended approach prioritizes:
1. **Pragmatism over perfection** — avoid over-engineering for edge cases that may never arise
2. **CDP-first** — leverage the existing CDP infrastructure as the primary anti-detection strategy
3. **Lightweight hardening for local launch** — add minimal, well-understood patches rather than fragile stealth plugins
4. **Documentation over code** — educate users on when and how to use CDP vs. local launch

### 3.2 Recommended Changes for Local Chromium Launch

Add the following minimal set of hardening measures to `src/tools/browser-state.ts`:

#### a) `--disable-blink-features=AutomationControlled`

```typescript
args: [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',  // ADD
]
```

This removes the Chrome automation flag that sets `navigator.webdriver`. It's a single flag, well-understood, and doesn't break with updates.

#### b) Custom User-Agent for headless mode

When running headless, Playwright's default User-Agent includes `HeadlessChrome`. Override it:

```typescript
const contextOptions: Record<string, unknown> = {
  acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
```

**Important**: Only override the User-Agent for headless mode. In headed mode, Playwright uses the real browser's User-Agent which is already correct.

#### c) Remove `navigator.webdriver` via addInitScript

For additional hardening against property-based detection:

```typescript
// After creating the context but before creating the page:
await this.context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

This is a well-known technique that removes the most obvious automation signal. Note that sophisticated detectors also check for `Object.defineProperty` artifacts, but this still defeats basic detection.

#### d) What NOT to do

- **Do NOT add playwright-extra/stealth**: The maintenance burden exceeds the benefit. It lags behind Playwright releases and gives a false sense of security.
- **Do NOT add full fingerprint randomization**: WebGL, canvas, font fingerprinting are detectable and the agent's usage patterns (slow, human-paced) don't justify the complexity.
- **Do NOT add request interception for User-Agent stripping**: The `contextOptions.userAgent` approach is cleaner and doesn't interfere with page loading performance.

### 3.3 CDP is the Primary Anti-Detection Strategy

The existing CDP mode (`--cdp` / `BROWSER_CDP`) is the single most effective strategy. When connecting to a real browser:

- **No automation flags** — the browser was launched manually by the user
- **Real profile** — cookies, localStorage, extensions are all real
- **Real IP** — the user's actual network connection, not a datacenter IP
- **Real browser fingerprint** — GPU, fonts, plugins, etc.

**Recommendation**: Promote CDP as the primary browser mode in documentation. The `--cdp` flag should be the recommended way to browse websites that have anti-bot protection.

**Trade-off**: CDP requires:
1. A browser already running with `--remote-debugging-port` on the host
2. Network connectivity between the agent environment and the browser host (important for WSL2 users)
3. The user's browser remains open during the session

These are reasonable requirements for a developer tool.

### 3.4 How Cloudflare Challenges Should Be Handled

Cloudflare is the most commonly encountered anti-bot system. Here's the pragmatic approach:

**For CDP mode (recommended):**
- Cloudflare typically does NOT challenge a connection from a real user's browser with real cookies
- The user visits the site normally in their own browser, Cloudflare sets the `cf_clearance` cookie
- When the agent connects via CDP, it creates a new context (different cookie jar). The clearance cookie is **NOT** inherited.
- **Mitigation**: When using CDP, the agent should navigate to a URL that Cloudflare will check. Since the context is fresh, it may still get a challenge.
- **Workaround**: The user can set up the CDP connection to reuse the default context (user's main browsing session) instead of creating a new isolated context. This would inherit all cookies including Cloudflare clearance. However, this has privacy implications (the agent can see all the user's cookies).

| Approach | Cloudflare Challenge | Privacy | Recommendation |
|----------|:-------------------:|:-------:|:--------------:|
| New context via CDP | May still get challenged | ✅ Isolated from user's session | Default behavior |
| Reuse existing context via CDP | ✅ Passes (clearance cookie inherited) | ⚠️ Agent can access user's cookies | Not recommended by default |
| Local Chromium (headless/headed) | ❌ Almost always challenged | ✅ Clean session | Not suitable for Cloudflare sites |

**For Cloudflare sites, the current approach has a gap**: the CDP mode creates a new context, so Cloudflare clearance cookies are lost. A potential improvement would be an option to reuse the default context (the user's existing browser session). This could be added as an opt-in flag like `--cdp-context=default`.

**For Local Chromium mode:**
- Cloudflare will almost always challenge headless Chromium
- Even headed Chromium is often challenged because `navigator.webdriver` is flagged
- The `--disable-blink-features=AutomationControlled` flag + `addInitScript` patch improves odds but doesn't guarantee success
- **Practical advice**: If a site is blocked by Cloudflare, switch to CDP mode. Accept that some sites will be inaccessible to the local Chromium mode.

---

## 4. Multi-Tab Handling

### 4.1 Current State

The current implementation in `src/tools/browser-state.ts` manages:

```typescript
class BrowserState {
  private browser: Browser | null = null;   // Single browser instance
  private context: BrowserContext | null = null;  // Single context
  private page: Page | null = null;         // Single page
  // ...
}
```

**Key observations:**

1. **Single page ONLY**: All tools operate on `this.page`. There is no concept of tabs, tab switching, or tracking multiple pages.
2. **CDP creates a new context**: When using CDP mode, `connectOverCDP()` connects to the host browser, then `browser.newContext()` creates a new isolated context. This context gets a new page via `context.newPage()`. This appears as a new tab/window in the host browser.
3. **Local launch also creates single context + page**: Same pattern, a fresh context and a single page.
4. **No popup handler**: There is no listener for page popups (`page.on('popup')` or `context.on('page')`). If a click opens a new tab, that new page is not tracked.

### 4.2 Gaps and Risks

#### Gap 1: User Switches Tabs Manually

**Scenario**: The agent is browsing in headed mode or CDP mode. The user manually switches to another tab in the browser window. The agent continues to operate on the original page (which is now in the background). This works, but the snapshot reflects the background page, which may confuse the user.

**Risk**: Low. The agent has a consistent view of its page.

#### Gap 2: Click Opens a New Tab

**Scenario**: The agent clicks a link with `target="_blank"` or a JavaScript `window.open()`. This creates a new tab but the agent's `this.page` still points to the original page. The agent doesn't know about the new tab.

```html
<!-- Example: link that opens a new tab -->
<a href="https://example.com/newpage" target="_blank">Open New Tab</a>
```

**Risk**: High. The agent sees the original page unchanged, may become confused about why the navigation didn't happen, and may retry or report an error.

**Playwright behavior**: When a click triggers a popup/new tab, Playwright creates a new `Page` object but does NOT automatically switch the agent's reference to it. The agent must listen for the `popup` event:

```javascript
// Current code — no popup handler
await page.getByText('Open New Tab').click();

// What happens: new tab opens, but this.page is still the original
// The agent has no way to interact with the new tab
```

#### Gap 3: Multiple Tabs Opened by the Agent

**Scenario**: The agent navigates to a page, opens a link in a new tab, then later needs to switch back to the original tab.

**Risk**: Moderate. Currently no tool or mechanism exists for tab management.

#### Gap 4: CDP Context Isolation

**Scenario**: In CDP mode, the agent creates a new context. The user might be browsing in their main context. The user's main context tabs are completely invisible to the agent (and vice versa). This is by design (isolation), but can be confusing if the user expects the agent to see their existing tabs.

**Risk**: Low. This is the intended design for isolation.

### 4.3 Recommended Approach for Multi-Tab Support

#### Design goal: Keep it simple

This is a terminal AI agent, not a web browser. Multi-tab support should follow the principle of least complexity. The agent should be able to:

1. **Know about tabs**: Be aware when a new tab opens
2. **Switch between tabs**: Have a tool or mechanism to change which tab is active
3. **Close tabs**: Clean up tabs that are no longer needed

#### Option A: Minimal (Recommended)

Add a `context.on('page')` / `page.on('popup')` handler that tracks new pages, but keep a single "active page" concept. Add a `browser_switch_tab` tool.

**Pros**: Simple, backward-compatible, low code complexity.
**Cons**: Doesn't give the model full multi-tab awareness without explicit tool calls.

**Implementation sketch:**

```typescript
class BrowserState {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];  // Changed from single page to array
  private activePageIndex: number = 0;  // Which page is "active"

  async getPage(): Promise<Page> {
    // Returns the currently active page
    if (this.pages.length === 0) { /* launch */ }
    return this.pages[this.activePageIndex];
  }

  async switchTab(index: number): Promise<void> {
    if (index >= 0 && index < this.pages.length) {
      await this.pages[index].bringToFront();
      this.activePageIndex = index;
    }
  }

  async closeTab(index: number): Promise<void> {
    if (this.pages.length <= 1) return;  // Don't close the last tab
    await this.pages[index].close();
    this.pages.splice(index, 1);
    if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = this.pages.length - 1;
    }
  }
}
```

**Handler for popups:**

```typescript
// Register this in launch():
this.context.on('page', (newPage) => {
  this.pages.push(newPage);
  this.activePageIndex = this.pages.length - 1;  // Auto-switch to new tab
});
```

**New tool: `browser_switch_tab`**

```
name: browser_switch_tab
description: 'Switch to a different browser tab. Use browser_list_tabs to see available tabs.'
parameters:
  index: number (required) — tab index to switch to
```

**New tool: `browser_list_tabs`**

```
name: browser_list_tabs
description: 'List all open browser tabs and their current URLs.'
parameters: (none)
```

#### Option B: Full Context Array

Track multiple contexts (for isolation between different browsing sessions) and multiple pages per context.

**Pros**: Maximum flexibility.
**Cons**: Significant complexity, unnecessary for this project's use case.

#### Option C: Status Quo (No Changes)

Accept the single-tab limitation. When a new tab opens, the agent gets an unexpected result from its click. The agent can recover by navigating to the URL manually or reporting an error.

**Pros**: Zero code changes.
**Cons**: Confusing failures when links open new tabs. The model cannot debug these without explicit help.

#### Recommendation

**Go with Option A**. The key changes needed:

1. **Track all pages**: Change `private page: Page | null` to `private pages: Page[]`
2. **Auto-track new tabs**: Add `context.on('page')` listener in the launch method (works for both CDP and local mode)
3. **Add two new tools**: `browser_list_tabs` and `browser_switch_tab`
4. **Keep `getPage()` simple**: Returns the currently active page
5. **Update `close()`**: Close all pages
6. **Update `buildSnapshot()`**: Include tab index/URL info in the snapshot header for context

**What about `browser_list_tabs` in the snapshot?** The snapshot returned after every action should include a small tab summary:

```
URL: https://example.com/page1
Title: Example Page
Active Tab: 2 of 3
Tabs: [0] https://example.com (about:blank)
      [1] https://example.com/docs
    → [2] https://example.com/page1
```

This keeps the model informed without requiring explicit tool calls.

### 4.4 Handling Target="_blank" and window.open()

These are the most common sources of unwanted new tabs:

```html
<a href="/other" target="_blank">Link</a>
<!-- Click → new tab opens in background -->
```

**Playwright behavior:**
- `page.getByText('Link').click()` — clicks the link, new tab opens
- The original page remains the "active" one for the agent
- The new page is created in the browser but is not tracked by `BrowserState`

**Fix with Option A:**
- Register `context.on('page')` to automatically track all pages
- When a popup opens, the new page is added to `this.pages`
- The agent can then use `browser_switch_tab` to interact with the new page
- Optionally auto-switch to new tabs immediately (matching user expectation when clicking links)

The `context.on('page')` event fires for:
- `window.open()` calls
- `<a target="_blank">` clicks
- Programmatically created tabs
- Command-click / middle-click (in headed mode)

### 4.5 CDP Mode Specifics

When using `connectOverCDP`:

```typescript
this.browser = await chromium.connectOverCDP(cdpUrl);
```

The `browser` object represents the host browser. `browser.contexts` gives access to all existing contexts (including the user's default context). `browser.newContext()` creates a new one.

**Current behavior**: `newContext()` creates an isolated tab group.
**Issue**: The new context has its own cookie jar, localStorage, etc. Cloudflare clearance cookies from the user's main session are not inherited.

**Potential enhancement for CDP**: Add an option to use the default context instead of creating a new one:

```typescript
if (useDefaultContext) {
  const contexts = this.browser.contexts();
  this.context = contexts[0];  // User's main browser context
} else {
  this.context = await this.browser.newContext({...});
}
```

This would:
- ✅ Inherit all cookies (Cloudflare clearance, login sessions)
- ✅ Use the user's real browser fingerprint
- ❌ Privacy risk — the agent can see the user's cookies and localStorage
- ❌ Side effects — the agent's browsing history appears in the user's main context

**Recommendation**: Keep the isolated context as default. Document the trade-off. If users need to access Cloudflare-protected sites, they can:
1. First visit the site in their main browser to get cookies
2. Use the agent with CDP (the isolated context won't have those cookies though)
3. Alternative: Use `--cdp-context=default` if implemented as an opt-in

---

## 5. Practical Recommendations

### 5.1 Summary of Code Changes

| Change | Priority | Effort | Benefit |
|--------|:--------:|:------:|:-------:|
| Add `--disable-blink-features=AutomationControlled` to launch args | Medium | 5 min | Hides basic automation flag |
| Override User-Agent in headless mode | Low | 5 min | Hides `HeadlessChrome` string |
| Add `addInitScript` to remove `navigator.webdriver` | Low | 5 min | Defeats basic JS detection |
| Add `context.on('page')` listener for new tab tracking | High | 30 min | Prevents silent tab loss |
| Change `page` → `pages[]` in BrowserState | High | 1-2 hours | Foundation for multi-tab support |
| Add `browser_list_tabs` tool | Medium | 30 min | Let model see available tabs |
| Add `browser_switch_tab` tool | Medium | 30 min | Let model switch tabs |
| Add tab info to snapshot header | Medium | 15 min | Keep model aware of current tab |
| CDP: default context option (`--cdp-context=default`) | Low | 1 hour | Better Cloudflare handling |

### 5.2 Documentation for Users

Add to the docs:

---

**Browser Anti-Detection Notes**

This project uses Playwright for browser automation. Automated browsers are sometimes detected and blocked by websites (Cloudflare, Google, etc.).

**How to avoid detection:**

1. **Use CDP mode (recommended)**: Connect to your real browser:
   ```bash
   # Start Edge with remote debugging on host
   msedge.exe --remote-debugging-port=9222

   # Connect from deepseek-arch
   deepseek-arch chat --cdp http://host-ip:9222
   ```
   This uses your real browser profile, cookies, and IP, making detection very unlikely.

2. **Use headed mode**: If CDP is not available:
   ```bash
   deepseek-arch chat --browser
   ```
   Headed mode is less likely to be flagged than headless, though not immune.

3. **Know the limitations**: When running headless or even headed local Chromium, some sites with aggressive anti-bot protection may block access. This is expected behavior. Switch to CDP mode for those sites.

**What about Cloudflare?**

Cloudflare challenges are the most common obstacle. The CDP approach is the only reliable way to access Cloudflare-protected sites. If you encounter a Cloudflare challenge:
1. Open the site in your regular browser (Edge/Chrome) to pass the challenge
2. The clearance cookie is stored in your browser
3. Then use `deepseek-arch chat --cdp http://...` — the agent may still get challenged because it uses a fresh context
4. **Workaround**: For sites that need Cloudflare clearance, implement `--cdp-context=default` (future feature) to reuse your main browser session

---

### 5.3 Handling Common Anti-Bot Scenarios

| Scenario | Problem | Solution |
|----------|---------|----------|
| Cloudflare JS challenge page (just says "Checking your browser...") | Local Chromium fails JS challenge | Switch to CDP mode |
| reCAPTCHA appears | Agent can't solve visual challenges | User must solve manually; switch to CDP mode for that site |
| Site returns 403 / "Access Denied" | IP blocked / detection triggered | Use CDP mode from home network IP |
| Site shows empty page | Headless Chromium may not render JS-heavy content | Try `--browser` headed mode or CDP |
| Slow page load | Network proxy issues | The 30s timeout is generous; adjust proxy settings (`https_proxy`) |
| `navigator.webdriver` detection | Basic automation flag visible | Add `--disable-blink-features=AutomationControlled` (see 5.1) |

### 5.4 Future Considerations

1. **Browser profile persistence**: Currently, the agent's browser context is ephemeral. Consider persisting the context data (cookies, localStorage) between sessions. This would:
   - Maintain login sessions across conversations
   - Build up "normal" browsing history over time
   - Improve anti-detection (the profile appears more "real")
   - **Risk**: Cookie leakage, storage bloat

2. **Human-like interaction delays**: The current agent loop has natural delays (LLM thinking time between actions). This is already beneficial for behavioral detection. No artificial delays needed.

3. **TLS fingerprinting**: More advanced anti-bot systems (Akamai, some Cloudflare configurations) analyze TLS handshake characteristics. Playwright uses Node.js's TLS stack, which differs from Chromium's native TLS. Mitigation requires using the OS-level Chromium binary (which deepseek-arch already does with `channel: 'chromium'`/`channel: 'msedge'`). The CDP mode inherently avoids this issue.

4. **Rotating User-Agents**: For a single-user agent tool, a fixed, up-to-date User-Agent is better than rotation. Rotating User-Agents signals automated behavior.

5. **HTTP/2 fingerprinting**: Similar to TLS fingerprinting. Using the system-installed Chromium (not Playwright's bundled one) helps produce more standard fingerprints.

### 5.5 Conclusion

For deepseek-arch's use case as a terminal AI agent with occasional web browsing needs:

- **The CDP approach is the strongest anti-detection strategy** and should be the recommended primary mode.
- **Lightweight hardening** (one launch arg, one init script, headless UA override) is worth adding for the local Chromium mode — low maintenance cost, meaningful improvement against basic detection.
- **Multi-tab support** should be implemented to handle `target="_blank"` links and improve model reliability. The tracked-pages-array approach (Section 4.3 Option A) is the right balance of simplicity and functionality.
- **Anti-bot arms race acceptance**: No amount of stealth will fool all detectors all the time. The practical approach is to provide the CDP escape hatch rather than trying to build an undetectable headless browser.

---

## Appendix: Quick Reference

### Browser Modes

| Mode | Command | Anti-Detection | Tabs | Use Case |
|------|---------|:--------------:|:----:|----------|
| Headless (default) | `deepseek-arch chat` | ❌ Weak | 1 basic | Simple sites, documentation |
| Headed | `deepseek-arch chat --browser` | ⚠️ Moderate | 1 basic | JS-heavy sites |
| CDP (new context) | `deepseek-arch chat --cdp http://localhost:9222` | ✅ Strong | 1 basic + user's tabs | Cloudflare/protected sites |
| CDP (default context) | Future: `--cdp-context=default` | ✅✅ Strongest | Shared with user | Sites needing login/clearance |

### Current vs. Recommended Launch Args

| Argument | Current | Recommended | Purpose |
|----------|:-------:|:-----------:|---------|
| `--no-sandbox` | ✅ | ✅ | WSL2/Linux compatibility |
| `--disable-setuid-sandbox` | ✅ | ✅ | WSL2/Linux compatibility |
| `--disable-dev-shm-usage` | ✅ | ✅ | Docker/Linux compatibility |
| `--disable-blink-features=AutomationControlled` | ❌ | **✅ ADD** | Hide automation flags |
| `--disable-infobars` | ❌ | Optional | Remove "Chrome is being controlled" bar (headed mode) |

### Current vs. Recommended Context Options

| Option | Current | Recommended | Purpose |
|--------|:-------:|:-----------:|---------|
| `acceptDownloads` | ✅ | ✅ | File downloads |
| `viewport` | `1280x720` | `1280x720` (or randomize) | Screen size |
| `userAgent` | Default (Playwright's) | Custom for headless | Hide HeadlessChrome UA |
| `addInitScript` | ❌ | **✅ ADD** | Remove `navigator.webdriver` |

---

*This document was created as a research reference. See [docs/browser-tools.md](./browser-tools.md) for the existing browser tools design documentation.*
