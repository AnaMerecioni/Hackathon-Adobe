// Rebranding asistat: pornește de la rezultatele analizei (similaritate, confuzie, elemente) și de la brief-ul
// utilizatorului, și propune 3 direcții vizuale care îndepărtează reclama de concurentul cel mai apropiat.
// Opțional generează câte o imagine pe direcție (Pollinations: editare cu cheie, FLUX gratuit fără cheie), ca să poată fi retestată în panel.

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
