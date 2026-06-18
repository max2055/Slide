/**
 * Appearance Settings — comprehensive visual personalization.
 * Modifies CSS custom properties on <html> and dispatches settings changes.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { applyAccentColor, applyBorderRadius, applyNavWidth } from "../app-settings.ts";
import { applyButtonPalette, type ButtonPalette } from "../btn-palette.ts";
import { applyDensity, type Density } from "../density.ts";
import { DEFAULT_TAB_OPTIONS, TAB_GROUPS } from "../navigation.ts";
import type { Locale } from "../../i18n/lib/types.ts";

const ALL_TABS = TAB_GROUPS.flatMap((g) => [...g.tabs]);

const TIMEZONES = [
  "UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore",
  "Asia/Kolkata", "Europe/London", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Los_Angeles",
  "Australia/Sydney", "Pacific/Auckland",
];

const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Violet", hex: "#7c5cff" },
  { name: "Cyan", hex: "#22d3ee" },
  { name: "Emerald", hex: "#34d399" },
  { name: "Amber", hex: "#fbbf24" },
  { name: "Rose", hex: "#f472b6" },
  { name: "Sky", hex: "#60a5fa" },
  { name: "Slate", hex: "#64748b" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Orange", hex: "#f97316" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Teal", hex: "#14b8a6" },
];

const RADIUS_STOPS = [
  { value: 0, labelKey: "sharp" },
  { value: 25, labelKey: "subtle" },
  { value: 50, labelKey: "rounded" },
  { value: 75, labelKey: "pill" },
  { value: 100, labelKey: "max" },
];

const DENSITY_OPTIONS: { value: Density; labelKey: string }[] = [
  { value: "compact", labelKey: "appearance.compact" },
  { value: "standard", labelKey: "appearance.standard" },
  { value: "comfortable", labelKey: "appearance.comfortable" },
];

const PAGE_SIZE_OPTIONS = [10, 20, 25, 50, 100] as const;

const REFRESH_OPTIONS = [
  { value: 10, labelKey: "appearance.seconds10" },
  { value: 30, labelKey: "appearance.seconds30" },
  { value: 60, labelKey: "appearance.seconds60" },
  { value: 300, labelKey: "appearance.minutes5" },
];

const SEVERITY_OPTIONS = ["critical", "warning", "info"] as const;
const SEVERITY_LABEL_KEYS: Record<string, string> = {
  critical: "appearance.critical",
  warning: "appearance.warning",
  info: "appearance.info",
};

const LANG_OPTIONS = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

function dispatchSettingsChange(partial: Record<string, unknown>) {
  window.dispatchEvent(
    new CustomEvent("slide-settings-change", { detail: partial, bubbles: true }),
  );
}

function readStoredAccent(): string {
  try {
    return localStorage.getItem("slide-accent") || "#7c5cff";
  } catch {
    return "#7c5cff";
  }
}

function readStoredRadius(): number {
  try {
    const v = localStorage.getItem("slide-radius");
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= 0 && n <= 100) return n;
    }
  } catch { /* ignore */ }
  return 50;
}

function readSettingsField<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem("slide.control.settings.v1:default");
    if (raw) {
      const s = JSON.parse(raw);
      return s[key] ?? fallback;
    }
  } catch { /* ignore */ }
  return fallback;
}

@customElement("appearance-settings")
export class AppearanceSettings extends LitElement {
  @state() private accent: string = readStoredAccent();
  @state() private radius: number = readStoredRadius();
  @state() private density: Density = "standard";
  @state() private sidebarPos: "left" | "right" = "left";
  @state() private reduceMotion: boolean = false;
  @state() private locale: string = "en";
  @state() private defaultTab: string = "dashboard";
  @state() private navWidth: number = 258;
  @state() private visibleTabs: string[] = [];
  @state() private pageSize: number = 50;
  @state() private dateFormat: "absolute" | "relative" = "absolute";
  @state() private timezone: string = "";
  @state() private autoRefresh: boolean = true;
  @state() private refreshInterval: number = 30;
  @state() private notifyEnabled: boolean = true;
  @state() private notifySeverity: string[] = ["critical", "warning"];
  @state() private defaultModel: string = "";

