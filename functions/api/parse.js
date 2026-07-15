// Conference Companion — parse endpoint (Cloudflare Pages Function)
// Accepts POST {url} or {text}. Fetches the URL server-side if given,
// then asks Cloudflare's free Workers AI to structure it into sessions.
// Requires one binding in the Pages project settings: Workers AI, named "AI".

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_INPUT = 12000;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    let raw = (body.text || "").trim();

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
    }

    if (!raw) return json({ error: "empty" }, 400);
    raw = raw.slice(0, MAX_INPUT);

    const prompt =
      'Parse this conference schedule into JSON. Respond with ONLY valid JSON, no markdown fences, no preamble. ' +
      'Shape: {"name":"conference name","days":[{"label":"short day label like Mon 14 Sep"}],' +
      '"sessions":[{"d":0,"start":"9:00 am","end":"10:00 am","title":"","room":"","speaker":"","track":"",' +
      '"type":"Talk|Workshop|Keynote|Panel|Discussion|Masterclass|Showcase|Break","desc":"one short sentence",' +
      '"flag":"only include if something was missing or ambiguous: brief note of what you assumed"}]}. ' +
      'd is the day index into days. Omit flag when confident. If an end time is missing, estimate it from ' +
      'surrounding sessions and add a flag saying so. Keep desc under 15 words. Ignore navigation menus, ' +
      'footers, FAQs and newsletter forms. Schedule:\n\n' + raw;

    const ai = await env.AI.run(MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    });

    const text = (ai.response || "").trim();
    const parsed = extractJSON(text);
    if (!parsed || !parsed.sessions || !parsed.sessions.length) {
      return json({ error: "no sessions found" }, 422);
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
