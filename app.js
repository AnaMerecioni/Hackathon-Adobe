import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=202611071329";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// GitHub Pages ține pagina în cache ~10 minute: verificăm versiunea publicată și reîncărcăm dacă e mai nouă
const APP_VERSION = "202611071405";
fetch(`version.txt?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.ok ? r.text() : null).then((v) => {
  v = v?.trim();
  if (v && v !== APP_VERSION && !location.search.includes(`r=${v}`)) location.replace(`${location.pathname}?r=${v}`);
}).catch(() => {});
const $ = (s) => document.querySelector(s);
const MASK = "#7f7f7f";            // aceeași mascare plată pe toate reclamele
const COLORS = ["#e4572e", "#2a9d5c", "#3a6ea5", "#c98a00", "#8e44ad", "#16a3a3", "#d1495b", "#5b6b2f"];
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
const BUCKET = "creative"; // nume neutru: URL-urile cu „/ads/” sunt blocate de extensiile anti-reclame
const MAX_SIDE = 1024; // imagini mici → cereri mici către Gemini

// Redimensionează un canvas/imagine la maxim MAX_SIDE și întoarce un Blob
function toScaledBlob(source, w, h, type = "image/png") {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, type, 0.9));
}
const OK_TYPES = ["image/png", "image/jpeg", "image/webp"];
async function scaleFile(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(`„${file.name}” nu e o imagine suportată. Folosește PNG, JPG sau WebP.`); }
  const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
  // telefoanele trimit uneori „image/jpg” sau un tip gol: re-encodăm ca să fie acceptat de Storage
  if (Math.max(bmp.width, bmp.height) <= MAX_SIDE && OK_TYPES.includes(type) && type === file.type) return file;
  return toScaledBlob(bmp, bmp.width, bmp.height, type === "image/png" ? "image/png" : "image/jpeg");
}
async function sha(blob) {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- mărire imagine ----------
document.addEventListener("click", (e) => {
  const img = e.target.closest("#ad-gallery img, .variants img");
  if (!img) return;
  const lb = $("#lightbox");
  lb.querySelector("img").src = img.src;
  lb.querySelector(".lb-cap").textContent = img.closest(".thumb, figure")?.innerText.replace(/\s+/g, " ").trim() ?? "";
  lb.classList.remove("hidden");
});
$("#lightbox").addEventListener("click", () => $("#lightbox").classList.add("hidden"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lightbox").classList.add("hidden"); });

// ---------- tooltip pentru grafice ----------
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]"), tip = $("#tip");
  if (!t) return tip.classList.add("hidden");
  tip.innerHTML = t.dataset.tip;
  tip.classList.remove("hidden");
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
});

const DX = { asset_puternic: "Asset puternic", tradator: "Element trădător", decor: "Decor", neutru: "Neutru", neconcludent: "Neconcludent" };

let brands = [];
let ads = [];

// ---------- tab-uri ----------
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

const category = () => $("#category").value.trim().toLowerCase();
try { const c = localStorage.getItem("fl-category"); if (c) $("#category").value = c; } catch {}
$("#category").addEventListener("change", () => { try { localStorage.setItem("fl-category", category()); } catch {} loadData(); });

// ---------- set de date ----------
async function loadData() {
  const { data: b, error } = await sb.from("brands").select("*").eq("category", category()).order("name");
  if (error) return alert(error.message);
  brands = b;
  const ids = brands.map((x) => x.id);
  const { data: a } = ids.length
    ? await sb.from("ads").select("id,brand_id,title,role,image_path,sha256,created_at").in("brand_id", ids).order("created_at", { ascending: false })
    : { data: [] };
  ads = a ?? [];
  const bn = (id) => brands.find((x) => x.id === id)?.name;

  $("#brand-list").innerHTML = brands.map((x) => {
    const m = ads.filter((a) => a.brand_id === x.id && a.role === "memory").length;
    return `<li>${esc(x.name)} · ${m} memorie</li>`;
  }).join("") || '<li class="muted">Niciun brand încă</li>';
  $("#ad-brand").innerHTML = brands.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");

  const thumb = (a, cta = false) => `<div class="thumb" data-id="${a.id}"><img src="${imgUrl(a.image_path)}" loading="lazy" alt=""
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img-missing',textContent:'Imaginea nu s-a încărcat'}))" />
    <div><span class="tag ${a.role}">${a.role === "memory" ? "memorie" : "test"}</span> ${esc(bn(a.brand_id))}${a.title ? " · " + esc(a.title) : ""}</div>
    ${cta && a.role === "test" ? `<button class="cta" type="button" data-analyze="${a.id}">▶ Analizează</button>` : ""}</div>`;
  $("#ad-gallery").innerHTML = ads.map((a) => thumb(a, true)).join("") || '<p class="muted">Nicio reclamă încă.</p>';
  $("#ad-gallery").querySelectorAll("[data-analyze]").forEach((b) => b.addEventListener("click", () => goAnalyze(b.dataset.analyze)));
  const testCount = ads.filter((a) => a.role === "test").length;
  $("#start-cta").classList.toggle("hidden", !testCount);
  const tests = ads.filter((a) => a.role === "test");
  $("#test-gallery").innerHTML = tests.map((a) => thumb(a)).join("") || '<p class="muted">Încarcă întâi o reclamă cu rol „Test”.</p>';
  $("#test-gallery").querySelectorAll(".thumb").forEach((t) => t.addEventListener("click", () => selectTest(t.dataset.id)));
}

function switchTab(name) {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "history") loadHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function selectTest(id) {
  $("#test-gallery").querySelectorAll(".thumb").forEach((x) => x.classList.toggle("selected", x.dataset.id === id));
  openEditor(ads.find((a) => a.id === id));
}
function goAnalyze(id) {
  switchTab("analyze");
  const first = id ?? ads.find((a) => a.role === "test")?.id;
  if (first) selectTest(first);
}

$("#brand-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#brand-name").value.trim();
  if (!name) return;
  const { error } = await sb.from("brands").insert({ name, category: category() });
  if (error) return alert(error.code === "23505" ? "Brandul există deja." : error.message);
  $("#brand-name").value = "";
  loadData();
});

$("#ad-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = [...$("#ad-files").files];
  const brand_id = $("#ad-brand").value;
  if (!brand_id) return alert("Adaugă întâi un brand.");
  $("#ad-status").textContent = `Se încarcă ${files.length} imagini…`;
  const skipped = [];
  for (const orig of files) {
    let f;
    try { f = await scaleFile(orig); } catch (err) { skipped.push(err.message); continue; }
    const sha256 = await sha(f);
    const dup = ads.find((a) => a.sha256 === sha256);
    if (dup) { skipped.push(`${orig.name} (există deja la ${brands.find((b) => b.id === dup.brand_id)?.name}, ${dup.role === "memory" ? "memorie" : "test"})`); continue; }
    const ext = f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
    const path = `img/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type });
    if (up.error) { $("#ad-status").textContent = up.error.message; return; }
    const { error } = await sb.from("ads").insert({ brand_id, role: $("#ad-role").value, title: $("#ad-title").value || null, image_path: path, sha256 });
    if (error) { $("#ad-status").textContent = error.message; return; }
  }
  $("#ad-status").textContent = skipped.length
    ? `Gata. Sărite, pentru că aceeași imagine nu poate fi și memorie, și test: ${skipped.join("; ")}.`
    : "Gata.";
  e.target.reset();
  loadData();
});

$("#start-cta").addEventListener("click", () => goAnalyze());

// ---------- elemente comune categoriei (ignorate de panel) ----------
const GENERIC_DEFAULTS = {
  apa: "sticla de apă, apa / lichidul, picături de apă, paharul cu apă",
  "apă": "sticla de apă, apa / lichidul, picături de apă, paharul cu apă",
  bere: "sticla sau doza de bere, spuma, halba / paharul, ciocnitul paharelor",
  cafea: "ceașca, boabele de cafea, aburul",
  suc: "sticla sau doza, paharul, cuburile de gheață",
  ciocolata: "tableta de ciocolată, bucățile rupte",
  "ciocolată": "tableta de ciocolată, bucățile rupte",
};
function genericFor(cat) {
  try { const v = localStorage.getItem(`fl-generic-${cat}`); if (v != null) return v; } catch {}
  return GENERIC_DEFAULTS[cat] ?? "";
}
const genericList = () => $("#generic").value.split(",").map((x) => x.trim()).filter(Boolean);
$("#generic").addEventListener("change", () => { try { localStorage.setItem(`fl-generic-${category()}`, $("#generic").value); } catch {} });

// ---------- editor de mască ----------
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let current = null; // { ad, img, layers: [{name, hue, rects:[]}], active }

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Imaginea nu s-a putut încărca pentru editare."));
    // URL separat pentru canvas: Safari altfel refolosește copia din cache fără antet CORS și blochează editorul
    i.src = src + (src.includes("?") ? "&" : "?") + "cors=1";
  });
}

