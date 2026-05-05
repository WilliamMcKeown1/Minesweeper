const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', true);

const PUBLIC_DIR = path.join(__dirname, 'public');
const WEB_ROOT = fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : __dirname;
app.use(express.static(WEB_ROOT));

const PORT      = process.env.PORT || 3000;
const MINE_RATE = 0.16;
const BAN_MS    = 5 * 60 * 1000;
const STATE_PATH = process.env.STATE_PATH || path.join(os.tmpdir(), 'minesweeper-grid-state.json');
let SEED = process.env.SEED ? parseInt(process.env.SEED, 10) : Math.floor(Math.random() * 1e9);
let persistenceEnabled = true;

const revealed   = new Map();
const flagged    = new Map();
const mineCache  = new Map();
const countCache = new Map();
const bans       = new Map();
const players    = new Map();
let totalRevealed = 0;
let firstDigSafeCenter = null;

function saveStateNow() {
  if (!persistenceEnabled) return;
  const now = Date.now();
  const bansArr = [];
  for (const [ip, expiry] of bans.entries()) {
    if (expiry > now) bansArr.push([ip, expiry]);
  }
  const state = {
    seed: SEED,
    totalRevealed,
    firstDigSafeCenter,
    revealed: [...revealed.entries()],
    flagged: [...flagged.entries()],
    bans: bansArr,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

let saveStateTimer = null;
function scheduleSaveState() {
  if (!persistenceEnabled) return;
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    try {
      saveStateNow();
    } catch (err) {
      console.error('Failed to persist grid state:', err.message);
    }
  }, 50);
}

function loadState() {
  if (!persistenceEnabled) return;
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    if (Number.isInteger(state.seed)) SEED = state.seed;
    totalRevealed = Number.isInteger(state.totalRevealed) ? state.totalRevealed : 0;
    if (
      state.firstDigSafeCenter &&
      Number.isInteger(state.firstDigSafeCenter.col) &&
      Number.isInteger(state.firstDigSafeCenter.row)
    ) {
      firstDigSafeCenter = { col: state.firstDigSafeCenter.col, row: state.firstDigSafeCenter.row };
    }
    if (Array.isArray(state.revealed)) {
      for (const [k, n] of state.revealed) {
        if (typeof k === 'string' && Number.isInteger(n)) revealed.set(k, n);
      }
    }
    if (Array.isArray(state.flagged)) {
      for (const [k, sid] of state.flagged) {
        if (typeof k === 'string' && typeof sid === 'string') flagged.set(k, sid);
      }
    }
    if (Array.isArray(state.bans)) {
      const now = Date.now();
      for (const [ip, expiry] of state.bans) {
        if (typeof ip === 'string' && Number.isFinite(expiry) && expiry > now) bans.set(ip, expiry);
      }
    }
  } catch (err) {
    console.error('Failed to load persisted grid state:', err.message);
    persistenceEnabled = false;
  }
}

function cellHash(col, row) {
  let h = (SEED ^ (col * 2654435761) ^ (row * 2246822519)) >>> 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) >>> 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) >>> 0;
  h =  ((h >>> 16) ^ h) >>> 0;
  return h / 0xFFFFFFFF;
}

function hasMine(col, row) {
  if (
    firstDigSafeCenter &&
    Math.abs(col - firstDigSafeCenter.col) <= 1 &&
    Math.abs(row - firstDigSafeCenter.row) <= 1
  ) {
    return false;
  }
  const k = `${col},${row}`;
  if (!mineCache.has(k)) mineCache.set(k, cellHash(col, row) < MINE_RATE);
  return mineCache.get(k);
}

function countAround(col, row) {
  const k = `${col},${row}`;
  if (countCache.has(k)) return countCache.get(k);
  let n = 0;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (dr || dc) n += hasMine(col + dc, row + dr) ? 1 : 0;
  countCache.set(k, n);
  return n;
}

function doReveal(startCol, startRow) {
  const delta = [];
  const stack = [[startCol, startRow]];
  while (stack.length) {
    const [c, r] = stack.pop();
    const k = `${c},${r}`;
    if (revealed.has(k)) continue;
    const n = countAround(c, r);
    revealed.set(k, n);
    totalRevealed++;
    delta.push([c, r, n]);
    if (n === 0) {
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if ((dr || dc) && !hasMine(c + dc, r + dr))
            stack.push([c + dc, r + dr]);
    }
  }
  return delta;
}

