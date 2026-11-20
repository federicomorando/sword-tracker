const $ = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.replace(/^\/|\/$/g, '')).toLowerCase();
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND_COLORS = { player: '#3b82f6', monster: '#dc2626', ally: '#16a34a' };

// Testo nero su sfondi chiari, bianco su quelli scuri (soglia di massimo contrasto WCAG)
function isLight(hex) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.179;
}

if (!slug) {
  document.body.classList.add('narrow');
  $('home').hidden = false;
  $('home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = $('home-slug').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (SLUG_RE.test(s)) location.href = '/' + s;
  });
} else if (!SLUG_RE.test(slug)) {
  location.replace('/');
} else {
  startBoard();
}

function startBoard() {
  $('board-view').hidden = false;
  $('board-title').textContent = slug;
  document.title = `${slug} · SwORD Tracker`;

  let state = null;
  let ws;
  let retry = 0;
  let deleted = false;
  let editingId = null;
  const PROFILE_KEY = `sword-tracker:profile:${slug}`;
  const loadProfile = () => {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) ?? null; } catch { return null; }
  };
  const saveProfile = (p) => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* ignora */ } };
  let profile = loadProfile();

  // --- rete ---
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?board=${encodeURIComponent(slug)}`);
    ws.onopen = () => { retry = 0; setStatus(true); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') { state = m.state; render(); }
      else if (m.type === 'deleted') {
        deleted = true;
        $('board-view').hidden = true;
        $('gone').hidden = false;
        document.body.classList.add('narrow');
        document.title = 'Board eliminata · SwORD Tracker';
      } else if (m.type === 'error') showError(m.message);
    };
    ws.onclose = (e) => {
      if (deleted) return;
      setStatus(false);
      if (e.code === 1008) {
        showError(e.reason || 'Connessione rifiutata');
        $('error').hidden = false;
        clearTimeout(errTimer);
        return;
      }
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    };
  }
  const send = (op) => { if (ws?.readyState === 1) ws.send(JSON.stringify(op)); else showError('Non connesso'); };
  function setStatus(ok) {
    $('status').textContent = ok ? 'connesso' : 'riconnessione…';
    $('status').className = 'status ' + (ok ? 'ok' : 'off');
  }
  let errTimer;
  function showError(msg) {
    $('error').textContent = msg; $('error').hidden = false;
    clearTimeout(errTimer); errTimer = setTimeout(() => { $('error').hidden = true; }, 4000);
  }

  // --- render ---
  function render() {
    if (!state) return;
    const list = $('slots');
    list.replaceChildren();
    const mineName = profile?.characterName;
    for (let n = state.maxSlot; n >= state.minSlot; n--) {
      const li = document.createElement('li');
      li.className = 'slot';
      li.dataset.slot = n;
      const num = document.createElement('div');
      num.className = 'slot-num'; num.textContent = n;
      const box = document.createElement('div');
      box.className = 'slot-tokens';
      for (const t of state.tokens.filter((x) => x.slot === n)) box.append(tokenEl(t, mineName));
      li.append(num, box);
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => onDrop(e, li, n));
      list.append(li);
    }
  }

  function tokenEl(t, mineName) {
    const el = document.createElement('div');
    el.className = 'token' + (mineName && t.name === mineName && t.kind === 'player' ? ' mine' : '');
    el.style.background = t.color;
    if (isLight(t.color)) el.classList.add('light');
    el.draggable = true;
    el.dataset.id = t.id;
    el.classList.toggle('acted', t.acted);
    const box = document.createElement('label');
    box.className = 'acted-box';
    box.title = 'Ha già agito in questo turno';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = t.acted;
    check.setAttribute('aria-label', `${t.name}: ha già agito in questo turno`);
    check.addEventListener('change', () => send({ type: 'update', id: t.id, acted: check.checked }));
    box.append(check);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = t.name;
    if (t.playerName) { const s = document.createElement('small'); s.textContent = t.playerName; label.append(s); }
    label.addEventListener('click', () => openTokenDialog(t));
    const moveGroup = (defs) => {
      const g = document.createElement('div');
      g.className = 'move';
      for (const [txt, d, title] of defs) {
        const b = document.createElement('button');
        b.textContent = txt; b.title = title; b.setAttribute('aria-label', title);
        b.addEventListener('click', () => {
          // lo spostamento si ferma allo slot di confine
          const slot = Math.max(state.minSlot, Math.min(state.maxSlot, t.slot + d));
          if (slot !== t.slot) send({ type: 'move', id: t.id, slot });
        });
        g.append(b);
      }
      return g;
    };
    const mv = moveGroup([['▲', 1, 'Su di 1'], ['▼', -1, 'Giù di 1']]);
    const mv3 = moveGroup([['+3', 3, 'Su di 3'], ['−3', -3, 'Giù di 3']]);
    el.append(box, label, mv, mv3);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  }

  function onDrop(e, li, slot) {
    e.preventDefault();
    li.classList.remove('over');
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    // indice di inserimento: prima della targhetta il cui centro è oltre il cursore
    const others = [...li.querySelectorAll('.token')].filter((x) => x.dataset.id !== id);
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      const before = e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
      if (before) { index = i; break; }
    }
    send({ type: 'move', id, slot, index });
  }

  // --- dialoghi ---
  // returnValue resta quello della chiusura precedente (anche con Esc): va azzerato a ogni apertura
  const openDialog = (dlg) => { dlg.returnValue = ''; dlg.showModal(); };
  // Annulla è type="button": così il pulsante predefinito (Invio nei campi) è quello di conferma
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('cancel')));
  const closeOnCancel = (dlg) => dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  ['dlg-profile', 'dlg-monster', 'dlg-token', 'dlg-config', 'dlg-delete'].forEach((id) => closeOnCancel($(id)));
  const defaultSlot = () => Math.min(Math.max(0, state?.minSlot ?? 0), state?.maxSlot ?? 0);

  function openProfile() {
    const f = $('form-profile');
    f.role.value = profile?.role ?? 'player';
    f.playerName.value = profile?.playerName ?? '';
    f.characterName.value = profile?.characterName ?? '';
    f.color.value = profile?.color ?? KIND_COLORS.player;
    openDialog($('dlg-profile'));
  }
  $('btn-profile').addEventListener('click', openProfile);
  $('dlg-profile').addEventListener('close', () => {
    if ($('dlg-profile').returnValue !== 'ok') return;
    const f = $('form-profile');
    const prev = profile;
    profile = { role: f.role.value, playerName: f.playerName.value.trim(), characterName: f.characterName.value.trim(), color: f.color.value };
    saveProfile(profile);
    // se il colore è cambiato, aggiorna anche la mia targhetta già presente sulla board
    if (prev && prev.color !== profile.color) {
      for (const t of state?.tokens ?? []) {
        if (t.kind === 'player' && t.name === prev.characterName && t.playerName === prev.playerName) {
          send({ type: 'update', id: t.id, color: profile.color });
        }
      }
    }
    applyProfileUI();
    render();
  });

  function applyProfileUI() {
    const master = profile?.role === 'master';
    $('btn-add-me').hidden = master;
  }

  $('btn-add-me').addEventListener('click', () => {
    if (!profile?.characterName) { openProfile(); return; }
    if (state.tokens.some((t) => t.kind === 'player' && t.name === profile.characterName && t.playerName === profile.playerName)) {
      showError('Il tuo personaggio è già sulla board'); return;
    }
    send({ type: 'create', name: profile.characterName, playerName: profile.playerName, kind: 'player', color: profile.color, slot: defaultSlot() });
  });

  $('btn-add-monster').addEventListener('click', () => {
    const f = $('form-monster');
    f.slot.value = defaultSlot(); f.slot.min = state.minSlot; f.slot.max = state.maxSlot;
    openDialog($('dlg-monster'));
  });
  $('dlg-monster').addEventListener('close', () => {
    if ($('dlg-monster').returnValue !== 'ok') return;
    const f = $('form-monster');
    const count = Math.max(1, Math.min(20, parseInt(f.count.value, 10) || 1));
    const base = f.name.value.trim();
    if (!base) return;
    for (let i = 1; i <= count; i++) {
      send({ type: 'create', name: count > 1 ? `${base} ${i}` : base, kind: f.kind.value, slot: parseInt(f.slot.value, 10) });
    }
    f.name.value = ''; f.count.value = 1;
  });

  function openTokenDialog(t) {
    editingId = t.id;
    const f = $('form-token');
    f.name.value = t.name; f.playerName.value = t.playerName; f.kind.value = t.kind; f.color.value = t.color;
    openDialog($('dlg-token'));
  }
  $('form-token').kind.addEventListener('change', (e) => { $('form-token').color.value = KIND_COLORS[e.target.value]; });
  $('btn-delete').addEventListener('click', () => {
    send({ type: 'delete', id: editingId });
    $('dlg-token').close('cancel');
  });
  $('dlg-token').addEventListener('close', () => {
    if ($('dlg-token').returnValue !== 'ok') return;
    const f = $('form-token');
    send({ type: 'update', id: editingId, name: f.name.value, playerName: f.playerName.value, kind: f.kind.value, color: f.color.value });
  });

  $('btn-config').addEventListener('click', () => {
    const f = $('form-config');
    f.minSlot.value = state.minSlot; f.maxSlot.value = state.maxSlot;
    openDialog($('dlg-config'));
  });
  $('dlg-config').addEventListener('close', () => {
    if ($('dlg-config').returnValue !== 'ok') return;
    const f = $('form-config');
    send({ type: 'config', minSlot: parseInt(f.minSlot.value, 10), maxSlot: parseInt(f.maxSlot.value, 10) });
  });

  // Reset turn: richiede la pressione prolungata, così è difficile da attivare per sbaglio
  const HOLD_MS = 1200;
  const resetBtn = $('btn-reset-turn');
  let holdTimer = null;
  const startHold = () => {
    if (holdTimer) return;
    resetBtn.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      resetBtn.classList.remove('holding');
      send({ type: 'resetTurn' });
    }, HOLD_MS);
  };
  const stopHold = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    resetBtn.classList.remove('holding');
  };
  resetBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) startHold(); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) resetBtn.addEventListener(ev, stopHold);
  resetBtn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); startHold(); }
  });
  resetBtn.addEventListener('keyup', stopHold);
  resetBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // Eliminazione della board: chiunque abbia il link, dopo aver scritto il nome per confermare
  $('btn-delete-board').addEventListener('click', () => {
    $('dlg-config').close('cancel');
    const f = $('form-delete');
    f.confirm.value = '';
    $('btn-confirm-delete').disabled = true;
    $('delete-name').textContent = slug;
    openDialog($('dlg-delete'));
  });
  $('form-delete').confirm.addEventListener('input', (e) => {
    $('btn-confirm-delete').disabled = e.target.value.trim().toLowerCase() !== slug;
  });
  $('dlg-delete').addEventListener('close', () => {
    if ($('dlg-delete').returnValue !== 'ok') return;
    send({ type: 'deleteBoard' });
  });

  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('btn-copy').textContent = 'Copiato!'; }
    catch { prompt('Copia il link:', location.href); }
    setTimeout(() => { $('btn-copy').textContent = 'Copia link'; }, 1500);
  });

  applyProfileUI();
  connect();
  if (!profile) setTimeout(openProfile, 300);
}