async function openEditor(ad) {
  if (!ad) return;
  $("#editor").classList.remove("hidden");
  $("#progress").textContent = "Se încarcă imaginea…";
  let img;
  try { img = await loadImage(imgUrl(ad.image_path)); }
  catch (e) {
    $("#progress").innerHTML = `<span class="err">${esc(e.message)} Reîncarcă pagina (Cmd+Shift+R) și încearcă din nou.</span>`;
    $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  $("#progress").textContent = "";
  current = { ad, img, layers: [{ name: "Logo", logo: true, rects: [] }], active: 0 };
  $("#generic").value = genericFor(category());
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  $("#editor").classList.remove("hidden");
  $("#result").classList.add("hidden");
  renderLayers(); draw();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderLayers() {
  const color = (l, i) => (l.logo ? MASK : COLORS[i % COLORS.length]);
  // Bara de deasupra imaginii: arată clar pe ce strat desenezi și permite schimbarea dintr-un click
  $("#drawbar").innerHTML = `<span class="db-lbl">Desenezi pe:</span>` + current.layers.map((l, i) =>
    `<button type="button" class="db-chip ${i === current.active ? "on" : ""}" data-pick="${i}">
      <span class="sw" style="background:${color(l, i)}"></span>${esc(l.name)} <span class="cnt">${l.hue ? "nuanță" : l.rects.length}</span></button>`).join("");
  $("#drawbar").querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    current.active = +b.dataset.pick; renderLayers(); draw();
  }));
  // Lista din dreapta: fiecare strat cu zonele lui, fiecare zonă se poate șterge separat
  $("#layers").innerHTML = current.layers.map((l, i) => `<li class="${i === current.active ? "active" : ""}" data-i="${i}">
    <div class="ly-head"><span><span class="sw" style="background:${color(l, i)}"></span>${esc(l.name)}${l.hue ? " (culoare)" : ""}
      · ${l.hue ? "nuanță" : `${l.rects.length} ${l.rects.length === 1 ? "zonă" : "zone"}`}</span>
      <span>${l.rects.length > 1 ? `<button data-clear="${i}" title="Șterge toate zonele">Șterge tot</button>` : ""}${l.logo ? "" : `<button data-del="${i}" title="Șterge elementul">✕</button>`}</span></div>
    ${l.rects.length ? `<div class="zones">${l.rects.map((r, j) => `<span class="zone">#${j + 1}<button data-zone="${i}:${j}" title="Șterge zona">✕</button></span>`).join("")}</div>` : ""}
  </li>`).join("");
  $("#layers").querySelectorAll("li").forEach((li) => li.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (t?.dataset.del) { current.layers.splice(+t.dataset.del, 1); current.active = 0; }
    else if (t?.dataset.clear) current.layers[+t.dataset.clear].rects = [];
    else if (t?.dataset.zone) { const [i, j] = t.dataset.zone.split(":").map(Number); current.layers[i].rects.splice(j, 1); }
    else current.active = +li.dataset.i;
    renderLayers(); draw();
  }));
}

$("#el-add").addEventListener("click", () => {
  const name = $("#el-name").value.trim();
  if (!name || !current) return;
  // un element comun categoriei nu are sens în ablație: nu deosebește brandurile
  const gen = genericList().map((g) => g.toLowerCase());
  const n = name.toLowerCase();
  if (gen.some((g) => g.split(/[\s/]+/).some((w) => w.length > 3 && n.includes(w.slice(0, 5)))) &&
      !confirm(`„${name}” pare un element comun categoriei „${category()}”, pe care panelul îl ignoră. Îl adaugi totuși?`)) return;
  current.layers.push({ name, hue: $("#el-hue").checked, rects: [] });
  current.active = current.layers.length - 1;
  $("#el-name").value = ""; $("#el-hue").checked = false;
  renderLayers(); draw();
});

let drag = null;
const pos = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
};
canvas.addEventListener("pointerdown", (e) => { if (!current) return; canvas.setPointerCapture(e.pointerId); drag = { a: pos(e), b: pos(e) }; });
canvas.addEventListener("pointermove", (e) => { if (drag) { drag.b = pos(e); draw(); } });
canvas.addEventListener("pointerup", () => {
  if (!drag) return;
  const r = normRect(drag.a, drag.b);
  if (r.w > 2 && r.h > 2) current.layers[current.active].rects.push(r);
  drag = null; renderLayers(); draw();
});
const normRect = (a, b) => ({ x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), w: Math.round(Math.abs(a.x - b.x)), h: Math.round(Math.abs(a.y - b.y)) });

function draw() {
  if (!current) return;
  ctx.filter = "none";
  ctx.drawImage(current.img, 0, 0);
  const lw = Math.max(2, canvas.width / 300);
  current.layers.forEach((l, i) => {
    for (const r of l.rects) {
      if (l.logo) { ctx.fillStyle = MASK; ctx.fillRect(r.x, r.y, r.w, r.h);
        if (i === current.active) { ctx.strokeStyle = "#e4572e"; ctx.lineWidth = lw; ctx.strokeRect(r.x, r.y, r.w, r.h); } }
      else { ctx.strokeStyle = COLORS[i % COLORS.length]; ctx.lineWidth = lw; ctx.setLineDash([lw * 3, lw * 2]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]); }
    }
  });
  if (drag) { const r = normRect(drag.a, drag.b); ctx.strokeStyle = "#000"; ctx.lineWidth = lw; ctx.strokeRect(r.x, r.y, r.w, r.h); }
}

// Culoarea medie a inelului din jurul zonei — umple elementul cu „fundalul” lui
function ringColor(c, r) {
  const W = c.canvas.width, H = c.canvas.height, pad = Math.max(3, Math.round(Math.min(r.w, r.h) * 0.08));
  const x0 = Math.max(0, r.x - pad), y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(W, r.x + r.w + pad), y1 = Math.min(H, r.y + r.h + pad);
  const d = c.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
    const k = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
    R += d[k]; G += d[k + 1]; B += d[k + 2]; n++;
  }
  return n ? `rgb(${R / n | 0},${G / n | 0},${B / n | 0})` : MASK;
}

function renderVariant(element) {
  const c = document.createElement("canvas");
  c.width = current.img.naturalWidth; c.height = current.img.naturalHeight;
  const x = c.getContext("2d");
  x.filter = element?.hue ? "hue-rotate(180deg)" : "none";
  x.drawImage(current.img, 0, 0);
  x.filter = "none";
  if (element && !element.hue) for (const r of element.rects) { x.fillStyle = ringColor(x, r); x.fillRect(r.x, r.y, r.w, r.h); }
  for (const r of current.layers[0].rects) { x.fillStyle = MASK; x.fillRect(r.x, r.y, r.w, r.h); }
  return toScaledBlob(c, c.width, c.height);
}

// ---------- rulare ----------
async function invoke(body) {
  const { data, error } = await sb.functions.invoke("panel", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch {}
    if (/non-2xx/.test(msg)) msg = "Serverul nu a răspuns la timp (limitele gratuite Gemini). Încearcă din nou peste un minut.";
    throw new Error(msg);
  }
  return data;
}

async function uploadBlob(path, blob) {
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/png", upsert: true });
  if (error) throw error;
  return path;
}

async function createAnalysis({ useMemory, withAblations }) {
  const n_evals = Math.min(30, Math.max(1, +$("#n-evals").value || 10));
  const { data: a, error } = await sb.from("analyses")
    .insert({ ad_id: current.ad.id, category: category(), use_memory: useMemory, n_evals, generic_elements: genericList() }).select().single();
  if (error) throw error;
  const rows = [{ kind: "base", element: null, blob: await renderVariant(null) }];
  if (withAblations) {
    for (const l of current.layers.slice(1)) {
      if (!l.hue && !l.rects.length) continue;
      rows.push({ kind: "ablation", element: l.name, blob: await renderVariant(l) });
    }
    for (const f of $("#gen-files").files) rows.push({ kind: "generated", element: f.name.replace(/\.\w+$/, ""), blob: await scaleFile(f) });
  }
  const variants = [];
  for (const [i, r] of rows.entries()) {
    const path = await uploadBlob(`analyses/${a.id}/${i}-${r.kind}.${r.blob.type === "image/png" ? "png" : (r.blob.type.split("/")[1] || "png")}`, r.blob);
    const { data: v, error: ve } = await sb.from("variants").insert({ analysis_id: a.id, kind: r.kind, element: r.element, image_path: path }).select().single();
    if (ve) throw ve;
    variants.push(v);
  }
  return { analysis: a, variants };
}

async function runAll(variants, onProgress) {
  let done = 0, next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < variants.length) {
      const v = variants[next++];
      // o variantă poate cere mai multe runde (limita de timp a serverului); continuăm până sunt gata toate evaluările
      let out = await invoke({ action: "run_variant", variant_id: v.id });
      for (let k = 0; out?.partial && k < 8; k++) out = await invoke({ action: "run_variant", variant_id: v.id, continue: true });
      if (out?.partial) throw new Error("Panelul răspunde prea încet acum (limitele gratuite Gemini). Încearcă din nou peste câteva minute.");
      onProgress(++done, variants.length, v);
    }
  }));
}

$("#run").addEventListener("click", async () => {
  if (!current) return;
  if (!current.layers[0].rects.length && !confirm("Nu ai mascat niciun logo. Continui?")) return;
  const btn = $("#run"), prog = $("#progress");
  const bar = (f) => { $("#progress-wrap").classList.remove("hidden"); $("#pbar-fill").style.width = `${Math.round(f * 100)}%`; };
  btn.disabled = true; btn.textContent = "Analiza rulează…"; bar(0.03);
  try {
    prog.textContent = "Pregătesc variantele…";
    const main = await createAnalysis({ useMemory: $("#use-memory").checked, withAblations: true });
    let control = null;
    if ($("#control").checked && $("#use-memory").checked) control = await createAnalysis({ useMemory: false, withAblations: false });
    const all = [...main.variants, ...(control?.variants ?? [])];
    prog.textContent = `Panelul evaluează 0 / ${all.length} variante…`;
    await runAll(all, (d, n, v) => { bar(0.05 + 0.8 * (d / n)); prog.textContent = `Panelul evaluează ${d} / ${n} variante… (ultima: ${v.element ?? v.kind})`; });
    prog.textContent = "Calculez diagnosticul, similaritatea și scriu raportul…"; bar(0.9);
    await invoke({ action: "finalize", analysis_id: main.analysis.id });
    if (control) await invoke({ action: "finalize", analysis_id: control.analysis.id });
    prog.textContent = "Gata."; bar(1);
    await showResult($("#result"), main.analysis.id, control?.analysis.id);
    $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    prog.innerHTML = `<span class="err">Eroare: ${esc(e.message)}</span>`;
  } finally { btn.disabled = false; btn.textContent = "▶ Pornește analiza"; }
});

