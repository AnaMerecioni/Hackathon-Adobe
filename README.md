# Fără logo — laboratorul de amprentă a brandului

Pre-test instant care arată dacă o reclamă lucrează pentru brandul care o plătește. Logo-ul se maschează cu culoare plată, un panel orb de evaluatori AI (Gemini vision) ghicește brandul, iar ablația arată ce elemente poartă de fapt identitatea.

## Cum se folosește

1. **Set de date:** alegi o categorie, adaugi 3–5 branduri și încarci reclame. Cele cu rolul „Memorie” sunt exemple nemascate, etichetate (3–5 per brand). Cele cu rolul „Test” sunt reclamele de analizat.
2. **Analiză:** alegi o reclamă de test, tragi dreptunghiuri peste logo/nume (zona **Logo**) și definești elementele (mascota, sloganul, fundalul). Bifează „culoare” la un element cromatic. Poți încărca și variante generate, deja mascate. Apoi apeși **Rulează panelul orb**.
3. **Rezultate:** vezi atribuirea, unde se duce restul probabilității, Δ per element cu diagnosticul (asset puternic / decor / element trădător) și raportul.

## Arhitectură

- **Frontend:** HTML + JS static (fără build), publicat pe GitHub Pages. Mascarea și ablația se fac în browser, pe canvas.
- **Supabase** (proiectul `ysckyoffhrdfzcxspmhb`):
  - Storage: bucket public `ads`
  - Postgres: `brands`, `ads`, `analyses`, `variants`, `panel_votes`, `element_impacts` (cu RLS)
  - Edge function `panel` (`supabase/functions/panel/index.ts`):
    - `run_variant` — rulează ~10 evaluări (3 în paralel, cu reîncercare la limitele planului gratuit), amestecă ordinea candidaților la fiecare evaluare, folosește memoria însămânțată și salvează distribuțiile de probabilitate
    - `finalize` — calculează Δ, atribuirea greșită și diagnosticul cu reguli deterministe, apoi Gemini scrie raportul doar din cifre

## Configurare

Edge function-ul are nevoie de secretul `GEMINI_API_KEY` (cheie gratuită din [Google AI Studio](https://aistudio.google.com/apikey)), setat în Supabase → Edge Functions → Secrets. Opțional, `GEMINI_MODEL` (implicit `gemini-3.5-flash-lite`).

Pragurile de diagnostic (Δ > 0,15 pentru asset, |Δ| < 0,03 pentru decor, atracție > 10% spre un concurent pentru element trădător) sunt valori de pornire, de calibrat pe setul de demo.

## Limite cunoscute

- Demo fără conturi: oricine are linkul poate încărca reclame și porni analize, care consumă din cota Gemini.
- Detecția automată de logo (OWLv2), OCR-ul (Tesseract) și similaritatea CLIP nu sunt încă integrate. Mascarea se face manual. Coloana `analyses.similarity` e pregătită pentru similaritate.
