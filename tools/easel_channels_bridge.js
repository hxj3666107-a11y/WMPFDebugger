#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

function nullableString(value) {
  if (value === undefined || value === null || value === "")
    return null;

  return String(value);
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "")
    return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safePart(value) {
  const text = String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return text || "unknown";
}

function nextAvailableDirectory(root, baseName) {
  let candidate = path.join(root, baseName);

  if (!fs.existsSync(candidate))
    return candidate;

  for (let i = 2; i < 10000; i++) {
    candidate = path.join(root, `${baseName}_${i}`);

    if (!fs.existsSync(candidate))
      return candidate;
  }

  throw new Error("无法生成唯一 capture 目录");
}

function deliverCapture(meta = {}) {
  if (!meta.videoPath)
    throw new Error("缺少 videoPath");

  const videoPath = path.resolve(String(meta.videoPath));

  if (!fs.existsSync(videoPath))
    throw new Error(`视频不存在：${videoPath}`);

  const stat = fs.statSync(videoPath);

  if (!stat.isFile())
    throw new Error(`videoPath 不是文件：${videoPath}`);

  if (stat.size <= 0)
    throw new Error("视频文件为空");

  const root =
    process.env.EASEL_ROOT ||
    path.join(os.homedir(), "Easel");

  const inboxRoot = path.resolve(
    process.env.EASEL_CHANNELS_INBOX ||
    path.join(root, "outputs", "_channels_inbox")
  );

  const capturedDate = meta.capturedAt
    ? new Date(meta.capturedAt)
    : new Date();

  if (Number.isNaN(capturedDate.getTime()))
    throw new Error(`capturedAt 无效：${meta.capturedAt}`);

  const capturedAt = capturedDate.toISOString();

  const stamp = capturedAt.replace(/[:.]/g, "-");
  const seedPart = safePart(meta.seed);

  const baseCaptureId =
    `wxchannels_${stamp}_${seedPart}`;

  fs.mkdirSync(inboxRoot, { recursive: true });

  const finalDir = nextAvailableDirectory(
    inboxRoot,
    baseCaptureId
  );

  const captureId = path.basename(finalDir);

  const temporaryDir = path.join(
    inboxRoot,
    `.tmp-${captureId}-${process.pid}`
  );

  fs.mkdirSync(temporaryDir, { recursive: false });

  try {
    const videoTarget = path.join(
      temporaryDir,
      "original.mp4"
    );

    fs.copyFileSync(videoPath, videoTarget);

    const copiedStat = fs.statSync(videoTarget);

    if (copiedStat.size !== stat.size) {
      throw new Error(
        `视频复制长度异常：${copiedStat.size} != ${stat.size}`
      );
    }

    const capture = {
      schema_version: "channels-capture-v1",

      capture_id: captureId,

      platform: "wechat_channels",
      source_type: "wechat_embedded_browser",
      media_type: "video",

      captured_at: capturedAt,

      files: {
        video: "original.mp4"
      },

      media: {
        size_bytes: copiedStat.size,
        duration_sec: nullableNumber(meta.duration)
      },

      playback: {
        current_time_sec: nullableNumber(meta.currentTime)
      },

      source: {
        feed_id: nullableString(meta.feedId),
        seed: nullableString(meta.seed),
        download_path: videoPath
      },

      bridge: {
        producer: "WMPFDebugger-linux",
        contract: "channels-capture-v1"
      }
    };

    fs.writeFileSync(
      path.join(temporaryDir, "capture.json"),
      JSON.stringify(capture, null, 2) + "\n",
      "utf8"
    );

    fs.renameSync(temporaryDir, finalDir);

    return {
      captureId,
      directory: finalDir,
      video: path.join(finalDir, "original.mp4"),
      manifest: path.join(finalDir, "capture.json")
    };

  } catch (error) {
    try {
      fs.rmSync(temporaryDir, {
        recursive: true,
        force: true
      });
    } catch {}

    throw error;
  }
}

if (require.main === module) {
  try {
    const videoPath = process.argv[2];

    if (!videoPath) {
      console.error(
        "用法：node tools/easel_channels_bridge.js <video.mp4> '[metadata-json]'"
      );
      process.exit(2);
    }

    let metadata = {};

    if (process.argv[3])
      metadata = JSON.parse(process.argv[3]);

    const result = deliverCapture({
      ...metadata,
      videoPath
    });

    console.log("CHANNELS_BRIDGE=PASS");
    console.log("CAPTURE_ID =", result.captureId);
    console.log("DIRECTORY  =", result.directory);
    console.log("VIDEO      =", result.video);
    console.log("MANIFEST   =", result.manifest);

  } catch (error) {
    console.error(
      "CHANNELS_BRIDGE=FAIL:",
      error.message
    );

    process.exitCode = 1;
  }
}

module.exports = {
  deliverCapture
};