// ---------- rezultate ----------
async function showResult(el, analysisId, controlId) {
  const [{ data: a }, { data: vs }, { data: imp }] = await Promise.all([
    sb.from("analyses").select("*, ads(*, brands(*))").eq("id", analysisId).single(),
    sb.from("variants").select("id,kind,element,image_path,status,attribution,attribution_sd,distribution,created_at").eq("analysis_id", analysisId).order("created_at"),
    sb.from("element_impacts").select("*").eq("analysis_id", analysisId).order("delta", { ascending: false }),
  ]);
  let ctrl = null;
  if (controlId) ctrl = (await sb.from("analyses").select("summary").eq("id", controlId).single()).data?.summary;
  if (!ctrl) {
    const { data: c } = await sb.from("analyses").select("summary").eq("ad_id", a.ad_id).eq("use_memory", false)
      .eq("status", "done").gte("created_at", new Date(new Date(a.created_at).getTime() - 120000).toISOString())
      .lte("created_at", new Date(new Date(a.created_at).getTime() + 120000).toISOString()).limit(1);
    ctrl = c?.[0]?.summary ?? null;
  }
  const s = a.summary;
  const base = vs.find((v) => v.kind === "base");
  const target = a.ads.brands.name;
  const dist = Object.entries(base?.distribution ?? {}).sort((x, y) => y[1] - x[1]);

  el.classList.remove("hidden");
  if (a.status === "error") { el.innerHTML = `<h2>Analiză eșuată</h2><p class="err">${esc(a.error)}</p>`; return; }
  if (!s) { el.innerHTML = `<h2>Analiză în curs</h2><p class="muted">Status: ${esc(a.status)}</p>`; return; }

  if (s.version === 2) {
    el.innerHTML = summaryView({ a, s, imp, target }) + `<div class="rebrand-slot"></div>` +
      `<div class="details-toggle"><button type="button" class="ghost" data-toggle-stats>📊 Vezi analiza statistică</button></div>
       <div class="stats-details hidden">${compactStats({ a, s, vs, imp, target })}
         <div class="full-details hidden">${statsView({ a, s, vs, imp, target, ctrl })}</div></div>`;
    const btn = el.querySelector("[data-toggle-stats]"), box = el.querySelector(".stats-details");
    btn.addEventListener("click", () => {
      const open = box.classList.toggle("hidden") === false;
      btn.textContent = open ? "Ascunde analiza statistică" : "📊 Vezi analiza statistică";
      if (open) box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    mountRebrand(el.querySelector(".rebrand-slot"), { a, s, imp, target, analysisId, vs });
    el.querySelector("[data-toggle-full]").addEventListener("click", (e) => {
      e.preventDefault();
      const full = el.querySelector(".full-details");
      const open = full.classList.toggle("hidden") === false;
      e.target.textContent = open ? "Ascunde detaliile" : "Toate tabelele și graficele";
    });
    return;
  }
  el.innerHTML = `
    <h2>${esc(target)} — ${esc(a.ads.title ?? "reclamă")}</h2>
    <div class="grid2">
      <div>
        <div class="big">${pct(s.attribution)} <small>atribuire corectă · ±${pct(s.attribution_sd)} (n=${s.n_evals}${s.use_memory ? ", cu memorie" : ", fără memorie"})</small></div>
        ${ctrl ? `<p class="muted">Control fără memorie: ${pct(ctrl.attribution)} — ce brand e deja cunoscut din antrenare.</p>` : ""}
        <h3>Unde se duce probabilitatea</h3>
        <div class="bars">${dist.map(([b, p]) => `<div class="bar ${b === target ? "target" : ""}"><span>${esc(b)}</span>
          <div class="track"><div class="fill" style="width:${(p * 100).toFixed(1)}%"></div></div><span>${pct(p)}</span></div>`).join("")}</div>
      </div>
      <div>
        <h3 style="margin-top:0">Raport</h3>
        <div class="report">${esc(a.report)}</div>
      </div>
    </div>
    ${imp.length ? `<h3>Ablație — ce poartă brandul</h3>
    <table><thead><tr><th>Element</th><th>Δ atribuire</th><th>Atrage spre</th><th>Citat ca indiciu</th><th>Diagnostic</th></tr></thead><tbody>
    ${imp.map((i) => {
      const [tb, tp] = Object.entries(i.pull_shift).sort((x, y) => y[1] - x[1])[0] ?? ["—", 0];
      return `<tr><td>${esc(i.element)}</td><td>${i.delta >= 0 ? "+" : ""}${i.delta.toFixed(2)}</td>
        <td>${tp > 0.01 ? `${esc(tb)} (+${pct(tp)})` : "—"}</td><td>${pct(i.cue_rate)}</td>
        <td><span class="dx ${i.diagnosis}">${DX[i.diagnosis]}</span></td></tr>`;
    }).join("")}</tbody></table>
    <p class="muted">Praguri: asset Δ &gt; ${s.thresholds.asset}, decor |Δ| &lt; ${s.thresholds.decor}, trădător dacă atrage &gt; ${pct(s.thresholds.traitor)} spre un concurent.</p>` : ""}
    ${charts({ a, vs, imp, target, s })}
    <h3>Variante testate</h3>
    <div class="variants">${vs.map((v) => `<figure><img src="${imgUrl(v.image_path)}" loading="lazy" alt="" />
      <figcaption><b>${v.kind === "base" ? "Bază (mascat)" : v.kind === "ablation" ? "Fără: " + esc(v.element) : "Generată: " + esc(v.element)}</b><br>
      ${pct(v.attribution)} ±${pct(v.attribution_sd)}${v.kind === "generated" && base ? ` · ${v.attribution - base.attribution >= 0 ? "+" : ""}${Math.round((v.attribution - base.attribution) * 100)} pp` : ""}</figcaption></figure>`).join("")}</div>`;
}

// Culoarea urmează brandul (ordine fixă, alfabetică), nu poziția în clasament
const SLOTS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
function brandColors(names) {
  const sorted = [...names].filter((n) => n !== "nu știu").sort((x, y) => x.localeCompare(y, "ro"));
  const m = Object.fromEntries(sorted.map((n, i) => [n, `var(${SLOTS[i % SLOTS.length]})`]));
  m["nu știu"] = "var(--unk)";
  return m;
}
const vname = (v) => (v.kind === "base" ? "Bază (logo mascat)" : v.kind === "ablation" ? `Fără: ${v.element}` : `Generată: ${v.element}`);

function charts({ a, vs, imp, target, s }) {
  const done = vs.filter((v) => v.distribution);
  if (!done.length) return "";
  const names = [...new Set(done.flatMap((v) => Object.keys(v.distribution)))];
  const col = brandColors(names);
  const order = [target, ...names.filter((n) => n !== target && n !== "nu știu").sort((x, y) => x.localeCompare(y, "ro")), "nu știu"]
    .filter((n) => names.includes(n));
  const legend = `<div class="legend">${order.map((n) => `<span><i style="background:${col[n]}"></i>${esc(n)}${n === target ? " (brandul testat)" : ""}</span>`).join("")}</div>`;

  // 1) Distribuția voturilor pe fiecare variantă
  const rows = done.map((v) => `<div class="srow"><span class="lbl" title="${esc(vname(v))}">${esc(vname(v))}</span>
    <div class="stack">${order.map((n) => {
      const p = v.distribution[n] ?? 0;
      return p > 0.004 ? `<span style="width:${(p * 100).toFixed(2)}%;background:${col[n]}" data-tip="<b>${esc(vname(v))}</b><br>${esc(n)}: ${pct(p)}"></span>` : "";
    }).join("")}</div><span class="val" data-tip="Atribuire corectă ± abatere standard">${pct(v.attribution)}</span></div>`).join("");
  let html = `<div class="viz"><h3>Cui atribuie panelul fiecare variantă</h3>
    <p class="sub">Fiecare bară = 100% din probabilitatea panelului. Cifra din dreapta = atribuirea corectă către ${esc(target)}.</p>
    ${legend}${rows}
    <div class="axis"><span></span><div class="ticks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div><span></span></div></div>`;

  // 2) Impactul elementelor (Δ), divergent în jurul lui 0
  if (imp.length) {
    const max = Math.max(0.3, ...imp.map((i) => Math.abs(i.delta))) * 1.05;
    const xp = (d) => 50 + (d / max) * 50;
    html += `<div class="viz"><h3>Ce element poartă brandul</h3>
      <p class="sub">Δ = cât scade atribuirea corectă când elementul e scos. Spre dreapta: elementul ajută brandul. Spre stânga: fără el, brandul e recunoscut mai bine. Linia punctată = pragul de asset (Δ ${s.thresholds.asset}).</p>
      <div class="legend"><span><i style="background:var(--pos)"></i>ajută recunoașterea</span><span><i style="background:var(--neg)"></i>încurcă recunoașterea</span></div>
      ${imp.map((i) => {
        const [tb, tp] = Object.entries(i.pull_shift).sort((x, y) => y[1] - x[1])[0] ?? ["—", 0];
        const w = Math.abs(xp(i.delta) - 50), pos = i.delta >= 0;
        const tip = `<b>${esc(i.element)}</b><br>Δ ${i.delta >= 0 ? "+" : ""}${i.delta.toFixed(2)}<br>${tp > 0.01 ? `Atrage spre ${esc(tb)}: +${pct(tp)}<br>` : ""}Citat ca indiciu: ${pct(i.cue_rate)}`;
        return `<div class="drow"><span class="lbl">${esc(i.element)}</span><div class="dtrack" data-tip="${tip}">
          <span class="thr" style="left:${xp(s.thresholds.asset)}%"></span><span class="zero"></span>
          <span class="bar ${pos ? "pos" : "neg"}" style="${pos ? `left:50%` : `left:${50 - w}%`};width:${w}%"></span></div>
          <span><span class="dx ${i.diagnosis}">${DX[i.diagnosis]}</span> ${i.delta >= 0 ? "+" : ""}${i.delta.toFixed(2)}</span></div>`;
      }).join("")}
      <div class="axis d"><span></span><div class="ticks"><span>−${max.toFixed(2)}</span><span>0</span><span>+${max.toFixed(2)}</span></div><span></span></div></div>`;
  }

  // 3) Similaritate vizuală cu fiecare brand (embeddings)
  const sim = a.similarity;
  if (sim?.per_brand && Object.keys(sim.per_brand).length) {
    const vals = Object.values(sim.per_brand).concat(sim.typical ?? []);
    const lo = Math.max(0, Math.min(...vals) - 0.05), hi = Math.min(1, Math.max(...vals) + 0.03);
    const xp = (v) => ((v - lo) / (hi - lo)) * 100;
    const ents = Object.entries(sim.per_brand).sort((x, y) => y[1] - x[1]);
    html += `<div class="viz"><h3>Cu cine seamănă vizual reclama mascată</h3>
      <p class="sub">Similaritate cosinus între embedding-ul reclamei mascate și reclamele fiecărui brand (${esc(sim.model)}). Linia punctată = cât de asemănătoare sunt în medie reclamele din categorie între ele.
      ${sim.generic ? `<b>Reclamă generică:</b> seamănă cu concurența peste nivelul tipic al categoriei.` : sim.generic === false ? "Reclama se distinge de categorie." : ""}</p>
      ${ents.map(([b, v]) => `<div class="srow"><span class="lbl">${esc(b)}${b === target ? " (propriu)" : ""}</span>
        <div class="dots">${sim.typical != null ? `<span class="typ" style="left:${xp(sim.typical)}%" data-tip="Tipic în categorie: ${sim.typical.toFixed(3)}"></span>` : ""}
        <span class="dot" style="left:${xp(v)}%;background:${col[b] ?? "var(--unk)"}" data-tip="<b>${esc(b)}</b><br>similaritate ${v.toFixed(3)}"></span></div>
        <span class="val">${v.toFixed(2)}</span></div>`).join("")}
      <div class="axis"><span></span><div class="ticks"><span>${lo.toFixed(2)}</span><span>${hi.toFixed(2)}</span></div><span></span></div></div>`;
  } else if (sim?.error) {
    html += `<p class="muted">Similaritatea nu s-a putut calcula: ${esc(sim.error)}</p>`;
  }
  return html;
}

// ---------- raport statistic (versiunea 2) ----------
const pctCI = (ci) => (ci && Number.isFinite(ci[0]) ? `[${Math.round(ci[0] * 100)}%, ${Math.round(ci[1] * 100)}%]` : "—");
const ppCI = (ci) => (ci && Number.isFinite(ci[0]) ? `[${(ci[0] * 100).toFixed(0)}, ${(ci[1] * 100).toFixed(0)}] pp` : "—");
const fmtP = (p) => (!Number.isFinite(p) ? "—" : p < 0.001 ? "< .001" : p.toFixed(3).replace(/^0/, ""));
const starsOf = (p) => (!Number.isFinite(p) ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "ns");
const sgn = (x, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const REPORT_SECTIONS = [["sinteza", "Sinteză"], ["variabile", "Variabile analizate"], ["metoda", "Metodă"],
  ["rezultate", "Rezultate"], ["verificari", "Verificări de calitate"], ["limite", "Limite"], ["recomandare", "Recomandare"]];

function reportHtml(report) {
  let r = null;
  try { r = JSON.parse(report); } catch {}
  if (!r || typeof r !== "object") return `<div class="report">${esc(report)}</div>`;
  return `<div class="report-sections">${REPORT_SECTIONS.filter(([k]) => r[k]).map(([k, t]) =>
    `<section class="rs ${k}"><h4>${t}</h4><p>${esc(r[k])}</p></section>`).join("")}</div>`;
}

// Statistica pe scurt: 6 indicatori + un grafic (forest plot dacă există elemente, altfel atribuirea cu IC)
function compactStats({ a, s, vs, imp, target }) {
  const P = s.profile ?? {}, t1 = P.top1_agreement ?? {};
  const chanceTxt = P.chance != null ? `${Math.round(P.chance * 100)}%` : "—";
  const conf = Object.entries(s.confusion ?? {}).sort((x, y) => y[1].mean - x[1].mean)[0];
  const top = [...imp].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
  const st = top?.stats ?? {};
  const leak = P.leak?.rate >= 0.3;
  const rows = [
    ["Atribuire corectă", `${pct(s.attribution)}, IC 95% ${pctCI(s.attribution_ci)}`,
      s.above_chance ? `peste nivelul șansei (${chanceTxt})` : `nu se distinge de șansă (${chanceTxt})`, s.above_chance ? "good" : "bad"],
    ["Acord între evaluatori", t1.n ? `${t1.k}/${t1.n} (${pct(t1.rate)}), IC ${pctCI(t1.ci)}` : "—",
      "aleg brandul corect pe primul loc", t1.rate >= 0.7 ? "good" : t1.rate >= 0.4 ? "warn" : "bad"],
    ["Confuzie principală", conf ? `${esc(conf[0])}: ${pct(conf[1].mean)}, IC ${pctCI(conf[1].ci)}` : "—",
      "probabilitatea dată concurentului", conf && conf[1].mean > 0.25 ? "bad" : "good"],
    ["Cel mai puternic element", top ? `${esc(top.element)}: Δ ${sgn(top.delta)}, p ${fmtP(st.p_holm)} ${starsOf(st.p_holm)}, g ${Number.isFinite(st.g) ? st.g.toFixed(2) : "—"}` : "nu au fost testate elemente",
      top ? DX[top.diagnosis] : "adaugă elemente în editor", top ? ({ asset_puternic: "good", tradator: "bad", neconcludent: "warn" }[top.diagnosis] ?? "") : ""],
    ["Calitatea datelor", leak ? `mascare incompletă (${pct(P.leak.rate)} au citit numele)` : `mascare OK · ${P.n_invalid ?? 0} voturi invalide`,
      leak ? "rezultat nevalid" : "date utilizabile", leak ? "bad" : (P.n_invalid ? "warn" : "good")],
    ["Putere statistică", `n = ${P.n_per_variant} evaluări/variantă`, `efect minim detectabil ≈ ${Math.round((P.mde ?? 0) * 100)} pp`,
      (P.mde ?? 1) <= 0.15 ? "good" : "warn"],
  ];
  const chart = imp.length ? statsView({ a, s, vs, imp, target, part: "chart2" }) : statsView({ a, s, vs, imp, target, part: "chart1" });
  return `<div class="compact">
    <h3>Analiza statistică pe scurt</h3>
    <table class="kpis"><tbody>${rows.map(([k, v, note, tone]) => `<tr><th>${k}</th><td>${v}</td><td><span class="chip ${tone}">${esc(note)}</span></td></tr>`).join("")}</tbody></table>
    ${chart}
    <p class="note">IC = interval de încredere 95% (bootstrap). p corectat Holm; * p&lt;.05, ** p&lt;.01, *** p&lt;.001. g = mărimea efectului (Hedges).
      <a href="#" data-toggle-full>Toate tabelele și graficele</a></p>
  </div>`;
}

// Rezumat pe înțelesul oricui: verdict, 3 cifre, ce funcționează / ce încurcă, ce să faci
function summaryView({ a, s, imp, target }) {
  const P = s.profile ?? {};
  let rep = {};
  try { rep = JSON.parse(a.report) || {}; } catch {}
  const critic = (s.alerts ?? []).find((x) => x.level === "critic");
  const conf = Object.entries(s.confusion ?? {}).sort((x, y) => y[1].mean - x[1].mean)[0];
  const att = s.attribution ?? 0, ci = s.attribution_ci ?? [NaN, NaN];
  const width = Number.isFinite(ci[0]) ? ci[1] - ci[0] : 1;
  const certainty = s.above_chance && width < 0.3 ? ["sigur", "good"] : s.above_chance ? ["orientativ", "warn"] : ["nesigur", "bad"];

  let verdict, tone;
  if (critic) { verdict = "Rezultat nevalid: numele brandului se vede încă în reclamă"; tone = "bad"; }
  else if (conf && conf[1].mean > att) { verdict = `Reclama e confundată cu ${conf[0]}`; tone = "bad"; }
  else if (att >= 0.6 && s.above_chance) { verdict = `Reclama e recunoscută ca ${target} și fără logo`; tone = "good"; }
  else if (s.above_chance) { verdict = `Reclama e recunoscută parțial ca ${target}`; tone = "warn"; }
  else { verdict = `Fără logo, reclama nu e recunoscută ca ${target}`; tone = "bad"; }

  const sim = s.similarity;
  const distinct = sim?.generic == null ? ["—", ""] : sim.generic ? ["Seamănă cu restul categoriei", "warn"] : ["Se distinge de categorie", "good"];

  const plain = (i) => {
    const pp = Math.round(Math.abs(i.delta) * 100), st = i.stats ?? {};
    switch (i.diagnosis) {
      case "asset_puternic": return ["good", `<b>${esc(i.element)}</b> te face recognoscibil: fără el, recunoașterea scade cu ${pp} puncte.`];
      case "tradator": return ["bad", `<b>${esc(i.element)}</b> te face să semeni cu ${esc(st.top_competitor ?? "un concurent")}${st.top_pull ? ` (+${Math.round(st.top_pull * 100)} puncte spre el)` : ""}.`];
      case "decor": return ["neutral", `<b>${esc(i.element)}</b> nu contează pentru recunoaștere.`];
      case "neconcludent": return ["warn", `<b>${esc(i.element)}</b> pare să ${i.delta >= 0 ? "ajute" : "încurce"} (${pp} puncte), dar datele nu sunt încă suficiente ca să fim siguri.`];
      default: return ["neutral", `<b>${esc(i.element)}</b> are un efect mic asupra recunoașterii.`];
    }
  };
  const items = imp.map(plain);
  const icon = { good: "✓", bad: "✕", warn: "?", neutral: "–" };
  const elementsBlock = items.length ? `<div class="sum-block"><h3>Ce funcționează și ce încurcă</h3>
    <ul class="plain">${items.map(([t, h]) => `<li class="${t}"><span class="ic">${icon[t]}</span><span>${h}</span></li>`).join("")}</ul></div>` : "";
  const todo = critic
    ? "Acoperă cu dreptunghiul Logo și textul care numește brandul (de exemplu textele legale mici) și rulează din nou analiza."
    : rep.recomandare || "";

  return `
    <h2>${esc(target)} — ${esc(a.ads.title ?? "reclamă")}</h2>
    <div class="verdict ${tone}">${esc(verdict)}</div>
    ${critic ? `<p class="crit-note">${esc(critic.text)}</p>` : ""}
    <div class="tiles">
      <div class="tile"><span class="t-lbl">Recunoaștere fără logo</span><span class="t-val">${pct(att)}</span>
        <span class="t-sub">din panel îl ghicește corect · <span class="chip ${certainty[1]}">rezultat ${certainty[0]}</span></span></div>
      <div class="tile"><span class="t-lbl">Cel mai des confundat cu</span><span class="t-val">${conf ? esc(conf[0]) : "—"}</span>
        <span class="t-sub">${conf ? `${pct(conf[1].mean)} din panel` : ""}</span></div>
      <div class="tile"><span class="t-lbl">Cât de distinctă e vizual</span><span class="t-val sm">${esc(distinct[0])}</span>
        <span class="t-sub">${sim?.nearest_brand ? `cel mai apropiat: ${esc(sim.nearest_brand)}` : ""}</span></div>
    </div>
    ${rep.sinteza && !critic ? `<p class="sum-text">${esc(rep.sinteza)}</p>` : ""}
    ${elementsBlock}
    ${todo ? `<div class="todo"><h3>Ce să faci</h3><p>${esc(todo)}</p></div>` : ""}
    <p class="muted small">Pe baza a ${P.n_per_variant ?? "—"} evaluări AI pe variantă${P.leak?.rate ? "" : ""}. Un pre-test rapid, nu un panel cu oameni.</p>`;
}

function statsView({ a, s, vs, imp, target, ctrl, part }) {
  const P = s.profile, col = brandColors([target, ...Object.keys(s.confusion ?? {}), "nu știu"]);
  const alerts = (s.alerts ?? []).map((x) => `<div class="alert ${x.level}"><b>${x.level === "critic" ? "Critic" : x.level === "atentie" ? "Atenție" : "OK"}</b> ${esc(x.text)}</div>`).join("");
  const chanceTxt = P.chance != null ? `${Math.round(P.chance * 100)}%` : "—";

  // Grafic 1: atribuirea pe fiecare variantă, punct = medie, bară = IC 95%, linie = nivelul șansei
  const rows = s.variants.map((v) => {
    const lo = v.ci?.[0] ?? v.mean, hi = v.ci?.[1] ?? v.mean;
    const label = v.kind === "base" ? "Bază (logo mascat)" : v.kind === "ablation" ? `Fără: ${v.element}` : `Generată: ${v.element}`;
    return `<div class="ci-row"><span class="lbl" title="${esc(label)}">${esc(label)}</span>
      <div class="ci-track" data-tip="<b>${esc(label)}</b><br>M = ${pct(v.mean)}, IC 95% ${pctCI(v.ci)}<br>n = ${v.n} evaluări">
        ${P.chance != null ? `<span class="chance" style="left:${P.chance * 100}%"></span>` : ""}
        <span class="whisk" style="left:${lo * 100}%;width:${Math.max(0.4, (hi - lo) * 100)}%"></span>
        <span class="pt ${v.kind}" style="left:${v.mean * 100}%"></span></div>
      <span class="val">${pct(v.mean)}</span></div>`;
  }).join("");
  const chart1 = `<div class="viz"><h3>Atribuirea corectă pe fiecare variantă</h3>
    <p class="sub">Punct = media panelului, bară = interval de încredere 95% (bootstrap). Linia punctată = nivelul șansei (${chanceTxt}, ghicit la întâmplare între ${P.candidates} branduri).</p>
    ${rows}<div class="axis"><span></span><div class="ticks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div><span></span></div></div>`;

  // Grafic 2: forest plot pentru Δ (bază − fără element), cu IC 95% și semnificație după Holm
  let chart2 = "";
  if (imp.length) {
    const ext = Math.max(0.3, ...imp.flatMap((i) => [Math.abs(i.stats?.ci?.[0] ?? i.delta), Math.abs(i.stats?.ci?.[1] ?? i.delta)])) * 1.08;
    const xp = (d) => 50 + (d / ext) * 50;
    chart2 = `<div class="viz"><h3>Ce element poartă brandul — efectul eliminării</h3>
      <p class="sub">Δ = atribuirea de bază minus atribuirea fără element. Spre dreapta: elementul ajută recunoașterea. Bară = IC 95%; stelele = semnificație după corecția Holm (* p&lt;.05, ** p&lt;.01, *** p&lt;.001, ns = nesemnificativ). Linia punctată = pragul de asset (Δ ${s.thresholds.asset}).</p>
      ${imp.map((i) => {
        const st = i.stats ?? {}, ci = st.ci ?? [i.delta, i.delta];
        const tip = `<b>${esc(i.element)}</b><br>Δ = ${sgn(i.delta)} (${Math.round(i.delta * 100)} pp), IC 95% ${ppCI(ci)}<br>p (Holm) ${fmtP(st.p_holm)}, Hedges g = ${Number.isFinite(st.g) ? st.g.toFixed(2) : "—"} (${esc(st.effect ?? "")})` +
          (st.top_pull > 0.01 ? `<br>Atrage spre ${esc(st.top_competitor)}: +${pct(st.top_pull)}, p (Holm) ${fmtP(st.p_pull_holm)}` : "");
        return `<div class="frow"><span class="lbl">${esc(i.element)}</span>
          <div class="ftrack" data-tip="${tip}"><span class="zero"></span><span class="thr" style="left:${xp(s.thresholds.asset)}%"></span>
            <span class="fci ${i.diagnosis}" style="left:${xp(Math.min(ci[0], ci[1]))}%;width:${Math.max(0.5, Math.abs(xp(ci[1]) - xp(ci[0])))}%"></span>
            <span class="fpt ${i.diagnosis}" style="left:${xp(i.delta)}%"></span></div>
          <span class="fval">${sgn(i.delta)} <b>${starsOf(st.p_holm)}</b> <span class="dx ${i.diagnosis}">${DX[i.diagnosis]}</span></span></div>`;
      }).join("")}
      <div class="axis f"><span></span><div class="ticks"><span>−${ext.toFixed(2)}</span><span>0</span><span>+${ext.toFixed(2)}</span></div><span></span></div></div>`;
  }

  if (part === "chart1") return chart1;
  if (part === "chart2") return chart2;

  // Tabel: rezultate per element (format APA)
  const table = imp.length ? `<div class="viz"><h3>Tabelul 1. Efectul fiecărui element asupra atribuirii</h3>
    <div class="tscroll"><table class="apa"><thead><tr><th>Element</th><th>M fără element</th><th>Δ</th><th>IC 95%</th><th>p (Holm)</th><th>Hedges g</th><th>Confuzie principală</th><th>Diagnostic</th></tr></thead><tbody>
    ${imp.map((i) => { const st = i.stats ?? {}; return `<tr><td>${esc(i.element)}</td><td>${pct(st.mean_variant)}</td><td>${sgn(i.delta)}</td>
      <td>${ppCI(st.ci)}</td><td>${fmtP(st.p_holm)} ${starsOf(st.p_holm)}</td><td>${Number.isFinite(st.g) ? st.g.toFixed(2) : "—"} <span class="muted">${esc(st.effect ?? "")}</span></td>
      <td>${st.top_pull > 0.01 ? `${esc(st.top_competitor)} ${sgn(st.top_pull * 100, 0)} pp` : "—"}</td><td><span class="dx ${i.diagnosis}">${DX[i.diagnosis]}</span></td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="note">Notă. n = ${P.n_per_variant} evaluări pe variantă. Δ = M(bază) − M(fără element). IC bootstrap percentile (4000 reeșantionări); p din test de permutare bilateral (5000 permutări), corectat Holm. Asset: Δ &gt; ${s.thresholds.asset} și p &lt; .05; trădător: atrage &gt; ${Math.round(s.thresholds.traitor * 100)} pp spre un concurent, semnificativ; decor: |Δ| &lt; ${s.thresholds.decor} cu IC care include 0; neconcludent: efect vizibil, dar nesemnificativ.</p></div>` : "";

  // Tabel: variabile analizate
  const elems = imp.map((i) => i.element);
  const gens = (s.generated ?? []).map((g) => g.element);
  const vars = [
    ["Atribuire corectă", "Dependentă", "Continuă, 0–1", `Probabilitatea pe care fiecare evaluator o acordă brandului ${target}`],
    ["Variantă", "Independentă (manipulată)", "Categorială", `Bază; fără: ${elems.join(", ") || "—"}${gens.length ? `; generate: ${gens.join(", ")}` : ""}`],
    ["Confuzie cu concurentul", "Dependentă secundară", "Continuă, 0–1", `Probabilitatea acordată fiecărui concurent (${Object.keys(s.confusion ?? {}).join(", ")})`],
    ["„Nu știu”", "Dependentă secundară", "Continuă, 0–1", "Nesiguranța panelului"],
    ["Acord top-1", "Descriptivă", "Proporție", "Ponderea evaluatorilor al căror prim vot e brandul corect"],
    ["Similaritate vizuală", "Descriptivă", "Cosinus, −1–1", "Embedding gemini-embedding-2, reclama mascată vs. reclamele fiecărui brand"],
    ["Ordinea candidaților", "Control", "Randomizată", "Amestecată la fiecare evaluare (elimină biasul de poziție)"],
    ["Mascarea logo-ului", "Control", "Constantă", "Același gri plat pe toate variantele"],
    ["Memorie însămânțată", "Control", s.use_memory ? "Activă" : "Inactivă", s.use_memory ? Object.entries(P.memory_per_brand ?? {}).map(([b, n]) => `${b}: ${n}`).join(", ") : "—"],
    ["Elemente comune categoriei", "Control", "Excluse", (s.generic_elements ?? []).join(", ") || "—"],
  ];
  const varTable = `<div class="viz"><h3>Variabile analizate</h3><div class="tscroll"><table class="apa"><thead><tr><th>Variabilă</th><th>Rol</th><th>Tip</th><th>Măsurare</th></tr></thead>
    <tbody>${vars.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;

  // Profilul datelor
  const t1 = P.top1_agreement ?? {};
  const prof = [
    ["Evaluări pe variantă", P.n_per_variant], ["Variante", P.n_variants], ["Voturi totale / invalide", `${P.n_votes} / ${P.n_invalid}`],
    ["Candidați (fără „nu știu”)", `${P.candidates} · nivelul șansei ${chanceTxt}`],
    ["Acord top-1 pe bază", t1.n ? `${t1.k}/${t1.n} (${pct(t1.rate)}), IC Wilson ${pctCI(t1.ci)}` : "—"],
    ["„Nu știu” mediu", pct(P.unknown_mean)], ["Dispersia voturilor (entropie 0–1)", Number.isFinite(P.entropy_mean) ? P.entropy_mean.toFixed(2) : "—"],
    ["Efect minim detectabil (α=.05, putere .80)", `${Math.round(P.mde * 100)} pp`],
    ["Text cu numele brandului citit de panel", P.leak?.rate ? `${pct(P.leak.rate)} — ${P.leak.texts.join("; ")}` : "nu"],
  ];
  const profTable = `<div class="viz"><h3>Profilul datelor</h3><div class="tscroll"><table class="apa kv"><tbody>
    ${prof.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`).join("")}</tbody></table></div></div>`;

  const conf = Object.entries(s.confusion ?? {}).sort((x, y) => y[1].mean - x[1].mean)[0];
  return `
    <h2>${esc(target)} — ${esc(a.ads.title ?? "reclamă")} <span class="muted">· ${esc(s.category)}</span></h2>
    ${alerts}
    <div class="grid2">
      <div>
        <div class="big">${pct(s.attribution)} <small>atribuire corectă</small></div>
        <p class="kpi">IC 95% ${pctCI(s.attribution_ci)} · n = ${P.n_per_variant} · ${s.use_memory ? "cu memorie" : "fără memorie"}</p>
        <p class="kpi">${s.above_chance == null ? "" : s.above_chance ? `Peste nivelul șansei (${chanceTxt}): întreg intervalul e deasupra.` : `Nu se poate distinge de nivelul șansei (${chanceTxt}).`}</p>
        ${conf ? `<p class="kpi">Confuzie principală: <b>${esc(conf[0])}</b> ${pct(conf[1].mean)}, IC 95% ${pctCI(conf[1].ci)}</p>` : ""}
        ${ctrl ? `<p class="kpi">Control fără memorie: ${pct(ctrl.attribution)} — cât din recunoaștere vine din ce știa deja modelul.</p>` : ""}
      </div>
      <div><h3 style="margin-top:0">Raportul statisticianului</h3>${reportHtml(a.report)}</div>
    </div>
    ${chart1}${chart2}${table}
    ${charts({ a, vs, imp: [], target, s })}
    <div class="grid2">${varTable}${profTable}</div>
    <h3>Variante testate</h3>
    <div class="variants">${vs.map((v) => { const st = s.variants.find((x) => x.kind === v.kind && x.element === v.element);
      return `<figure><img src="${imgUrl(v.image_path)}" loading="lazy" alt="" />
      <figcaption><b>${v.kind === "base" ? "Bază (mascat)" : v.kind === "ablation" ? "Fără: " + esc(v.element) : "Generată: " + esc(v.element)}</b><br>
      ${pct(st?.mean ?? v.attribution)} · IC ${pctCI(st?.ci)}</figcaption></figure>`; }).join("")}</div>`;
}

// ---------- rebranding: interviu de brand (voce sau text) → 3 direcții → A/B test în panel ----------
const BRIEF_Q = [
  ["promisiune", "Ce promite brandul, într-o propoziție?", "ex. Apă pură, direct din inima munților"],
  ["valori", "Care sunt cele 3 valori ale brandului?", "ex. puritate, natură, echilibru"],
  ["personalitate", "Dacă brandul ar fi un om, cum ar fi?", "", ["prietenos", "premium", "jucăuș", "de încredere", "aventuros", "rebel", "cald", "minimalist"]],
  ["ton", "Ce ton are comunicarea?", "", ["serios", "cald", "amuzant", "inspirațional", "direct"]],
  ["pastreaza", "Ce active trebuie păstrate?", "culoare, mascotă, formă, slogan"],
  ["evita", "Ce trebuie evitat?", "culori, stiluri sau asocieri nedorite"],
  ["constrangeri", "Există constrângeri?", "ghid de brand, cerințe legale, buget"],
  ["obiectiv", "Care e obiectivul rebrandingului?", ""],
  ["public", "Cui te adresezi?", "ex. familii și tineri activi"],
  ["curaj", "Cât de curajos poate fi?", "", ["ajustare fină", "echilibrat", "schimbare totală"]],
];
function needsRebrand(s) {
  const sim = s.similarity ?? {}, conf = Object.values(s.confusion ?? {}).reduce((m, x) => Math.max(m, x.mean), 0);
  return sim.generic === true || (sim.nearest != null && sim.own_brand != null && sim.nearest > sim.own_brand) || conf > (s.attribution ?? 0);
}

async function mountRebrand(slot, ctx) {
  const { s, imp, target, analysisId } = ctx;
  const rival = s.similarity?.nearest_brand ?? Object.entries(s.confusion ?? {}).sort((x, y) => y[1].mean - x[1].mean)[0]?.[0];
  const need = needsRebrand(s);
  const assets = imp.filter((i) => i.diagnosis === "asset_puternic").map((i) => i.element);
  slot.innerHTML = `<div class="rb-cta ${need ? "hot" : ""}">
      <div><b>${need ? `Reclama seamănă prea mult cu ${esc(rival ?? "concurența")}` : "Vrei să faci reclama și mai distinctivă?"}</b>
      <p>${need ? "Răspunde la câteva întrebări despre brand și primești 3 direcții de rebranding, testate apoi automat în panel." : "Poți genera direcții de rebranding pornind de la identitatea brandului."}</p></div>
      <button type="button" class="primary inline-cta" data-rb-open>✨ Pornește rebrandingul</button></div>
    <div class="rb-panel hidden"></div><div class="rb-result"></div>`;
  const panel = slot.querySelector(".rb-panel");
  slot.querySelector("[data-rb-open]").addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.dataset.ready) { renderBriefForm(panel, ctx, { rival, assets }); panel.dataset.ready = 1; }
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // ultimul rebranding salvat pentru această analiză
  const { data: prev } = await sb.from("rebrands").select("*").eq("analysis_id", analysisId).order("created_at", { ascending: false }).limit(1);
  if (prev?.[0]?.result) renderRebrand(slot.querySelector(".rb-result"), ctx, { id: prev[0].id, result: prev[0].result, images: prev[0].images ?? [], image_error: prev[0].image_error });
}

function renderBriefForm(panel, ctx, { rival, assets }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  panel.innerHTML = `
    <div class="rb-step"><span class="rb-num">1</span><div>
      <h3>Interviu de brand</h3>
      <p class="muted">Apasă pe microfon și povestește liber despre brand: ce promite, cum e, cui se adresează, ce vrei să păstrezi. Sau scrie mai jos.</p>
      <div class="rb-voice">
        ${SR ? `<button type="button" class="mic" data-mic title="Vorbește">🎙</button>` : `<span class="muted small">Dictarea nu e disponibilă în acest browser; scrie textul.</span>`}
        <textarea data-transcript rows="4" placeholder="ex. Dorna e apa din inima munților Bucovinei, pură și naturală. Vrem să fim calzi și de încredere…"></textarea>
      </div>
      <button type="button" class="ghost" data-extract>✨ Completează formularul din ce am spus</button>
      <span class="muted small" data-extract-status></span>
    </div></div>
    <div class="rb-step"><span class="rb-num">2</span><div>
      <h3>Identitatea brandului</h3><p class="muted">Toate câmpurile sunt opționale. Poți corecta ce a completat AI-ul.</p>
      <div class="rb-form">${BRIEF_Q.map(([k, q, ph, opts]) => `<label class="rb-q"><span>${q}</span>
        ${opts ? `<div class="opts" data-opts="${k}">${opts.map((o) => `<button type="button" class="opt" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}
        <input data-k="${k}" placeholder="${esc(ph)}" /></label>`).join("")}</div>
    </div></div>
    <div class="rb-step"><span class="rb-num">3</span><div>
      <h3>Generează</h3>
      <label class="inline"><input type="checkbox" data-images checked /> generează reclamele noi ca imagini (AI gratuit, FLUX)</label>
      <button type="button" class="primary big" data-go>✨ Generează 3 direcții de rebranding</button>
      <div class="muted" data-go-status></div>
    </div></div>`;
  const val = (k) => panel.querySelector(`[data-k="${k}"]`);
  val("obiectiv").value = rival ? `diferențiere față de ${rival}` : "";
  val("pastreaza").value = assets.join(", ");
  // opțiunile rapide completează câmpul (multi-select pentru personalitate)
  panel.querySelectorAll("[data-opts]").forEach((box) => box.addEventListener("click", (e) => {
    const b = e.target.closest(".opt"); if (!b) return;
    const k = box.dataset.opts, input = val(k), multi = k === "personalitate";
    if (!multi) { box.querySelectorAll(".opt").forEach((x) => x.classList.toggle("on", x === b)); input.value = b.dataset.v; return; }
    b.classList.toggle("on");
    input.value = [...box.querySelectorAll(".opt.on")].map((x) => x.dataset.v).join(", ");
  }));
  // dictare (Web Speech API, română)
  const mic = panel.querySelector("[data-mic]"), ta = panel.querySelector("[data-transcript]");
  if (mic && SR) {
    let rec = null, base = "";
    mic.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = "ro-RO"; rec.continuous = true; rec.interimResults = true;
      base = ta.value ? ta.value.trim() + " " : "";
      rec.onresult = (ev) => {
        let fin = "", tmp = "";
        for (const r of ev.results) (r.isFinal ? (fin += r[0].transcript + " ") : (tmp += r[0].transcript));
        ta.value = base + fin + tmp;
      };
      rec.onend = () => { mic.classList.remove("rec"); rec = null; };
      rec.onerror = (ev) => { panel.querySelector("[data-extract-status]").textContent = `Microfon: ${ev.error}`; };
      rec.start(); mic.classList.add("rec");
    });
  }
  panel.querySelector("[data-extract]").addEventListener("click", async (e) => {
    const st = panel.querySelector("[data-extract-status]");
    e.target.disabled = true; st.textContent = "Extrag răspunsurile…";
    try {
      const out = await invoke({ action: "brief_from_text", text: ta.value, brand: ctx.target });
      let n = 0;
      for (const [k] of BRIEF_Q) if (out?.[k]) { val(k).value = out[k]; n++; }
      st.textContent = `Am completat ${n} răspunsuri. Verifică-le mai jos.`;
    } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    finally { e.target.disabled = false; }
  });
  panel.querySelector("[data-go]").addEventListener("click", async (e) => {
    const st = panel.querySelector("[data-go-status]"), btn = e.target;
    const brief = Object.fromEntries(BRIEF_Q.map(([k]) => [k, val(k).value.trim()]).filter(([, v]) => v));
    const images = panel.querySelector("[data-images]").checked;
    btn.disabled = true; btn.textContent = "Generez direcțiile…";
    st.textContent = images ? "Întâi strategia (câteva secunde), apoi cele 3 reclame noi apar pe rând." : "Durează câteva secunde.";
    try {
      const out = await invoke({ action: "rebrand", analysis_id: ctx.analysisId, brief, images });
      const box = panel.parentElement.querySelector(".rb-result");
      renderRebrand(box, ctx, { ...out, autoImages: images });
      panel.classList.add("hidden");
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; btn.textContent = "✨ Generează 3 direcții de rebranding"; }
  });
}

// Previzualizare gratuită, în browser: recolorează reclama cu paleta direcției (gradient map pe luminozitate,
// păstrând detaliile și zonele gri ale măștii neatinse). Rezultatul poate fi testat în panel ca orice variantă.
const hexRgb = (h) => { const m = String(h).replace("#", "").match(/^([0-9a-f]{6})$/i); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
async function recolorPreview(url, hexes) {
  const pal = hexes.map(hexRgb).filter(Boolean).sort((x, y) => lum(x) - lum(y));
  if (pal.length < 2) return null;
  const img = await loadImage(url);
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), px = d.data, k = pal.length - 1;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (Math.abs(r - 127) < 5 && Math.abs(g - 127) < 5 && Math.abs(b - 127) < 5) continue; // masca rămâne gri
    const t = Math.min(0.9999, lum([r, g, b]) / 255) * k, j = Math.floor(t), f = t - j;
    const a = pal[j], z = pal[j + 1];
    for (let ch = 0; ch < 3; ch++) {
      const mapped = a[ch] + (z[ch] - a[ch]) * f, orig = px[i + ch];
      px[i + ch] = mapped * 0.72 + orig * 0.28; // păstrăm o parte din textura originală
    }
  }
  x.putImageData(d, 0, 0);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

// Pune sliderul înainte/după în cardul direcției i (înlocuiește previzualizarea existentă)
function setBA(box, i, baseUrl, afterUrl, label) {
  const dir = box.querySelectorAll(".dir")[i]; if (!dir) return;
  const cur = dir.querySelector(".ba, .dir-ph");
  const html = `<div class="ba" style="--x:50%"><img src="${baseUrl}" alt="" /><img class="after" src="${afterUrl}" alt="" />
    <input type="range" min="0" max="100" value="50" aria-label="Înainte / după" /><span class="ba-l">înainte</span><span class="ba-r">${esc(label)}</span></div>`;
  if (cur) cur.outerHTML = html; else dir.insertAdjacentHTML("afterbegin", html);
  const inp = dir.querySelector(".ba input");
  inp.addEventListener("input", () => inp.parentElement.style.setProperty("--x", `${inp.value}%`));
}

// Generează reclamele noi cu AI, una câte una. Planul gratuit permite o imagine la ~45 s, așa că așteptăm cât cere serverul.
async function genImages(box, rbId, r, images, baseUrl) {
  const st = box.querySelector("[data-gen-status]"), btn = box.querySelector("[data-gen]");
  const todo = (r.directii ?? []).map((_, i) => i).filter((i) => !images[i]);
  if (!todo.length) return;
  if (btn) btn.disabled = true;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let done = 0, failed = 0;
  for (const i of todo) {
    const name = r.directii[i].titlu;
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      st.textContent = `Desenez reclama nouă ${done + failed + 1} / ${todo.length}: „${name}”…`;
      try {
        const out = await invoke({ action: "rebrand_image", rebrand_id: rbId, index: i });
        if (out?.retry_after) {
          for (let t = Math.ceil(out.retry_after) + 2; t > 0; t--) {
            st.textContent = `Generatorul gratuit face o imagine la 45 s. Următoarea („${name}”) pornește în ${t} s…`;
            await sleep(1000);
          }
          continue;
        }
        images[i] = out.path; r.directii[i].sursa_imagine = out.source; ok = true; done++;
        setBA(box, i, baseUrl, imgUrl(out.path) + `?t=${Date.now()}`, out.source ?? "AI");
      } catch (err) { st.innerHTML = `<span class="err">„${esc(name)}”: ${esc(err.message)}</span>`; await sleep(3000); break; }
    }
    if (!ok) failed++;
  }
  st.textContent = failed
    ? `Am desenat ${done} din ${todo.length} reclame. Pentru celelalte rămâne previzualizarea cu paleta; poți reîncerca.`
    : `Gata: ${done} reclame noi desenate de AI. Trage de slider ca să compari cu originalul.`;
  if (btn) { btn.disabled = false; btn.classList.toggle("hidden", !failed); btn.textContent = "🎨 Reîncearcă imaginile lipsă"; }
}

function renderRebrand(box, ctx, { id: rbId, result: r, images = [], image_error, autoImages = false }) {
  const baseV = ctx.vs.find((v) => v.kind === "base");
  const baseUrl = baseV ? imgUrl(baseV.image_path) : "";
  const RISK = { sigur: "good", echilibrat: "warn", curajos: "bad" };
  const previews = [];
  box.innerHTML = `<div class="rb-out">
    <h3>Rebranding propus${r.concurent ? ` · departe de ${esc(r.concurent)}` : ""}</h3>
    <p class="sum-text">${esc(r.diagnostic)}</p>
    ${r.coduri_comune?.length ? `<div class="chips-row"><span class="muted small">Coduri comune cu concurentul:</span>${r.coduri_comune.map((c) => `<span class="chip warn">${esc(c)}</span>`).join("")}</div>` : ""}
    <div class="palette">${(r.paleta ?? []).map((p) => `<button type="button" class="sw-big" data-copy="${esc(p.hex)}" title="Copiază ${esc(p.hex)}">
      <span style="background:${esc(p.hex)}"></span><b>${esc(p.nume)}</b><small>${esc(p.hex)} · ${esc(p.rol)}</small></button>`).join("")}</div>
    <div class="grid2 keep-change">
      <div><h4>Păstrezi</h4><ul>${(r.pastrezi ?? []).map((x) => `<li>✓ ${esc(x)}</li>`).join("")}</ul></div>
      <div><h4>Schimbi</h4><ul>${(r.schimbi ?? []).map((x) => `<li>→ ${esc(x)}</li>`).join("")}</ul></div>
    </div>
    <div class="dirs">${(r.directii ?? []).map((d, i) => `<div class="dir">
      ${images[i] ? `<div class="ba" style="--x:50%"><img src="${baseUrl}" alt="" /><img class="after" src="${imgUrl(images[i])}" alt="" />
        <input type="range" min="0" max="100" value="50" aria-label="Înainte / după" /><span class="ba-l">înainte</span><span class="ba-r">${esc(d.sursa_imagine ?? "după")}</span></div>`
        : `<div class="dir-ph" data-ph="${i}">${d.culori?.length >= 2 ? "Pregătesc previzualizarea…" : "Fără imagine"}</div>`}
      ${(d.culori ?? []).length ? `<div class="mini-pal">${d.culori.map((h) => `<span style="background:${esc(h)}" title="${esc(h)}"></span>`).join("")}</div>` : ""}
      <div class="dir-body"><div class="dir-head"><b>${esc(d.titlu)}</b><span class="chip ${RISK[d.risc] ?? ""}">${esc(d.risc)}</span></div>
        <p>${esc(d.descriere)}</p>
        ${d.text_nou ? `<p class="new-copy">„${esc(d.text_nou)}”</p>` : ""}
        ${(d.pastrat?.length || d.schimbat?.length) ? `<div class="ks">
          ${d.pastrat?.length ? `<div><b>Păstrează</b>${d.pastrat.map((x) => `<span class="chip good">${esc(x)}</span>`).join("")}</div>` : ""}
          ${d.schimbat?.length ? `<div><b>Schimbă</b>${d.schimbat.map((x) => `<span class="chip warn">${esc(x)}</span>`).join("")}</div>` : ""}</div>` : ""}
        <p class="muted small"><b>De ce e distinct:</b> ${esc(d.de_ce_distinct)}</p>
        ${d.legatura_cu_identitatea ? `<p class="muted small"><b>Identitate:</b> ${esc(d.legatura_cu_identitatea)}</p>` : ""}
        <details><summary>Prompt pentru imagine</summary><p class="small">${esc(d.prompt_imagine)}</p>
          <button type="button" class="ghost sm" data-copy="${esc(d.prompt_imagine)}">Copiază promptul</button></details>
      </div></div>`).join("")}</div>
    <div class="gen-row"><button type="button" class="ghost${(r.directii ?? []).every((_, i) => images[i]) ? " hidden" : ""}" data-gen>🎨 Desenează reclamele noi cu AI (gratuit)</button>
      <span class="muted small" data-gen-status>${(r.directii ?? []).every((_, i) => images[i]) ? "" : "Până atunci vezi o previzualizare cu paleta nouă."}</span></div>
    <div class="ab"><button type="button" class="primary big" data-ab>▶ Testează direcțiile în panel (A/B)</button>
      <div class="muted small">Originalul și fiecare direcție trec prin același panel orb; câștigă varianta recunoscută cel mai bine.</div>
      <div class="muted" data-ab-status></div><div data-ab-out></div></div>
    ${r.urmatorul_pas ? `<div class="todo"><h3>Următorul pas</h3><p>${esc(r.urmatorul_pas)}</p></div>` : ""}
  </div>`;
  box.querySelectorAll(".ba input").forEach((inp) => inp.addEventListener("input", () => inp.parentElement.style.setProperty("--x", `${inp.value}%`)));
  box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.innerHTML; b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 900); } catch {}
  }));
  // previzualizări cu paleta pentru direcțiile fără imagine AI
  (r.directii ?? []).forEach(async (d, i) => {
    if (images[i] || !(d.culori?.length >= 2) || !baseUrl) return;
    const ph = box.querySelector(`[data-ph="${i}"]`);
    try {
      const blob = await recolorPreview(baseUrl, d.culori);
      if (!blob) { if (ph) ph.textContent = "Fără imagine"; return; }
      previews[i] = blob;
      if (images[i]) return;
      setBA(box, i, baseUrl, URL.createObjectURL(blob), "paleta nouă (previzualizare)");
    } catch { if (ph && !images[i]) ph.textContent = "Previzualizarea nu a putut fi generată"; }
  });
  const ab = box.querySelector("[data-ab]");
  ab.addEventListener("click", () => runAB(box, ctx, r, images, ab, previews, rbId));
  box.querySelector("[data-gen]").addEventListener("click", () => genImages(box, rbId, r, images, baseUrl));
  if (autoImages && baseUrl) genImages(box, rbId, r, images, baseUrl);
}

// A/B: originalul vs. fiecare direcție generată, același panel orb, aceeași statistică
async function runAB(box, ctx, r, images, btn, previews = [], rbId = "x") {
  const st = box.querySelector("[data-ab-status]"), out = box.querySelector("[data-ab-out]");
  const baseV = ctx.vs.find((v) => v.kind === "base");
  btn.disabled = true; btn.textContent = "Testul A/B rulează…";
  try {
    const { data: an, error } = await sb.from("analyses").insert({ ad_id: ctx.a.ad_id, category: ctx.s.category, use_memory: ctx.s.use_memory,
      n_evals: ctx.s.n_evals ?? 10, generic_elements: ctx.s.generic_elements ?? [] }).select().single();
    if (error) throw error;
    // imaginile AI au prioritate; altfel urcăm previzualizarea cu paleta
    const paths = [];
    for (const [i] of r.directii.entries()) {
      if (images[i]) paths[i] = images[i];
      else if (previews[i]) paths[i] = await uploadBlob(`rebrand/${rbId}/${i}-paleta.png`, previews[i]);
    }
    if (!paths.some(Boolean)) throw new Error("Nu există încă imagini de testat. Așteaptă previzualizările sau încarcă o machetă în editor.");
    const rows = [{ kind: "base", element: null, image_path: baseV.image_path },
      ...r.directii.map((d, i) => paths[i] && { kind: "generated", element: d.titlu, image_path: paths[i] }).filter(Boolean)];
    const variants = [];
    for (const row of rows) {
      const { data: v, error: ve } = await sb.from("variants").insert({ analysis_id: an.id, ...row }).select().single();
      if (ve) throw ve; variants.push(v);
    }
    st.textContent = `Panelul evaluează 0 / ${variants.length} variante…`;
    await runAll(variants, (d, n) => (st.textContent = `Panelul evaluează ${d} / ${n} variante…`));
    st.textContent = "Calculez rezultatele…";
    await invoke({ action: "finalize", analysis_id: an.id });
    const { data: res } = await sb.from("analyses").select("summary").eq("id", an.id).single();
    const S2 = res.summary, gens = [...(S2.generated ?? [])].sort((x, y) => y.mean - x.mean);
    const win = gens[0];
    out.innerHTML = `<div class="ab-res">
      <div class="verdict ${win && win.lift > 0 && win.p_holm < 0.05 ? "good" : win && win.lift > 0 ? "warn" : "bad"}">
        ${win ? (win.lift > 0 ? `Câștigă „${esc(win.element)}”: recunoașterea crește de la ${pct(S2.attribution)} la ${pct(win.mean)}` : "Nicio direcție nu bate originalul") : "—"}</div>
      <ol class="ranking">${gens.map((g) => `<li><b>${esc(g.element)}</b> <span>${pct(g.mean)}</span>
        <span class="chip ${g.lift > 0 ? (g.p_holm < 0.05 ? "good" : "warn") : "bad"}">${g.lift >= 0 ? "+" : "−"}${Math.abs(Math.round(g.lift * 100))} pp · ${g.p_holm < 0.05 ? "semnificativ" : "nesigur"}</span></li>`).join("")}
        <li class="orig"><b>Original</b> <span>${pct(S2.attribution)}</span></li></ol>
      ${statsView({ a: { ...ctx.a, report: "" }, s: S2, vs: [], imp: [], target: ctx.target, part: "chart1" })}
    </div>`;
    st.textContent = "Gata. Analiza A/B e salvată și în tab-ul Rezultate.";
  } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
  finally { btn.disabled = false; btn.textContent = "▶ Testează din nou (A/B)"; }
}

async function loadHistory() {
  const { data, error } = await sb.from("analyses").select("id,created_at,status,use_memory,summary,ads(title,brands(name,category))")
    .order("created_at", { ascending: false }).limit(50);
  if (error) return ($("#history-list").textContent = error.message);
  $("#history-list").innerHTML = data.map((a) => `<div class="hist-item" data-id="${a.id}">
    <span>${esc(a.ads?.brands?.name)} · ${esc(a.ads?.title ?? "reclamă")} <span class="muted">(${esc(a.ads?.brands?.category)}${a.use_memory ? "" : ", control"})</span></span>
    <span>${a.summary ? pct(a.summary.attribution) : esc(a.status)} <span class="muted">${new Date(a.created_at).toLocaleString("ro-RO")}</span></span></div>`).join("")
    || '<p class="muted">Nicio analiză încă.</p>';
  $("#history-list").querySelectorAll(".hist-item").forEach((h) =>
    h.addEventListener("click", () => showResult($("#history-detail"), h.dataset.id)));
}

// ---------- autentificare (doar echipa) ----------
async function showApp(session) {
  const on = !!session;
  $("#login").classList.toggle("hidden", on);
  $("#app").classList.toggle("hidden", !on);
  $("#mainnav").classList.toggle("hidden", !on);
  $("#userbox").classList.toggle("hidden", !on);
  if (on) { $("#user-email").textContent = session.user.email; loadData(); }
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-err").textContent = "";
  const { data, error } = await sb.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-pass").value });
  if (error) return ($("#login-err").textContent = error.message === "Invalid login credentials" ? "Email sau parolă greșite." : error.message);
  showApp(data.session);
});
$("#logout").addEventListener("click", async () => { await sb.auth.signOut(); showApp(null); });
sb.auth.getSession().then(({ data }) => showApp(data.session));
