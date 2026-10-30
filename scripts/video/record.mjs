// Records the pages of a shot for the edit (shot.mjs --record <dir>), no screen recorder needed.
// Each page is its own track (Chromium's screencast, at 2x pixels), all on one clock, so the edit
// can cut between pages and lay the PayPal window over the buyer page. Marks are the moments
// the edit cuts on, in seconds from the start of the shot.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FPS = 30;

export function recorder(where) {
  const dir = resolve(where);
  mkdirSync(dir, { recursive: true });
  const tracks = [];
  const marks = [];
  let t0 = null;
  const now = () => (Date.now() - t0) / 1000;

  return {
    /** Starts taking frames of `page` now; the shot's clock starts with start(). */
    async track(name, page) {
      const frames = join(dir, name);
      rmSync(frames, { recursive: true, force: true });
      mkdirSync(frames, { recursive: true });
      const t = { name, page, frames: [], end: null, offset: null };
      tracks.push(t);
      const cdp = await page.context().newCDPSession(page);
      t.cdp = cdp;
      cdp.on("Page.screencastFrame", (f) => {
        if (t.stopped) return;
        // The compositor's own timestamps keep motion even; mapped once onto Date.now().
        const at = f.metadata.timestamp * 1000;
        t.offset ??= Date.now() - at;
        const file = join(frames, `${String(t.frames.length).padStart(6, "0")}.jpg`);
        writeFileSync(file, Buffer.from(f.data, "base64"));
        t.frames.push({ file, ms: at + t.offset });
        cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      });
      page.on("close", () => {
        t.end ??= Date.now();
      });
      const vp = page.viewportSize();
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 92,
        everyNthFrame: 1,
        maxWidth: vp.width * 2,
        maxHeight: vp.height * 2,
      });
    },
    start() {
      t0 = Date.now();
    },
    get live() {
      return t0 !== null;
    },
    mark(name) {
      if (t0 === null) return;
      marks.push({ name, t: Math.round(now() * 100) / 100 });
    },
    /** Stops every track and writes <track>.mp4 (30 fps) and shot.json (marks, where each track starts). */
    async finish() {
      const end = Date.now();
      const out = { duration: (end - t0) / 1000, marks, tracks: {} };
      for (const t of tracks) {
        t.stopped = true;
        await t.cdp.send("Page.stopScreencast").catch(() => {});
      }
      for (const t of tracks) {
        const last = Math.min(t.end ?? end, end);
        // Frames from before the start: only the newest stays, as the first picture.
        let first = t.frames.findLastIndex((f) => f.ms <= t0);
        if (first < 0) first = 0;
        const frames = t.frames.slice(first).filter((f) => f.ms <= last);
        if (!frames.length) continue;
        const begin = Math.max(frames[0].ms, t0);
        const list = frames.map((f, i) => {
          const from = Math.max(f.ms, begin);
          const to = i + 1 < frames.length ? frames[i + 1].ms : last;
          return `file '${f.file.replaceAll("\\", "/")}'\nduration ${Math.max(0.001, (to - from) / 1000).toFixed(4)}`;
        });
        // The concat demuxer ignores the last duration unless the last file is listed again.
        list.push(`file '${frames.at(-1).file.replaceAll("\\", "/")}'`);
        const listFile = join(dir, `${t.name}.txt`);
        writeFileSync(listFile, list.join("\n"));
        const mp4 = join(dir, `${t.name}.mp4`);
        execFileSync("ffmpeg", [
          ...["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile],
          ...[
            "-vf",
            `fps=${FPS},format=yuv420p`,
            "-c:v",
            "libx264",
            "-preset",
            "faster",
            "-crf",
            "14",
          ],
          ...["-movflags", "+faststart", mp4],
        ]);
        rmSync(join(dir, t.name), { recursive: true, force: true });
        rmSync(listFile);
        out.tracks[t.name] = {
          file: `${t.name}.mp4`,
          start: (begin - t0) / 1000,
          seconds: (last - begin) / 1000,
        };
      }
      writeFileSync(join(dir, "shot.json"), JSON.stringify(out, null, 2));
      return out;
    },
  };
}

/** A pointer drawn into the page, so a viewer sees what gets clicked (headless has no cursor). */
export function pointerScript() {
  addEventListener("DOMContentLoaded", () => {
    const p = document.createElement("div");
    p.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.8 L20.5 15.8 Z" fill="#fff" stroke="#000" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(p.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity .2s",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))",
    });
    document.documentElement.append(p);
    // Like a screen recorder set to hide an idle cursor: it shows while the hand moves.
    let idle;
    const wake = () => {
      p.style.opacity = "1";
      clearTimeout(idle);
      idle = setTimeout(() => {
        p.style.opacity = "0";
      }, 2200);
    };
    addEventListener(
      "mousemove",
      (e) => {
        wake();
        p.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`;
      },
      true,
    );
    addEventListener(
      "mousedown",
      (e) => {
        wake();
        const ring = document.createElement("div");
        Object.assign(ring.style, {
          position: "fixed",
          left: `${e.clientX - 18}px`,
          top: `${e.clientY - 18}px`,
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          border: "3px solid #ffe500",
          boxShadow: "0 0 0 2px #000",
          zIndex: "2147483646",
          pointerEvents: "none",
          transition: "transform .45s ease-out, opacity .45s ease-out",
        });
        document.documentElement.append(ring);
        requestAnimationFrame(() => {
          ring.style.transform = "scale(1.6)";
          ring.style.opacity = "0";
        });
        setTimeout(() => ring.remove(), 600);
      },
      true,
    );
  });
}
