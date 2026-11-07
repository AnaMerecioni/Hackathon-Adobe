// Rebranding asistat: pornește de la rezultatele analizei (similaritate, confuzie, elemente) și de la brief-ul
// utilizatorului, și propune 3 direcții vizuale care îndepărtează reclama de concurentul cel mai apropiat.
// Opțional generează câte o imagine pe direcție (Pollinations: editare cu cheie, FLUX gratuit fără cheie), ca să poată fi retestată în panel.

import * as S from "./stats.ts";

type Deps = {
  supabase: any;
  gemini: (body: Record<string, unknown>) => Promise<string>;
  inlineImage: (path: string) => Promise<{ mime_type: string; data: string }>;
  geminiKey: () => string;
  bucket: string;
};

// Întrebările de identitate de brand (toate opționale)
export const BRIEF_FIELDS: Record<string, string> = {
  promisiune: "Ce promite brandul, într-o propoziție",
  valori: "Cele 3 valori ale brandului",
  personalitate: "Dacă brandul ar fi un om, cum ar fi (prietenos, premium, jucăuș, de încredere, aventuros, rebel, cald, minimalist)",
  ton: "Tonul comunicării (serios, cald, amuzant etc.)",
  pastreaza: "Activele care trebuie păstrate (culoare, mascotă, formă, slogan)",
  evita: "Ce trebuie evitat (culori, stiluri, asocieri)",
  constrangeri: "Constrângeri (ghid de brand, legal, buget de producție)",
  obiectiv: "Obiectivul rebrandingului (diferențiere de concurent, modernizare, premium, public mai tânăr)",
  public: "Publicul țintă",
  curaj: "Cât de curajos poate fi rebrandingul (ajustare fină, echilibrat, schimbare totală)",
};
export type Brief = Partial<Record<keyof typeof BRIEF_FIELDS, string>>;

