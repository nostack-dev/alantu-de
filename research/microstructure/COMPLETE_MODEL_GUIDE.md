# ALANTU Microstructure — vollständiger Modell-, Daten- und Integrationsleitfaden

Stand: 2026-09-22

## 0. Was in diesem Paket tatsächlich trainiert ist

Es gibt zwei klar getrennte Ebenen.

### A. Trainiertes Proof-Modell

`fi2010-microstructure-model.json` ist ein **wirklich trainiertes Ridge-Modell** auf dem öffentlichen FI-2010 Limit-Order-Book-Datensatz.

Es wurde auf den ersten sieben Handelstagen entwickelt und auf den letzten drei Tagen separat geprüft. Es enthält die vollständigen Mittelwerte, Standardabweichungen, Koeffizienten und Schwellen für die Horizonte 10/20/30/50/100 Events.

Dieses Modell ist reproduzierbar, aber **kein ORCL-Produktionsmodell**.

### B. ORCL Produktionsmodell `hdr-dt-v1`

`orcl-l2-model.json` ist momentan absichtlich **`status=unavailable`**.

Das ist kein fehlender Code. Es ist eine Sicherheitsbedingung: Das ORCL-Modell darf erst trainiert und veröffentlicht werden, wenn echte historische ORCL-Daten des gleichen Live-Datenvertrags vorliegen und der harte Holdout-Gate bestanden wurde.

Kein FI-2010-Koeffizient wird als ORCL-Koeffizient ausgegeben.

---

# 1. Forschungsfrage

Die operative Frage lautet:

> Kann der aktuelle Zustand und die Bewegung des ORCL-Orderbuchs vorhersagen, ob der Midprice nach den nächsten 100 echten Orderbuch-Events höher oder niedriger liegt?

Das Modell arbeitet deshalb nicht primär in Kerzen oder Sekunden, sondern auf der **Event-Uhr des Marktes**.

Der reale Zeithorizont ist dynamisch:

[
\Delta T_{100}(t)=t_{event+100}-t_{event}
]

Live wird er aus der aktuellen Eventrate geschätzt:

[
\widehat{\Delta T}_{100}=100/r_{events}
]

Damit bedeuten 100 Events an einem schnellen Markt einen kürzeren Zeithorizont als 100 Events in einem ruhigen Markt.

---

# 2. Zeit ist ein Feature, nicht nur Metadaten

Für zwei aufeinanderfolgende Börsenereignisse:

[
\Delta t_i = t_i-t_{i-1}
]

Verwendet wird der **Exchange Event Timestamp** `ts_event` in Nanosekunden.

Zusätzlich werden getrennt gemessen:

- `ts_event`: Markt-/Exchange-Zeit
- `ts_recv`: Empfang beim Datenprovider
- `ts_out`: Ausgabe des Providers
- `ts_local_recv`: Empfang in unserem Collector

Damit entstehen:

[
L_{capture}=ts_{recv}-ts_{event}
]

[
L_{gateway}=ts_{out}-ts_{recv}
]

[
L_{network}=ts_{local}-ts_{out}
]

[
L_{E2E}=ts_{local}-ts_{event}
]

Diese Latenzen werden **nicht mit der Marktbewegung verwechselt**. Sie dienen als Qualitäts-/Handelbarkeit-Gate.

---

# 3. Der L2-Zustand

Benötigt werden pro Event die besten zehn Bid- und Ask-Ebenen:

[
(BidPx_j,BidSize_j,AskPx_j,AskSize_j),\quad j=1..10
]

Aus ihnen entstehen die sieben klassischen, skalenfreien Basisfeatures.

## 3.1 Depth Imbalance

Für Tiefe (k\in\{1,3,5,10\}):

[
I_k=\frac{\sum_{j=1}^k BidSize_j-\sum_{j=1}^k AskSize_j}
{\sum_{j=1}^k BidSize_j+\sum_{j=1}^k AskSize_j}
]

Features:

1. `imbalance_l1`
2. `imbalance_l3`
3. `imbalance_l5`
4. `imbalance_l10`

## 3.2 Microprice bias

[
Mid=\frac{Ask_1+Bid_1}{2}
]

[
Micro=\frac{Ask_1 BidSize_1+Bid_1 AskSize_1}{BidSize_1+AskSize_1}
]

[
MicroBias=\frac{Micro-Mid}{Ask_1-Bid_1}
]

Feature 5: `microprice_bias`.

## 3.3 Nah gegen Gesamtbuch

[
NearFar=I_1-I_{10}
]

Feature 6: `near_far_imbalance`.

## 3.4 Depth Ratio

[
DepthRatio_5=\log\frac{\sum_{j=1}^5 BidSize_j+\epsilon}
{\sum_{j=1}^5 AskSize_j+\epsilon}
]

