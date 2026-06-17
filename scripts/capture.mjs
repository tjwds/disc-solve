// Headless-Chrome screenshot over the DevTools protocol.
//
// Why not `chrome --screenshot`? That captures at the OS --window-size, but
// headless Chrome's layout viewport (window.innerHeight) is shorter than the
// window by the platform's frame height (~87px on macOS). The page lays out into
// the shorter viewport while the capture is the full window height, so a strip of
// empty background is left below the content. Driving the capture over CDP lets us
// pin an exact device viewport with Emulation.setDeviceMetricsOverride, so the
// layout and the screenshot are the same size and there is no gap.
//
// Usage: node capture.mjs <chrome> <url> <out.png> <width> <height> <scale> <renderMs>

import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chromeBin, url, out, wStr, hStr, scaleStr, renderStr] = process.argv.slice(2);
const width = Number(wStr);
const height = Number(hStr);
const scale = Number(scaleStr);
const renderMs = Number(renderStr) || 3000;
if (!chromeBin || !url || !out || !width || !height || !scale) {
  console.error("usage: capture.mjs <chrome> <url> <out.png> <width> <height> <scale> <renderMs>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "disk-solve-cdp-"));

// Let Chrome pick its own debugging port (avoids collisions) and report it via
// the DevToolsActivePort file it writes into the user-data-dir.
const chrome = spawn(chromeBin, [
  "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function debugPort() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (line) return Number(line);
    }
    await sleep(100);
  }
  throw new Error("Chrome never reported a DevTools port");
}

let ws;
try {
  const port = await debugPort();
  const req = (path, method = "GET") =>
    new Promise((res, rej) => {
      const r = http.request(`http://127.0.0.1:${port}${path}`, { method }, (resp) => {
        let d = "";
        resp.on("data", (c) => (d += c));
        resp.on("end", () => res(JSON.parse(d)));
      });
      r.on("error", rej);
      r.end();
    });

  const tab = await req("/json/new?" + encodeURIComponent(url), "PUT");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket failed to open"));
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const o = JSON.parse(m.data);
    if (o.id && pending.has(o.id)) {
      pending.get(o.id)(o);
      pending.delete(o.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await sleep(renderMs); // let React mount and the demo settle
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!shot.result?.data) throw new Error("captureScreenshot returned no data");
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