  @state() private btnPalPrimaryBg: string = "#7c5cff";
  @state() private btnPalPrimaryColor: string = "#ffffff";
  @state() private btnPalSecondaryBg: string = "#f1f3f5";
  @state() private btnPalDangerBg: string = "#f87171";
  @state() private btnPalGhostColor: string = "#6e6e73";

  static styles = css`
    :host { display: block; max-width: 640px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 20px;
      margin-bottom: 16px;
    }
    .card h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-strong);
    }
    .card .desc {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--muted);
    }
    .color-grid { display: flex; gap: 8px; flex-wrap: wrap; }
    .color-swatch {
      width: 36px; height: 36px;
      border-radius: 50%;
      border: 3px solid transparent;
      cursor: pointer;
      transition: transform 0.15s, border-color 0.15s;
    }
    .color-swatch:hover { transform: scale(1.12); }
    .color-swatch.active { border-color: var(--text-strong); transform: scale(1.15); }
    .custom-color-row {
      display: flex; align-items: center; gap: 10px; margin-top: 10px;
    }
    .custom-color-row input[type="color"] {
      width: 36px; height: 36px;
      border: 2px solid var(--border);
      border-radius: 50%;
      cursor: pointer;
      padding: 0;
      background: none;
    }
    .custom-color-row .hint {
      font-size: 12px; color: var(--muted);
    }
    .custom-color-row code {
      font-size: 12px; color: var(--muted);
    }
    .field-group {
      display: flex; flex-direction: column; gap: 12px;
    }
    .field-hint { font-size: 12px; color: var(--muted); }
    .text-input {
      width: 100%; padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card); color: var(--text);
      font-size: 13px; box-sizing: border-box;
    }
    .range-input { width: 100%; }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Read current visual state from DOM
    this.accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c5cff";
    const r = getComputedStyle(document.documentElement).getPropertyValue("--radius").trim();
    const rn = parseInt(r, 10);
    this.radius = !isNaN(rn) && rn > 0 && rn <= 20 ? Math.round((rn / 10) * 50) : readStoredRadius();
    this.density = (document.documentElement.dataset.density as Density) || "standard";
    this.sidebarPos = (document.documentElement.dataset.sidebarPosition as "left" | "right") || "left";
    this.reduceMotion = document.documentElement.dataset.reduceAnimations !== undefined;
    this.locale = localStorage.getItem("slide.i18n.locale") || "en";
    this.navWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--shell-nav-width").trim(), 10) || 258;
    // Read persisted settings from localStorage
    this.defaultTab = readSettingsField("defaultTab", "dashboard");
    this.visibleTabs = readSettingsField("visibleTabs", []);
    this.navWidth = readSettingsField("navWidth", this.navWidth);
    this.pageSize = readSettingsField("defaultPageSize", 50);
    this.dateFormat = readSettingsField("dateFormat", "absolute");
    this.timezone = readSettingsField("timezone", "");
    this.autoRefresh = readSettingsField("autoRefreshEnabled", true);
    this.refreshInterval = readSettingsField("autoRefreshInterval", 30);
    this.notifyEnabled = readSettingsField("notificationEnabled", true);
    this.notifySeverity = readSettingsField("notifySeverity", ["critical", "warning"]);
    this.defaultModel = readSettingsField("defaultModel", "");
    // Button palette
    const savedPalette = readSettingsField("btnPalette", null);
    if (savedPalette) {
      this.btnPalPrimaryBg = savedPalette.primaryBg || "#7c5cff";
      this.btnPalPrimaryColor = savedPalette.primaryColor || "#ffffff";
      this.btnPalSecondaryBg = savedPalette.secondaryBg || "#f1f3f5";
      this.btnPalDangerBg = savedPalette.dangerBg || "#f87171";
      this.btnPalGhostColor = savedPalette.ghostColor || "#6e6e73";
    }
  }

  render() {
    const accentOpts = ACCENT_PRESETS.map(c => ({ value: c.hex, label: c.name }));
    const radiusOpts = RADIUS_STOPS.map(r => ({ value: r.value, label: t(`appearance.${r.labelKey}`) }));
    const densityOpts = DENSITY_OPTIONS.map(d => ({ value: d.value, label: t(d.labelKey) }));
    const sidebarOpts = [
      { value: "left", label: t("appearance.left") },
      { value: "right", label: t("appearance.right") },
    ];
    const pageSizeOpts = PAGE_SIZE_OPTIONS.map(n => ({ value: n, label: `${n} rows` }));
    const dateFormatOpts = [
      { value: "absolute", label: t("appearance.absolute") },
      { value: "relative", label: t("appearance.relative") },
    ];
    const tzOpts = [
      { value: "", label: t("appearance.browserDefault") },
      ...TIMEZONES.map(tz => ({ value: tz, label: tz })),
    ];
    const refreshOpts = REFRESH_OPTIONS.map(o => ({ value: o.value, label: t(o.labelKey) }));
    const severityOpts = SEVERITY_OPTIONS.map(s => ({ value: s, label: t(SEVERITY_LABEL_KEYS[s]) }));
    const defaultTabOpts = DEFAULT_TAB_OPTIONS.map(t => ({ value: t, label: t }));

    return html`
      <!-- Accent Color -->
      <div class="card">
        <h3>${t("appearance.accentColor")}</h3>
        <p class="desc">${t("appearance.accentColorDesc")}</p>
        <div class="color-grid">
          ${ACCENT_PRESETS.map((c) => html`
            <div
              class="color-swatch ${this.accent === c.hex ? "active" : ""}"
              style="background:${c.hex}"
              title=${c.name}
              @click=${() => this._setAccent(c.hex)}
            ></div>
          `)}
        </div>
        <div class="custom-color-row">
          <input type="color" .value=${this.accent} @input=${(e: Event) => this._setAccent((e.target as HTMLInputElement).value)} />
          <span class="hint">${t("appearance.customColor")}</span>
          <code>${this.accent}</code>
        </div>
      </div>