Feature 7: `depth_ratio_l5`.

---

# 4. XY-Zustandsraum

Die HDR/Trajektorien-Schicht komprimiert den Zustand in zwei geometrisch interpretierbare Achsen.

## X = gekoppelter Marktdruck

[
X=\frac{I_1+I_3+I_5+I_{10}+2\cdot MicroBias}{6}
]

Positive X-Werte bedeuten stärker bid-seitigen/aufwärtsgerichteten Buchdruck; negative entsprechend die Gegenrichtung.

## Y = sichtbare Liquiditätsmasse

[
Y=\log\left(1+\sum_{j=1}^{10}(BidSize_j+AskSize_j)\right)
]

Y ist keine Richtung, sondern die logarithmierte sichtbare Top-10-Liquiditätsmasse.

Features:

8. `xy_pressure`
9. `xy_liquidity_log`

Feature 10 ist zusätzlich `spread_bps`.

---

# 5. Bewegung relativ zu echtem Delta-t

Feature 11:

[
log\_dt\_us=\log(1+\Delta t\;in\;\mu s)
]

Die Geschwindigkeit im XY-Raum:

[
v_x=\frac{X_i-X_{i-1}}{\Delta t_i},\qquad
v_y=\frac{Y_i-Y_{i-1}}{\Delta t_i}
]

Die Beschleunigung:

[
a_x=\frac{v_{x,i}-v_{x,i-1}}
{(\Delta t_i+\Delta t_{i-1})/2}
]

analog für (a_y).

Um extreme Tick-Raten numerisch stabil zu halten, wird eine vorzeichenbehaftete Log-Transformation benutzt:

[
slog(z)=sign(z)\log(1+|z|)
]

Features:

12. `vx_log`
13. `vy_log`
14. `ax_log`
15. `ay_log`

---

# 6. HDR-Kopplung: self / local / global

Für einen aktuellen Wert (z) und Referenzwert (r):

[
HDR(z,r)=\frac{z-r}{|z|+|r|+\epsilon}
]

Diese Relation ist dimensionslos und begrenzt die Wirkung von Skalenniveaus.

## Self

Referenz: eigener Zustand vor 100 Events.

[
Self_X=HDR(X_t,X_{t-100})
]

[
Self_Y=HDR(Y_t,Y_{t-100})
]

Features 16–17.

## Local

Referenz: Mittelwert der vorherigen 10 Events.

[
Local_X=HDR(X_t,mean(X_{t-10:t-1}))
]

analog Y.

Features 18–19.

## Global

Referenz: Mittelwert der vorherigen 1000 Events.

[
Global_X=HDR(X_t,mean(X_{t-1000:t-1}))
]

analog Y.

Features 20–21.

Wichtig: Alle Referenzen enden bei (t-1). Kein Future Leakage.

---

# 7. Event-Pace

Das Modell sieht zusätzlich, **wie schnell die Marktmasse gerade Zustände wechselt**.

[
r_{10}=10/(t_t-t_{t-10})
]

[
r_{100}=100/(t_t-t_{t-100})
]

Features:

22. `log_rate_10 = log(1+r10)`
23. `log_rate_100 = log(1+r100)`
24. `pace_ratio_log = log(r10/r100)`

Damit unterscheidet das Modell eine plötzliche Beschleunigung der Eventaktivität von einer normalen gleichmäßigen Eventrate.

---

# 8. Exakte Feature-Reihenfolge von hdr-dt-v1

Die Reihenfolge ist Teil des Modellvertrags und darf nicht geändert werden:

1. imbalance_l1
2. imbalance_l3
3. imbalance_l5
4. imbalance_l10
5. microprice_bias
6. near_far_imbalance
7. depth_ratio_l5
8. xy_pressure
9. xy_liquidity_log
10. spread_bps
11. log_dt_us
12. vx_log
13. vy_log
14. ax_log
15. ay_log
16. hdr_self_x
17. hdr_self_y
18. hdr_local_x
19. hdr_local_y
20. hdr_global_x
21. hdr_global_y
22. log_rate_10
23. log_rate_100
24. pace_ratio_log

Die Konstante lautet:

`feature_version = "hdr-dt-v1"`

Training (Python) und Live-Inference (JavaScript) werden in CI numerisch gegeneinander getestet.

---

# 9. Forecast-Ziel

Fixer Eventhorizont:

[
H=100
]

Für Event (i):

[
R_{i,100}=10000\left(\frac{Mid_{i+100}}{Mid_i}-1\right)
]

Mit Deadband 0,5 bp:

- (R > +0.5bp\) → UP
- (R < -0.5bp\) → DOWN
- sonst → STATIONARY / kein Richtungsziel

