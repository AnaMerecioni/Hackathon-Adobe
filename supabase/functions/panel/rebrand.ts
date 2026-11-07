// Rebranding asistat: pornește de la rezultatele analizei (similaritate, confuzie, elemente) și de la brief-ul
// utilizatorului, și propune 3 direcții vizuale care îndepărtează reclama de concurentul cel mai apropiat.
// Opțional generează câte o imagine pe direcție (model de imagine Gemini), ca să poată fi retestată în panel.

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

const IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const clip = (s: unknown, n = 400) => String(s ?? "").slice(0, n).trim();

async function generateImage(d: Deps, base: { mime_type: string; data: string }, prompt: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": d.geminiKey(), "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: "Redesenează această reclamă după instrucțiunile de mai jos. Păstrează formatul și produsul; zonele gri plate " +
          "sunt locul logo-ului și rămân gri plat. Nu adăuga niciun nume de brand, logo sau text lizibil.\n\n" + prompt },
        { inline_data: base },
      ] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) throw new Error(`Imagine ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const j = await res.json();
  const part = (j?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data || p.inline_data?.data);
  const img = part?.inlineData ?? part?.inline_data;
  if (!img) throw new Error("Modelul de imagine nu a întors nicio imagine.");
  return { mime: img.mimeType ?? img.mime_type ?? "image/png", bytes: Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0)) };
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

  const facts = {
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
    "4. Propui exact 3 direcții diferite între ele: una „sigur” (ajustare fină), una „echilibrat”, una „curajos”. " +
      "Dacă brief-ul cere o ajustare fină, chiar și direcția „curajos” rămâne recognoscibilă pentru clienții actuali.",
    "5. Pentru fiecare direcție scrii un prompt de imagine detaliat, în română, care descrie reclama nouă (fără nume de brand, fără logo, fără text lizibil).",
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
        prompt_imagine: { type: "string" } },
        required: ["titlu", "risc", "descriere", "de_ce_distinct", "legatura_cu_identitatea", "culori", "prompt_imagine"] } },
      urmatorul_pas: { type: "string" },
    },
    required: ["diagnostic", "coduri_comune", "pastrezi", "schimbi", "paleta", "directii", "urmatorul_pas"],
  };
  parts.push({ text: `Date din analiză (JSON):\n${JSON.stringify(facts)}\n\nBrief-ul utilizatorului (JSON):\n${JSON.stringify(brief)}` });
  const txt = await d.gemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 4000 },
  });
  let result: any;
  try { result = JSON.parse(txt.replace(/^```(json)?|```$/g, "")); } catch { throw new Error("Răspunsul pentru rebranding nu a putut fi citit. Încearcă din nou."); }
  result.directii = (result.directii ?? []).slice(0, 3);
  result.concurent = rival;

  const { data: row, error } = await d.supabase.from("rebrands")
    .insert({ analysis_id: analysisId, brief, result, created_by: email }).select().single();
  if (error) throw error;

  // Imagini opționale: o variantă pe direcție, salvată ca să poată fi testată în panel
  const images: string[] = [];
  let imageError: string | null = null;
  if (wantImages) {
    const baseImg = await d.inlineImage(base.image_path);
    for (const [i, dir] of result.directii.entries()) {
      try {
        const img = await generateImage(d, baseImg, `${dir.titlu}. ${dir.prompt_imagine}`);
        const path = `rebrand/${row.id}/${i}.${img.mime.includes("jpeg") ? "jpg" : "png"}`;
        const up = await d.supabase.storage.from(d.bucket).upload(path, img.bytes, { contentType: img.mime, upsert: true });
        if (up.error) throw up.error;
        images[i] = path;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        imageError = /\b(429|403)\b/.test(m) ? "Generarea de imagini AI nu e inclusă în cota gratuită a cheii Gemini." : m;
        break; // dacă modelul de imagine nu e disponibil, nu mai încercăm și pentru celelalte direcții
      }
    }
    await d.supabase.from("rebrands").update({ images, image_error: imageError }).eq("id", row.id);
  }
  return { id: row.id, result, images, image_error: imageError };
}
