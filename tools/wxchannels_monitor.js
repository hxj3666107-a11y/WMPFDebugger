const WebSocket = require("ws");

const ws = new WebSocket("ws://127.0.0.1:62000");

let nextId = 1;
const pending = new Map();

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 8000);

    pending.set(id, { resolve, reject, timer });

    const msg = { id, method, params };

    if (sessionId)
      msg.sessionId = sessionId;

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

    const target = targetInfos.find(
      t => t.title === "视频号"
    );

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
  if (window.__wmpf_manual_save_hooked)
    return "already ready";

  const original = Worker.prototype.postMessage;

  Worker.prototype.postMessage = function(message, ...rest) {
    try {
      if (
        message &&
        typeof message === "object" &&
        message.cmd === "CUT"
      ) {
        window.__wmpf_last_cut = {
          time: Date.now(),
          seed: message.seed,
          url: message.url,
          contentLen: message.contentLen,
          first: message.first,
          timestampOffset: message.timestampOffset,
          segmentDuration: message.segmentDuration,
          disableDecrypt: message.disableDecrypt
        };
      }
    } catch (_) {}

    return original.call(this, message, ...rest);
  };

  window.__wmpf_manual_save_hooked = true;

  return "ready";
})()
`,
        returnByValue: true
      },
      sessionId
    );

    console.log("MONITOR:", r?.result?.value);
    console.log("只监听，不会自动下载视频。");

    ws.close();

  } catch (e) {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  }
});