Das Modell versucht nicht, den exakten Preis zu erraten. Es schätzt die **Richtung über die nächsten 100 Book-Events**.

---

# 10. Modell

Das Modell ist bewusst transparent:

[
z_j=\frac{x_j-\mu_j}{\sigma_j}
]

[
score=\beta_0+\sum_j\beta_jz_j
]

Ridge-Regularisierung:

[
\lambda=8
]

Signal:

- `score >= threshold` → UP
- `score <= -threshold` → DOWN
- sonst → NO SIGNAL

Der Threshold wird ausschließlich auf dem Validation-Block gewählt.

---

# 11. Historisches Training für ORCL

Script:

`tools/databento-orcl-mbp10-backfill.py`

holt echte `ORCL / XNAS.ITCH / mbp-10` Events und persistiert tageweise:

- `ts_event_ns`
- `ts_recv_ns`
- 7 Basisfeatures
- X/Y
- Midprice
- Spread in bps
- Venue sequence

Danach:

`tools/train-orcl-l2-100.py`

Chronologischer Split:

- erste 55 % der brauchbaren Handelstage: Fit
- nächste 20 %: Threshold-Selection
- letzte 25 %: vollständig unangetasteter Holdout

Kein Random Shuffle.

---

# 12. Unabhängige Signale

Damit 100 direkt aufeinanderfolgende Signale nicht 100-mal praktisch dieselbe Zukunft zählen:

Nach jedem gezählten Signal werden im Validator die nächsten **100 Events übersprungen**.

So werden die Holdout-Samples wesentlich weniger abhängig voneinander.

---

# 13. Kostenmodell

Jedes Signal wird netto bewertet:

[
NetEdge=DirectionalMove-ObservedSpread-0.35bp
]

Das ist bewusst konservativer als ein reiner Midprice-Backtest.

Ein Modell wird nicht aufgrund guter Brutto-Richtung freigeschaltet.

---

# 14. Promotion-Gate

Ein ORCL-Modell darf nur `status=validated` erhalten, wenn mindestens:

- 252 brauchbare Handelstage
- 500 unabhängige Holdout-Signale
- 60 Holdout-Handelstage
- unteres 95%-Wilson-Intervall der netto-positiven Trefferquote > 50 %
- mittlerer Netto-Edge > 0,5 bp
- Median-Netto-Edge > 0
- 95%-Day-Block-Bootstrap-Untergrenze des Mittelwerts > 0
- erster und zweiter Holdout-Abschnitt positiv
- Low-Vol-Regime positiv
- High-Vol-Regime positiv
- besser als L1-Imbalance-Baseline
- besser als kurzfristige Momentum-Baseline

Erst danach wird eine Modell-ID erzeugt.

---

# 15. Modell-ID

Die Modell-ID ist ein SHA-256-basierter Fingerprint über:

- Symbol
- Dataset
- Schema
- Feature-Version
- Horizont
- Feature-Namen
- Standardisierung
- Koeffizienten
- Threshold

Browser, Relay und Modell müssen dieselbe ID sehen.

Damit kann kein altes Modell versehentlich mit neuen Features laufen.

---

# 16. Live-Pfad

```
Databento XNAS.ITCH mbp-10
       |
       | ts_event / ts_recv / ts_out
       v
databento-orcl-mbp10-live.py
       |
       | HTTPS internal ingest, ~10 ms batches
       v
market-relay/server.mjs
       |
       | 24 hdr-dt-v1 features
       | score + threshold
       | 100E ETA
       | latency gate
       v
SSE /v1/stream
       |
       v
ALANTU UI
```

Der alte Yahoo-Pfad bleibt unabhängig davon bestehen.

---

# 17. Live-Latenz-Gate

Ein Forecast ist wertlos, wenn die Daten bereits einen großen Teil des Forecastfensters alt sind.

Darum wird dynamisch geprüft:

[
Budget=min(250ms,0.35\cdot ETA_{100})
]

Standardgrenzen:

- Provider Capture: maximal 50 ms
- End-to-End: maximal 250 ms
- zusätzlich maximal 35 % des geschätzten 100E-Horizonts
- Relay-Staleness ebenfalls begrenzt

Wenn eines davon reißt, wird der Forecast **nicht ausgeliefert**.

Diese Werte sind Konfiguration, keine Trainingsfeatures.

---

# 18. Live-Ausgabe

Nur bei validiertem Modell und bestandenem Timing-Gate:

`100E FORECAST ↑ · L2 · +100 Events · ≈ X s · Δt Y ms · E2E Z ms`

Die drei geometrischen Komponenten zeigen:

- Self
- Lokal
- Global

Kein Gate → kein Richtungsclaim.

---

# 19. Das bereits trainierte FI-2010-Modell

Datei:

