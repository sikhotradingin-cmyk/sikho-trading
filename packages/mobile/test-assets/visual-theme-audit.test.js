import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const wwwDir = path.resolve(__dirname, '../android/app/src/main/assets/www');
const html = fs.readFileSync(path.join(wwwDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(wwwDir, 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(wwwDir, 'app.js'), 'utf8');
const chartAdapterJs = fs.readFileSync(path.join(wwwDir, 'chart-adapter.js'), 'utf8');

test('VISUAL & THEME CORRECTION: Shared Specification Palette Tokens in CSS', () => {
  // Check Light Palette
  assert.ok(css.includes('--bg-app: #F6F8FC;'), 'Light --bg-app must be #F6F8FC');
  assert.ok(css.includes('--bg-surface: #FFFFFF;'), 'Light --bg-surface must be #FFFFFF');
  assert.ok(css.includes('--bg-elevated: #EDF2F8;'), 'Light --bg-elevated must be #EDF2F8');
  assert.ok(css.includes('--border-subtle: #D8E0EB;'), 'Light --border-subtle must be #D8E0EB');
  assert.ok(css.includes('--text-primary: #172033;'), 'Light --text-primary must be #172033');
  assert.ok(css.includes('--text-secondary: #526176;'), 'Light --text-secondary must be #526176');
  assert.ok(css.includes('--primary-accent: #1D4ED8;'), 'Light --primary-accent must be #1D4ED8');
  assert.ok(css.includes('--positive-text: #047857;'), 'Light --positive-text must be #047857');
  assert.ok(css.includes('--negative-text: #BE123C;'), 'Light --negative-text must be #BE123C');

  // Check Dark Palette
  assert.ok(css.includes('--bg-app: #0B1220;'), 'Dark --bg-app must be #0B1220');
  assert.ok(css.includes('--bg-surface: #121C2D;'), 'Dark --bg-surface must be #121C2D');
  assert.ok(css.includes('--bg-elevated: #1B283D;'), 'Dark --bg-elevated must be #1B283D');
  assert.ok(css.includes('--border-subtle: #30415B;'), 'Dark --border-subtle must be #30415B');
  assert.ok(css.includes('--text-primary: #F1F5F9;'), 'Dark --text-primary must be #F1F5F9');
  assert.ok(css.includes('--text-secondary: #B2BFD1;'), 'Dark --text-secondary must be #B2BFD1');
  assert.ok(css.includes('--primary-accent: #60A5FA;'), 'Dark --primary-accent must be #60A5FA');
  assert.ok(css.includes('--positive-text: #34D399;'), 'Dark --positive-text must be #34D399');
  assert.ok(css.includes('--negative-text: #FB7185;'), 'Dark --negative-text must be #FB7185');
});

test('DEFECT A: Dark Profile Surfaces, IMMUTABLE Badge Removal & Selected States', () => {
  // tab-profile must not have hardcoded white/grey background inline
  const tabProfile = html.match(/<main id="tab-profile"[^>]*>/);
  assert.ok(tabProfile, 'tab-profile must exist');
  assert.ok(!tabProfile[0].includes('#F8FAFC'), 'tab-profile must not have inline #F8FAFC background');

  // Identity header must use semantic classes and no hardcoded #FFFFFF inline
  assert.ok(html.includes('class="profile-header-card"'), 'Identity section uses profile-header-card');
  assert.ok(html.includes('class="profile-sub-banner"'), 'Subscription banner uses profile-sub-banner');

  // Unreadable IMMUTABLE badge removed
  assert.ok(!html.includes('IMMUTABLE</span>'), 'Nonessential IMMUTABLE badge is removed from profile');

  // Theme selector segmented buttons
  assert.ok(css.includes('.segmented-pill-group .seg-pill-btn.active'), 'Segmented pill button has distinct active state');
  assert.ok(css.includes('border-color: var(--primary-accent)'), 'Active theme button has primary accent border');
});

test('DEFECT B: Light Chart Theme Synchronization & Canvas Styling', () => {
  // applyChartTheme must call activeChartAdapter.setTheme()
  assert.ok(appJs.includes('applyChartTheme'), 'applyChartTheme defined');
  assert.ok(appJs.includes('chAdp.setTheme(isDark)'), 'applyChartTheme sets activeChartAdapter theme');

  // chart-stage-wrap and container styling
  assert.ok(css.includes('.chart-stage-wrap {') && css.includes('background: var(--bg-app);'), 'chart-stage-wrap uses theme-aware bg-app');

  // chart-adapter.js getThemeStyles sets theme colors
  assert.ok(chartAdapterJs.includes('#F6F8FC'), 'chart adapter supports light canvas #F6F8FC');
  assert.ok(chartAdapterJs.includes('#0B1220'), 'chart adapter supports dark canvas #0B1220');
  assert.ok(chartAdapterJs.includes('setTheme(isDark)'), 'chart adapter exposes setTheme');
});

test('DEFECT C: Chart Overlap, Header Chips, and Explanatory Strip', () => {
  // Fullscreen button position in CSS: top 6px, right 8px
  assert.ok(css.includes('.chart-onplot-fullscreen-btn {') && css.includes('right: 8px;') && css.includes('top: 6px;'), 'Fullscreen button positioned top:6px; right:8px;');

  // OHLC legend constrained
  assert.ok(css.includes('.ohlc-floating-legend {') && css.includes('max-width: calc(100% - 48px);'), 'OHLC legend constrained to avoid colliding with fullscreen button');

  // Explanatory strip hidden from overlaying candle area
  assert.ok(css.includes('.chart-indicator-label {') && css.includes('display: none !important;'), 'chart-indicator-label hidden from chart canvas');

  // Header meta row scrolls horizontally without vertical jump
  assert.ok(css.includes('.chart-top-bar {') && css.includes('min-height: 58px;'), 'chart-top-bar maintains stable 58px height');
  assert.ok(css.includes('.chart-meta-row {') && css.includes('overflow-x: auto;') && css.includes('white-space: nowrap;'), 'chart-meta-row scrolls horizontally');
});

test('DEFECT D: Markets Virtual Available & Horizontal Scroll Overflow Guard', () => {
  // Virtual available label classes and styles
  assert.ok(html.includes('class="virtual-avail-badge"'), 'Virtual available badge markup updated');
  assert.ok(html.includes('class="virtual-avail-title">VIRTUAL AVAILABLE</div>'), 'Virtual available title formatted');
  assert.ok(css.includes('.virtual-avail-title'), 'CSS defines virtual-avail-title');
  assert.ok(css.includes('.virtual-avail-val'), 'CSS defines virtual-avail-val');

  // Overflow guards
  assert.ok(css.includes('overscroll-behavior-x: contain;'), 'Horizontal strips contain overscroll');
  assert.ok(css.includes('max-width: 100vw;'), 'Viewport width clamped to prevent full-page overflow');
});

test('BUILD & VERSIONING: VersionCode 38 and Clean Manifest Alignment', () => {
  const gradle = fs.readFileSync(path.resolve(__dirname, '../android/app/build.gradle'), 'utf8');
  const vcMatch = gradle.match(/versionCode\s+(\d+)/);
  assert.ok(vcMatch && parseInt(vcMatch[1], 10) === 38, 'build.gradle must have versionCode 38');
  assert.ok(html.includes('Build 38'), 'index.html displays Build 38');
});