      <!-- Border Radius -->
      <div class="card">
        <h3>${t("appearance.borderRadius")}</h3>
        <p class="desc">${t("appearance.borderRadiusDesc")}</p>
        <app-option-group
          .value=${this.radius}
          .options=${radiusOpts}
          @change=${(e: CustomEvent) => this._setRadius(e.detail as number)}
        ></app-option-group>
      </div>

      <!-- Font Density -->
      <div class="card">
        <h3>${t("appearance.fontDensity")}</h3>
        <p class="desc">${t("appearance.fontDensityDesc")}</p>
        <app-option-group
          .value=${this.density}
          .options=${densityOpts}
          @change=${(e: CustomEvent) => this._setDensity(e.detail as Density)}
        ></app-option-group>
      </div>

      <!-- Sidebar Position -->
      <div class="card">
        <h3>${t("appearance.sidebarPosition")}</h3>
        <p class="desc">${t("appearance.sidebarPositionDesc")}</p>
        <app-option-group
          .value=${this.sidebarPos}
          .options=${sidebarOpts}
          @change=${(e: CustomEvent) => this._setSidebarPos(e.detail as "left" | "right")}
        ></app-option-group>
      </div>

      <!-- Language -->
      <div class="card">
        <h3>${t("appearance.language")}</h3>
        <p class="desc">${t("appearance.languageDesc")}</p>
        <app-select-field
          .value=${this.locale}
          .options=${LANG_OPTIONS.map(l => ({ value: l.value, label: l.label }))}
          @change=${(e: CustomEvent) => this._setLocale(e.detail as string)}
        ></app-select-field>
      </div>

