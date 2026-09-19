const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const WebSocket = require("ws");
const { deliverCapture } = require("./easel_channels_bridge");

const ROOT = path.resolve(__dirname, "..");
const KEYGEN = path.join(ROOT, "tools", "wxisaac_keygen.js");
const OUT_DIR = path.join(ROOT, "downloads");

fs.mkdirSync(OUT_DIR, { recursive: true });

let nextId = 1;
const pending = new Map();

const ws = new WebSocket("ws://127.0.0.1:62000");

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 8000);

    pending.set(id, { resolve, reject, timer });

    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;

    ws.send(JSON.stringify(msg));
  });
}

ws.on("message", raw => {
  let m;

  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (!m.id || !pending.has(m.id))
    return;

  const p = pending.get(m.id);
  pending.delete(m.id);
  clearTimeout(p.timer);

  if (m.error)
    p.reject(new Error(JSON.stringify(m.error)));
  else
    p.resolve(m.result);
});

ws.on("open", async () => {
  try {
    const { targetInfos } = await call("Target.getTargets");

    const target = targetInfos.find(t => t.title === "视频号");

    if (!target)
      throw new Error("没有找到视频号 Target");

    const { sessionId } = await call(
      "Target.attachToTarget",
      { targetId: target.targetId }
    );

    const r = await call(
      "Runtime.evaluate",
      {
        expression: `
(() => {
  const videos = [...document.querySelectorAll("video")];

  const ranked = videos.map(v => {
    const r = v.getBoundingClientRect();

    const left   = Math.max(0, r.left);
    const top    = Math.max(0, r.top);
    const right  = Math.min(innerWidth, r.right);
    const bottom = Math.min(innerHeight, r.bottom);

    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);

    return {
      video: v,
      area: w * h
    };
  }).sort((a, b) => b.area - a.area);

  const video = ranked[0]?.area > 0
    ? ranked[0].video
    : null;

  if (!video)
    return JSON.stringify({
      error: "没有找到当前中央视频"
    });

  const player = video.parentElement?.player;

  if (!player)
    return JSON.stringify({
      error: "当前视频没有 player 对象"
    });

  const source = player.currentSource?.();
  const opts = source?.decryptPlayerOptions;

  if (!opts?.url || !opts?.seed)
    return JSON.stringify({
      error: "当前视频没有 decryptPlayerOptions"
    });

  return JSON.stringify({
    seed: String(opts.seed),
    url: opts.url,
    duration: Number(video.duration || opts.duration || 0),
    currentTime: Number(video.currentTime || 0),
    feedId:
      video.closest('[id^="flow-feed-"]')?.id || null
  });
})()
`,
        returnByValue: true
      },
      sessionId
    );

    const rawCut = r?.result?.value;

    if (!rawCut || rawCut === "null")
      throw new Error("当前页面没有捕获到 CUT 数据");

    const cut = JSON.parse(rawCut);

    if (cut.error)
      throw new Error(cut.error);

    if (!cut.seed || !cut.url)
      throw new Error("CUT 数据缺少 seed 或 url");

    const seed = String(cut.seed);

    console.log("SEED       :", seed);
    console.log("CONTENT_LEN:", cut.contentLen ?? "unknown");

    const keyFile = `/tmp/wx_key_${seed}.bin`;

    console.log("GENERATING KEY...");

    execFileSync(
      process.execPath,
      [KEYGEN, seed, keyFile],
      {
        cwd: ROOT,
        stdio: "ignore"
      }
    );

    const key = fs.readFileSync(keyFile);

    if (key.length !== 131072)
      throw new Error(`密钥长度异常：${key.length}`);

    console.log("DOWNLOADING...");

    const response = await fetch(cut.url);

    console.log(
      "HTTP       :",
      response.status,
      response.statusText
    );

    if (!response.ok)
      throw new Error(`视频下载失败：HTTP ${response.status}`);

    const encrypted = Buffer.from(
      await response.arrayBuffer()
    );

    console.log("DOWNLOADED :", encrypted.length);

    if (
      cut.contentLen &&
      encrypted.length !== Number(cut.contentLen)
    ) {
      console.warn(
        "WARNING    : 下载长度与 contentLen 不一致",
        encrypted.length,
        "!=",
        cut.contentLen
      );
    }

    const plain = Buffer.from(encrypted);

    const xorLength = Math.min(
      131072,
      plain.length,
      key.length
    );

    for (let i = 0; i < xorLength; i++)
      plain[i] ^= key[i];

    const head = plain.subarray(0, 32);

    console.log(
      "PLAIN_HEAD :",
      head.toString("hex")
    );

    if (plain.subarray(4, 8).toString("ascii") !== "ftyp")
      throw new Error("解密结果不是标准 MP4：未发现 ftyp");

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const outFile = path.join(
      OUT_DIR,
      `wxchannels_${stamp}_${seed}.mp4`
    );

    fs.writeFileSync(outFile, plain);

    console.log("MP4 OK     : ftyp");
    console.log("OUTPUT     :", outFile);
    console.log("SIZE       :", plain.length);

    try {
      const delivery = deliverCapture({
        videoPath: outFile,
        seed,
        duration: cut.duration,
        currentTime: cut.currentTime,
        feedId: cut.feedId
      });

      console.log("EASEL      : delivered");
      console.log("CAPTURE_ID :", delivery.captureId);
      console.log("EASEL_DIR  :", delivery.directory);

      const easelRoot =
        process.env.EASEL_ROOT ||
        "/home/huang-justin/Easel";

      const easelPython = path.join(
        easelRoot,
        ".venv",
        "bin",
        "python"
      );

      const easelImporter = path.join(
        easelRoot,
        "web",
        "channels_material_importer.py"
      );

      console.log("EASEL      : importing material...");

      execFileSync(
        easelPython,
        [easelImporter, delivery.directory],
        {
          cwd: easelRoot,
          stdio: "inherit"
        }
      );

      console.log("EASEL      : material imported");
    } catch (bridgeError) {
      console.warn(
        "EASEL WARN : 视频已保存，但投递 Easel 失败：",
        bridgeError.message
      );
    }

    try {
      fs.unlinkSync(keyFile);
    } catch {}

    ws.close();

  } catch (e) {
    console.error("ERROR:", e.message);

    try {
      ws.close();
    } catch {}

    process.exitCode = 1;
  }
});
