# SwORD Tracker

Tracker dell'iniziativa condiviso per SwORD 2.0. Master e giocatori vedono la stessa colonna di slot (di base da -1 a 15, configurabile)
e ne spostano le targhette in tempo reale. Nessuna registrazione: apri `/<nome-board>` e la board viene creata al primo accesso;
chi ha il link la vede e la modifica. Le modifiche sono persistenti.

## Funzioni
- **Targhette** di personaggi, mostri e alleati, con colore (il testo diventa nero sui colori chiari). Più targhette per slot, ordine libero.
- **Spostamenti**: drag & drop, ▲▼ (di 1), +3/−3 (si fermano allo slot di confine). Utilizzabile anche da smartphone.
- **Ha già agito**: spunta a sinistra di ogni targhetta, condivisa e mantenuta negli spostamenti; **Reset turn** (da tenere premuto 1,2 s) le azzera.
- **Profilo volante** per board (ruolo, nome giocatore, nome personaggio, colore), salvato solo nel browser. **+ Il mio personaggio** lo usa
  per creare la targhetta; **+ PNG** aggiunge mostri o alleati, anche più copie numerate.
- **Board**: cambio dell'intervallo degli slot ed **eliminazione** della board (chiunque abbia il link, dopo aver scritto il nome per confermare).
  Ciascuno può eliminare anche solo il proprio personaggio. Le board inutilizzate per `BOARD_TTL_DAYS` giorni vengono cancellate.
- **Help, nota privacy/cookie, licenza e link al codice** nel footer, non invasivi: il sito non imposta cookie propri e non salva nulla che richieda consenso.

## Sviluppo
`npm install && npm start` (http://localhost:3000), test con `npm test`. Serve Node >= 22.13 (usa `node:sqlite` senza flag).
Se la porta 3000 è già occupata (per esempio dal servizio installato) usa `PORT=3001 DB_PATH=data/dev.db npm start`.

Variabili: `HOST` (127.0.0.1), `PORT` (3000), `DB_PATH` (`data/tracker.db`), `BOARD_TTL_DAYS` (365),
`MAX_CONN_PER_IP` (20), `ALLOWED_ORIGINS` (origini extra ammesse sul WebSocket, separate da virgola; di default solo lo stesso host).

Test: `npm test` (logica, protocollo WebSocket, limiti, migrazioni). Prova nel browser, opzionale: `npm run e2e` apre un server temporaneo e
pilota due utenti con Chromium (serve Playwright: `npm i --no-save playwright && npx playwright install chromium`, oppure
`PLAYWRIGHT_FROM=/percorso/di/un/package.json` che lo contiene; `SCREENSHOTS=/cartella` salva alcune immagini).

## Dati e limiti
I dati sono in SQLite (`DB_PATH`, modalità WAL; le colonne nuove si aggiungono da sole all'avvio). Per un backup (anche a servizio attivo) senza installare nulla:
`node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1],{readOnly:true}).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" /opt/sword-tracker-data/tracker.db /percorso/backup.db`
(il file di destinazione non deve esistere; in alternativa `sqlite3 <db> ".backup <file>"` se il comando è installato). Non ci sono backup automatici.
Limiti: 200 targhette per board, al massimo 100 slot, nomi di 40 caratteri, messaggi WebSocket di 4 KB.

## Sicurezza
Il server ascolta solo su 127.0.0.1 e sta dietro a un tunnel Cloudflare (nessuna porta aperta). Limiti per IP reale
(`CF-Connecting-IP`, letto solo da connessioni loopback): 20 connessioni WebSocket, 20 operazioni al secondo (10/s per connessione),
10 board nuove all'ora. Il WebSocket rifiuta le richieste con `Origin` di altri siti. Le risposte HTTP hanno CSP, `nosniff` e `X-Frame-Options`.
Le board sono protette solo dal nome nel link (nessun account): chi lo conosce può modificarle ed eliminarle.
L'applicazione non salva gli indirizzi IP né li scrive nei log (li usa solo in memoria per i limiti). Nessun innerHTML nel client: tutto il testo
inserito dagli utenti è mostrato come testo semplice. L'unica dipendenza è `ws` (`npm audit`: nessuna vulnerabilità nota al 2026-11-20).
Se usi Docker, la connessione non arriva da loopback: `CF-Connecting-IP` viene ignorato e tutti gli utenti condividono i limiti dell'IP del gateway Docker.

## Deploy (Linux, systemd, Cloudflare Tunnel)
Istanza ufficiale: <https://tracker.swordrpg.com>. Per ospitarne una tua serve Linux con systemd, Node >= 22.13 e un modo per pubblicare
`127.0.0.1:3000` (qui: Cloudflare Tunnel, senza porte aperte). Lo script fa il lato sistema:

    sudo HOSTNAME_PUBLIC=tracker.example.org bash deploy/install.sh

Cosa fa (idempotente: si rilancia anche per aggiornare il codice): controlla Node, copia il codice in `/opt/sword-tracker`, installa il servizio
`sword-tracker` (`deploy/sword-tracker.service`, con hardening systemd; l'utente è chi ha lanciato `sudo`, oppure `RUN_USER`), lo avvia e controlla se
la route del tunnel esiste già. I dati sono in `/opt/sword-tracker-data`. Se la tua macchina ha altri servizi (es. nginx) da sistemare, fallo a parte:
il repo contiene solo la parte generica.

### Route del tunnel (a mano, dalla dashboard)
Se il tunnel è **gestito dalla dashboard Cloudflare**, gli hostname di `/etc/cloudflared/config.yml` vengono ignorati, e una richiesta
per un hostname non presente nella dashboard riceve un 404 vuoto dalla regola finale.
1. Networking > Tunnels > (il tunnel) > Routes > Add route > **Published application**.
2. Il tuo hostname, servizio tipo **HTTP** (non HTTPS: con HTTPS il tracker risponde 502) e URL `localhost:3000`.
3. La dashboard crea il record DNS (CNAME verso `<id-tunnel>.cfargotunnel.com`, proxy attivo). Non usare `cloudflared tunnel route dns`:
   usa la zona del certificato locale, che può essere diversa da quella voluta.
4. **Non** creare un'applicazione Access: la board deve essere aperta.

Impostazioni consigliate sulla dashboard della zona (attive sull'istanza ufficiale al 2026-11-20): SSL/TLS "Full" (automatico),
Always Use HTTPS (http → 301 su https), Bot Fight Mode, regola di rate limiting `(http.request.uri.path eq "/ws")`: 30 richieste/10 s per IP,
blocco 10 s (verificato: la 32ª connessione in 4 s riceve 429, poi l'accesso torna normale).
Bot Fight Mode non imposta cookie visibili, ma inietta in `index.html` uno script inline di JavaScript Detections: la CSP lo blocca
(solo un messaggio in console, nessun effetto sul sito). Per evitarlo, disattiva "JavaScript Detections" nella stessa pagina.
Se compaiono cookie, aggiorna la nota in `client/index.html`.

### Diagnosi
- `404` vuoto da Cloudflare: la route manca nella dashboard (richiesta caduta nella regola finale `http_status:404`).
- `502`: servizio giù, oppure route configurata come HTTPS invece di HTTP.
- Nome non risolvibile subito dopo la creazione: cache DNS negativa dei resolver, passa da sola.
- Configurazione realmente in uso: `journalctl -u cloudflared | grep 'Updated to new configuration'`.

Alternativa con Docker (non provata): `docker compose up -d`, porta pubblicata solo su 127.0.0.1:3000.

## Licenza
MIT (vedi `LICENSE`). Segnalazioni di sicurezza: vedi `SECURITY.md`.
