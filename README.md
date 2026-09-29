# alantu.de — ALANTU: 3D-Exposés für Immobilienmakler

Öffentliche GitHub-Pages-Website von **ALANTU** unter https://www.alantu.de/ (Branch `main`, Root `/`, `CNAME` = `www.alantu.de`).

ALANTU macht aus einem vorhandenen PDF-Exposé ein interaktives 3D-Exposé zum Blättern – für Makler in ganz Deutschland.

## Seiten

| Pfad | Inhalt |
| --- | --- |
| `/` (`index.html`) | Produktseite mit dem 3D-Exposé als Live-Demo, Ablauf, PDF-Konverter, Preise, FAQ |
| `/index-brand.html` | identische Kopie von `index.html` (wird von den Exposé-Gates live geprüft) |
| `/pdf-to-exposee.html` | PDF → 3D-Exposé, läuft komplett im Browser |
| `/pdf-to-exposee-anchor.html` | Variante des Konverters (Anchor) |
| `/pdfconvert.html`, `/pdf-convert-anchor.html` | PDF → echter Text (OCR, im Browser) |
| `/box2d.html`, `/box3d.html` | Buch-Experimente (`box3d.html` leitet auf `box2d.html` weiter) |
| `/impressum/`, `/datenschutz/` | Rechtstexte (Entwurf, markierte Platzhalter) |
| `/stockstrend.html`, `/methodik.html` | Weiterleitung zu https://kurzlernen.de/ (Stockstrend ist dorthin umgezogen) |

## 3D-Exposé-Runtime – bitte nicht umbauen

`alantu-book-core.js`, `alantu-book-view.js` und der Inline-`<script type="module">`-Block in `index.html` sind die
abgestimmte Buch-Runtime (Touch, Wischen, Tippen, kein Jitter). Änderungen an der Seite erfolgen nur **um** das Exposé herum
(Seiten-Chrome im Block `<style id="alantu-chrome">`, Texte, Abschnitte, Meta). Das ursprüngliche `<style>`, das
`.stage-wrap`-Markup und das Modul-Skript sind byte-identisch zum letzten Stand von `index-brand.html`.

Bei Änderungen an `index.html` bitte `index-brand.html` identisch halten:

```sh
cp index.html index-brand.html
```

## Preise

Die Preise stehen ausschließlich im Abschnitt `<section id="preise">` in `index.html` (markiert mit `PREISE – zentral hier ändern`).
Aktuell als „Einführungspreis“ gekennzeichnet.

## Kontakt

Demo-/Kontakt-Links nutzen `mailto:chris.hohlfeld@gmail.com` (für `alantu.de` existiert derzeit kein MX-Eintrag, `hallo@alantu.de` wäre nicht zustellbar).

## Weitere Inhalte im Repository

`market-relay/`, `market-runtime/`, `Dockerfile.*`, `railway.json`, `deploy/`, `tools/` sowie `orcl-l2-model.json`,
`orcl-raw-sip-model.json` und `microstructure-edge-status.json` gehören zur früheren Marktdaten-Infrastruktur (Railway-Build,
Relay-Image). Sie sind nicht verlinkt, bleiben aber vorerst erhalten, weil externe Builds bzw. Dienste darauf verweisen.