      <!-- Reduce Animations -->
      <div class="card">
        <app-toggle
          .checked=${this.reduceMotion}
          @change=${(e: CustomEvent) => this._setReduceMotion(e.detail)}
        >${t("appearance.reduceAnimations")}</app-toggle>
        <p class="desc">${t("appearance.reduceAnimationsDesc")}</p>
      </div>

      <!-- Default Page -->
      <div class="card">
        <h3>${t("appearance.defaultPage")}</h3>
        <p class="desc">${t("appearance.defaultPageDesc")}</p>
        <app-select-field
          .value=${this.defaultTab}
          .options=${defaultTabOpts}
          @change=${(e: CustomEvent) => this._setDefaultTab(e.detail as string)}
        ></app-select-field>
      </div>

      <!-- Sidebar Width -->
      <div class="card">
        <h3>${t("appearance.sidebarWidth")}</h3>
        <p class="desc">${t("appearance.sidebarWidthDesc")} (${this.navWidth}px)</p>
        <input type="range" min="200" max="400" step="10"
          class="range-input"
          .value=${String(this.navWidth)}
          @input=${(e: Event) => this._setNavWidth(Number((e.target as HTMLInputElement).value))} />
      </div>

      <!-- Sidebar Tabs -->
      <div class="card">
        <h3>${t("appearance.sidebarTabs")}</h3>
        <p class="desc">${t("appearance.sidebarTabsDesc")}</p>
        ${ALL_TABS.map((tab) => html`
          <app-toggle
            .checked=${this._isTabVisible(tab)}
            @change=${() => this._toggleTab(tab)}
          >${tab}</app-toggle>
        `)}
      </div>

      <!-- Data Display -->
      <div class="card">
        <h3>${t("appearance.dataDisplay")}</h3>
        <div class="field-group">
          <app-select-field
            label=${t("appearance.defaultPageSize")}
            .value=${this.pageSize}
            .options=${pageSizeOpts}
            @change=${(e: CustomEvent) => this._setPageSize(e.detail as number)}
          ></app-select-field>
          <app-select-field
            label=${t("appearance.dateFormat")}
            .value=${this.dateFormat}
            .options=${dateFormatOpts}
            @change=${(e: CustomEvent) => this._setDateFormat(e.detail as string)}
          ></app-select-field>
          <app-select-field
            label=${t("appearance.timezone")}
            .value=${this.timezone}
            .options=${tzOpts}
            @change=${(e: CustomEvent) => this._setTimezone(e.detail as string)}
          ></app-select-field>
        </div>
      </div>

      <!-- Auto Refresh -->
      <div class="card">
        <h3>${t("appearance.autoRefresh")}</h3>
        <div class="field-group">
          <app-toggle
            .checked=${this.autoRefresh}
            @change=${(e: CustomEvent) => this._setAutoRefresh(e.detail)}
          >${t("appearance.enableAutoRefresh")}</app-toggle>
          ${this.autoRefresh ? html`
            <app-select-field
              .value=${this.refreshInterval}
              .options=${refreshOpts}
              @change=${(e: CustomEvent) => this._setRefreshInterval(e.detail as number)}
            ></app-select-field>
          ` : nothing}
        </div>
      </div>

      <!-- Notifications -->
      <div class="card">
        <h3>${t("appearance.notifications")}</h3>
        <div class="field-group">
          <app-toggle
            .checked=${this.notifyEnabled}
            @change=${(e: CustomEvent) => this._setNotifications(e.detail)}
          >${t("appearance.enableNotifications")}</app-toggle>
          ${this.notifyEnabled ? html`
            <div>
              <span class="field-hint">${t("appearance.minimumSeverity")}</span>
              <app-option-group
                .multi=${true}
                .selected=${this.notifySeverity}
                .options=${severityOpts}
                @change=${(e: CustomEvent) => this._setNotifySeverity(e.detail as string[])}
                style="margin-top:4px"
              ></app-option-group>
            </div>
          ` : nothing}
        </div>
      </div>

