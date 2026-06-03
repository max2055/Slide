# Stack Research

**Domain:** Alert System, Auth Refresh/Permissions, Report Refactoring, Data Quality, UI Unification
**Researched:** 2026-05-20
**Confidence:** HIGH

## Recommended Stack

### No New Core Libraries Required

After thorough analysis of the existing codebase and the planned v1.3 features, **no new core runtime dependencies are needed**. Every feature area can be implemented by extending existing capabilities or adding lightweight supporting libraries only where templating is needed.

The existing stack already covers:
- **Redis (ioredis 5.3.2)**: Token blacklisting, refresh token store
- **simple-statistics 7.8.9**: Moving average, standard deviation, percentile for threshold learning
- **PDFKit (pdfkit 0.18.0)**: PDF report generation
- **jsonwebtoken 9.0.2**: JWT creation and verification
- **Anthropic/OpenAI SDKs**: AI-powered threshold recommendation
- **ECharts 5.4.0**: Chart rendering in reports

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `ejs` | 5.0.2 | Server-side report template engine | **Report Refactoring** -- replace inline HTML strings in `report-service.ts` with `.ejs` template files. Lighter than Handlebars (205KB vs 2.8MB), zero dependencies, native Node.js support. |
| `crypto` (built-in) | Node.js built-in | Refresh token generation | **Auth Refresh** -- `crypto.randomBytes()` for secure token generation. Already used elsewhere in codebase. |

### Template System

**Important: Do NOT use puppeteer or playwright for HTML-to-PDF generation.**

The existing PDFKit-based approach is sufficient for the current report types (health, performance, slow_query, capacity). Adding a headless browser (Chrome/Chromium ~300MB) for HTML-to-PDF conversion:
- Adds 300MB+ to the deployment
- Adds 2-3s per report generation (browser startup)
- Requires managing browser lifecycle (crashes, memory leaks)
- Puppeteer 25.0.4 requires `@puppeteer/browsers` 3.0.3 + Chromium binary

PDFKit is already installed and working. Keep it for PDF output.

### ICON LIBRARY: Do NOT Add One

The existing `icons.ts` file at `frontend/src/openclaw/ui/icons.ts` already contains 60+ Lucide-style SVG icons as Lit `TemplateResult` objects. This is the correct approach:

- **Zero additional bundle size** -- only the icons actually used are imported
- **Tree-shakeable by Vite** -- unused icons are dropped
- **Lucide-compatible paths** -- existing icons use Lucide SVG path data
- **No JS runtime** -- pure SVG templates, no icon resolution logic needed
- **Consistent styling** -- all icons use `currentColor` via `stroke="currentColor"`

For v1.3 UI unification, the work is:
1. Audit existing icon usage (approximately 25 of the 60+ defined icons are actually imported)
2. Add missing icons to `icons.ts` following the same SVG template pattern
3. Remove unused/unnecessary emoji fallbacks (like `emoji-icon` in event-management.ts)
4. Add a standardized `<icon-element>` wrapper component for consistent sizing

If an external library is required later (not needed for v1.3), use **lucide-static 1.16.0** (46.3MB unpacked but tree-shakeable via selective imports). Do NOT use `@material/web` 2.4.1 (4MB, brings Material Design component system which conflicts with the existing custom UI).

## Installation

```bash
# Report template engine (backend)
cd apps/db-ops-api && npm install ejs@^5.0.2

# Dev: @types/ejs for TypeScript support
cd apps/db-ops-api && npm install -D @types/ejs@^5.0.0
```

No other new npm packages required for v1.3 features.

## Alternatives Considered

### Report Template Engine

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **EJS 5.0.2** (ADD) | Handlebars 4.7.9 | When templates need to be edited by non-developers (Handlebars has stricter logic-less philosophy). For a developer-maintained codebase, EJS's familiar ` <% %> ` syntax is more natural and its zero-dependency footprint is smaller (205KB vs 2.8MB). |
| **EJS 5.0.2** (ADD) | Inline HTML strings (current) | When a report has exactly one template and is never expected to change. For v1.3's report unification, multiple templates need maintenance; inline strings in `report-service.ts` are at 638 lines and growing. EJS separates templates into `.ejs` files. |
| **EJS 5.0.2** (ADD) | Puppeteer 25.0.4 | When reports require complex layouts with CSS Grid, Flexbox, and custom fonts that cannot be expressed in PDFKit. For the current report types (tables + metric cards + text), PDFKit is sufficient. Add puppetee only as a targeted upgrade. |

