# Kartenscanner

Erkennt deutsche Pokémon-Karten per Handykamera und zeigt den Cardmarket-Preis in Euro.
Ohne Konto, ohne Werbung, ohne Tracking. Die Texterkennung läuft im Browser, Fotos verlassen das Gerät nicht.

## Auf GitHub Pages veröffentlichen (einmalig, ca. 10 Minuten, am Computer)

1. Auf github.com anmelden, oben rechts **+** › **New repository**.
2. Name z. B. `kartenscanner`, Sichtbarkeit **Public**, „Add a README file“ **nicht** ankreuzen, **Create repository**.
3. Auf der neuen Seite den Link **uploading an existing file** anklicken.
4. Den **Inhalt** des entpackten Ordners `kartenscanner` (also `index.html`, `app.js`, den Ordner `vendor` usw., nicht den Ordner selbst) in das Browserfenster ziehen. Am besten in Chrome oder Edge, die nehmen Unterordner zuverlässig mit.
5. Unten **Commit changes** klicken und warten, bis alle Dateien hochgeladen sind.
6. Im Repository **Settings** › **Pages**: bei „Source“ **Deploy from a branch**, Branch **main**, Ordner **/ (root)**, **Save**.
7. Nach 1–2 Minuten steht oben auf der Pages-Seite die Adresse, z. B. `https://DEIN-NAME.github.io/kartenscanner/`.

Hinweis: Bei GitHub Pages ist der Code öffentlich sichtbar. Das ist unkritisch, weil die Seite keine Daten oder Schlüssel enthält.

## Auf dem iPhone oder iPad testen

1. Die Adresse in **Safari** öffnen.
2. **Karte scannen** tippen und den Kamerazugriff erlauben.
3. Karte in den Rahmen legen, sodass die Nummer unten links im gelben Streifen liegt, und auslösen.
4. Tipp: Über „Teilen“ › **Zum Home-Bildschirm** liegt der Scanner wie eine App auf dem Startbildschirm.

Der erste Scan dauert etwas länger, weil die Texterkennung (ca. 7 MB) geladen wird.

## Was beim ersten Test zu prüfen ist

- **Kommen Daten von TCGdex an?** Wenn bei jeder Karte „Die Kartendatenbank ist gerade nicht erreichbar“ erscheint, obwohl das WLAN funktioniert, blockiert der Browser die Anfragen. Dann melden.
- **Wird die Nummer erkannt?** Mit 20 Karten testen und notieren, wie viele direkt klappen.
- **Stimmen die Preise?** Bei 5 Karten den 30-Tage-Durchschnitt auf cardmarket.com vergleichen (Karte suchen, Sprache Deutsch, „30-Tage-Durchschnitt“).

Fehlersuche: Mit `?debug` hinter der Adresse (z. B. `…/kartenscanner/?debug`) schreibt die Seite den erkannten Text in die Browser-Konsole.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Alle Bildschirme der Seite |
| `app.js` | Kamera, Texterkennung, Abfrage bei TCGdex, Preisanzeige |
| `sets.js` | Liste der Set-Kürzel (z. B. MEW → 151). Neue Sets hier ergänzen |
| `style.css` | Aussehen, inkl. dunklem Modus |
| `datenschutz.html` | Datenschutz-Erklärung in einfacher Sprache |
| `vendor/tesseract/` | Texterkennung Tesseract.js 7 mit englischen Sprachdaten (Apache-2.0-Lizenz) |

## Datenschutz technisch abgesichert

Eine Content-Security-Policy in `index.html` erlaubt dem Browser nur Verbindungen zur eigenen Seite, zu `api.tcgdex.net` (Kartendaten) und `assets.tcgdex.net` (Kartenbilder). Es werden keine Cookies, kein lokaler Speicher und kein Cache der Texterkennung angelegt.

Datenquelle: [TCGdex](https://tcgdex.dev) (Cardmarket-Preise, täglich aktualisiert). Pokémon und alle Kartennamen sind Marken von Nintendo, Creatures und GAME FREAK; dieses Projekt ist nicht mit ihnen verbunden.
