const CELL_MIN   = 12;
const CELL_MAX   = 56;
const CELL_START = 28;

const NUM_COLORS = ['','#378ADD','#639922','#E24B4A','#7F77DD','#D85A30','#1D9E75','#D3D1C7','#888780'];

// ── State ─────────────────────────────────────────────
let revealed   = {};   // key -> neighbour count
let flagged    = {};   // key -> socket id who flagged
let offsetX    = 0;
let offsetY    = 0;
let cellSize   = CELL_START;
let flagMode   = false;
let banned     = false;
let banExpiry  = 0;
let myStreak   = 0;
let myId       = null;
let players    = {};   // id -> { name, color, col, row }
let totalRev   = 0;
let hasEverDug = false;
const OFFLINE_BAN_MS = 2 * 1000;
const OFFLINE_SEED = 1337;
const OFFLINE_MINE_RATE = 0.16;
const offlineMineCache = new Map();
const offlineCountCache = new Map();
let offlineFirstDigSafeCenter = null;
const OFFLINE_STATE_KEY = 'minesweeper_offline_state_v1';

// Cursor throttle
let lastCursorEmit = 0;

// ── DOM ───────────────────────────────────────────────
const canvas   = document.getElementById('c');
const ctx      = canvas.getContext('2d');
const wrap     = document.getElementById('board-wrap');
const modeBtn  = document.getElementById('mode-btn');
const banScreen = document.getElementById('ban-screen');
const banTimer = document.getElementById('ban-timer');
const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');
let boardDirty = true;

// ── Socket ────────────────────────────────────────────
let clientUUID = localStorage.getItem('player_uuid');
if (!clientUUID) { clientUUID = crypto.randomUUID(); localStorage.setItem('player_uuid', clientUUID); }
const socket = (typeof io === 'function') ? io({ query: { uuid: clientUUID } }) : null;

if (socket) {
  socket.on('connect', () => { myId = socket.id; });

  socket.on('init', data => {
    // Load full board state
    revealed = {};
    flagged  = {};
    for (const [c, r, n] of data.revealed) revealed[`${c},${r}`] = n;
    for (const [c, r, sid] of (data.flagged || [])) flagged[`${c},${r}`] = sid;

    totalRev = data.totalRevealed || 0;
    document.getElementById('s-rev').textContent = totalRev;

    // Load existing players
    players = {};
    for (const p of (data.players || [])) players[p.id] = p;
    updateOnlineCount();
    if (data.uuid) {
    document.cookie = `player_uuid=${data.uuid};max-age=31536000;path=/`;
    }

    if (data.banned && data.banExpiry > Date.now()) {
      applyBan(data.banExpiry);
    }

    draw();
  });

  socket.on('reveal', ({ delta, by }) => {
    for (const [c, r, n] of delta) revealed[`${c},${r}`] = n;
    totalRev += delta.length;
    document.getElementById('s-rev').textContent = totalRev;
    if (by === myId) {
      hasEverDug = true
      myStreak += delta.length;
      document.getElementById('s-streak').textContent = myStreak;
    }
    draw();
  });

  socket.on('flag', ({ col, row, on, by }) => {
    const k = `${col},${row}`;
    if (on) flagged[k] = by;
    else    delete flagged[k];
    draw();
  });

  socket.on('banned', ({ expiry }) => {
    myStreak = 0;
    document.getElementById('s-streak').textContent = 0;
    applyBan(expiry);
  });

  socket.on('player_join',  p => { players[p.id] = p; updateOnlineCount(); draw(); });
  socket.on('player_leave', ({ id }) => { delete players[id]; updateOnlineCount(); draw(); });
  socket.on('cursor', ({ id, col, row }) => {
    if (players[id]) { players[id].col = col; players[id].row = row; }
    draw();
  });
} else {
  // Keep the board usable even if socket.io client script failed to load.
  console.warn('Socket.io client not available; running in offline view mode.');
  initOfflineMode();
}

// ── Ban logic ─────────────────────────────────────────
function applyBan(expiry) {
  banned    = true;
  banExpiry = expiry;
  banScreen.classList.add('active');
  updateBanTimer();
}

function updateBanTimer() {
  if (!banned) return;
  const ms  = Math.max(0, banExpiry - Date.now());
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  banTimer.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  if (ms <= 0) {
    banned = false;
    banScreen.classList.remove('active');
    saveOfflineState();
  } else {
    saveOfflineState();
    setTimeout(updateBanTimer, 500);
  }
}

// ── Helpers ───────────────────────────────────────────
function key(col, row) { return `${col},${row}`; }

