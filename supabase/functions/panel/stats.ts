// Statistică pentru panelul orb. Fără dependențe: rulează în Deno (edge function) și în Node (teste).
// Alegerea metodelor: n e mic (~10 evaluări/variantă), iar atribuirea e mărginită în [0, 1] și adesea asimetrică,
// deci folosim metode fără ipoteză de normalitate: bootstrap pentru intervale și test de permutare pentru diferențe.

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
export const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// Generator determinist (mulberry32): aceleași date → aceleași intervale, rezultate reproductibile
export function rng(seed = 20261107) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** IC 95% bootstrap (percentile) pentru medie. */
export function bootCI(xs: number[], B = 4000, seed?: number): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const r = rng(seed), n = xs.length, ms: number[] = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[(r() * n) | 0]; ms.push(s / n); }
  ms.sort((x, y) => x - y);
  return [quantile(ms, 0.025), quantile(ms, 0.975)];
}

/** IC 95% bootstrap pentru diferența de medii a − b (eșantioane independente). */
export function bootDiffCI(a: number[], b: number[], B = 4000, seed?: number): [number, number] {
  if (a.length < 2 || b.length < 2) return [NaN, NaN];
  const r = rng(seed), ds: number[] = [];
  for (let k = 0; k < B; k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[(r() * a.length) | 0];
    for (let i = 0; i < b.length; i++) sb += b[(r() * b.length) | 0];
    ds.push(sa / a.length - sb / b.length);
  }
  ds.sort((x, y) => x - y);
  return [quantile(ds, 0.025), quantile(ds, 0.975)];
}

/** Test de permutare bilateral pentru diferența de medii. p = (k + 1) / (B + 1). */
export function permTest(a: number[], b: number[], B = 5000, seed?: number): number {
  if (a.length < 2 || b.length < 2) return NaN;
  const obs = Math.abs(mean(a) - mean(b));
  const all = [...a, ...b], na = a.length, r = rng(seed);
  let k = 0;
  for (let i = 0; i < B; i++) {
    for (let j = all.length - 1; j > 0; j--) { const t = (r() * (j + 1)) | 0; [all[j], all[t]] = [all[t], all[j]]; }
    let sa = 0; for (let j = 0; j < na; j++) sa += all[j];
    let sb = 0; for (let j = na; j < all.length; j++) sb += all[j];
    if (Math.abs(sa / na - sb / (all.length - na)) >= obs - 1e-12) k++;
  }
  return (k + 1) / (B + 1);
}

/** Hedges g (Cohen d corectat pentru eșantioane mici). */
export function hedgesG(a: number[], b: number[]): number {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const sp = Math.sqrt(((na - 1) * sd(a) ** 2 + (nb - 1) * sd(b) ** 2) / (na + nb - 2));
  if (sp === 0) return mean(a) === mean(b) ? 0 : Math.sign(mean(a) - mean(b)) * Infinity;
  const J = 1 - 3 / (4 * (na + nb) - 9);
  return ((mean(a) - mean(b)) / sp) * J;
}
export const effectLabel = (g: number) => {
  const x = Math.abs(g);
  if (!Number.isFinite(x)) return "foarte mare";
  return x < 0.2 ? "neglijabil" : x < 0.5 ? "mic" : x < 0.8 ? "mediu" : "mare";
};

/** Corecție Holm pentru comparații multiple (păstrează ordinea inițială). */
export function holm(ps: number[]): number[] {
  const idx = ps.map((p, i) => [p, i] as const).filter(([p]) => Number.isFinite(p)).sort((x, y) => x[0] - y[0]);
  const out = ps.map(() => NaN);
  let run = 0;
  idx.forEach(([p, i], r) => { run = Math.max(run, Math.min(1, p * (idx.length - r))); out[i] = run; });
  return out;
}

/** Interval Wilson 95% pentru o proporție. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Efectul minim detectabil (diferență de medii) la α = .05 bilateral, putere .80, două grupuri egale. */
export const mde = (sdPooled: number, nPerGroup: number) => (1.959964 + 0.841621) * sdPooled * Math.sqrt(2 / nPerGroup);

/** Entropia normalizată a unei distribuții (0 = toți de acord, 1 = complet împărțit). */
export function normEntropy(p: Record<string, number>): number {
  const v = Object.values(p).filter((x) => x > 0), k = Object.keys(p).length;
  if (k < 2) return 0;
  return -v.reduce((s, x) => s + x * Math.log(x), 0) / Math.log(k);
}

export const fmtP = (p: number) => (!Number.isFinite(p) ? "—" : p < 0.001 ? "< .001" : `= ${p.toFixed(3).replace(/^0/, "")}`);
export const stars = (p: number) => (!Number.isFinite(p) ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "ns");
