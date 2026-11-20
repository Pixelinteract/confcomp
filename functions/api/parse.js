// Conference Companion — parse endpoint (Cloudflare Pages Function)
// Accepts POST {url} or {text}. Fetches the URL server-side if given,
// then asks Cloudflare's free Workers AI to structure it into sessions.
// Requires one binding in the Pages project settings: Workers AI, named "AI".

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT = 12000;
const VISION_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct"; // read UX Camp grid rooms correctly where Llama 4 Scout did not
const MIN_TEXT = 600;      // below this, the page probably shows its schedule as an image
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    let raw = (body.text || "").trim();
    let imageRooms = null; // speaker -> room, read straight from an image transcript

    // Fetch the schedule page server-side (no CORS restriction here)
    if (body.url) {
      const target = new URL(body.url); // throws on invalid URL
      if (!/^https?:$/.test(target.protocol)) throw new Error("bad protocol");
      const page = await fetch(target.toString(), {
        headers: { "User-Agent": "ConferenceCompanion/1.0" },
        cf: { cacheTtl: 3600 },
      });
      const html = await page.text();
      raw = htmlToText(html);

      // Some sites post the schedule as an image. If the page has little
      // text, find likely schedule images and transcribe them.
      if (raw.length < MIN_TEXT && env.AI) {
        const imgs = findScheduleImages(html, target);
        let read = "";
        for (const src of imgs) {
          const t = await readImage(env, src);
          if (t) read += "\n\n" + t;
        }
        // Drop "(empty)" cell lines: they only confuse the text parser
        read = read.split("\n").filter((l) => !/\|\s*\(empty\)\s*\|?\s*$/i.test(l)).join("\n");
        imageRooms = roomsFromTranscript(read);
        if (read) raw = raw + read;
      }
    }

    if (!raw) return json({ error: "empty" }, 400);
    raw = raw.slice(0, MAX_INPUT);

    const prompt =
      'Parse this conference schedule into JSON. Respond with ONLY valid JSON, no markdown fences, no preamble. ' +
      'Shape: {"name":"conference name","days":[{"label":"short day label, e.g. weekday and date"}],' +
      '"sessions":[{"d":0,"start":"9:00 am","end":"10:00 am","title":"","room":"","speaker":"","track":"",' +
      '"type":"Talk|Workshop|Keynote|Panel|Discussion|Masterclass|Showcase|Break","desc":"one short sentence",' +
      '"flag":"only include if something was missing or ambiguous: brief note of what you assumed"}]}. ' +
      'd is the day index into days. Only use a date or weekday that appears in the schedule; ' +
      'never invent one. If no date is given, label days "Day 1", "Day 2" and so on. ' +
      'Skip "(empty)" cells; they are not sessions. Keep each session in the room it is listed under. ' +
      'Omit flag when confident. If an end time is missing, estimate it from ' +
      'surrounding sessions and add a flag saying so. Keep desc under 15 words. Ignore navigation menus, ' +
      'footers, FAQs and newsletter forms. Schedule:\n\n' + raw;

    if (!env.AI) return json({ error: "AI binding missing" }, 500);

    const ai = await env.AI.run(MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    });

    // Workers AI may return `response` as a string, or as an already-parsed
    // object when the model's output is valid JSON. Handle both.
    const out = ai && ai.response !== undefined ? ai.response : ai;
    const parsed =
      out && typeof out === "object" && out.sessions
        ? out
        : extractJSON(typeof out === "string" ? out : JSON.stringify(out || ""));
    if (!parsed || !parsed.sessions || !parsed.sessions.length) {
      return json({ error: "no sessions found" }, 422);
    }
    // The text model sometimes shifts sessions between grid columns, so
    // trust the room the image transcript gave for each speaker.
    if (imageRooms && imageRooms.size) {
      for (const s of parsed.sessions) {
        const room = imageRooms.get(normName(s.speaker));
        if (room) s.room = room;
      }
    }
    if (!parsed.days || !parsed.days.length) {
      const maxD = Math.max(...parsed.sessions.map((s) => s.d || 0));
      parsed.days = Array.from({ length: maxD + 1 }, (_, i) => ({ label: "Day " + (i + 1) }));
    }
    return json(parsed, 200);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