function getIP(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || socket.handshake.address;
}

function checkBan(ip) {
  if (!bans.has(ip)) return null;
  const expiry = bans.get(ip);
  if (Date.now() >= expiry) {
    bans.delete(ip);
    scheduleSaveState();
    return null;
  }
  return expiry;
}

const PLAYER_COLORS = ['#378ADD','#1D9E75','#D85A30','#7F77DD','#D4537E','#EF9F27','#639922','#F4C0D1'];
let colorIdx = 0;

io.on('connection', socket => {
  const ip = getIP(socket);
  console.log(`+ ${socket.id} (${ip})`);

  const revealedArr = [];
  for (const [k, n] of revealed) {
    const [c, r] = k.split(',').map(Number);
    revealedArr.push([c, r, n]);
  }
  const flaggedArr = [];
  for (const [k, sid] of flagged) {
    const [c, r] = k.split(',').map(Number);
    flaggedArr.push([c, r, sid]);
  }

  const banExpiry = checkBan(ip);
  socket.emit('init', {
    revealed:  revealedArr,
    flagged:   flaggedArr,
    banned:    banExpiry !== null,
    banExpiry: banExpiry,
    seed:      SEED,
    totalRevealed,
    players: [...players.entries()].map(([id, p]) => ({ id, ...p })),
  });

  const color = PLAYER_COLORS[colorIdx++ % PLAYER_COLORS.length];
  const name  = `anon_${socket.id.slice(0, 5)}`;
  players.set(socket.id, { name, color, col: 0, row: 0 });
  io.emit('player_join', { id: socket.id, name, color, col: 0, row: 0 });

  socket.on('dig', ({ col, row }) => {
    col = Math.round(col); row = Math.round(row);
    const banExp = checkBan(ip);
    if (banExp !== null) { socket.emit('banned', { expiry: banExp }); return; }
    const k = `${col},${row}`;
    if (revealed.has(k) || flagged.has(k)) return;
    if (!firstDigSafeCenter && totalRevealed === 0) {
      // Guarantee first dig is a zero by forcing a mine-free 3x3 safe zone.
      firstDigSafeCenter = { col, row };
      scheduleSaveState();
    }
    if (hasMine(col, row)) {
      const expiry = Date.now() + BAN_MS;
      bans.set(ip, expiry);
      scheduleSaveState();
      console.log(`  BANNED ${ip} until ${new Date(expiry).toISOString()}`);
      socket.emit('banned', { expiry });
      return;
    }
    const delta = doReveal(col, row);
    if (delta.length) {
      scheduleSaveState();
      io.emit('reveal', { delta, by: socket.id });
    }
  });

  socket.on('flag', ({ col, row, on }) => {
    if (checkBan(ip) !== null) return;
    const k = `${col},${row}`;
    if (revealed.has(k)) return;
    if (on) flagged.set(k, socket.id);
    else    flagged.delete(k);
    scheduleSaveState();
    io.emit('flag', { col, row, on, by: socket.id });
  });

  socket.on('cursor', ({ col, row }) => {
    const p = players.get(socket.id);
    if (p) { p.col = col; p.row = row; }
    socket.broadcast.emit('cursor', { id: socket.id, col, row });
  });

  socket.on('disconnect', () => {
    console.log(`- ${socket.id}`);
    players.delete(socket.id);
    io.emit('player_leave', { id: socket.id });
  });
});

loadState();

if (persistenceEnabled) {
  try {
    // Smoke-test write access so Railway-like readonly filesystems fail gracefully.
    saveStateNow();
  } catch (err) {
    persistenceEnabled = false;
    console.warn('State persistence disabled:', err.message);
  }
}

server.listen(PORT, () => {
  console.log(`\n  Endless Minesweeper -> http://localhost:${PORT}`);
  console.log(`  Board seed: ${SEED}\n`);
  console.log(`  Web root: ${WEB_ROOT}`);
  console.log(`  Persistence: ${persistenceEnabled ? STATE_PATH : 'disabled'}\n`);
});