      <!-- Button Colors -->
      <div class="card">
        <h3>Button Colors</h3>
        <p class="desc">Customize button fill and text colors per semantic level.</p>
        <div class="field-group">
          <div>
            <span class="field-hint">Primary (main actions)</span>
            <div class="custom-color-row" style="margin-top:6px">
              <input type="color" .value=${this.btnPalPrimaryBg} @input=${(e: Event) => this._setBtnColor("primary", "bg", (e.target as HTMLInputElement).value)} title="Fill" />
              <input type="color" .value=${this.btnPalPrimaryColor} @input=${(e: Event) => this._setBtnColor("primary", "color", (e.target as HTMLInputElement).value)} title="Text" />
              <span class="hint">fill / text</span>
              <code style="margin-left:auto">${this.btnPalPrimaryBg}</code>
            </div>
          </div>
          <div>
            <span class="field-hint">Secondary (regular actions)</span>
            <div class="custom-color-row" style="margin-top:6px">
              <input type="color" .value=${this.btnPalSecondaryBg} @input=${(e: Event) => this._setBtnColor("secondary", "bg", (e.target as HTMLInputElement).value)} title="Fill" />
              <span class="hint">background</span>
              <code style="margin-left:auto">${this.btnPalSecondaryBg}</code>
            </div>
          </div>
          <div>
            <span class="field-hint">Ghost (inline actions)</span>
            <div class="custom-color-row" style="margin-top:6px">
              <input type="color" .value=${this.btnPalGhostColor} @input=${(e: Event) => this._setBtnColor("ghost", "color", (e.target as HTMLInputElement).value)} title="Color" />
              <span class="hint">text color</span>
              <code style="margin-left:auto">${this.btnPalGhostColor}</code>
            </div>
          </div>
          <div>
            <span class="field-hint">Danger (destructive actions)</span>
            <div class="custom-color-row" style="margin-top:6px">
              <input type="color" .value=${this.btnPalDangerBg} @input=${(e: Event) => this._setBtnColor("danger", "bg", (e.target as HTMLInputElement).value)} title="Fill" />
              <span class="hint">background</span>
              <code style="margin-left:auto">${this.btnPalDangerBg}</code>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn-primary" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)">Primary</button>
            <button class="btn" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)">Secondary</button>
            <button class="btn-ghost" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-sm)">Ghost</button>
            <button class="btn-primary btn-danger" style="font-size:var(--text-xs);padding:var(--space-xs) var(--space-md)">Danger</button>
          </div>
        </div>
      </div>

      <!-- Default Model -->
      <div class="card">
        <h3>${t("appearance.defaultModel")}</h3>
        <p class="desc">${t("appearance.defaultModelDesc")}</p>
        <input type="text"
          class="text-input"
          .value=${this.defaultModel}
          @input=${(e: Event) => this._setDefaultModel((e.target as HTMLInputElement).value)}
          placeholder="e.g. claude-sonnet-4-20250929" />
      </div>
    `;
  }

  private _setAccent(hex: string) {
    this.accent = hex;
    applyAccentColor(hex);
    localStorage.setItem("slide-accent", hex);
    dispatchSettingsChange({ accentColor: hex });
  }

  private _setRadius(value: number) {
    this.radius = value;
    applyBorderRadius(value);
    localStorage.setItem("slide-radius", String(value));
    dispatchSettingsChange({ borderRadius: value });
  }

  private _setDensity(d: Density) {
    this.density = d;
    applyDensity(d);
    dispatchSettingsChange({ fontDensity: d });
  }

  private _setSidebarPos(pos: "left" | "right") {
    this.sidebarPos = pos;
    document.documentElement.dataset.sidebarPosition = pos;
    dispatchSettingsChange({ sidebarPosition: pos });
  }

  private _setReduceMotion(on: boolean) {
    this.reduceMotion = on;
    if (on) {
      document.documentElement.dataset.reduceAnimations = "";
    } else {
      delete document.documentElement.dataset.reduceAnimations;
    }
    dispatchSettingsChange({ reduceAnimations: on });
  }

  private _setLocale(locale: string) {
    this.locale = locale;
    localStorage.setItem("slide.i18n.locale", locale);
    import("../../i18n/lib/translate.ts").then(({ i18n }) => {
      i18n.setLocale(locale as Locale);
    });
    dispatchSettingsChange({ locale });
  }

  private _setDefaultTab(tab: string) {
    this.defaultTab = tab;
    dispatchSettingsChange({ defaultTab: tab });
  }

  private _setNavWidth(width: number) {
    this.navWidth = width;
    applyNavWidth(width);
    dispatchSettingsChange({ navWidth: width });
  }

  private _isTabVisible(tab: string): boolean {
    if (this.visibleTabs.length === 0) return true;
    return this.visibleTabs.includes(tab);
  }

  private _toggleTab(tab: string) {
    let next: string[];
    if (this.visibleTabs.length === 0) {
      next = ALL_TABS.filter((t) => t !== tab);
    } else if (this.visibleTabs.includes(tab)) {
      next = this.visibleTabs.filter((t) => t !== tab);
    } else {
      next = [...this.visibleTabs, tab];
    }
    this.visibleTabs = next;
    dispatchSettingsChange({ visibleTabs: next });
  }

  private _setPageSize(n: number) {
    this.pageSize = n;
    dispatchSettingsChange({ defaultPageSize: n });
  }

  private _setDateFormat(fmt: string) {
    this.dateFormat = fmt as "absolute" | "relative";
    dispatchSettingsChange({ dateFormat: fmt });
  }

  private _setTimezone(tz: string) {
    this.timezone = tz;
    dispatchSettingsChange({ timezone: tz });
  }

  private _setAutoRefresh(on: boolean) {
    this.autoRefresh = on;
    dispatchSettingsChange({ autoRefreshEnabled: on });
  }

  private _setRefreshInterval(n: number) {
    this.refreshInterval = n;
    dispatchSettingsChange({ autoRefreshInterval: n });
  }

  private _setNotifications(on: boolean) {
    this.notifyEnabled = on;
    dispatchSettingsChange({ notificationEnabled: on });
  }

  private _setNotifySeverity(severity: string[]) {
    this.notifySeverity = severity;
    dispatchSettingsChange({ notifySeverity: severity });
  }

  private _setDefaultModel(model: string) {
    this.defaultModel = model;
    dispatchSettingsChange({ defaultModel: model });
  }

  private _setBtnColor(level: string, prop: string, hex: string) {
    (this as any)[`btnPal${level.charAt(0).toUpperCase() + level.slice(1)}${prop === "bg" ? "Bg" : prop === "color" ? "Color" : ""}`] = hex;
    const palette: Partial<ButtonPalette> = {};
    const key = `${level}${prop === "bg" ? "Bg" : prop === "color" ? "Color" : ""}` as keyof ButtonPalette;
    palette[key] = hex;
    applyButtonPalette(palette);
    dispatchSettingsChange({ btnPalette: this._buildPalette() });
  }

  private _buildPalette(): ButtonPalette {
    return {
      primaryBg: this.btnPalPrimaryBg,
      primaryColor: this.btnPalPrimaryColor,
      primaryBorder: this.btnPalPrimaryBg,
      secondaryBg: this.btnPalSecondaryBg,
      secondaryColor: "#3c3c43",
      secondaryBorder: "#e5e5ea",
      ghostColor: this.btnPalGhostColor,
      ghostHoverColor: this.btnPalPrimaryBg,
      ghostHoverBg: "#eceef0",
      dangerBg: this.btnPalDangerBg,
      dangerColor: "#ffffff",
      dangerBorder: this.btnPalDangerBg,
    };
  }
}
