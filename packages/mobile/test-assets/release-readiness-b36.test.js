import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../');

const indexHtmlPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/index.html');
const stylesCssPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/styles.css');
const appJsPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/app.js');
const buildGradlePath = path.join(rootDir, 'packages/mobile/android/app/build.gradle');
const manifestPath = path.join(rootDir, 'packages/mobile/android/app/src/main/AndroidManifest.xml');
const mainActivityPath = path.join(rootDir, 'packages/mobile/android/app/src/main/java/com/indianpapertrading/MainActivity.kt');
const admobManagerPath = path.join(rootDir, 'packages/mobile/android/app/src/main/java/com/indianpapertrading/AdMobManager.kt');
const fcmServicePath = path.join(rootDir, 'packages/mobile/android/app/src/main/java/com/indianpapertrading/SikhoFirebaseMessagingService.kt');

test('BUILD 36: Chart Top Bar Cleanup and Contract Identity', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Top bar should NOT have chart-theme-btn, chart-btn-option-chain, or chart-fullscreen-btn
  const topBarMatch = html.match(/<div class="chart-top-bar">([\s\S]*?)<\/div>\s*<!-- Timeframe/);
  assert.ok(topBarMatch, 'chart-top-bar must exist');
  const topBarContent = topBarMatch[1];

  assert.ok(!topBarContent.includes('chart-theme-btn'), 'Duplicate day/night theme button removed from chart header');
  assert.ok(!topBarContent.includes('chart-btn-option-chain'), 'Duplicate top Option Chain button removed from chart header');
  assert.ok(!topBarContent.includes('chart-fullscreen-btn'), 'Fullscreen toggle moved out of chart header into chart stage');

  // Bottom option chain and trade buttons must remain intact
  assert.ok(html.includes('id="chart-bottom-trade-bar"'), 'Bottom trade action bar preserved');

  // Contract identity formatter function in appJs
  assert.ok(appJs.includes('function formatChartHeaderContractIdentity(inst)'), 'formatChartHeaderContractIdentity defined');
  assert.ok(appJs.includes('formatChartHeaderContractIdentity'), 'Header updates contract identity without truncation');
});

test('BUILD 36: On-Plot Fullscreen Control Inside Chart Area', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // Must be located inside .chart-stage-wrap
  const stageMatch = html.match(/<div class="chart-stage-wrap">([\s\S]*?)<\/div>\s*<!-- Range/);
  assert.ok(stageMatch, 'chart-stage-wrap must exist');
  const stageContent = stageMatch[1];

  assert.ok(stageContent.includes('id="chart-fullscreen-btn"'), 'Fullscreen button located inside chart-stage-wrap');
  assert.ok(stageContent.includes('class="chart-onplot-fullscreen-btn"'), 'Has chart-onplot-fullscreen-btn class');

  // CSS rules for positioning: top 8px, right 64px (avoiding scale & legend)
  assert.ok(css.includes('.chart-onplot-fullscreen-btn'), 'CSS defines on-plot fullscreen button');
  assert.ok(css.includes('top: 8px;'), 'Positioned at top: 8px');
  assert.ok(css.includes('right: 64px;'), 'Positioned at right: 64px');
});

test('BUILD 36: Mandatory Update Modal & Server Version Policy UI', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Blocking update modal elements
  assert.ok(html.includes('id="modal-update-required"'), 'Update required modal markup exists');
  assert.ok(html.includes('id="update-modal-title"'), 'Update title element exists');
  assert.ok(html.includes('id="update-modal-message"'), 'Update message element exists');
  assert.ok(html.includes('id="update-modal-notes"'), 'Update notes container exists');
  assert.ok(html.includes('id="btn-update-now"'), 'Update Now action button exists');
  assert.ok(html.includes('id="btn-update-close-app"'), 'Close App button exists');

  // Modal CSS
  assert.ok(css.includes('.blocking-update-modal'), 'Blocking modal styling present');
  assert.ok(css.includes('.blocking-update-card'), 'Modal card styling present');

  // JS version policy functions
  assert.ok(appJs.includes('function checkAppVersionPolicy'), 'checkAppVersionPolicy defined');
  assert.ok(appJs.includes('function showBlockingUpdateRequired'), 'showBlockingUpdateRequired defined');
  assert.ok(appJs.includes('function hideBlockingUpdateRequired'), 'hideBlockingUpdateRequired defined');
  assert.ok(appJs.includes('function onUpdateNowClicked'), 'onUpdateNowClicked defined');
  assert.ok(appJs.includes('function onCloseAppClicked'), 'onCloseAppClicked defined');
  assert.ok(appJs.includes("headers['x-app-version-code']"), 'x-app-version-code header sent on requests');
});