### Icon Library

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Existing `icons.ts`** (keep) | `lucide-static` 1.16.0 | When the project needs 100+ icons for a public-facing UI and maintaining custom SVG paths becomes tedious. For v1.3's internal tool UI, 60+ custom SVG icons are sufficient. |
| **Existing `icons.ts`** (keep) | `@material/web` 2.4.1 | When the project wants to adopt Material Design 3 as its design system. For v1.3, Material Design would conflict with the existing custom UI components and add unnecessary weight. |

### Refresh Token Approach

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Redis + DB** (extend existing) | `@fastify/oauth2` or Passport.js | When implementing third-party OAuth providers (Google, GitHub, etc.). For JWT-on-first-party only, Redis-based refresh token rotation is simpler and avoids adding an auth framework. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Puppeteer 25.0.4 | 300MB Chromium download, 2-3s startup per generation, memory leaks. The 4 report types generate tables + text + metric cards -- PDFKit handles this perfectly. | Keep existing PDFKit 0.18.0 |
| Playwright 1.60.0 | Same problem as Puppeteer plus requires its own browser binary. Playwright is a testing tool, not a generation tool. | EJS + PDFKit |
| Handlebars 4.7.9 | 2.8MB unpacked, 5 dependencies. Logic-less philosophy means computed data must be pre-processed in the service layer, duplicating logic. | EJS 5.0.2 (zero dependencies, 205KB) |
| `@material/web` | 4MB unpacked, brings Material Design 3 components (buttons, dialogs, navigation). Conflicts with existing custom UI. Would require rewriting all components for consistency. | Extend existing `icons.ts` |
| `@lit-labs/task` | Already outdated. `@lit/task` is the stable successor (3.1.0). But even `@lit/task` is unnecessary for v1.3 -- existing views use `@state` + `connectedCallback()` patterns that work fine. | Keep existing Lit patterns |
| Casbin / Policy engine | Previous research already concluded: overengineered for <100 roles and <500 permission points. RBAC tables + middleware pattern is working. | Existing `rbac-service.ts` + `require-permission.ts` |
| OAuth libraries (Passport, @fastify/oauth2) | Only needed for third-party auth providers. v1.3 is about first-party login with JWT refresh tokens, not SSO. | Custom refresh token service + Redis |

## Stack Patterns by Variant

**If the reporting requirements later expand to include rich HTML layouts (charts, images, paginated tables):**
- Add `playwright` 1.60.0 (not `puppeteer` -- Playwright has better TypeScript support, cross-browser consistency, and better crash recovery)
- Use Playwright's `page.pdf()` for PDF output: better layout fidelity than PDFKit
- Keep EJS for template generation, feed rendered HTML to Playwright for PDF conversion
- Note: This adds ~200MB to deployment size

**If instance scoring needs sophisticated statistical models beyond weighted sums:**
- The existing `simple-statistics` 7.8.9 already provides: linear regression, standard deviation, mean, median, quantile, sample correlation, Bayesian classifier
- If needed later, `ml.js` or `tensorflow.js` are overkill for instance health scoring

**If the alert system needs real-time streaming anomaly detection:**
- Consider adding Redis Streams for buffering metric data points
- The push-based pattern (gateway -> Redis Stream -> alert evaluator) is more scalable than the current cron-based polling
- Not needed for v1.3; the existing cron-based evaluator at 1-minute intervals is sufficient

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `ejs@5.0.2` | Node.js 18+ | Native ESM support. No peer dependencies. |
| `@types/ejs@5.0.x` | TypeScript 5.x | Type definitions for compile-time safety. |
| `simple-statistics@7.8.9` | All Node.js | Pure JS, no native deps. Already installed. |
| `jsonwebtoken@9.0.2` | Node.js 18+ | Already installed. |
| `ioredis@5.3.2` | Redis 6+ | Already installed. Refresh tokens stored as key-value with TTL. |

## Refresh Token Architecture

### Why No New Library

The refresh token pattern uses only:
1. **`jsonwebtoken`** (already installed) -- sign access tokens
2. **`ioredis`** (already installed) -- store refresh tokens with TTL
3. **`crypto.randomBytes()`** (built-in) -- generate cryptographically secure refresh token strings
4. **MySQL** (already connected) -- optional persistent refresh token table

### Data Flow

```
POST /api/auth/login
  -> Validate credentials (existing)
  -> Generate access_token (jwt.sign, 15min expiry)
  -> Generate refresh_token (crypto.randomBytes(48).toString('hex'))
  -> Store refresh_token in Redis: SET refresh_token:{hashed_token} {userId} EX {days}
  -> Return { access_token, refresh_token, expires_in }

POST /api/auth/refresh
  -> Receive { refresh_token }
  -> Hash the token
  -> Redis: GET refresh_token:{hashed_token}
  -> If found: generate new access_token, rotate refresh_token
  -> If not found or expired: 401, user must re-login

POST /api/auth/logout
  -> Receive access_token / refresh_token
  -> Blacklist access_token JWT ID in Redis until its natural expiry
  -> Delete refresh_token from Redis
```