function screenToCell(sx, sy) {
  return [Math.floor((sx - offsetX) / cellSize), Math.floor((sy - offsetY) / cellSize)];
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function updateOnlineCount() {
  document.getElementById('s-online').textContent = Object.keys(players).length;
}

function updateRevealedCount() {
  document.getElementById('s-rev').textContent = totalRev;
}

function updateStreakCount() {
  document.getElementById('s-streak').textContent = myStreak;
}

function offlineCellHash(col, row) {
  let h = (OFFLINE_SEED ^ (col * 2654435761) ^ (row * 2246822519)) >>> 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) >>> 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) >>> 0;
  h = ((h >>> 16) ^ h) >>> 0;
  return h / 0xFFFFFFFF;
}

function offlineHasMine(col, row) {
  if (
    offlineFirstDigSafeCenter &&
    Math.abs(col - offlineFirstDigSafeCenter.col) <= 1 &&
    Math.abs(row - offlineFirstDigSafeCenter.row) <= 1
  ) {
    return false;
  }
  const k = key(col, row);
  if (!offlineMineCache.has(k)) offlineMineCache.set(k, offlineCellHash(col, row) < OFFLINE_MINE_RATE);
  return offlineMineCache.get(k);
}

function offlineCountAround(col, row) {
  const k = key(col, row);
  if (offlineCountCache.has(k)) return offlineCountCache.get(k);
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr || dc) n += offlineHasMine(col + dc, row + dr) ? 1 : 0;
    }
  }
  offlineCountCache.set(k, n);
  return n;
}

function offlineReveal(startCol, startRow) {
  const delta = [];
  hasEverDug = true;  
  const stack = [[startCol, startRow]];
  while (stack.length) {
    const [c, r] = stack.pop();
    const k = key(c, r);
    if (k in revealed || k in flagged) continue;
    const n = offlineCountAround(c, r);
    revealed[k] = n;
    delta.push([c, r, n]);
    if (n === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((dr || dc) && !offlineHasMine(c + dc, r + dr)) stack.push([c + dc, r + dr]);
        }
      }
    }
  }
  return delta;
}

function initOfflineMode() {
  myId = 'offline-player';
  players = { [myId]: { name: 'you', color: '#1D9E75', col: 0, row: 0 } };
  updateOnlineCount();
  loadOfflineState();
  updateRevealedCount();
  updateStreakCount();
  draw();
}

function saveOfflineState() {
  try {
    localStorage.setItem(OFFLINE_STATE_KEY, JSON.stringify({
      revealed,
      flagged,
      totalRev,
      myStreak,
      offlineFirstDigSafeCenter,
      banned,
      banExpiry,
    }));
  } catch (err) {
    console.warn('Failed to save offline state:', err);
  }
}

function loadOfflineState() {
  revealed = {};
  flagged = {};
  totalRev = 0;
  myStreak = 0;
  offlineFirstDigSafeCenter = null;
  try {
    const raw = localStorage.getItem(OFFLINE_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state && typeof state === 'object') {
      if (state.revealed && typeof state.revealed === 'object') revealed = state.revealed;
      if (state.flagged && typeof state.flagged === 'object') flagged = state.flagged;
      if (Number.isInteger(state.totalRev)) totalRev = state.totalRev;
      if (Number.isInteger(state.myStreak)) myStreak = state.myStreak;
      if (
        state.offlineFirstDigSafeCenter &&
        Number.isInteger(state.offlineFirstDigSafeCenter.col) &&
        Number.isInteger(state.offlineFirstDigSafeCenter.row)
      ) {
        offlineFirstDigSafeCenter = {
          col: state.offlineFirstDigSafeCenter.col,
          row: state.offlineFirstDigSafeCenter.row,
        };
      }
      if (state.banned === true && Number.isFinite(state.banExpiry) && state.banExpiry > Date.now()) {
        applyBan(state.banExpiry);
      } else {
        banned = false;
        banExpiry = 0;
      }
    }
  } catch (err) {
    console.warn('Failed to load offline state:', err);
  }
}

canvas.addEventListener('mouseup', e => {
  wasPanning = didPan;  // capture before reset
  if (!didPan) {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.button === 0) flagMode ? handleFlag(sx, sy) : handleDig(sx, sy);
  }
  panning  = false;
  panStart = null;
  panOff   = null;
  didPan   = false;
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!wasPanning) {
    const r = canvas.getBoundingClientRect();
    handleFlag(e.clientX - r.left, e.clientY - r.top);
  }
});

