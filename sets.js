// Set-Kürzel, wie sie unten links auf neueren Karten stehen (seit Karmesin & Purpur, 2023),
// zugeordnet zur Set-ID in der TCGdex-Datenbank.
// Die App prüft jede Zuordnung gegen die Kartenanzahl hinter dem Schrägstrich ("025/165").
// Passt sie nicht oder fehlt ein Kürzel, zeigt die App alle Sets mit dieser Kartenanzahl zur Auswahl.
// Neue Sets einfach hier ergänzen.
window.SET_CODES = {
  SVI: 'sv01',    // Karmesin & Purpur
  PAL: 'sv02',    // Entwicklungen in Paldea
  OBF: 'sv03',    // Obsidianflammen
  MEW: 'sv03.5',  // 151
  PAR: 'sv04',    // Paradoxrift
  PAF: 'sv04.5',  // Paldeas Schicksale
  TEF: 'sv05',    // Gewalten der Zeit
  TWM: 'sv06',    // Maskerade im Zwielicht
  SFA: 'sv06.5',  // Nebel der Sagen
  SCR: 'sv07',    // Stellarkrone
  SSP: 'sv08',    // Stürmische Funken
  PRE: 'sv08.5',  // Prismatische Entwicklungen
  JTG: 'sv09',    // Reisegefährten
  DRI: 'sv10',    // Ewige Rivalen
  WHT: 'sv10.5w', // Weiße Flamme
  BLK: 'sv10.5b', // Schwarzer Blitz
  MEG: 'me01',    // Mega-Entwicklung
  PFL: 'me02'     // Fatale Flammen
};
