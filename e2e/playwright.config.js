// pgpt-pro (Process GPT Lite) regression suite — three tiers as Playwright projects:
//   smoke   : no model calls, < 3 min — health, auth, every screen renders, security fences
//   feature : fixed data through server APIs and MCP endpoints, UI behaviours (no/minimal model)
//   agent   : the demo-video journeys end to end with the real agents (slow, retried once)
// Reports: reports/<tier>/html, reports/<tier>/junit.xml; traces/screenshots kept on failure.
import { defineConfig } from '@playwright/test'

process.env.RT_RUN ||= Date.now().toString(36)
const { PGPT_URL } = await import('./lib/env.js')
const tier = process.env.RT_REPORT || 'all'

export default defineConfig({
  testDir: './tests',
  outputDir: `reports/${tier}/artifacts`,
  fullyParallel: false,
  workers: Number(process.env.RT_WORKERS || 3),
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { outputFolder: `reports/${tier}/html`, open: 'never' }],
    ['junit', { outputFile: `reports/${tier}/junit.xml` }],
  ],
  globalTeardown: './lib/teardown.js',
  use: {
    baseURL: PGPT_URL,
    viewport: { width: 1280, height: 720 },
    // the ArtCraft (egui) apps lay out wrongly above dpr 1
    deviceScaleFactor: 1,
    locale: 'ko-KR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'smoke', testDir: './tests/smoke', timeout: 60_000, retries: 0 },
    { name: 'feature', testDir: './tests/feature', timeout: 240_000, retries: 0 },
    // model answers vary: one retry; assertions are on durable outcomes (rows, files, cards)
    { name: 'agent', testDir: './tests/agent', timeout: 30 * 60_000, retries: 1, use: { actionTimeout: 60_000 } },
    // Lite behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite): signs in through ProcessGPT itself
    { name: 'deploy', testDir: './tests/deploy', timeout: 15 * 60_000, retries: 0, use: { actionTimeout: 30_000 } },
  ],
})