function isNearRevealed(col, row, maxDist = 2) {
  for (let dr = -maxDist; dr <= maxDist; dr++) {
    for (let dc = -maxDist; dc <= maxDist; dc++) {
      if (Math.abs(dr) + Math.abs(dc) > maxDist) continue; // manhattan distance
      if (`${col + dc},${row + dr}` in revealed) return true;
    }
  }
  return false;
}
// ── Draw ──────────────────────────────────────────────
function drawBoard() {
  if (!boardDirty) return;
  boardDirty = false;
  offscreen.width  = canvas.width;
  offscreen.height = canvas.height;

  const W  = offscreen.width;
  const H  = offscreen.height;
  const cs = cellSize;

  const bgCell = cssVar('--bg-cell');
  const bgRev  = cssVar('--bg-rev');
  const border = cssVar('--border');
  const textC  = cssVar('--text');

  offCtx.clearRect(0, 0, W, H);

  const colMin = Math.floor(-offsetX / cs) - 1;
  const colMax = Math.ceil((W - offsetX) / cs) + 1;
  const rowMin = Math.floor(-offsetY / cs) - 1;
  const rowMax = Math.ceil((H - offsetY) / cs) + 1;

  for (let row = rowMin; row < rowMax; row++) {
    for (let col = colMin; col < colMax; col++) {
      const k = `${col},${row}`;
      const x = offsetX + col * cs;
      const y = offsetY + row * cs;

      if (k in revealed) {
        offCtx.fillStyle = bgRev;
        offCtx.fillRect(x, y, cs, cs);
        offCtx.strokeStyle = border;
        offCtx.lineWidth = 0.5;
        offCtx.strokeRect(x + 0.25, y + 0.25, cs - 0.5, cs - 0.5);
        const n = revealed[k];
        if (n > 0) {
          offCtx.fillStyle = NUM_COLORS[n] || textC;
          offCtx.font = `600 ${Math.round(cs * 0.52)}px 'Courier New', monospace`;
          offCtx.textAlign = 'center';
          offCtx.textBaseline = 'middle';
          offCtx.fillText(n, x + cs / 2, y + cs / 2 + 1);
        }
      } else if (k in flagged) {
        offCtx.fillStyle = bgCell;
        offCtx.fillRect(x, y, cs, cs);
        offCtx.strokeStyle = border;
        offCtx.lineWidth = 0.5;
        offCtx.strokeRect(x + 0.25, y + 0.25, cs - 0.5, cs - 0.5);
        const fx = x + cs / 2, fy = y + cs / 2;
        offCtx.strokeStyle = '#D85A30';
        offCtx.lineWidth = cs * 0.07;
        offCtx.beginPath();
        offCtx.moveTo(fx - cs*0.04, fy - cs*0.32);
        offCtx.lineTo(fx - cs*0.04, fy + cs*0.28);
        offCtx.stroke();
        offCtx.fillStyle = '#D85A30';
        offCtx.beginPath();
        offCtx.moveTo(fx - cs*0.04, fy - cs*0.32);
        offCtx.lineTo(fx + cs*0.28, fy - cs*0.12);
        offCtx.lineTo(fx - cs*0.04, fy + cs*0.06);
        offCtx.closePath();
        offCtx.fill();
        if (flagged[k] !== myId) {
          const p = players[flagged[k]];
          if (p) {
            offCtx.fillStyle = p.color;
            offCtx.beginPath();
            offCtx.arc(x + cs*0.82, y + cs*0.18, cs*0.1, 0, Math.PI*2);
            offCtx.fill();
          }
        }
      } else {
        offCtx.fillStyle = bgCell;
        offCtx.fillRect(x, y, cs, cs);
        offCtx.strokeStyle = border;
        offCtx.lineWidth = 0.5;
        offCtx.strokeRect(x + 0.25, y + 0.25, cs - 0.5, cs - 0.5);
      }
    }
  }
}

