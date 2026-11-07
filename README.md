# Fără logo — laboratorul de amprentă a brandului

Pre-test instant care arată dacă o reclamă lucrează pentru brandul care o plătește. Logo-ul se maschează cu culoare plată, un panel orb de evaluatori AI ghicește brandul, iar ablația arată ce elemente poartă de fapt identitatea. Apelurile LLM încearcă Mistral Medium, apoi z.ai și Gemini ca fallback.

## Cum se folosește

1. **Set de date:** alegi o categorie, adaugi 3–5 branduri și încarci reclame. Cele cu rolul „Memorie” sunt exemple nemascate, etichetate (3–5 per brand). Cele cu rolul „Test” sunt reclamele de analizat.
2. **Analiză:** alegi o reclamă de test, tragi dreptunghiuri peste logo/nume (zona **Logo**) și definești elementele (mascota, sloganul, fundalul). Bifează „culoare” la un element cromatic. Poți încărca și variante generate, deja mascate. Apoi apeși **Rulează panelul orb**.
3. **Rezultate:** vezi atribuirea, unde se duce restul probabilității, Δ per element cu diagnosticul (asset puternic / decor / element trădător) și raportul.

## Rebranding

Când reclama seamănă prea mult cu concurența (similaritate peste nivelul categoriei sau confuzie mare), pe pagina de rezultate apare „Pornește rebrandingul”:

1. **Interviu de brand**: utilizatorul vorbește (Web Speech API, română) sau scrie liber; modelul LLM completează formularul de identitate (promisiune, valori, personalitate, ton, active de păstrat, ce eviți, constrângeri, obiectiv, public, curaj).
2. **3 direcții** (sigur / echilibrat / curajos): diagnostic, coduri comune cu concurentul, paletă, ce păstrezi și ce schimbi, prompt de imagine.
3. **Previzualizare**: imagine AI dacă modelul de imagine e disponibil, altfel recolorare cu paleta direcției direct în browser; slider înainte/după.
4. **Test A/B**: originalul și direcțiile trec prin același panel orb; clasament cu lift și semnificație.

## Arhitectură

- **Frontend:** HTML + JS static (fără build), publicat pe GitHub Pages. Mascarea și ablația se fac în browser, pe canvas.
- **Supabase** (proiectul `ysckyoffhrdfzcxspmhb`):
  - Storage: bucket public `creative` (numele „ads” e blocat de extensiile anti-reclame)
  - Postgres: `brands`, `ads`, `analyses`, `variants`, `panel_votes`, `element_impacts` (cu RLS)
  - Edge function `panel` (`supabase/functions/panel/index.ts`):
    - `run_variant` — rulează ~10 evaluări (3 în paralel, cu reîncercare la limitele planului gratuit), amestecă ordinea candidaților la fiecare evaluare, folosește memoria însămânțată și salvează distribuțiile de probabilitate
    - `finalize` — calculează Δ, atribuirea greșită și diagnosticul cu reguli deterministe, apoi modelul LLM scrie raportul doar din cifre

## Configurare

Setează cheile în Supabase → Edge Functions → Secrets. Pentru generare, furnizorii sunt încercați în ordinea **Mistral Medium → z.ai → Gemini**; fiecare cheie este opțională, iar cheia următoare este folosită dacă apelul precedent eșuează:

- `MISTRAL_API_KEY` — [Mistral Console](https://console.mistral.ai/api-keys/). Opțional, `MISTRAL_MODEL` (implicit `mistral-medium-2508`).
- `ZAI_API_KEY` — fallback z.ai. Opțional, `ZAI_MODEL` (implicit `glm-4.7-flash`).
- `GEMINI_API_KEY` — fallback Gemini și necesar pentru embeddings și Google Search. Opțional, `GEMINI_MODEL` (implicit `gemini-3.5-flash-lite`).

Pragurile de diagnostic (Δ > 0,15 pentru asset, |Δ| < 0,03 pentru decor, atracție > 10% spre un concurent pentru element trădător) sunt valori de pornire, de calibrat pe setul de demo.

## Limite cunoscute

- Acces doar pentru echipă: login cu email și parolă (Supabase Auth). Doar emailurile din tabela `team_members` pot citi date, încărca reclame sau porni analize. Imaginile din Storage au nume aleatorii și sunt accesibile prin URL direct.
- Detecția automată de logo (OWLv2) și OCR-ul (Tesseract) nu sunt încă integrate. Mascarea se face manual.
- Similaritatea se calculează cu `gemini-embedding-2` (768 dimensiuni): cosinus între reclama mascată și reclamele fiecărui brand din categorie. Acest endpoint de embeddings rămâne separat de lanțul LLM Mistral → z.ai → Gemini. Reclama e marcată „generică” dacă seamănă cu concurența peste media categoriei sau seamănă mai mult cu un concurent decât cu propriul brand.
- Aceeași imagine nu poate fi și memorie, și test: duplicatele sunt detectate după hash SHA-256.