// From "time | room | speaker | title" lines, map each speaker to their room.
// A speaker listed in more than one room is left out (ambiguous).
function roomsFromTranscript(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const f = line.split("|").map((x) => x.replace(/\*+/g, "").trim());
    if (f.length < 4 || !/\d{1,2}[:.]\d{2}/.test(f[0])) continue;
    const room = f[1], speaker = normName(f[2]);
    if (!room || !speaker || /^all rooms$/i.test(room)) continue;
    map.set(speaker, map.has(speaker) && map.get(speaker) !== room ? null : room);
  }
  for (const [k, v] of map) if (!v) map.delete(k);
  return map;
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Collect image URLs from the page, schedule-looking ones first.
// Skips logos, icons and SVGs.
function findScheduleImages(html, base) {
  const seen = new Map();
  const re = /<img\b[^>]*>|data-(?:src|image)="[^"]+"/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const srcM = tag.match(/data-(?:src|image)="([^"]+)"/i) || tag.match(/\bsrc="([^"]+)"/i);
    if (!srcM) continue;
    let url;
    try { url = new URL(srcM[1].replace(/&amp;/g, "&"), base); } catch (_) { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    const key = url.origin + url.pathname;
    if (/\.svg$|logo|icon|favicon|avatar/i.test(key)) continue;
    const alt = (tag.match(/\balt="([^"]*)"/i) || [])[1] || "";
    const hint = /schedule|agenda|program|timetable|itinerary/i.test(key + " " + alt);
    const prev = seen.get(key);
    if (!prev || (hint && !prev.hint)) seen.set(key, { url, hint });
  }
  const list = [...seen.values()];
  const hinted = list.filter((x) => x.hint);
  return (hinted.length ? hinted : list).slice(0, MAX_IMAGES).map(({ url }) => {
    // Squarespace serves resized images; 1500px keeps text readable but small
    if (/squarespace-cdn\.com$/.test(url.hostname)) url.search = "?format=1500w";
    return url.toString();
  });
}

// Ask a vision model to transcribe a schedule image to plain text.
async function readImage(env, src) {
  try {
    // Ask for JPEG/PNG: CDNs often serve WebP otherwise
    const res = await fetch(src, {
      headers: { Accept: "image/jpeg,image/png;q=0.9" },
      cf: { cacheTtl: 3600 },
    });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return "";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return "";
    const dataUrl = "data:" + type.split(";")[0] + ";base64," + toBase64(buf);
    const ai = await env.AI.run(VISION_MODEL, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text:
            "If this image is a conference schedule or agenda, transcribe it as plain text. " +
            "If it is a grid, first list the column headers (rooms) left to right. Then go row " +
            "by row: for each time, go through every column in order and write one line per " +
            "cell: time | room (that column's header) | speaker | title. If a cell is empty, " +
            "write time | room | (empty). Never move a session into a neighbouring column. " +
            "Rows that span the whole width (breaks) get one line: time | all rooms | title. " +
            "Include the conference name, and the date only if one is actually shown. " +
            "If it is not a schedule, reply with only NONE." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: 2048,
    });
    const out = ai && ai.response !== undefined ? ai.response : ai;
    const text = typeof out === "string" ? out : JSON.stringify(out || "");
    return /^\s*NONE\b/i.test(text) ? "" : text.trim();
  } catch (_) {
    return "";
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Crude but effective HTML -> text for schedule pages
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Pull the first complete JSON object out of a model reply,
// salvaging complete session entries if the reply was cut off.
function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(clean.slice(start));
  } catch (e) {
    const nameM = clean.match(/"name"\s*:\s*"([^"]*)"/);
    const sessions = [];
    const re = /\{[^{}]*"title"[^{}]*\}/g;
    let m;
    while ((m = re.exec(clean))) {
      try { sessions.push(JSON.parse(m[0])); } catch (_) {}
    }
    if (!sessions.length) return null;
    return { name: nameM ? nameM[1] : "My conference", sessions };
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
