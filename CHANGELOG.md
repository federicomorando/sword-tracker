# Changelog

## 1.2.5 — 2026-11-20
- Nel footer (home, board, pagina "Board eliminata") compaiono il riferimento alla licenza MIT e il link al repository GitHub.

## 1.2.4 — 2026-11-20
- Repository pubblico: licenza MIT, `SECURITY.md`, script `deploy/install.sh` generico (utente e hostname configurabili); la parte specifica della macchina di produzione è fuori dal repo.

## 1.2.3 — 2026-11-20
- Il footer con "Come funziona" e "Privacy e cookie" compare anche nella home (e nella pagina "Board eliminata"), non solo dentro la board.

## 1.2.2 — 2026-11-20
- Suggerimento di non usare nomi reali né altri dati personali: nella home, nel profilo, nella modifica delle targhette e nella nota Privacy.

## 1.2.1 — 2026-11-20
- Su telefono (schermi fino a 600 px) l'intestazione non resta più fissa in cima: occupava circa un quinto dello schermo.

## 1.2 — 2026-11-20
- Eliminazione della board dal menu **Board** (chiunque abbia il link, con conferma scritta); la board eliminata sparisce per tutti i collegati.
- Nota **Privacy e cookie** nel footer, accanto a un help discreto (**Come funziona**).
- Prova nel browser opzionale (`npm run e2e`).
- Node >= 22.13 (prima era indicato 22.5, ma `node:sqlite` richiedeva un flag); Dockerfile: la cartella `/data` appartiene all'utente `node`.

## 1.1 — 2026-11-20
- Spunta "ha già agito" su ogni targhetta e **Reset turn** (da tenere premuto). Migrazione automatica del database.

## 1.0.1 — 2026-11-20
- Fix: Invio nei dialoghi annullava invece di confermare (il profilo non veniva salvato).

## 1.0 — 2026-11-20
- Prima versione: board condivise in tempo reale, targhette con drag & drop, ▲▼ e ±3, profilo per board, colore, persistenza SQLite con scadenza,
  limiti per IP, deploy dietro Cloudflare Tunnel.