/** Interviu de brand: transformă textul liber (dictat sau scris) în răspunsurile formularului. */
export async function briefFromText(d: Deps, text: string, brand: string) {
  const t = clip(text, 6000);
  if (t.length < 10) throw new Error("Spune sau scrie câteva propoziții despre brand.");
  const schema = { type: "object", properties: Object.fromEntries(Object.entries(BRIEF_FIELDS).map(([k, v]) =>
    [k, { type: "string", description: v }])), required: Object.keys(BRIEF_FIELDS) };
  const out = await d.gemini({
    systemInstruction: { parts: [{ text: [
      "Ești strateg de brand. Primești transcrierea unui interviu despre brandul „" + brand + "” (vorbire liberă, poate avea greșeli de dictare).",
      "Extragi răspunsurile pentru fiecare câmp, în română, scurt și concret.",
      "Reguli: folosești doar ce a spus omul; dacă un câmp nu reiese din text, îl lași gol (\"\"); nu inventezi; corectezi doar greșelile evidente de dictare.",
    ].join("\n") }] },
    contents: [{ role: "user", parts: [{ text: t }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 1500 },
  });
  try { return JSON.parse(out.replace(/^```(json)?|```$/g, "")); } catch { throw new Error("Nu am putut extrage răspunsurile. Încearcă din nou."); }
}

/** Completează brief-ul din surse publice: Gemini cu Google Search. Întoarce câmpurile + sursele găsite. */
export async function briefFromWeb(d: Deps & { geminiRaw: (body: Record<string, unknown>) => Promise<any> }, brand: string, category: string) {
  const b = clip(brand, 80), cat = clip(category, 60);
  if (!b) throw new Error("Lipsește numele brandului.");
  const keys = Object.keys(BRIEF_FIELDS);
  const j = await d.geminiRaw({
    systemInstruction: { parts: [{ text: [
      "Ești strateg de brand. Cauți pe internet informații publice despre brandul indicat (site oficial, comunicate, campanii, articole).",
      "Completezi, în română, scurt și concret, câmpurile unui brief de brand. Reguli:",
      "- folosești doar ce găsești în surse; dacă nu găsești ceva, lași câmpul gol (\"\"); nu inventezi;",
      "- „pastreaza”: activele vizuale și verbale cunoscute ale brandului (culori, logo, mascotă, slogan);",
      "- „evita”: doar dacă reiese clar din poziționare (de ex. codurile concurenților principali);",
      "- „constrangeri” și „curaj” le lași goale (le decide echipa);",
      "- răspunzi DOAR cu un obiect JSON cu cheile: " + keys.join(", ") + ".",
    ].join("\n") }] },
    contents: [{ role: "user", parts: [{ text: `Brand: ${b}${cat ? ` (categoria: ${cat}, România)` : ""}` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.2 },
  });
  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  let out: Record<string, string> = {};
  try { out = m ? JSON.parse(m[0]) : {}; } catch { throw new Error("Nu am putut citi informațiile găsite. Încearcă din nou."); }
  const clean = Object.fromEntries(keys.map((k) => [k, clip(out[k], 300)]));
  clean.constrangeri = ""; clean.curaj = "";
  const surse = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: any) => c.web).filter((w: any) => w?.uri)
    .map((w: any) => ({ url: w.uri, titlu: clip(w.title, 80) })).slice(0, 6);
  return { ...clean, surse };
}

const clip = (s: unknown, n = 400) => String(s ?? "").slice(0, n).trim();
const POLL_KEY = () => (Deno.env.get("POLLINATIONS_KEY") ?? "").trim();
const EDIT_MODEL = Deno.env.get("POLLINATIONS_EDIT_MODEL") ?? "black-forest-labs/flux-3-image-klein";

// Dimensiunile unui PNG din antetul IHDR (variantele de bază sunt PNG), ca imaginea nouă să păstreze formatul
function pngSize(b64: string): [number, number] | null {
  try {
    const bin = atob(b64.slice(0, 64));
    if (!bin.startsWith("\x89PNG")) return null;
    const u = (i: number) => (bin.charCodeAt(i) << 24) | (bin.charCodeAt(i + 1) << 16) | (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
    return [u(16), u(20)];
  } catch { return null; }
}
function fitSize(size: [number, number] | null): [number, number] {
  const [w, h] = size ?? [1024, 1024], k = 1024 / Math.max(w, h);
  return [Math.round((w * k) / 16) * 16, Math.round((h * k) / 16) * 16];
}

/** Generează imaginea unei direcții. Cu POLLINATIONS_KEY editează reclama originală; fără cheie, FLUX desenează după descriere. */
async function generateImage(baseUrl: string, size: [number, number], prompt: string, seed: number) {
  const [w, h] = fitSize(size);
  const negative = " No logos, no brand names, no watermarks. Any headline text must be exactly the quoted text.";
  const key = POLL_KEY();
  const url = key
    ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt + negative)}?model=${encodeURIComponent(EDIT_MODEL)}` +
      `&image=${encodeURIComponent(baseUrl)}&width=${w}&height=${h}&seed=${seed}&key=${encodeURIComponent(key)}`
    : `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + negative)}?model=flux&width=${w}&height=${h}` +
      `&seed=${seed}&nologo=true&private=true&enhance=false`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image")) {
    const body = await res.text();
    // limita gratuită: „1 image every 45 seconds per IP. Retry after 42s”
    const wait = /FREE_LIMIT|Retry after/i.test(body) ? Number(body.match(/Retry after (\d+)/i)?.[1] ?? 45) : 0;
    throw Object.assign(new Error(`Imagine ${res.status}: ${body.slice(0, 200)}`), { retryAfter: wait });
  }
  return { mime: type, bytes: new Uint8Array(await res.arrayBuffer()), source: key ? `editare AI (${EDIT_MODEL.split("/").pop()})` : "AI · FLUX" };
}

export async function rebrand(d: Deps, analysisId: string, briefIn: Brief, wantImages: boolean, email: string) {
  const brief: Brief = Object.fromEntries(Object.entries(briefIn ?? {}).map(([k, v]) => [k, clip(v)])) as Brief;
  const { data: a } = await d.supabase.from("analyses").select("*, ads!inner(*, brands!inner(*))").eq("id", analysisId).single();
  if (!a?.summary) throw new Error("Analiza nu are încă rezultate.");
  const s = a.summary, target = a.ads.brands.name as string;
  const { data: base } = await d.supabase.from("variants").select("image_path").eq("analysis_id", analysisId).eq("kind", "base").single();
  if (!base) throw new Error("Lipsește varianta de bază.");

  // Cu cine seamănă: concurentul cel mai apropiat vizual, altfel cel cu care e confundat cel mai des
  const conf = Object.entries(s.confusion ?? {}).sort((x: any, y: any) => y[1].mean - x[1].mean)[0]?.[0] ?? null;
  const rival = s.similarity?.nearest_brand ?? conf;
  const parts: any[] = [{ text: "Reclama analizată (logo mascat cu gri):" }, { inline_data: await d.inlineImage(base.image_path) }];
  for (const [brand, label] of [[rival, "concurentului cu care seamănă"], [target, "brandului propriu"]] as const) {
    if (!brand) continue;
    const { data: ex } = await d.supabase.from("ads").select("image_path,brands!inner(name,category)")
      .eq("role", "memory").eq("brands.name", brand).eq("brands.category", a.category).neq("id", a.ad_id).limit(2);
    if (ex?.length) parts.push({ text: `Exemple de reclame ale ${label} (${brand}):` });
    for (const e of ex ?? []) parts.push({ inline_data: await d.inlineImage(e.image_path) });
  }

  // Ce a funcționat înainte: elementele diagnosticate „asset_puternic” în alte analize ale aceluiași brand
  const { data: wins } = await d.supabase.from("element_impacts")
    .select("element,delta,diagnosis,analyses!inner(id,ads!inner(brand_id))")
    .eq("analyses.ads.brand_id", a.ads.brand_id).in("diagnosis", ["asset_puternic"]).order("delta", { ascending: false }).limit(8);
  const merged = [...new Map((wins ?? []).map((w: any) => [w.element.toLowerCase(), { element: w.element, delta: w.delta }])).values()];
  const facts = {
    a_functionat_in_alte_reclame: merged,
    brand: target, categorie: a.category, elemente_comune_categoriei: s.generic_elements ?? [],
    recunoastere: s.attribution, confuzie: s.confusion, concurent_apropiat: rival,
    similaritate: s.similarity ? { per_brand: s.similarity.per_brand, tipic: s.similarity.typical, generica: s.similarity.generic } : null,
    elemente: (s.elements ?? []).map((e: any) => ({ element: e.element, diagnostic: e.diagnosis, delta: e.delta, atrage_spre: e.stats?.top_competitor })),
  };
  const system = [
    "ROL: Ești director de creație și strateg de brand, specializat în active distinctive de brand (metoda Ehrenberg-Bass).",
    "Sarcina: propui un rebranding vizual al reclamei, ca să nu mai semene cu concurența și să fie atribuită corect brandului.",
    "",
    "CE FACI:",
    "1. Pornești de la date: cu cine seamănă reclama, ce elemente sunt asset-uri (le păstrezi și le amplifici) și ce elemente sunt trădătoare (le schimbi).",
    "2. Compari vizual reclama cu exemplele concurentului și numești concret codurile comune (culori, compoziție, tip de imagine, tipografie).",
    "3. Respecți identitatea de brand din brief: promisiunea, valorile, personalitatea, tonul, activele de păstrat, ce trebuie evitat, " +
      "constrângerile, obiectivul, publicul și nivelul de curaj. Fiecare direcție trebuie să exprime promisiunea și personalitatea brandului.",
    "4. Propui exact 3 direcții, cu niveluri clare de schimbare față de reclama originală:",
    "   - „sigur”: păstrezi produsul (sticla/ambalajul) ȘI fundalul/scena; schimbi paleta de culori, lumina și textul.",
    "   - „echilibrat”: păstrezi produsul (sticla/ambalajul); schimbi fundalul, scena, compoziția, paleta și textul.",
    "   - „curajos”: schimbi și designul produsului (forma etichetei, culoarea ambalajului, materialul), plus scena, compoziția și textul; " +
      "rămân doar activele cerute de utilizator. Dacă brief-ul cere o ajustare fină, „curajos” rămâne totuși recognoscibil.",
    "5. Reutilizezi ce a mers: elementele din „a_functionat_in_alte_reclame” și codurile vizuale proprii din exemplele brandului; " +
      "le recombini diferit în fiecare direcție și scrii în „imprumutat” ce ai preluat. Nu copiezi nimic de la concurent.",
    "6. Creezi o mascotă originală a brandului (personaj simplu, prietenos, legat de promisiune și categorie, NU o sticlă cu ochi și nu personajul vreunui concurent) " +
      "și o desenezi ca SVG: viewBox=\"0 0 200 200\", doar forme simple (path, circle, ellipse, rect, polygon), fără text, fără imagini, fără script, fără gradient. " +
      "Folosești DOAR aceste 4 culori, care vor fi înlocuite cu paleta fiecărei direcții: #111111 (contur și detalii), #AA0000 (culoarea principală), " +
      "#00AA00 (culoarea secundară), #FFFFFF (alb, ochi și lumini). Maxim 3000 de caractere.",
    "7. Localizezi în reclama analizată, pe o scară 0–1000 (ymin, xmin, ymax, xmax): produsul principal (cutia strânsă în jurul lui) " +
      "și fiecare bloc de text mare (headline, slogan), ca să poată fi montat un layout nou fără textul vechi.",
    "8. Pentru fiecare direcție scrii un text nou de reclamă (headline scurt, în română, fără numele brandului) care exprimă promisiunea brandului.",
    "9. Pentru fiecare direcție scrii „prompt_imagine” în ENGLEZĂ, 70–130 de cuvinte, ca descriere completă a reclamei noi pentru un generator de imagini: " +
      "descrii precis elementele păstrate exact cum arată în original (formă, culoare, material, poziție), apoi ce e nou (scenă, lumină, paletă cu culorile direcției, " +
      "compoziție, stil fotografic) și headline-ul nou între ghilimele. Fără nume de brand, fără logo-uri.",
    "",
    "CE NU FACI:",
    "- Nu schimbi elementele comune categoriei (ele sunt obligatorii și nu deosebesc brandurile).",
    "- Nu copiezi codurile vizuale ale concurentului și nu propui culori sau stiluri pe care le folosește deja.",
    "- Nu elimini un element marcat „asset_puternic” și nu ignori ce a cerut utilizatorul să păstreze.",
    "- Nu inventezi cifre: folosești doar datele primite.",
    "- Nu folosești markdown în texte.",
  ].join("\n");
  const schema = {
    type: "object",
    properties: {
      diagnostic: { type: "string", description: "2–3 propoziții: de ce seamănă reclama cu concurentul, pe coduri vizuale concrete." },
      coduri_comune: { type: "array", items: { type: "string" }, description: "Codurile vizuale comune cu concurentul." },
      pastrezi: { type: "array", items: { type: "string" } },
      schimbi: { type: "array", items: { type: "string" } },
      paleta: { type: "array", items: { type: "object", properties: {
        hex: { type: "string" }, nume: { type: "string" }, rol: { type: "string" } }, required: ["hex", "nume", "rol"] } },
      directii: { type: "array", items: { type: "object", properties: {
        titlu: { type: "string" }, risc: { type: "string", enum: ["sigur", "echilibrat", "curajos"] },
        descriere: { type: "string" }, de_ce_distinct: { type: "string" },
        legatura_cu_identitatea: { type: "string", description: "Cum exprimă promisiunea și personalitatea brandului." },
        culori: { type: "array", items: { type: "string" }, description: "3–4 culori hex ale direcției, ordonate de la cea mai închisă la cea mai deschisă, diferite de ale concurentului." },
        pastrat: { type: "array", items: { type: "string" }, description: "Ce rămâne neschimbat din reclama originală." },
        schimbat: { type: "array", items: { type: "string" }, description: "Ce se schimbă concret." },
        text_nou: { type: "string", description: "Headline-ul nou, în română, fără numele brandului, maxim 6 cuvinte." },
        imprumutat: { type: "array", items: { type: "string" }, description: "Ce preia din reclamele care au funcționat ale brandului." },
        prompt_imagine: { type: "string", description: "Descriere completă în engleză pentru generatorul de imagini." } },
        required: ["titlu", "risc", "descriere", "de_ce_distinct", "legatura_cu_identitatea", "culori", "pastrat", "schimbat", "text_nou", "imprumutat", "prompt_imagine"] } },
      mascota: { type: "object", properties: {
        nume: { type: "string" }, descriere: { type: "string" }, svg: { type: "string" } }, required: ["nume", "descriere", "svg"] },
      zone: { type: "object", properties: {
        produs: { type: "array", items: { type: "integer" }, description: "[ymin, xmin, ymax, xmax] 0–1000" },
        text: { type: "array", items: { type: "array", items: { type: "integer" } }, description: "Blocuri de text mare, fiecare [ymin, xmin, ymax, xmax] 0–1000" } },
        required: ["produs", "text"] },
      urmatorul_pas: { type: "string" },
    },
    required: ["diagnostic", "coduri_comune", "pastrezi", "schimbi", "paleta", "directii", "mascota", "zone", "urmatorul_pas"],
  };
  parts.push({ text: `Date din analiză (JSON):\n${JSON.stringify(facts)}\n\nBrief-ul utilizatorului (JSON):\n${JSON.stringify(brief)}` });
  const txt = await d.gemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 14000 },
  });
  let result: any;
  try { result = JSON.parse(txt.replace(/^```(json)?|```$/g, "")); } catch { throw new Error("Răspunsul pentru rebranding nu a putut fi citit. Încearcă din nou."); }
  result.directii = (result.directii ?? []).slice(0, 3);
  result.concurent = rival;
  result.a_functionat = merged;
  // SVG-ul mascotei: păstrăm doar forme simple (fără script, imagini externe sau handler-e)
  if (result.mascota?.svg) {
    const svg = String(result.mascota.svg);
    result.mascota.svg = /<script|<image|<foreignObject|on\w+=|href=/i.test(svg) || !/^\s*<svg[\s>]/i.test(svg) ? "" : svg.slice(0, 6000);
  }

  const { data: row, error } = await d.supabase.from("rebrands")
    .insert({ analysis_id: analysisId, brief, result, created_by: email }).select().single();
  if (error) throw error;

  // Imaginile se generează separat, câte una (rebrandImage), ca să respecte limita planului gratuit
  const images: string[] = [];
  const imageError: string | null = null;
  return { id: row.id, result, images, image_error: imageError };
}

/** Generează imaginea direcției i pentru un rebranding salvat. La limita gratuită întoarce retry_after în secunde. */
export async function rebrandImage(d: Deps, rebrandId: string, i: number) {
  const { data: rb } = await d.supabase.from("rebrands").select("*").eq("id", rebrandId).single();
  if (!rb) throw new Error("Rebrandingul nu există.");
  const dir = rb.result?.directii?.[i];
  if (!dir) throw new Error("Direcția nu există.");
  // Fără cheie, generatorul gratuit desenează de la zero; nu folosim asta: reclama nouă trebuie să pornească de la cea originală
  if (!POLL_KEY()) return { need_key: true };
  const { data: base } = await d.supabase.from("variants").select("image_path").eq("analysis_id", rb.analysis_id).eq("kind", "base").single();
  const baseImg = await d.inlineImage(base.image_path);
  const baseUrl = d.supabase.storage.from(d.bucket).getPublicUrl(base.image_path).data.publicUrl;
  try {
    const img = await generateImage(baseUrl, pngSize(baseImg.data) as any, dir.prompt_imagine, 1000 + i * 17);
    const path = `rebrand/${rebrandId}/${i}.${img.mime.includes("png") ? "png" : "jpg"}`;
    const up = await d.supabase.storage.from(d.bucket).upload(path, img.bytes, { contentType: img.mime, upsert: true });
    if (up.error) throw up.error;
    // re-citim rândul ca să nu suprascriem imaginile altor direcții generate între timp
    const { data: cur } = await d.supabase.from("rebrands").select("images,result").eq("id", rebrandId).single();
    const images = [...(cur?.images ?? [])]; while (images.length < i) images.push(null);
    images[i] = path;
    const result = cur?.result ?? rb.result; result.directii[i].sursa_imagine = img.source;
    await d.supabase.from("rebrands").update({ images, result, image_error: null }).eq("id", rebrandId);
    return { path, source: img.source };
  } catch (e: any) {
    if (e?.retryAfter) return { retry_after: e.retryAfter };
    throw e;
  }
}

// ---------- Face Off: eșantion sintetic calibrat pe date reale (silicon sampling) ----------
// Metodă: (1) cote după structura populației adulte din România (recensământul 2021, aproximativ),
// (2) fiecare persoană primește un tipar de comportament extras din opinii reale găsite pe web (cu surse),
// (3) evaluări independente, (4) post-stratificare pe vârstă × mediu și interval de încredere bootstrap.
const QUOTE = {
  varsta: [["18–34", 0.25, [18, 34]], ["35–49", 0.28, [35, 49]], ["50–64", 0.24, [50, 64]], ["65+", 0.23, [65, 80]]] as const,
  mediu: [["urban", 0.52], ["rural", 0.48]] as const,
  sex: [["F", 0.52], ["M", 0.48]] as const,
  regiune: [["București-Ilfov", 0.12], ["Nord-Est", 0.16], ["Sud-Muntenia", 0.15], ["Nord-Vest", 0.13], ["Centru", 0.12],
    ["Sud-Est", 0.12], ["Sud-Vest Oltenia", 0.10], ["Vest", 0.10]] as const,
};
// Extragere pe cote: pentru n mic, metoda celor mai mari resturi pe fiecare dimensiune, apoi amestec determinist
function quotaDraw<T>(items: readonly (readonly [T, number, ...unknown[]])[], n: number, r: () => number): T[] {
  const raw = items.map(([k, p]) => ({ k, x: p * n }));
  const base = raw.map((o) => ({ k: o.k, c: Math.floor(o.x), f: o.x - Math.floor(o.x) }));
  let left = n - base.reduce((a, o) => a + o.c, 0);
  [...base].sort((a, b) => b.f - a.f).slice(0, left).forEach((o) => o.c++);
  const out: T[] = base.flatMap((o) => Array(o.c).fill(o.k));
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export async function faceOffSetup(d: Deps & { geminiRaw: (b: Record<string, unknown>) => Promise<any> }, rebrandId: string, n = 12) {
  const { data: rb } = await d.supabase.from("rebrands").select("*").eq("id", rebrandId).single();
  if (!rb) throw new Error("Rebrandingul nu există.");
  const { data: a } = await d.supabase.from("analyses").select("category, ads!inner(brands!inner(name))").eq("id", rb.analysis_id).single();
  const cat = a?.category ?? "", brand = a?.ads?.brands?.name ?? "brand", rival = rb.result?.concurent ?? "";
  n = Math.max(6, Math.min(16, n));

  // 1. Ce spun oamenii reali: recenzii, forumuri, comentarii, articole (Google Search)
  const j = await d.geminiRaw({
    systemInstruction: { parts: [{ text: [
      "Ești cercetător de piață. Cauți pe internet ce spun cumpărători REALI din România despre brandul indicat, concurenții lui și categoria:",
      "recenzii de produs, forumuri, comentarii, articole cu vox-pop, studii de consum publicate.",
      "Grupezi ce găsești în 3–5 tipare de comportament (segmente). Pentru fiecare: ce îi face să cumpere, ce îi deranjează, cum aleg brandul,",
      "și 1–2 opinii tipice reformulate scurt (nu inventa, reformulează doar ce ai găsit).",
      "Răspunzi DOAR cu JSON: {\"segmente\":[{\"nume\":\"\",\"pondere\":0.3,\"comportament\":\"\",\"ce_conteaza\":\"\",\"ce_deranjeaza\":\"\",\"opinii\":[\"\"]}]}.",
      "„pondere” = cât de frecvent apare tiparul în ce ai găsit (suma 1).",
    ].join("\n") }] },
    contents: [{ role: "user", parts: [{ text: `Brand: ${brand}. Categoria: ${cat}. Concurent apropiat: ${rival || "—"}. Țara: România.` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 2500, temperature: 0.2 },
  });
  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
  let segs: any[] = [];
  try { segs = (JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] ?? "{}").segmente ?? []).slice(0, 5); } catch { /* fără segmente */ }
  if (!segs.length) segs = [{ nume: "cumpărător obișnuit", pondere: 1, comportament: "cumpără din obișnuință, atent la preț", ce_conteaza: "preț, disponibilitate", ce_deranjeaza: "reclame care nu spun nimic", opinii: [] }];
  const surse = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: any) => c.web).filter((w: any) => w?.uri)
    .map((w: any) => ({ url: w.uri, titlu: clip(w.title, 80) })).slice(0, 8);
  const tot = segs.reduce((s2, x) => s2 + (Number(x.pondere) || 0), 0) || 1;

  // 2. Eșantion pe cote (determinist pe rebranding) + segment după frecvența reală
  let seed = 0; for (const ch of rebrandId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const r = S.rng(seed);
  const ages = quotaDraw(QUOTE.varsta, n, r), envs = quotaDraw(QUOTE.mediu, n, r), sexes = quotaDraw(QUOTE.sex, n, r), regs = quotaDraw(QUOTE.regiune, n, r);
  const segIdx = quotaDraw(segs.map((x, i) => [i, (Number(x.pondere) || 0) / tot] as const), n, r);
  const ageRange = Object.fromEntries(QUOTE.varsta.map(([k, , rg]) => [k, rg]));
  const frame = Array.from({ length: n }, (_, i) => {
    const [lo, hi] = ageRange[ages[i]] as readonly [number, number];
    return { grupa: ages[i], varsta: lo + Math.floor(r() * (hi - lo + 1)), mediu: envs[i], sex: sexes[i], regiune: regs[i], segment: segIdx[i] ?? 0 };
  });

  // 3. Povestea fiecărei persoane, consistentă cu profilul demografic și cu tiparul real
  const pSchema = { type: "object", properties: { persoane: { type: "array", items: { type: "object", properties: {
    nume: { type: "string" }, localitate: { type: "string" }, ocupatie: { type: "string" },
    poveste: { type: "string", description: "2 propoziții: viața de zi cu zi și cum cumpără din categorie, fidel tiparului primit." } },
    required: ["nume", "localitate", "ocupatie", "poveste"] } } }, required: ["persoane"] };
  const pTxt = await d.gemini({
    systemInstruction: { parts: [{ text: "Pentru fiecare profil primit scrii o persoană plauzibilă din România: nume românesc potrivit sexului, " +
      "o localitate reală din regiunea și mediul indicate, o ocupație potrivită vârstei, și o poveste scurtă care respectă tiparul de comportament. " +
      "Păstrezi ordinea profilurilor. Fără stereotipuri jignitoare." }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify({ categorie: cat, profiluri: frame.map((f) => ({ ...f, tipar: segs[f.segment] })) }) }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: pSchema, maxOutputTokens: 4000, temperature: 0.9 },
  });
  let people: any[] = [];
  try { people = JSON.parse(pTxt.replace(/^```(json)?|```$/g, "")).persoane ?? []; } catch { /* gol */ }
  const personas = frame.map((f, i) => ({ ...f, ...(people[i] ?? {}), nume: people[i]?.nume ?? `Persoana ${i + 1}`,
    tipar: segs[f.segment]?.nume ?? "" }));
  const setup = { personas, segmente: segs, surse, n, metoda: "cote recensământ 2021 (vârstă, sex, mediu, regiune) + tipare din opinii reale + post-stratificare" };
  const result = { ...(rb.result ?? {}), face_off_setup: setup };
  await d.supabase.from("rebrands").update({ result }).eq("id", rebrandId);
  return setup;
}

/** O persoană din eșantion evaluează reclama actuală și cele 3 concepte (cerere separată = evaluare independentă). */
export async function faceOffEval(d: Deps, rebrandId: string, i: number) {
  const { data: rb } = await d.supabase.from("rebrands").select("*").eq("id", rebrandId).single();
  const setup = rb?.result?.face_off_setup, p = setup?.personas?.[i];
  if (!p) throw new Error("Persoana nu există; pornește din nou Face Off.");
  const { data: a } = await d.supabase.from("analyses").select("category").eq("id", rb.analysis_id).single();
  const { data: base } = await d.supabase.from("variants").select("image_path").eq("analysis_id", rb.analysis_id).eq("kind", "base").single();
  const dirs = (rb.result?.directii ?? []).slice(0, 3), seg = setup.segmente?.[p.segment] ?? {};
  const desc = [rb.result?.diagnostic, (rb.result?.coduri_comune ?? []).length ? `Elemente: ${rb.result.coduri_comune.join(", ")}.` : ""].filter(Boolean).join(" ");
  const options = [`Reclama actuală (imaginea atașată, dacă o vezi; logo-ul e acoperit cu gri).${desc ? ` Descriere: ${desc}` : ""}`,
    ...dirs.map((x: any, k: number) => `Concept ${k + 1} „${x.titlu}”: headline „${x.text_nou}”. ${x.descriere} Culori: ${(x.culori ?? []).join(", ")}.` +
      (rb.result?.mascota?.nume ? ` Apare mascota „${rb.result.mascota.nume}”.` : ""))];
  const schema = { type: "object", properties: {
    scoruri: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" }, atentie: { type: "integer" }, distinctiv: { type: "integer" }, potrivire: { type: "integer" }, cumparare: { type: "integer" } },
      required: ["index", "atentie", "distinctiv", "potrivire", "cumparare"] } },
    favorit: { type: "integer" },
    citat: { type: "string", description: "Ce spui cu voce tare când vezi reclamele, la persoana I, natural, 1–2 propoziții, cu vocabularul tău." },
    ce_schimbi: { type: "string", description: "Un singur lucru concret pe care l-ai schimba la varianta preferată." } },
    required: ["scoruri", "favorit", "citat", "ce_schimbi"] };
  const parts: any[] = [];
  if (base) parts.push({ inline_data: await d.inlineImage(base.image_path) });
  parts.push({ text: options.map((o, k) => `${k}. ${o}`).join("\n") });
  const t = await d.gemini({
    systemInstruction: { parts: [{ text: [
      `Ești ${p.nume}, ${p.varsta} de ani (${p.sex === "F" ? "femeie" : "bărbat"}), ${p.ocupatie}, din ${p.localitate} (${p.mediu}, ${p.regiune}). ${p.poveste ?? ""}`,
      `Cum cumperi ${a?.category ?? "din categorie"} (tipar observat la cumpărători reali): ${seg.comportament ?? ""}. Ce contează: ${seg.ce_conteaza ?? ""}. Ce te deranjează: ${seg.ce_deranjeaza ?? ""}.`,
      seg.opinii?.length ? `Oameni ca tine spun lucruri ca: ${seg.opinii.map((o: string) => `„${o}”`).join(" ")}` : "",
      "Reacționezi ca tine, nu ca un expert. Note 1–10: atenție (te-ar opri?), distinctiv (îl deosebești de alte branduri?), potrivire (pare de încredere?), cumpărare.",
      "Fii sincer: dacă nu-ți pasă de reclame, se vede în note. Nu da aceeași notă peste tot. Alegi o singură variantă preferată.",
    ].filter(Boolean).join("\n") }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 700, temperature: 1 },
  });
  let out: any;
  try { out = JSON.parse(t.replace(/^```(json)?|```$/g, "")); } catch { throw new Error("Răspuns invalid; reîncerc."); }
  const fav = Number.isInteger(out.favorit) && out.favorit >= 0 && out.favorit <= dirs.length ? out.favorit : 0;
  const cl = (x: any) => Math.max(1, Math.min(10, Number(x) || 5));
  return { i, favorit: fav, citat: clip(out.citat, 300), ce_schimbi: clip(out.ce_schimbi, 200),
    scoruri: (out.scoruri ?? []).map((x: any) => ({ index: x.index, atentie: cl(x.atentie), distinctiv: cl(x.distinctiv), potrivire: cl(x.potrivire), cumparare: cl(x.cumparare) })) };
}

/** Agregare cu post-stratificare (vârstă × mediu) și IC 95% bootstrap pentru cota de preferință. */
export async function faceOffSave(d: Deps, rebrandId: string, answers: any[]) {
  const { data: rb } = await d.supabase.from("rebrands").select("*").eq("id", rebrandId).single();
  const setup = rb?.result?.face_off_setup;
  if (!setup) throw new Error("Lipsește eșantionul.");
  const dirs = (rb.result?.directii ?? []).slice(0, 3), K = ["atentie", "distinctiv", "potrivire", "cumparare"];
  const ok = (answers ?? []).filter((x) => x && setup.personas[x.i]);
  if (!ok.length) throw new Error("Niciun răspuns de agregat.");
  // ponderi: cota populației pe celulă / cota în eșantion
  const pop: Record<string, number> = {};
  for (const [g, pg] of QUOTE.varsta) for (const [m, pm] of QUOTE.mediu) pop[`${g}|${m}`] = pg * pm;
  const cell = (x: any) => `${setup.personas[x.i].grupa}|${setup.personas[x.i].mediu}`;
  const cnt: Record<string, number> = {}; ok.forEach((x) => (cnt[cell(x)] = (cnt[cell(x)] ?? 0) + 1));
  const w = ok.map((x) => (pop[cell(x)] ?? 0.01) / (cnt[cell(x)] / ok.length));
  const wsum = w.reduce((a, b) => a + b, 0);
  const r = S.rng(4242);
  const opts = [0, ...dirs.map((_: any, k: number) => k + 1)];
  const scores = opts.map((o) => {
    const share = ok.reduce((a, x, k) => a + (x.favorit === o ? w[k] : 0), 0) / wsum;
    const boots: number[] = [];
    for (let b = 0; b < 2000; b++) { let num = 0, den = 0;
      for (let k = 0; k < ok.length; k++) { const j = Math.floor(r() * ok.length); den += w[j]; if (ok[j].favorit === o) num += w[j]; }
      boots.push(num / den); }
    boots.sort((x, y) => x - y);
    const row: any = { index: o, votes: ok.filter((x) => x.favorit === o).length, share, ci: [boots[50], boots[1949]] };
    for (const k of K) { const xs = ok.map((x, j) => [x.scoruri.find((s2: any) => s2.index === o)?.[k], w[j]]).filter(([v]) => v != null) as [number, number][];
      row[k] = xs.length ? xs.reduce((a, [v, ww]) => a + v * ww, 0) / xs.reduce((a, [, ww]) => a + ww, 0) : 0; }
    row.total = K.reduce((a, k) => a + row[k], 0) / K.length;
    return row;
  });
  const out: any = { n: ok.length, scores, answers: ok, metoda: setup.metoda, created_at: new Date().toISOString() };
  try {
    out.insight = clip(await d.gemini({
      systemInstruction: { parts: [{ text: "Ești strateg de brand. Din rezultatele panelului (ponderate) scrii 2–3 propoziții în română, fără markdown: " +
        "ce variantă merită dusă mai departe, cât de sigur e rezultatul (uită-te la intervalele de încredere) și cele mai frecvente lucruri de schimbat." }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify({ optiuni: ["Reclama actuală", ...dirs.map((x: any) => x.titlu)], scores, de_schimbat: ok.map((x) => x.ce_schimbi) }) }] }],
      generationConfig: { maxOutputTokens: 400 },
    }), 700);
  } catch { /* opțional */ }
  const result = { ...(rb.result ?? {}), face_off: out };
  await d.supabase.from("rebrands").update({ result }).eq("id", rebrandId);
  return out;
}

/** Heatmap: zonele din reclamă care seamănă cu reclamele concurenților (Gemini vision, coordonate 0–1000). */
export async function similarityHeatmap(d: Deps, analysisId: string) {
  const { data: a } = await d.supabase.from("analyses").select("*, ads!inner(*, brands!inner(*))").eq("id", analysisId).single();
  if (!a?.summary) throw new Error("Analiza nu are încă rezultate.");
  const s = a.summary, target = a.ads.brands.name as string;
  const { data: base } = await d.supabase.from("variants").select("image_path").eq("analysis_id", analysisId).eq("kind", "base").single();
  const rivals = Object.entries(s.similarity?.per_brand ?? s.confusion ?? {}).filter(([b]) => b !== target)
    .sort((x: any, y: any) => (y[1]?.mean ?? y[1]) - (x[1]?.mean ?? x[1])).map(([b]) => b).slice(0, 2);
  const parts: any[] = [{ text: "Reclama analizată (logo acoperit cu gri):" }, { inline_data: await d.inlineImage(base.image_path) }];
  for (const b of rivals) {
    const { data: ex } = await d.supabase.from("ads").select("image_path,brands!inner(name,category)")
      .eq("role", "memory").eq("brands.name", b).eq("brands.category", a.category).limit(2);
    if (ex?.length) parts.push({ text: `Reclame ${b}:` });
    for (const e of ex ?? []) parts.push({ inline_data: await d.inlineImage(e.image_path) });
  }
  const schema = { type: "object", properties: { zone: { type: "array", items: { type: "object", properties: {
    box: { type: "array", items: { type: "integer" }, description: "[ymin, xmin, ymax, xmax] 0–1000 în reclama analizată" },
    intensitate: { type: "number", description: "0–1: cât de puternic seamănă zona cu concurentul" },
    concurent: { type: "string" }, ce: { type: "string", description: "Ce anume seamănă, concret (culoare, element, compoziție, tipografie)." } },
    required: ["box", "intensitate", "concurent", "ce"] } } }, required: ["zone"] };
  const t = await d.gemini({
    systemInstruction: { parts: [{ text: [
      `Compari reclama analizată (brandul „${target}”, categoria „${a.category}”) cu reclamele concurenților.`,
      "Marchezi 3–8 zone din reclama analizată care seamănă vizual cu reclamele concurenților: aceeași culoare dominantă, același tip de element, aceeași compoziție, tipografie sau stil foto.",
      `Nu marchezi elementele comune întregii categorii (${(s.generic_elements ?? []).join(", ") || "produsul în sine"}) decât dacă sunt tratate identic. Nu marchezi zonele gri.`,
      "Coordonatele sunt pe reclama analizată, scara 0–1000.",
    ].join("\n") }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 1500 },
    __vision: true,
  });
  let zone: any[] = [];
  try { zone = (JSON.parse(t.replace(/^```(json)?|```$/g, "")).zone ?? []).filter((z: any) => z.box?.length === 4).slice(0, 8)
    .map((z: any) => ({ box: z.box.map((v: number) => Math.max(0, Math.min(1000, Math.round(v)))), intensitate: Math.max(0, Math.min(1, Number(z.intensitate) || 0.5)),
      concurent: clip(z.concurent, 40), ce: clip(z.ce, 160) })); } catch { /* gol */ }
  const heat = { zone, rivals, created_at: new Date().toISOString() };
  await d.supabase.from("analyses").update({ summary: { ...s, heatmap: heat } }).eq("id", analysisId);
  return heat;
}
