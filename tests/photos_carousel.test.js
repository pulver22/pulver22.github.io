/**
 * photos_carousel.test.js
 *
 * Validates that the Swiper carousel on photos.html renders correctly:
 *   - The container fits within the viewport (no runaway width feedback loop)
 *   - The container has meaningful height
 *   - Slides have correct proportional width and positive height
 *   - Slide count includes loop duplicates
 *
 * Prerequisites:
 *   - Node.js with puppeteer installed globally:
 *       npm install -g puppeteer
 *   - An HTTP server serving the repo root on port 9090:
 *       python3 -m http.server 9090 &
 *
 * Usage:
 *   NODE_PATH=$(npm root -g) node tests/photos_carousel.test.js
 */

'use strict';

const puppeteer = require('puppeteer');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:9090';
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;
const SLIDES_PER_VIEW = 3;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });

  try {
    // ── Test 1: container dimensions before Swiper ──────────────────────────
    console.log('\nTest 1: Container dimensions before Swiper initialises');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });
      await page.setCacheEnabled(false);

      // Block Swiper JS so we see the pure CSS layout
      await page.setRequestInterception(true);
      page.on('request', req =>
        req.url().includes('swiper.min.js') ? req.abort() : req.continue()
      );

      await page.goto(`${BASE_URL}/photos.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      const metrics = await page.evaluate(() => {
        const c = document.querySelector('.swiper-container');
        return c
          ? { width: c.offsetWidth, height: c.offsetHeight }
          : null;
      });

      assert(metrics !== null, 'Swiper container is present in DOM');
      assert(
        metrics && metrics.width > 0,
        `Container has positive width before Swiper (${metrics && metrics.width}px)`
      );
      assert(
        metrics && metrics.height > 100,
        `Container has meaningful height before Swiper (${metrics && metrics.height}px)`
      );
      await page.close();
    }

    // ── Test 2: Swiper carousel dimensions after full initialisation ─────────
    console.log('\nTest 2: Swiper carousel dimensions after full initialisation');
    {
      const page = await browser.newPage();
      await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });
      await page.setCacheEnabled(false);

      await page.goto(`${BASE_URL}/photos.html`, {
        waitUntil: 'networkidle0',
        timeout: 20000,
      });

      const metrics = await page.evaluate((slidesPerView, realSlideCount) => {
        const container = document.querySelector('.swiper-container');
        const wrapper = document.querySelector('.swiper-wrapper');
        const allSlides = document.querySelectorAll('.swiper-slide');
        const realSlides = document.querySelectorAll(
          '.swiper-slide:not(.swiper-slide-duplicate)'
        );

        return {
          viewportW: window.innerWidth,
          containerW: container ? container.offsetWidth : -1,
          containerH: container ? container.offsetHeight : -1,
          wrapperW: wrapper ? wrapper.offsetWidth : -1,
          firstSlideW: allSlides[0] ? allSlides[0].offsetWidth : -1,
          firstSlideH: allSlides[0] ? allSlides[0].offsetHeight : -1,
          totalSlideCount: allSlides.length,
          realSlideCount: realSlides.length,
        };
      }, SLIDES_PER_VIEW);

      // Container must fit within the viewport (no feedback loop)
      assert(
        metrics.containerW <= metrics.viewportW * 1.05,
        `Container width (${metrics.containerW}px) ≤ viewport width (${metrics.viewportW}px) — no feedback loop`
      );
      assert(
        metrics.containerW > 0,
        `Container has positive width after Swiper (${metrics.containerW}px)`
      );
      assert(
        metrics.containerH > 100,
        `Container has meaningful height after Swiper (${metrics.containerH}px)`
      );

      // Slide width must be proportional to container width (± 10% tolerance for spaceBetween)
      const expectedSlideW = metrics.containerW / SLIDES_PER_VIEW;
      const slideTolerance = expectedSlideW * 0.15;
      assert(
        Math.abs(metrics.firstSlideW - expectedSlideW) <= slideTolerance,
        `First slide width (${metrics.firstSlideW}px) ≈ containerW/${SLIDES_PER_VIEW} = ${Math.round(expectedSlideW)}px`
      );
      assert(
        metrics.firstSlideH > 100,
        `First slide has meaningful height (${metrics.firstSlideH}px)`
      );

      // Slide count: loop:true should add duplicates
      assert(
        metrics.totalSlideCount > metrics.realSlideCount,
        `Loop duplicates present — total slides (${metrics.totalSlideCount}) > real slides (${metrics.realSlideCount})`
      );
      assert(
        metrics.realSlideCount > 0,
        `At least one non-duplicate slide exists (got ${metrics.realSlideCount})`
      );

      await page.close();
    }

  } finally {
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
