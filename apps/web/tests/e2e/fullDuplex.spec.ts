import { chromium, expect, test } from "@playwright/test";

test("full-duplex: toggle starts listening and connects to Gateway", async () => {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();

  // Mock ASR Gateway WebSocket to return deterministic partial/final
  await page.routeWebSocket("**/asr**", async (ws) => {
    ws.onMessage((msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === "session.start") {
          ws.send(JSON.stringify({
            type: "session.started",
            sessionId: data.sessionId,
            provider: "mock",
            audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
            maxDurationMs: 90000,
            heartbeatMs: 10000,
          }));
        } else if (data.type === "audio.chunk") {
          // Send partial after first chunk
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "partial",
              sessionId: data.sessionId,
              text: "停",
              seq: data.seq,
            }));
          }, 100);
          // Send final after commit
        } else if (data.type === "session.end") {
          ws.send(JSON.stringify({
            type: "final",
            sessionId: data.sessionId,
            text: "停一下",
          }));
          ws.send(JSON.stringify({
            type: "session.ended",
            sessionId: data.sessionId,
            reason: "completed",
          }));
        }
      } catch { /* ignore */ }
    });
  });

  await page.goto("http://127.0.0.1:5175/");
  await page.waitForTimeout(5000);
  const btn = page.locator("[data-vivic-full-duplex]");
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await page.waitForTimeout(3000);
  const status = page.locator("[data-vivic-fd-status]");
  await expect(status).toBeVisible({ timeout: 10000 });
  const statusText = await status.textContent();
  expect(statusText).not.toContain("错误");
  expect(statusText).not.toContain("Gateway 连接失败");
  await context.close();
  await browser.close();
});