test('BUILD 36: UMP Privacy Options & Sanitized Diagnostics', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Privacy options wrapper starts hidden
  assert.ok(html.includes('id="prof-ad-privacy-wrap"') && html.includes('style="display:none;'), 'Privacy options wrapper hidden by default');
  assert.ok(html.includes('id="prof-app-version"'), 'Profile displays app version');

  // Dead ad diagnostics button removed
  assert.ok(!html.includes('Ad diagnostics (support)'), 'Dead diagnostics button removed from Profile');

  // UMP logic: only show when REQUIRED, hide on NOT_REQUIRED or UNKNOWN
  assert.ok(appJs.includes('updatePrivacyOptionsVisibility'), 'updatePrivacyOptionsVisibility defined');
  assert.ok(appJs.includes("status === 'REQUIRED'"), 'Checks for REQUIRED status');

  // Sanitized debug trigger: 5 taps on version label
  assert.ok(appJs.includes('onVersionLabelClick'), 'onVersionLabelClick defined');
  assert.ok(appJs.includes('showSanitizedDiagnostics'), 'showSanitizedDiagnostics defined');
});

test('BUILD 36: Native Android Bridge & Manifest Capabilities', () => {
  const gradle = fs.readFileSync(buildGradlePath, 'utf8');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const mainActivity = fs.readFileSync(mainActivityPath, 'utf8');
  const admobManager = fs.readFileSync(admobManagerPath, 'utf8');
  const fcmService = fs.readFileSync(fcmServicePath, 'utf8');

  // Gradle version and dependencies
  assert.ok(gradle.includes('versionCode 36'), 'versionCode bumped to 36');
  assert.ok(gradle.includes('versionName "v1.0.1"'), 'versionName is v1.0.1');
  assert.ok(gradle.includes('com.google.android.play:app-update'), 'Play App Update library included');
  assert.ok(gradle.includes('com.google.firebase:firebase-messaging'), 'FCM messaging library included');

  // Manifest permissions and services
  assert.ok(manifest.includes('android.permission.POST_NOTIFICATIONS'), 'POST_NOTIFICATIONS permission declared');
  assert.ok(manifest.includes('SikhoFirebaseMessagingService'), 'SikhoFirebaseMessagingService registered');

  // Native bridge methods
  assert.ok(mainActivity.includes('fun getAppVersionInfo(): String'), 'getAppVersionInfo bridge method defined');
  assert.ok(mainActivity.includes('fun getPrivacyOptionsRequirementStatus(): String'), 'getPrivacyOptionsRequirementStatus bridge method defined');
  assert.ok(mainActivity.includes('fun startPlayStoreUpdate('), 'startPlayStoreUpdate bridge method defined');
  assert.ok(mainActivity.includes('fun closeApp()'), 'closeApp bridge method defined');
  assert.ok(mainActivity.includes('fun getFcmToken()'), 'getFcmToken bridge method defined');
  assert.ok(mainActivity.includes('fun registerFcmToken'), 'registerFcmToken bridge method defined');

  // UMP status query in AdMobManager
  assert.ok(admobManager.includes('fun getPrivacyOptionsRequirementStatus(): String'), 'AdMobManager queries UMP requirement status');

  // FCM channel definition
  assert.ok(fcmService.includes('release_updates'), 'release_updates channel configured');
});