function draw() {
  drawBoard();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(offscreen, 0, 0);

  const cs = cellSize;
  const W  = canvas.width;
  const H  = canvas.height;

  if (cs >= 10) {
    for (const [id, p] of Object.entries(players)) {
      if (id === myId) continue;
      const cx = offsetX + p.col * cs + cs / 2;
      const cy = offsetY + p.row * cs + cs / 2;
      if (cx < -cs || cx > W + cs || cy < -cs || cy > H + cs) continue;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4, cs * 0.16), 0, Math.PI * 2);
      ctx.fill();
      if (cs >= 16) {
        ctx.fillStyle = p.color;
        ctx.font = `500 ${Math.max(9, Math.round(cs * 0.35))}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(p.name, cx + 6, cy - 2);
      }
    }
  }
}
// ── Interaction ───────────────────────────────────────
function handleDig(sx, sy) {
  if (banned) return;
  const [col, row] = screenToCell(sx, sy);
  const k = key(col, row);
  if (k in revealed || k in flagged) return;
  if (hasEverDug && !isNearRevealed(col, row)) return;
  if (socket) {
    socket.emit('dig', { col, row });
    return;
  }
  if (!offlineFirstDigSafeCenter && totalRev === 0) {
    // Guarantee first dig is a zero by forcing a mine-free 3x3 safe zone.
    offlineFirstDigSafeCenter = { col, row };
  }
  if (offlineHasMine(col, row)) {
    myStreak = 0;
    updateStreakCount();
    applyBan(Date.now() + OFFLINE_BAN_MS);
    saveOfflineState();
    return;
  }
  const delta = offlineReveal(col, row);
  totalRev += delta.length;
  myStreak += delta.length;
  updateRevealedCount();
  updateStreakCount();
  saveOfflineState();
  draw();
}

function handleFlag(sx, sy) {
  if (banned) return;
  const [col, row] = screenToCell(sx, sy);
  const k = key(col, row);
  if (k in revealed) return;
  if (totalRev > 0 && !isNearRevealed(col, row)) return;
  const on = !(k in flagged);
  if (socket) {
    socket.emit('flag', { col, row, on });
    return;
  }
  if (on) flagged[k] = myId;
  else    delete flagged[k];
  saveOfflineState();
  draw();
}

function emitCursor(sx, sy) {
  const now = Date.now();
  if (now - lastCursorEmit < 50) return;
  lastCursorEmit = now;
  const [col, row] = screenToCell(sx, sy);
  socket?.emit('cursor', { col, row });
  document.getElementById('s-pos').textContent = `${col}, ${row}`;
}

// ── Mode toggle ───────────────────────────────────────
modeBtn.onclick = () => {
  flagMode = !flagMode;
  modeBtn.textContent = flagMode ? 'flag mode' : 'dig mode';
  modeBtn.className   = flagMode ? 'flag' : '';
};

// ── Resize ────────────────────────────────────────────
function resize() {
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}
new ResizeObserver(resize).observe(wrap);
resize();

// ── Mouse ─────────────────────────────────────────────
let panning  = false;
let panStart = null;
let panOff   = null;
let didPan   = false;
let wasPanning = false;

canvas.addEventListener('mousedown', e => {
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    panning  = true;
    didPan   = false;
    panStart = [e.clientX, e.clientY];
    panOff   = [offsetX, offsetY];
    return;
  }
  if (e.button === 0) {
    panning  = false;
    didPan   = false;
    panStart = [e.clientX, e.clientY];
    panOff   = [offsetX, offsetY];
  }
});

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  emitCursor(e.clientX - r.left, e.clientY - r.top);
  if (!panStart) return;
  const dx = e.clientX - panStart[0];
  const dy = e.clientY - panStart[1];
  if (panning || e.buttons === 4 || e.buttons === 2) {
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      offsetX = panOff[0] + dx;
      offsetY = panOff[1] + dy;
      didPan  = true;
      boardDirty = true;
      draw();
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  panning  = false;
  panStart = null;
  panOff   = null;
  didPan   = false;
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r      = canvas.getBoundingClientRect();
  const mx     = e.clientX - r.left;
  const my     = e.clientY - r.top;
  const worldX = (mx - offsetX) / cellSize;
  const worldY = (my - offsetY) / cellSize;
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  cellSize     = Math.min(CELL_MAX, Math.max(CELL_MIN, cellSize * factor));
  offsetX      = mx - worldX * cellSize;
  offsetY      = my - worldY * cellSize;
  boardDirty   = true;
  draw();
}, { passive: false });

// ── Touch ─────────────────────────────────────────────
let touchStart = null;

canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const r = canvas.getBoundingClientRect();
    touchStart = { x: t.clientX - r.left, y: t.clientY - r.top, ox: offsetX, oy: offsetY, moved: false };
  }
}, { passive: true });

canvas.addEventListener('touchmove', e => {
  if (e.touches.length === 1 && touchStart) {
    const t  = e.touches[0];
    const r  = canvas.getBoundingClientRect();
    const dx = (t.clientX - r.left) - touchStart.x;
    const dy = (t.clientY - r.top)  - touchStart.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      offsetX = touchStart.ox + dx;
      offsetY = touchStart.oy + dy;
      touchStart.moved = true;
      boardDirty = true;
      draw();
    }
  }
}, { passive: true });

canvas.addEventListener('touchend', () => {
  if (touchStart && !touchStart.moved) {
    flagMode ? handleFlag(touchStart.x, touchStart.y) : handleDig(touchStart.x, touchStart.y);
  }
  touchStart = null;
});