### MySQL Migration (Optional Persistence)

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash VARCHAR(128) NOT NULL COMMENT 'SHA-256 of the raw refresh token',
  expires_at DATETIME NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_ip VARCHAR(45) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_token_hash (token_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Redis is the primary store (fast, automatic TTL). MySQL is a durable fallback for audit/recovery.

### Token Rotation Policy

- Each refresh token can be used exactly **once** for a refresh
- On refresh: the old token is revoked, a new refresh token is issued
- This prevents stolen refresh tokens from being reused (rotation)
- Grace period: allow the previous token for 30 seconds to handle concurrent requests

## Threshold Learning Algorithm

### Approach: Moving Window + Z-Score

No new library needed. The existing `simple-statistics` 7.8.9 provides all primitives.

```typescript
import { mean, standardDeviation } from 'simple-statistics';

class AdaptiveThresholdLearner {
  private windowSize = 1440; // 24 hours at 1-minute intervals

  async computeDynamicThreshold(
    instanceId: number,
    metricName: string,  // 'cpu_usage', 'connections', etc.
    recentValues: number[]
  ): Promise<{ warning: number; critical: number; baseline: number }> {
    if (recentValues.length < 60) {
      // Not enough data: use static defaults
      return { warning: 80, critical: 90, baseline: 50 };
    }

    const m = mean(recentValues);
    const sd = standardDeviation(recentValues);

    return {
      warning: m + 2 * sd,   // 2 sigma: ~95th percentile
      critical: m + 3 * sd,  // 3 sigma: ~99.7th percentile
      baseline: m,
    };
  }
}
```

For AI-powered threshold recommendation (reuse existing Anthropic/OpenAI SDK):
```typescript
class AIThresholdAdvisor {
  async recommendThresholds(
    instanceId: number,
    metricHistory: { timestamp: Date; value: number }[]
  ): Promise<{ warning: number; critical: number; rationale: string }> {
    // Summarize metric history
    const summary = this.summarizeMetrics(metricHistory);
    // Call existing LLM: aiBridge.sendMessage({ role: 'user', content: prompt })
    // Prompt: analyze metric history and recommend thresholds
  }
}
```

This uses the existing `@anthropic-ai/sdk` or `openai` -- no new AI library needed.

## Instance Scoring Algorithm

### Approach: Weighted Multi-Metric Scoring

Pure math, no library needed. The `simple-statistics` library is available for percentile normalization.

```typescript
interface ScoringWeights {
  cpuWeight: number;      // 0.25
  memoryWeight: number;   // 0.25
  diskWeight: number;     // 0.20
  connectionsWeight: number; // 0.10
  qpsWeight: number;      // 0.10
  slowQueryWeight: number; // 0.10
}

class InstanceScorer {
  // Convert raw metric to 0-100 score (inverted: lower raw = higher score)
  scoreMetric(value: number, warning: number, critical: number): number {
    if (value <= warning) return 100;
    if (value >= critical) return 0;
    // Linear interpolation between warning and critical
    return 100 - ((value - warning) / (critical - warning)) * 100;
  }

  computeOverallScore(metrics: RawMetrics, weights: ScoringWeights): number {
    const scores = {
      cpu: this.scoreMetric(metrics.cpu_usage, 70, 90),
      memory: this.scoreMetric(metrics.memory_usage, 75, 90),
      disk: this.scoreMetric(metrics.disk_usage, 80, 95),
      connections: this.scoreMetric(metrics.connections, 80, 100),
      qps: this.scoreMetric(metrics.qps, 70, 90),
      slowQuery: metrics.slow_queries === 0 ? 100
        : Math.max(0, 100 - metrics.slow_queries * 10),
    };

    return Math.round(
      scores.cpu * weights.cpuWeight +
      scores.memory * weights.memoryWeight +
      scores.disk * weights.diskWeight +
      scores.connections * weights.connectionsWeight +
      scores.qps * weights.qpsWeight +
      scores.slowQuery * weights.slowQueryWeight
    );
  }
}
```

## Metrics Collection (CPU/Memory)

### Current Collection Method

The existing `metrics-database-service.ts` already collects CPU, memory, disk, connections, QPS, TPS from MySQL `performance_schema` and inserts into the `metrics_database` table. No new collection mechanism is needed for the existing monitored instances.

### For the Gateway Layer

The OpenClaw gateway agent runtime runs on the same machine as monitored databases, so it has OS-level access. The gateway already reports metrics via WebSocket/RPC. The existing `metricsDatabaseService.getRealtimeMetrics()` reads from the `metrics_database` table.

### What's Needed for v1.3

1. A **data quality score service** (`data-quality-service.ts`) that reads metrics from `metrics_database` and computes instance scores
2. Integration with the existing cron evaluator (or a new cron schedule) to periodically compute scores
3. Store scores in a new `instance_scores` or `database_instances.health_score` column

**No new metric collection infrastructure is needed.** The existing metrics pipeline (gateway -> metrics_database table) already handles CPU/memory collection.

## Report Refactoring: EJS Template File Structure

```
apps/db-ops-api/src/report-templates/
  report-templates/
    health-report.ejs
    performance-report.ejs
    slow-query-report.ejs
    capacity-report.ejs
    _header.ejs         (partial: CSS styles, HTML head)
    _footer.ejs         (partial: closing tags)
    _metric-card.ejs     (partial: reusable metric card)
    _table.ejs           (partial: reusable data table)
```

This replaces the current 200+ lines of inline HTML string concatenation in `report-service.ts` with clean template files. Example usage:

```typescript
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

class ReportTemplateService {
  private templates: Map<string, ejs.TemplateFunction> = new Map();

  private loadTemplate(name: string): ejs.TemplateFunction {
    if (!this.templates.has(name)) {
      const filePath = resolve(__dirname, `report-templates/${name}.ejs`);
      const content = readFileSync(filePath, 'utf-8');
      this.templates.set(name, ejs.compile(content, { filename: filePath }));
    }
    return this.templates.get(name)!;
  }

  render(type: ReportType, data: object): string {
    const template = this.loadTemplate(type);
    return template(data);
  }
}
```

## ov-card Refactoring

**No library needed.** The `ov-card` CSS class pattern exists in:
- `overview-cards.ts` (OpenClaw overview cards)
- `reports.ts` (report type cards)
- `schema-management.ts` (schema stat cards)

Refactoring approach:
1. Replace inline `.ov-card` styles in each component's `static styles` with a shared CSS class in a common stylesheet
2. Rename from `ov-card` to `stat-card` or `metric-card` for clarity
3. Standardize the CSS variables used (already using `var(--border)`, `var(--card)`, etc.)

## Sources

- `npm view ejs@5.0.2` (2026-05-20) -- zero dependencies, 205KB unpacked, ESM support
- `npm view puppeteer@25.0.4` (2026-05-20) -- requires chromium-bidi 16.0.1, browser download
- `npm view playwright@1.60.0` (2026-05-20) -- 1.60.0, requires playwright-core, browser download
- `npm view lucide-static@1.16.0` (2026-05-20) -- 46.3MB unpacked, pure SVG, tree-shakeable
- `npm view @material/web@2.4.1` (2026-05-20) -- 4MB, lit peer dependency, Material Design 3
- `npm view simple-statistics@7.8.9` (2026-05-20) -- 1.2MB, ISC, zero deps, already installed
- Slide codebase `apps/db-ops-api/server.ts` -- JWT login flow, 24h token expiry, no refresh token
- Slide codebase `apps/db-ops-api/src/auth-database-service.ts` -- user auth, no refresh mechanism
- Slide codebase `apps/db-ops-api/src/report-service.ts` -- inline HTML strings, 638 lines
- Slide codebase `apps/db-ops-api/src/report-exporter.ts` -- PDFKit PDF generation, HTML/MD export
- Slide codebase `apps/db-ops-api/src/report-database-service.ts` -- ReportType/ReportFormat types
- Slide codebase `apps/db-ops-api/src/event-aggregator.ts` -- existing alert aggregation pattern
- Slide codebase `apps/db-ops-api/src/alert-event-service.ts` -- event lifecycle management
- Slide codebase `apps/db-ops-api/src/metrics-database-service.ts` -- CPU/memory/disk metrics collection
- Slide codebase `apps/db-ops-api/src/auth/rbac-service.ts` -- existing RBAC CRUD
- Slide codebase `apps/db-ops-api/src/auth/require-permission.ts` -- permission check middleware
- Slide codebase `frontend/src/openclaw/ui/icons.ts` -- 60+ Lucide-style custom SVG icons
- Slide codebase `frontend/src/openclaw/ui/views/overview-cards.ts` -- ov-card pattern
- Slide codebase `frontend/src/openclaw/ui/views/reports.ts` -- reports page with ov-card usage
- Slide codebase `frontend/src/openclaw/ui/views/event-management.ts` -- emoji fallback for icons

---
*Stack research for: Slide v1.3 new features (Alert System, Auth Refresh, Report Refactoring, Data Quality, UI Unification)*
*Researched: 2026-05-20*
