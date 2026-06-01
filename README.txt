Stoma-Schablonen Skalierer: Offline-Paket

Inhalt:
- index.html
- vendor/ (lokale Bibliotheken)
- start_stoma.command (Ein-Klick Start fuer macOS)
- start_stoma_windows.bat (Ein-Klick Start fuer Windows)
- start_stoma_windows.ps1 (lokaler Windows-Server ohne Python)
- start_local_server.command (nur Server, ohne Browser-Start)

So verwendest du das Paket:
1. Ganze offline_package als Ordner auf den Zielrechner kopieren.
2. Doppelklick:
	- macOS: start_stoma.command
	- Windows: start_stoma_windows.bat
3. Die App oeffnet sich unter: http://127.0.0.1:8765
4. Vorlage laden, Linie pruefen, Ausgabe herunterladen oder drucken.

Hinweise:
- Fuer PDF-Worker und Browser-Sicherheit bitte ueber den lokalen Server (Schritt 2-3) arbeiten, nicht direkt per file://.
- Beim Drucken immer "Tatsaechliche Groesse" oder "100%" waehlen.
- Internet wird nicht benoetigt.
- Windows benoetigt kein Python: der BAT-Start nutzt standardmaessig PowerShell (ab Werk vorhanden).

Optional (Terminal statt Doppelklick):
python3 -m http.server 8765 --directory "."
Dann im Browser: http://127.0.0.1:8765

Optional Windows (ohne Python):
powershell -NoProfile -ExecutionPolicy Bypass -File .\start_stoma_windows.ps1 -Port 8765 -Root "."
