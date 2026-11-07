// Edge function „panel” — panelul orb pentru „Fără logo”.
// Acțiuni (POST JSON):
//   { action: "run_variant", variant_id }   rulează n_evals evaluări Gemini vision pe o variantă și salvează voturile
//   { action: "finalize", analysis_id }     calculează Δ, atribuirea greșită și diagnosticul, apoi scrie raportul
// Secret necesar: GEMINI_API_KEY (gratuit din aistudio.google.com/apikey). Opțional: GEMINI_MODEL (implicit gemini-3.5-flash-lite).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UNKNOWN = "nu știu";
const MAX_VARIANTS = 10;
const MEMORY_PER_BRAND = 5;
const CONCURRENCY = 3; // planul gratuit Gemini are limite mici de cereri/minut
// Praguri de pornire (de calibrat pe setul de demo)
const T = { asset: 0.15, decor: 0.03, traitor: 0.10 };

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// Imaginile se trimit inline (base64); le descărcăm o singură dată per rulare.
const imgCache = new Map<string, Promise<{ mime_type: string; data: string }>>();
function inlineImage(path: string) {
  if (!imgCache.has(path)) {
    imgCache.set(path, (async () => {
      const { data, error } = await supabase.storage.from("ads").download(path);
      if (error || !data) throw new Error(`Nu pot descărca imaginea ${path}`);
      const bytes = new Uint8Array(await data.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { mime_type: data.type || "image/png", data: btoa(bin) };
    })());
  }
  return imgCache.get(path)!;
}

// Curățăm cheia de spații, rânduri noi și ghilimele lipite din greșeală
const geminiKey = () => (Deno.env.get("GEMINI_API_KEY") ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();

async function gemini(body: Record<string, unknown>, attempt = 0): Promise<string> {
  const key = geminiKey();
  if (!key) throw new Error("Lipsește secretul GEMINI_API_KEY în Supabase (Edge Functions → Secrets).");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    // respectăm retryDelay dacă Google îl trimite, altfel backoff exponențial
    let wait = 2000 * 2 ** attempt;
    try {
      const j = await res.clone().json();
      const d = j?.error?.details?.find((x: any) => x.retryDelay)?.retryDelay;
      if (d) wait = Math.max(wait, parseFloat(d) * 1000);
    } catch { /* ignorăm */ }
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000) + Math.random() * 500));
    return gemini(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("").trim();
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ---------- run_variant ----------
async function runVariant(variantId: string) {
  imgCache.clear();
  const { data: v, error } = await supabase.from("variants")
    .select("*, analyses!inner(*, ads!inner(*, brands!inner(*)))").eq("id", variantId).single();
  if (error || !v) throw new Error("Varianta nu există.");
  const analysis = v.analyses;
  const testAd = analysis.ads;
  const target = testAd.brands.name as string;

  const { count } = await supabase.from("variants").select("id", { count: "exact", head: true })
    .eq("analysis_id", analysis.id);
  if ((count ?? 0) > MAX_VARIANTS) throw new Error(`Maxim ${MAX_VARIANTS} variante pe analiză.`);

  const { data: brands } = await supabase.from("brands").select("id,name").eq("category", analysis.category);
  const names = (brands ?? []).map((b) => b.name);
  if (!names.includes(target)) names.push(target);

  await supabase.from("variants").update({ status: "running" }).eq("id", variantId);
  await supabase.from("panel_votes").delete().eq("variant_id", variantId);

  // Memoria însămânțată: 3–5 reclame nemascate, etichetate, per brand — niciodată reclama testată.
  const memory: any[] = [];
  if (analysis.use_memory) {
    const { data: mem } = await supabase.from("ads").select("id,image_path,brand_id,brands!inner(name,category)")
      .eq("role", "memory").eq("brands.category", analysis.category).neq("id", testAd.id)
      .order("created_at");
    const perBrand: Record<string, number> = {};
    for (const m of mem ?? []) {
      const n = (m as any).brands.name;
      perBrand[n] = (perBrand[n] ?? 0) + 1;
      if (perBrand[n] > MEMORY_PER_BRAND) continue;
      memory.push({ text: `Reclamă cunoscută — brand: ${n}` });
      memory.push({ inline_data: await inlineImage(m.image_path) });
    }
    if (memory.length) memory.unshift({ text: "Ai văzut în trecut aceste reclame, etichetate cu brandul lor:" });
  }

  const system =
    "Ești un evaluator dintr-un panel orb de recunoaștere a brandului. Primești o reclamă din care logo-ul și numele " +
    "brandului au fost acoperite cu culoare plată. Zonele acoperite NU sunt un indiciu. Estimează pentru fiecare candidat " +
    "probabilitatea ca reclama să fie a lui, pe baza elementelor vizuale (culori, personaje, tipografie, layout, produs, ton). " +
    `Folosește „${UNKNOWN}” pentru nesiguranță reală. Probabilitățile trebuie să însumeze 1. Răspunde doar cu JSON conform schemei.`;
  const schema = {
      type: "object",
      properties: {
        probabilities: {
          type: "array",
          items: {
            type: "object",
            properties: { brand: { type: "string" }, p: { type: "number", minimum: 0, maximum: 1 } },
            required: ["brand", "p"],
          },
        },
        cues: { type: "array", items: { type: "string" }, description: "Indicii vizuale scurte, în română, ex. „verde închis”, „mascota”." },
      },
      required: ["probabilities", "cues"],
  };
  const testImage = { inline_data: await inlineImage(v.image_path) };
  const candidatesAll = [...names, UNKNOWN];

  const votes = await pool(Array.from({ length: analysis.n_evals }, (_, i) => i), CONCURRENCY, async (i) => {
    const order = shuffle(candidatesAll); // amestecăm ordinea la fiecare evaluare (bias de poziție)
    const parts = [
      ...memory,
      { text: `Reclama de evaluat (logo mascat). Candidați, în această ordine: ${order.map((c) => `„${c}”`).join(", ")}.` },
      testImage,
    ];
    const text = await gemini({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 1024 },
    });
    let input: any = { probabilities: [], cues: [] };
    try { input = JSON.parse(text.replace(/^```(json)?|```$/g, "")); } catch { /* vot invalid → „nu știu” */ }
    const probs: Record<string, number> = Object.fromEntries(candidatesAll.map((c) => [c, 0]));
    for (const { brand, p } of input.probabilities ?? []) {
      const key = candidatesAll.find((c) => c.toLowerCase() === String(brand).trim().toLowerCase());
      if (key && Number.isFinite(p) && p > 0) probs[key] += p;
    }
    const total = Object.values(probs).reduce((s, x) => s + x, 0);
    if (total > 0) for (const k in probs) probs[k] /= total; else probs[UNKNOWN] = 1;
    return { variant_id: variantId, eval_index: i, candidate_order: order, probabilities: probs, cues: (input.cues ?? []).slice(0, 12), model: MODEL };
  });

  const { error: insErr } = await supabase.from("panel_votes").insert(votes);
  if (insErr) throw insErr;

  const distribution = Object.fromEntries(candidatesAll.map((c) => [c, mean(votes.map((x) => x.probabilities[c]))]));
  const att = votes.map((x) => x.probabilities[target]);
  const upd = { status: "done", attribution: mean(att), attribution_sd: sd(att), distribution };
  await supabase.from("variants").update(upd).eq("id", variantId);
  return { variant_id: variantId, target, ...upd, n: votes.length };
}

