import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { temporary, removeTemporary } from '../tests/helpers.js';
const root = temporary('ui-profile');
const brain = new Brain(root);
brain.settings.update({
  ...brain.settings.data,
  onboarded: true,
  background: false,
  name: 'Performance test fixture',
});
const types = ['project', 'concept', 'device', 'technology', 'person', 'note'];
const nodes = Array.from({ length: 350 }, (_, i) =>
  brain.graph.entity({ name: `Test entity ${i}`, type: types[i % types.length] }),
);
for (let i = 1; i < nodes.length; i++)
  brain.graph.link({ from_id: nodes[i].id, to_id: nodes[Math.floor((i - 1) / 3)].id, type: 'references' });
const service = await serve(brain, { port: 0 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    (window as any).__drawTimes = [];
    const original = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const start = performance.now();
      original.apply(this, args);
      queueMicrotask(() => (window as any).__drawTimes.push(performance.now() - start));
    };
  });
  await page.goto(service.url);
  await page.getByLabel(/Knowledge graph with 350 entities/).waitFor();
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.getByRole('button', { name: 'Reset graph view' }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as any).__drawTimes = [];
  });
  // A raw browser script avoids tsx injecting its Node-only function-name helper.
  const frames = page.evaluate<number[]>(`new Promise(resolve => {
    const times = []; let previous = 0;
    const step = (time) => {
      if (previous) times.push(time - previous);
      previous = time;
      if (times.length === 180) resolve(times); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + Math.sin(i / 12) * 180,
      box.y + box.height / 2 + Math.cos(i / 12) * 100,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const frameTimes = (await frames).sort((a, b) => a - b);
  const drawTimes: number[] = await page.evaluate(() => (window as any).__drawTimes);
  drawTimes.sort((a, b) => a - b);
  await page.getByRole('button', { name: 'Reset graph view' }).click();
  await page.waitForTimeout(500);
  mkdirSync('artifacts/screenshots', { recursive: true });
  await page.screenshot({ path: 'artifacts/screenshots/17-graph-350.png', animations: 'disabled' });
  const results = {
    browser: await browser.version(),
    viewport: '1440x960',
    entities: 350,
    relationships: 349,
    frame_samples: frameTimes.length,
    frame_median_ms: frameTimes[90],
    frame_p95_ms: frameTimes[171],
    frames_over_33ms: frameTimes.filter((t) => t > 33.4).length,
    draw_samples: drawTimes.length,
    draw_median_ms: drawTimes[Math.floor(drawTimes.length / 2)],
    draw_p95_ms: drawTimes[Math.floor(drawTimes.length * 0.95)],
    note: 'Headless Edge, requestAnimationFrame intervals during repeated pan; draw measurement includes the synchronous task through its microtask checkpoint. This is a local sample, not a cross-hardware FPS guarantee.',
  };
  writeFileSync('artifacts/graph-performance.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await service.close();
  removeTemporary(root);
}
