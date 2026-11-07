// Edge function „panel” — panelul orb pentru „Fără logo”.
// Acțiuni (POST JSON):
//   { action: "run_variant", variant_id }   rulează n_evals evaluări Gemini vision pe o variantă și salvează voturile
//   { action: "finalize", analysis_id }     calculează Δ, atribuirea greșită și diagnosticul, apoi scrie raportul
// Secret necesar: GEMINI_API_KEY (gratuit din aistudio.google.com/apikey). Opțional: GEMINI_MODEL (implicit gemini-3.5-flash-lite).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as S from "./stats.ts";
import { rebrand, briefFromText } from "./rebrand.ts";

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
// Bucket cu nume neutru: URL-urile cu „/ads/” sunt blocate de extensiile anti-reclame
const BUCKET = "creative";

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
type Img = { mime_type: string; data: string; sha256: string };
const imgCache = new Map<string, Promise<Img>>();
function loadImage(path: string): Promise<Img> {
  if (!imgCache.has(path)) {
    imgCache.set(path, (async () => {
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error(`Nu pot descărca imaginea ${path}`);
      const bytes = new Uint8Array(await data.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { mime_type: data.type || "image/png", data: btoa(bin), sha256: hash };
    })());
  }
  return imgCache.get(path)!;
}
async function inlineImage(path: string) {
  const { mime_type, data } = await loadImage(path);
  return { mime_type, data };
}
// Completează hash-ul reclamelor vechi, încărcate înainte de coloana sha256
async function adHash(ad: { id: string; image_path: string; sha256?: string | null }) {
  if (ad.sha256) return ad.sha256;
  const h = (await loadImage(ad.image_path)).sha256;
  await supabase.from("ads").update({ sha256: h }).eq("id", ad.id);
  return h;
}

// ---------- similaritate (Gemini Embedding 2, multimodal) ----------
const EMBED_MODEL = Deno.env.get("GEMINI_EMBED_MODEL") ?? "gemini-embedding-2";
async function embedImage(path: string, attempt = 0): Promise<number[]> {
  const img = await inlineImage(path);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`, {
    method: "POST",
    headers: { "x-goog-api-key": geminiKey(), "content-type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ inline_data: img }] }, output_dimensionality: 768 }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return embedImage(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Embedding ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j?.embedding?.values ?? j?.embeddings?.[0]?.values ?? [];
}
function cosine(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
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
    const { data: mem } = await supabase.from("ads").select("id,image_path,sha256,brand_id,brands!inner(name,category)")
      .eq("role", "memory").eq("brands.category", analysis.category).neq("id", testAd.id)
      .order("created_at");
    const testHash = await adHash(testAd);
    const perBrand: Record<string, number> = {};
    for (const m of mem ?? []) {
      if ((await adHash(m)) === testHash) continue; // aceeași imagine ca reclama testată → ar strica testul orb
      const n = (m as any).brands.name;
      perBrand[n] = (perBrand[n] ?? 0) + 1;
      if (perBrand[n] > MEMORY_PER_BRAND) continue;
      memory.push({ text: `Reclamă cunoscută — brand: ${n}` });
      memory.push({ inline_data: await inlineImage(m.image_path) });
    }
    if (memory.length) memory.unshift({ text: "Ai văzut în trecut aceste reclame, etichetate cu brandul lor:" });
  }

  // Elementele comune categoriei (ex. la apă: sticla, apa) apar la toți concurenții, deci nu deosebesc brandurile
  const generic: string[] = (analysis.generic_elements ?? []).map((x: string) => x.trim()).filter(Boolean);
  const genericTxt = generic.length ? generic.join(", ") : "produsul în sine și ambalajul tipic al categoriei";
  const system = [
    `ROL: Ești un evaluator dintr-un panel orb de recunoaștere a brandului. Categoria de produs este „${analysis.category}”.`,
    "",
    "CE PRIMEȘTI:",
    memory.length
      ? "- Reclame văzute anterior, fiecare etichetată cu brandul ei. Acestea sunt experiența ta cu brandurile din categorie."
      : "- Nu primești exemple anterioare; folosește doar ce vezi în reclamă.",
    "- O reclamă de evaluat, din care logo-ul și numele brandului au fost acoperite cu dreptunghiuri gri plate.",
    "- O listă închisă de candidați, inclusiv „nu știu”.",
    "",
    "CE FACI:",
    `1. Cauți doar elementele care pot deosebi un brand de altul în categoria „${analysis.category}”: paleta de culori proprie, ` +
      "personaje sau mascote, tipografia, stilul fotografic și decorul, compoziția și layout-ul, forma și designul specific " +
      "al etichetei sau ambalajului (nu simpla prezență a produsului), sloganul și tonul.",
    memory.length
      ? "2. Compari aceste elemente cu reclamele din memorie și cauți potriviri concrete (aceeași culoare, același personaj, același stil)."
      : "2. Judeci doar pe baza elementelor distinctive vizibile.",
    "3. Împarți probabilitatea între candidați; suma trebuie să fie exact 1.",
    "4. Pui la „nu știu” partea pentru care nu ai indicii distinctive. Dacă nu vezi niciun indiciu distinctiv, „nu știu” primește cel puțin 0.6.",
    "5. În „cues” scrii 1–6 indicii scurte (2–4 cuvinte, în română) care ți-au influențat cu adevărat decizia, de ex. „etichetă verde”, „munți înzăpeziți”.",
    "6. În „text_vizibil” copiezi exact orice text lizibil care numește un brand sau un producător, inclusiv textele legale mici " +
      "(„® … marcă înregistrată a …”, adrese web, nume de companii). Dacă nu există, lași lista goală. Acest câmp verifică dacă mascarea a reușit.",
    "",
    "CE NU FACI:",
    `- Nu folosești ca indiciu elementele comune întregii categorii „${analysis.category}”: ${genericTxt}. ` +
      "Ele apar la toți concurenții și nu deosebesc brandurile; nu le treci nici în „cues”.",
    "- Nu încerci să ghicești ce e sub zonele gri și nu tratezi forma, mărimea sau poziția lor ca indiciu.",
    "- Nu folosești la vot textul care numește brandul, chiar dacă e vizibil: îl raportezi doar în „text_vizibil” și votezi ca și cum n-ar exista.",
    "- Nu adaugi branduri care nu sunt în lista de candidați.",
    memory.length
      ? "- Nu te bazezi pe faima brandului sau pe ce știi despre el din afara exemplelor primite; un brand cunoscut nu primește automat mai multă probabilitate."
      : "- Nu dai mai multă probabilitate unui brand doar pentru că e mai cunoscut.",
    "- Nu scrii nimic în afara JSON-ului cerut.",
  ].join("\n");
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
        cues: { type: "array", items: { type: "string" }, description: "1–6 indicii vizuale distinctive, scurte, în română (fără elementele comune categoriei)." },
        text_vizibil: { type: "array", items: { type: "string" }, description: "Text lizibil care numește un brand sau producător; gol dacă nu există." },
      },
      required: ["probabilities", "cues", "text_vizibil"],
  };
  const testImage = { inline_data: await inlineImage(v.image_path) };
  const candidatesAll = [...names, UNKNOWN];

  const votes = await pool(Array.from({ length: analysis.n_evals }, (_, i) => i), CONCURRENCY, async (i) => {
    const order = shuffle(candidatesAll); // amestecăm ordinea la fiecare evaluare (bias de poziție)
    const parts = [
      ...memory,
      { text: `Reclama de evaluat (categoria „${analysis.category}”, logo mascat). Candidați, în această ordine: ${order.map((c) => `„${c}”`).join(", ")}.` },
      testImage,
    ];
    const text = await gemini({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 1024 },
    });
    let input: any = { probabilities: [], cues: [], text_vizibil: [] };
    let valid = true;
    try { input = JSON.parse(text.replace(/^```(json)?|```$/g, "")); } catch { valid = false; /* vot invalid → „nu știu” */ }
    const probs: Record<string, number> = Object.fromEntries(candidatesAll.map((c) => [c, 0]));
    for (const { brand, p } of input.probabilities ?? []) {
      const key = candidatesAll.find((c) => c.toLowerCase() === String(brand).trim().toLowerCase());
      if (key && Number.isFinite(p) && p > 0) probs[key] += p;
    }
    const total = Object.values(probs).reduce((s, x) => s + x, 0);
    if (total > 0) for (const k in probs) probs[k] /= total; else { probs[UNKNOWN] = 1; valid = false; }
    return { variant_id: variantId, eval_index: i, candidate_order: order, probabilities: probs, valid,
      cues: (input.cues ?? []).slice(0, 12), visible_text: (input.text_vizibil ?? []).map(String).slice(0, 8), model: MODEL };
  });

  const { error: insErr } = await supabase.from("panel_votes").insert(votes);
  if (insErr) throw insErr;

  const distribution = Object.fromEntries(candidatesAll.map((c) => [c, mean(votes.map((x) => x.probabilities[c]))]));
  const att = votes.map((x) => x.probabilities[target]);
  const upd = { status: "done", attribution: mean(att), attribution_sd: sd(att), distribution };
  await supabase.from("variants").update(upd).eq("id", variantId);
  return { variant_id: variantId, target, ...upd, n: votes.length };
}

async function computeSimilarity(a: any, base: any, target: string) {
  imgCache.clear();
  const { data: ads } = await supabase.from("ads").select("id,image_path,sha256,embedding,brands!inner(name,category)")
    .eq("brands.category", a.category);
  const testHash = await adHash(a.ads);
  await pool(ads ?? [], 3, async (x: any) => { x.sha256 = await adHash(x); });
  const pool_ = (ads ?? []).filter((x: any) => x.id !== a.ad_id && x.sha256 !== testHash);
  // embeddings cache-uite pe reclamă
  await pool(pool_, 3, async (x: any) => {
    if (x.embedding?.length) return;
    x.embedding = await embedImage(x.image_path);
    await supabase.from("ads").update({ embedding: x.embedding }).eq("id", x.id);
  });
  const baseEmb = base.embedding?.length ? base.embedding : await embedImage(base.image_path);
  if (!base.embedding?.length) await supabase.from("variants").update({ embedding: baseEmb }).eq("id", base.id);

  const byBrand: Record<string, number[]> = {};
  for (const x of pool_ as any[]) (byBrand[x.brands.name] ??= []).push(cosine(baseEmb, x.embedding));
  const per_brand = Object.fromEntries(Object.entries(byBrand).map(([b, xs]) => [b, mean(xs)]));
  const competitors = Object.entries(per_brand).filter(([b]) => b !== target).sort((x, y) => y[1] - x[1]);
  const compSims = (pool_ as any[]).filter((x) => x.brands.name !== target).map((x) => cosine(baseEmb, x.embedding));
  // „tipic” = cât de asemănătoare sunt în medie reclamele din categorie între ele
  const pair: number[] = [];
  for (let i = 0; i < pool_.length; i++) for (let j = i + 1; j < pool_.length; j++)
    pair.push(cosine((pool_[i] as any).embedding, (pool_[j] as any).embedding));
  const typical = pair.length ? mean(pair) : null;
  const own = per_brand[target] ?? null;
  const [nearestBrand, nearest] = competitors[0] ?? [null, null];
  const category_mean = compSims.length ? mean(compSims) : null;
  return {
    model: EMBED_MODEL, per_brand, own_brand: own, nearest_brand: nearestBrand, nearest,
    category_mean, typical, distinctiveness: own != null && nearest != null ? own - nearest : null,
    // reclamă generică: seamănă cu concurența mai mult decât seamănă de obicei reclamele din categorie între ele,
    // sau seamănă mai mult cu un concurent decât cu propriul brand
    generic: category_mean != null && typical != null
      ? category_mean > typical || (own != null && nearest != null && nearest > own) : null,
    n_ads: pool_.length,
  };
}

// Mută o singură dată imaginile din vechiul bucket „ads” în „creative” (cale „ads/…” → „img/…”)
async function migrateStorage() {
  const moved: string[] = [], failed: string[] = [];
  for (const table of ["ads", "variants"] as const) {
    const { data: rows } = await supabase.from(table).select("id,image_path");
    for (const r of rows ?? []) {
      const { data: blob } = await supabase.storage.from("ads").download(r.image_path);
      if (!blob) continue; // deja mutată
      const newPath = r.image_path.startsWith("ads/") ? "img/" + r.image_path.slice(4) : r.image_path;
      const up = await supabase.storage.from(BUCKET).upload(newPath, blob, { contentType: blob.type || "image/jpeg", upsert: true });
      if (up.error) { failed.push(`${r.image_path}: ${up.error.message}`); continue; }
      await supabase.from(table).update({ image_path: newPath }).eq("id", r.id);
      moved.push(newPath);
    }
  }
  return { moved: moved.length, failed };
}

// ---------- finalize: analiză statistică + raport ----------
// Design: fiecare variantă (bază, fără element X, generată) e evaluată de n evaluatori independenți (cereri separate,
// ordinea candidaților randomizată). Variabila dependentă = probabilitatea acordată brandului corect de un evaluator.
const ALPHA = 0.05;
async function finalize(analysisId: string) {
  const { data: a } = await supabase.from("analyses").select("*, ads!inner(*, brands!inner(*))").eq("id", analysisId).single();
  if (!a) throw new Error("Analiza nu există.");
  const target = a.ads.brands.name as string;
  const { data: vs } = await supabase.from("variants").select("*").eq("analysis_id", analysisId).eq("status", "done").order("created_at");
  const base = vs?.find((v) => v.kind === "base");
  if (!base) throw new Error("Rulează întâi varianta de bază (kind = base).");

  const { data: allVotes } = await supabase.from("panel_votes").select("variant_id,probabilities,cues,valid,visible_text")
    .in("variant_id", (vs ?? []).map((v) => v.id));
  const votesOf = (id: string) => (allVotes ?? []).filter((x) => x.variant_id === id);
  const shareOf = (id: string, brand: string) => votesOf(id).map((x) => (x.probabilities as Record<string, number>)[brand] ?? 0);
  const baseVotes = votesOf(base.id);
  const baseAtt = shareOf(base.id, target);
  const brandsAll = Object.keys(base.distribution ?? {}).filter((b) => b !== UNKNOWN);
  const competitors = brandsAll.filter((b) => b !== target);
  const chance = brandsAll.length ? 1 / brandsAll.length : null;

  // ---- 1. Profilul datelor (diagnostic înainte de analiză) ----
  const nTotal = (allVotes ?? []).length, nInvalid = (allVotes ?? []).filter((x) => !x.valid).length;
  const top1 = baseVotes.filter((x) => {
    const p = x.probabilities as Record<string, number>;
    return Object.entries(p).sort((u, w) => w[1] - u[1])[0]?.[0] === target;
  }).length;
  const unk = shareOf(base.id, UNKNOWN);
  const entropy = S.mean(baseVotes.map((x) => S.normEntropy(x.probabilities as Record<string, number>)));
  // Verificarea mascării: evaluatorii raportează textul lizibil care numește un brand
  const brandNames = brandsAll.map((b) => b.toLowerCase());
  const leakVotes = baseVotes.filter((x) => (x.visible_text ?? []).some((t: string) => brandNames.some((b) => t.toLowerCase().includes(b))));
  const leakTexts = [...new Set(baseVotes.flatMap((x) => x.visible_text ?? []))].slice(0, 5);
  const leakRate = baseVotes.length ? leakVotes.length / baseVotes.length : 0;
  // Câte reclame de memorie a avut fiecare brand (după excluderea duplicatelor reclamei testate)
  const memory_per_brand: Record<string, number> = {};
  if (a.use_memory) {
    const { data: mem } = await supabase.from("ads").select("id,sha256,brands!inner(name,category)")
      .eq("role", "memory").eq("brands.category", a.category).neq("id", a.ad_id);
    for (const b of brandsAll) memory_per_brand[b] = 0;
    for (const m of mem ?? []) if (m.sha256 !== a.ads.sha256) memory_per_brand[(m as any).brands.name] = Math.min(MEMORY_PER_BRAND, (memory_per_brand[(m as any).brands.name] ?? 0) + 1);
  }
  const sdBase = S.sd(baseAtt);
  const nPer = baseAtt.length;
  const alerts: { level: "critic" | "atentie" | "ok"; text: string }[] = [];
  if (leakRate >= 0.3) alerts.push({ level: "critic", text: `Mascare incompletă: ${Math.round(leakRate * 100)}% dintre evaluatori au citit un text care numește brandul (${leakTexts.join("; ")}). Rezultatul de atribuire nu e valid până nu acoperi și acest text.` });
  else if (leakVotes.length) alerts.push({ level: "atentie", text: `Unii evaluatori (${leakVotes.length}/${baseVotes.length}) au raportat text lizibil cu numele unui brand: ${leakTexts.join("; ")}.` });
  if (a.use_memory) for (const [b, n] of Object.entries(memory_per_brand)) if (n < 2) alerts.push({ level: "atentie", text: `${b} are doar ${n} reclame de memorie (recomandat 3–5); panelul îl poate recunoaște mai greu, iar comparația devine dezechilibrată.` });
  if (nInvalid) alerts.push({ level: "atentie", text: `${nInvalid} din ${nTotal} voturi au fost invalide și au fost tratate ca „nu știu”.` });
  if (nPer < 20) alerts.push({ level: "atentie", text: `Eșantion mic (n = ${nPer} evaluări pe variantă): efectul minim detectabil e ≈ ${Math.round(S.mde(Math.max(sdBase, 0.05), nPer) * 100)} puncte procentuale; diferențele mai mici pot exista, dar nu pot fi confirmate.` });
  if (!alerts.length) alerts.push({ level: "ok", text: "Nicio problemă de calitate a datelor detectată." });

  // ---- 2. Atribuirea pe fiecare variantă: medie, IC 95% bootstrap ----
  const variantStats = (vs ?? []).map((v, i) => {
    const xs = shareOf(v.id, target);
    const ci = S.bootCI(xs, 4000, 1000 + i);
    return { id: v.id, kind: v.kind, element: v.element, n: xs.length, mean: S.mean(xs), sd: S.sd(xs), ci,
      above_chance: chance != null && Number.isFinite(ci[0]) ? ci[0] > chance : null };
  });
  const baseStat = variantStats.find((x) => x.id === base.id)!;

  // ---- 3. Ablație: Δ = bază − fără element; test de permutare, IC bootstrap, Hedges g, corecție Holm ----
  const abl = (vs ?? []).filter((v) => v.kind === "ablation" && v.element);
  const raw = abl.map((v, i) => {
    const xs = shareOf(v.id, target);
    const pulls = competitors.map((c) => ({ c, d: S.mean(shareOf(base.id, c)) - S.mean(shareOf(v.id, c)),
      p: S.permTest(shareOf(base.id, c), shareOf(v.id, c), 5000, 300 + i) }));
    const top = pulls.sort((x, y) => y.d - x.d)[0] ?? { c: null, d: 0, p: NaN };
    return { v, xs, delta: S.mean(baseAtt) - S.mean(xs), ci: S.bootDiffCI(baseAtt, xs, 4000, 500 + i),
      p: S.permTest(baseAtt, xs, 5000, 700 + i), g: S.hedgesG(baseAtt, xs), top, pulls };
  });
  const pAdj = S.holm(raw.map((r) => r.p));
  const pPullAdj = S.holm(raw.map((r) => r.top.p));
  const allCues = baseVotes.map((v) => (v.cues ?? []).map((c: string) => c.toLowerCase()));
  const cueRate = (el: string) => {
    const words = el.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return 0;
    return S.mean(allCues.map((cs) => (cs.some((c: string) => words.some((w) => c.includes(w.slice(0, 5)))) ? 1 : 0)));
  };
  const impacts = raw.map((r, i) => {
    const sig = pAdj[i] < ALPHA, pullSig = pPullAdj[i] < ALPHA;
    let diagnosis = "neutru";
    if (r.top.d > T.traitor && pullSig && r.top.d > r.delta) diagnosis = "tradator";
    else if (r.delta > T.asset && sig) diagnosis = "asset_puternic";
    else if (Math.abs(r.delta) < T.decor && r.ci[0] <= 0 && r.ci[1] >= 0) diagnosis = "decor";
    else if (!sig && Math.abs(r.delta) >= T.decor) diagnosis = "neconcludent";
    const pull_shift = Object.fromEntries(r.pulls.map((x) => [x.c, x.d]));
    return {
      analysis_id: analysisId, element: r.v.element, delta: r.delta, pull_shift, cue_rate: cueRate(r.v.element), diagnosis,
      stats: { n_base: baseAtt.length, n_variant: r.xs.length, mean_variant: S.mean(r.xs), ci: r.ci, p: r.p, p_holm: pAdj[i],
        g: r.g, effect: S.effectLabel(r.g), top_competitor: r.top.c, top_pull: r.top.d, p_pull_holm: pPullAdj[i] },
    };
  });
  await supabase.from("element_impacts").delete().eq("analysis_id", analysisId);
  if (impacts.length) {
    const { error } = await supabase.from("element_impacts").insert(impacts);
    if (error) throw error;
  }

  // ---- 4. Variante generate: lift față de bază ----
  const gen = (vs ?? []).filter((v) => v.kind === "generated");
  const genRaw = gen.map((v, i) => {
    const xs = shareOf(v.id, target);
    return { element: v.element, mean: S.mean(xs), lift: S.mean(xs) - S.mean(baseAtt), ci: S.bootDiffCI(xs, baseAtt, 4000, 900 + i),
      p: S.permTest(xs, baseAtt, 5000, 1100 + i), g: S.hedgesG(xs, baseAtt) };
  });
  const genAdj = S.holm(genRaw.map((x) => x.p));
  const generated = genRaw.map((x, i) => ({ ...x, p_holm: genAdj[i], effect: S.effectLabel(x.g) }));

  // ---- 5. Similaritate vizuală ----
  let similarity = a.similarity ?? null;
  try { similarity = await computeSimilarity(a, base, target); } catch (e) {
    similarity = { error: e instanceof Error ? e.message : String(e) };
  }

  const confusion = Object.fromEntries(competitors.map((c) => {
    const xs = shareOf(base.id, c);
    return [c, { mean: S.mean(xs), ci: S.bootCI(xs, 4000, 1300 + competitors.indexOf(c)) }];
  }));
  const summary = {
    version: 2, target, category: a.category, generic_elements: a.generic_elements ?? [], model: MODEL,
    thresholds: { ...T, alpha: ALPHA }, use_memory: a.use_memory, n_evals: a.n_evals,
    methods: {
      ci: "bootstrap percentile, 4000 reeșantionări", test: "test de permutare bilateral, 5000 permutări",
      multiple: "corecție Holm pe familia de elemente", effect: "Hedges g", proportion: "interval Wilson",
    },
    profile: {
      n_per_variant: nPer, n_variants: (vs ?? []).length, n_votes: nTotal, n_invalid: nInvalid,
      candidates: brandsAll.length, chance, unknown_mean: S.mean(unk), entropy_mean: entropy,
      top1_agreement: { k: top1, n: baseVotes.length, rate: baseVotes.length ? top1 / baseVotes.length : null, ci: S.wilson(top1, baseVotes.length) },
      mde: S.mde(Math.max(sdBase, 0.05), nPer), memory_per_brand, leak: { rate: leakRate, texts: leakTexts },
    },
    alerts,
    attribution: baseStat.mean, attribution_sd: baseStat.sd, attribution_ci: baseStat.ci, above_chance: baseStat.above_chance,
    confusion, misattribution: Object.fromEntries(Object.entries(base.distribution ?? {}).filter(([b]) => b !== target)),
    variants: variantStats.map(({ id, ...x }) => x),
    elements: impacts.map(({ analysis_id, ...x }) => x),
    generated, generic: similarity?.generic ?? null, similarity,
  };

  // ---- 6. Raportul: Gemini scrie ca un statistician, doar din cifrele de mai sus ----
  const reportSchema = {
    type: "object",
    properties: {
      sinteza: { type: "string" }, variabile: { type: "string" }, metoda: { type: "string" },
      rezultate: { type: "string" }, verificari: { type: "string" }, limite: { type: "string" }, recomandare: { type: "string" },
    },
    required: ["sinteza", "variabile", "metoda", "rezultate", "verificari", "limite", "recomandare"],
  };
  const reportSystem = [
    "ROL: Ești un statistician experimentat în cercetare de marketing și pre-testare publicitară.",
    "Scrii, în română, pentru o echipă de brand care nu e specializată în statistică: riguros, dar clar.",
    "",
    "REGULI:",
    "- Folosești DOAR cifrele din JSON. Nu inventezi valori, teste sau eșantioane.",
    "- Procente fără zecimale (ex. 31%), Δ și Hedges g cu 2 zecimale, p cu 3 zecimale în stil APA (p = .032, p < .001).",
    "- Intervalele le scrii „IC 95% [a%, b%]”. Semnificația o judeci pe p_holm, nu pe p brut.",
    "- Un efect nesemnificativ nu înseamnă „fără efect”: spui că datele nu pot confirma efectul și menționezi efectul minim detectabil (profile.mde).",
    "- Dacă există o alertă de nivel „critic”, o pui prima în „sinteza” și spui clar că rezultatul de atribuire nu e valid.",
    "- Nu recomanzi schimbarea elementelor comune categoriei (generic_elements).",
    "- Fără markdown, fără asteriscuri, fără titluri; fiecare câmp e un paragraf scurt (maxim 90 de cuvinte).",
    "",
    "CE SCRII ÎN FIECARE CÂMP:",
    "- sinteza: concluzia principală și cât de sigură e (2–3 propoziții).",
    "- variabile: variabila dependentă (atribuirea = probabilitatea acordată brandului corect de fiecare evaluator), " +
      "variabilele manipulate (fiecare element scos și variantele generate), variabilele de control (logo mascat identic, " +
      "ordinea candidaților randomizată, memoria însămânțată, elementele comune categoriei ignorate) și măsurile secundare " +
      "(confuzia cu fiecare concurent, „nu știu”, acordul evaluatorilor, similaritatea vizuală).",
    "- metoda: designul (variante independente, n evaluări pe variantă) și testele din „methods”, cu o propoziție despre de ce sunt potrivite pentru n mic și date mărginite.",
    "- rezultate: atribuirea de bază cu IC și comparația cu nivelul șansei (chance); confuzia principală; fiecare element cu Δ, IC, p_holm, g și diagnostic; variantele generate.",
    "- verificari: calitatea datelor din „alerts” și „profile” (mascare, voturi invalide, memorie pe brand, acordul evaluatorilor).",
    "- limite: ce nu pot spune aceste date (panel AI, nu oameni; eșantion; putere statistică).",
    "- recomandare: 1–2 acțiuni concrete pe elementele distinctive, în ordinea priorității.",
  ].join("\n");
  const reportText = await gemini({
    systemInstruction: { parts: [{ text: reportSystem }] },
    contents: [{ role: "user", parts: [{ text: `Rezultate (JSON):\n${JSON.stringify(summary)}` }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: reportSchema, maxOutputTokens: 3000 },
  });
  let report = reportText;
  try { report = JSON.stringify(JSON.parse(reportText.replace(/^```(json)?|```$/g, ""))); } catch { /* păstrăm textul brut */ }

  await supabase.from("analyses").update({ status: "done", summary, similarity, report, finished_at: new Date().toISOString(), error: null })
    .eq("id", analysisId);
  return { analysis_id: analysisId, summary, report };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Folosește POST." }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON invalid." }, 400); }
  // Doar membrii echipei (tabela team_members) pot porni analize
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await supabase.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  const { data: member } = email
    ? await supabase.from("team_members").select("email").eq("email", email).maybeSingle()
    : { data: null };
  if (!member) return json({ error: "Acces doar pentru echipă. Autentifică-te în aplicație." }, 401);
  try {
    if (body.action === "diag") {
      // diagnostic fără a expune cheia: lungime, prefix, caractere suspecte
      const raw = Deno.env.get("GEMINI_API_KEY") ?? "";
      const k = geminiKey();
      return json({ model: MODEL, raw_length: raw.length, length: k.length, prefix: k.slice(0, 4),
        had_whitespace_or_quotes: raw !== k, non_ascii: /[^\x21-\x7e]/.test(k) });
    }
    if (body.action === "migrate_storage") return json(await migrateStorage());
    if (body.action === "brief_from_text") {
      return json(await briefFromText({ supabase, gemini, inlineImage, geminiKey, bucket: BUCKET }, body.text ?? "", body.brand ?? "brand"));
    }
    if (body.action === "rebrand" && body.analysis_id) {
      return json(await rebrand({ supabase, gemini, inlineImage, geminiKey, bucket: BUCKET },
        body.analysis_id, body.brief ?? {}, !!body.images, email!));
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
    if (body.action === "run_variant" && body.variant_id) await supabase.from("variants").update({ status: "error" }).eq("id", body.variant_id);
    if (body.action === "finalize" && body.analysis_id) await supabase.from("analyses").update({ status: "error", error: msg }).eq("id", body.analysis_id);
    return json({ error: msg }, 500);
  }
});