`trained/fi2010-microstructure-model.json`

Features:

1. imbalance_l1
2. imbalance_l3
3. imbalance_l5
4. imbalance_l10
5. microprice_bias
6. near_far_imbalance
7. depth_ratio_l5

Für jeden Horizont existieren:

- Threshold
- Intercept
- sieben Koeffizienten

Beispiel 100 Events aus dem gespeicherten Modell:

`threshold = 0.07249791296956642`

Die vollständigen Parameter stehen in der JSON-Datei; keine Werte müssen aus diesem Dokument abgeschrieben werden.

## Inference

1. Features in exakt derselben Reihenfolge berechnen.
2. Mit gespeicherten `mean/std` standardisieren.
3. `score = intercept + beta dot z`.
4. Score gegen den für den Horizont gespeicherten Threshold prüfen.

Ein ausführbares Beispiel liegt als:

`examples/use_fi2010_trained_model.py`

bei.

Dieses Modell darf **nicht** in den ORCL-Livepfad kopiert werden. Es wurde auf einem anderen Benchmark trainiert und hat keinen Δt/HDR-Vertrag.

---

# 20. Wie das ORCL-Modell trainiert wird

Nach vorhandenem Databento-Zugang:

```bash
export DATABENTO_API_KEY='...'
export L2_START='YYYY-MM-DD'
export L2_END='YYYY-MM-DD'
export L2_OUT_DIR='orcl-l2-days'

python -m pip install databento pandas numpy
python tools/databento-orcl-mbp10-backfill.py
python tools/train-orcl-l2-100.py \
  orcl-l2-days \
  orcl-l2-model.candidate.json \
  orcl-l2-proof.json

node tools/finalize-l2-model.mjs orcl-l2-model.candidate.json
```

Danach die JSON prüfen:

```bash
jq '.status,.evidence' orcl-l2-model.candidate.json
```

Nur `status=validated` darf produktiv übernommen werden.

---

# 21. Live Deployment

Benötigte Secrets:

- `DATABENTO_API_KEY`
- `L2_INGEST_TOKEN`

Optional für den alten SIP-Shadow-Pfad:

- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`

Beispiel liegt als `deploy/.env.example` bei.

Start:

```bash
docker compose --env-file .env -f deploy/market-stack.compose.yml up -d
```

Der Collector sendet nur an den internen Relay-Ingest. Der Databento-Key erscheint niemals im Browser.

---

# 22. Browser-Anbindung

Der Browser verbindet sich ausschließlich zum Relay-SSE-Endpunkt.

Die Client-Konfiguration steht in:

`microstructure-live-config.json`

Sie bleibt `enabled:false`, solange der reale Relay-Host und das validierte Modell nicht verfügbar sind.

Im Browser wird ein L2-Signal außerdem nur akzeptiert, wenn:

- Modellstatus `validated`
- Modell-ID exakt gleich
- Schema `mbp-10`
- Horizont exakt 100
- Event aktuell
- Latenz-Gate bestanden

---

# 23. Reproduzierbarkeit Training ↔ Live

Das Paket enthält zwei unabhängige Implementierungen derselben 24 Features:

- Python: `l2_temporal_features.py`
- JavaScript: `l2-event-signal.mjs`

CI baut denselben deterministischen Event-Stream in beiden Implementierungen und vergleicht alle 24 Werte numerisch.

Aktueller Crosscheck:

- Featurezahl: 24
- maximale absolute Differenz: ca. `5.55e-11`

Damit ist die Trainings-/Live-Featuredefinition praktisch numerisch identisch.

---

# 24. Validierungen im Paket

Unter `validation/` liegen bzw. werden beim Paketbuild frisch erzeugt:

- FI-2010 Holdout-Proof
- trainiertes FI-2010-Modell
- langer Event-Horizont-Test
- Development-only Horizon Sweep
- JS Unit-Test für Δt/HDR
- Python↔JS Feature-Parity
- ORCL externe LOBSTER-Evidenz
- ORCL aktueller Proof-Verdict
- ORCL Modell-Placeholder / Status

Die Rohdaten des FI-2010-Proofs sind ebenfalls im ZIP.

---

# 25. Aktuelle wissenschaftliche Aussage

Bewiesen:

- Orderbuchzustand trägt Richtungsinformation.
- Eventhorizont und reale Eventpace sind unterschiedliche Dinge.
- Training und Live können exakt dieselbe Δt/HDR-Mathematik verwenden.

Nicht bewiesen:

- ein aktuell profitabler ORCL-Live-Edge mit hdr-dt-v1.

Daher bleibt das ORCL-Modell fail-closed, bis genau dieser Datensatz den vorgeschriebenen Holdout durchläuft.

Das ist Absicht und Teil des Modells, kein fehlendes Feature.
