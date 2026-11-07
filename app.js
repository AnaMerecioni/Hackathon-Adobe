import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=202611071127";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const MASK = "#7f7f7f";            // aceeași mascare plată pe toate reclamele
const COLORS = ["#e4572e", "#2a9d5c", "#3a6ea5", "#c98a00", "#8e44ad", "#16a3a3", "#d1495b", "#5b6b2f"];
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (path) => sb.storage.from("ads").getPublicUrl(path).data.publicUrl;
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

const DX = { asset_puternic: "Asset puternic", tradator: "Element trădător", decor: "Decor", neutru: "Neutru" };

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
    const path = `ads/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from("ads").upload(path, f, { contentType: f.type });
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

// ---------- editor de mască ----------
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let current = null; // { ad, img, layers: [{name, hue, rects:[]}], active }

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Imaginea nu s-a putut încărca."));
    i.src = src;
  });
}

async function openEditor(ad) {
  const img = await loadImage(imgUrl(ad.image_path));
  current = { ad, img, layers: [{ name: "Logo", logo: true, rects: [] }], active: 0 };
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  $("#editor").classList.remove("hidden");
  $("#result").classList.add("hidden");
  renderLayers(); draw();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderLayers() {
  $("#layers").innerHTML = current.layers.map((l, i) => `<li class="${i === current.active ? "active" : ""}" data-i="${i}">
    <span><span class="sw" style="background:${l.logo ? MASK : COLORS[i % COLORS.length]}"></span>${esc(l.name)}${l.hue ? " (culoare)" : ""} · ${l.hue ? "nuanță" : l.rects.length + " zone"}</span>
    <span>${l.rects.length ? `<button data-undo="${i}" title="Șterge ultima zonă">↶</button>` : ""}${l.logo ? "" : `<button data-del="${i}" title="Șterge elementul">✕</button>`}</span></li>`).join("");
  $("#layers").querySelectorAll("li").forEach((li) => li.addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.del) current.layers.splice(+t.dataset.del, 1), (current.active = 0);
    else if (t.dataset.undo) current.layers[+t.dataset.undo].rects.pop();
    else current.active = +li.dataset.i;
    renderLayers(); draw();
  }));
}

$("#el-add").addEventListener("click", () => {
  const name = $("#el-name").value.trim();
  if (!name || !current) return;
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
  if (r.w > 4 && r.h > 4) current.layers[current.active].rects.push(r);
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
      if (l.logo) { ctx.fillStyle = MASK; ctx.fillRect(r.x, r.y, r.w, r.h); }
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
    throw new Error(msg);
  }
  return data;
}

async function uploadBlob(path, blob) {
  const { error } = await sb.storage.from("ads").upload(path, blob, { contentType: blob.type || "image/png", upsert: true });
  if (error) throw error;
  return path;
}

async function createAnalysis({ useMemory, withAblations }) {
  const n_evals = Math.min(30, Math.max(1, +$("#n-evals").value || 10));
  const { data: a, error } = await sb.from("analyses")
    .insert({ ad_id: current.ad.id, category: category(), use_memory: useMemory, n_evals }).select().single();
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
      await invoke({ action: "run_variant", variant_id: v.id });
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