// ---------- finalize ----------
async function finalize(analysisId: string) {
  const { data: a } = await supabase.from("analyses").select("*, ads!inner(*, brands!inner(*))").eq("id", analysisId).single();
  if (!a) throw new Error("Analiza nu există.");
  const target = a.ads.brands.name as string;
  const { data: vs } = await supabase.from("variants").select("*").eq("analysis_id", analysisId).eq("status", "done");
  const base = vs?.find((v) => v.kind === "base");
  if (!base) throw new Error("Rulează întâi varianta de bază (kind = base).");

  const { data: baseVotes } = await supabase.from("panel_votes").select("cues").eq("variant_id", base.id);
  const allCues = (baseVotes ?? []).map((v) => v.cues.map((c: string) => c.toLowerCase()));
  const cueRate = (el: string) => {
    const words = el.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return 0;
    return mean(allCues.map((cs) => (cs.some((c: string) => words.some((w) => c.includes(w.slice(0, 5)))) ? 1 : 0)));
  };

  const impacts = (vs ?? []).filter((v) => v.kind === "ablation" && v.element).map((v) => {
    const delta = base.attribution - v.attribution;
    const pull: Record<string, number> = {};
    for (const [brand, p] of Object.entries(base.distribution as Record<string, number>)) {
      if (brand === target || brand === UNKNOWN) continue;
      pull[brand] = p - ((v.distribution as Record<string, number>)[brand] ?? 0); // >0: elementul trage spre concurent
    }
    const [topBrand, topPull] = Object.entries(pull).sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
    const rate = cueRate(v.element);
    let diagnosis = "neutru";
    if (topPull > T.traitor && topPull > delta) diagnosis = "tradator";
    else if (delta > T.asset) diagnosis = "asset_puternic";
    else if (Math.abs(delta) < T.decor) diagnosis = "decor";
    return { analysis_id: analysisId, element: v.element, delta, pull_shift: pull, cue_rate: rate, diagnosis, _top: [topBrand, topPull] };
  });

  await supabase.from("element_impacts").delete().eq("analysis_id", analysisId);
  if (impacts.length) {
    const { error } = await supabase.from("element_impacts").insert(impacts.map(({ _top, ...r }) => r));
    if (error) throw error;
  }

  const misattribution = Object.fromEntries(
    Object.entries(base.distribution as Record<string, number>).filter(([b]) => b !== target),
  );
  const generated = (vs ?? []).filter((v) => v.kind === "generated").map((v) => ({
    element: v.element, attribution: v.attribution, sd: v.attribution_sd, lift: v.attribution - base.attribution,
  }));
  const summary = {
    target, thresholds: T, model: MODEL, n_evals: a.n_evals, use_memory: a.use_memory,
    attribution: base.attribution, attribution_sd: base.attribution_sd, misattribution,
    generic: a.similarity ? (a.similarity.category_mean ?? 0) > 0.9 : null, similarity: a.similarity,
    elements: impacts.map(({ analysis_id, _top, ...r }) => ({ ...r, top_competitor: _top[0], top_pull: _top[1] })),
    generated,
  };

  const report = await gemini({
    systemInstruction: { parts: [{ text: "Scrii rapoarte scurte de pre-test publicitar, în română, pentru echipe de brand. Folosește DOAR cifrele primite; " +
      "nu inventa valori. Procentele cu 0 zecimale, Δ cu 2 zecimale. Structură: 1) atribuire și cu cine e confundat brandul; " +
      "2) elementele trădătoare și ce se întâmplă fără ele; 3) asset-urile reale; 4) decorul; 5) variantele generate (dacă există); " +
      "6) o recomandare concretă. Maxim 180 de cuvinte, fără titluri markdown și fără asteriscuri." }] },
    contents: [{ role: "user", parts: [{ text: `Metrici (JSON):\n${JSON.stringify(summary)}` }] }],
    generationConfig: { maxOutputTokens: 1500 },
  });

  await supabase.from("analyses").update({ status: "done", summary, report, finished_at: new Date().toISOString(), error: null })
    .eq("id", analysisId);
  return { analysis_id: analysisId, summary, report };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Folosește POST." }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalid." }, 400); }
  try {
    if (body.action === "diag") {
      // diagnostic fără a expune cheia: lungime, prefix, caractere suspecte
      const raw = Deno.env.get("GEMINI_API_KEY") ?? "";
      const k = geminiKey();
      return json({ model: MODEL, raw_length: raw.length, length: k.length, prefix: k.slice(0, 4),
        had_whitespace_or_quotes: raw !== k, non_ascii: /[^\x21-\x7e]/.test(k) });
    }
    if (body.action === "run_variant" && body.variant_id) {
      return json(await runVariant(body.variant_id));
    }
    if (body.action === "finalize" && body.analysis_id) {
      await supabase.from("analyses").update({ status: "running" }).eq("id", body.analysis_id);
      return json(await finalize(body.analysis_id));
    }
    return json({ error: "Acțiune necunoscută. Folosește run_variant sau finalize." }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (body.variant_id) await supabase.from("variants").update({ status: "error" }).eq("id", body.variant_id);
    if (body.analysis_id) await supabase.from("analyses").update({ status: "error", error: msg }).eq("id", body.analysis_id);
    return json({ error: msg }, 500);
  }
});
