const NUM_COLORS = ["", "#378ADD", "#639922", "#E24B4A", "#7F77DD", "#D85A30", "#1D9E75", "#D3D1C7", "#888780"];

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const wrap = document.getElementById("board-wrap");

const widthInput = document.getElementById("grid-width");
const heightInput = document.getElementById("grid-height");
const mineRateInput = document.getElementById("mine-rate");
const newGameBtn = document.getElementById("new-game-btn");
const statusLabel = document.getElementById("solo-status");   // fix: was missing
const revealedLabel = document.getElementById("solo-revealed");
const minesLabel = document.getElementById("solo-mines");

const STATE_PLAYING = "playing";
const STATE_WON = "won";
const STATE_LOST = "lost";

let cols = 20;
let rows = 16;
let mineRate = 0.16;
let totalMines = 0;
let board = [];
let gameState = STATE_PLAYING;
let firstClick = true;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Reads inputs from player
function readConfig() {
  cols = clamp(parseInt(widthInput.value || "20", 10), 3, 1000);
  rows = clamp(parseInt(heightInput.value || "16", 10), 3, 1000);
  mineRate = clamp(parseFloat(mineRateInput.value || "16"), 1, 99) / 100;
  widthInput.value = String(cols);
  heightInput.value = String(rows);
  mineRateInput.value = String(Math.round(mineRate * 100));
}

// Makes cell
function makeCell() {
  return {
    mine: false,
    revealed: false,
    flagged: false,
    around: 0,
  };
}

// Checks if within bounds of grid
function inBounds(col, row) {
  return col >= 0 && col < cols && row >= 0 && row < rows;
}

// Returns cell
function cell(col, row) {
  return board[row][col];
}

// Returns neighbors of cell
function neighbors(col, row) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nc = col + dc;
      const nr = row + dr;
      if (inBounds(nc, nr)) out.push([nc, nr]);
    }
  }
  return out;
}

// Places mines at beginning of game
function placeMines(firstCol, firstRow) {
  const safeZone = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = firstCol + dc;
      const r = firstRow + dr;
      if (inBounds(c, r)) safeZone.add(`${c},${r}`);
    }
  }

  const candidates = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = `${col},${row}`;
      if (!safeZone.has(key)) candidates.push([col, row]);
    }
  }

  const wanted = clamp(Math.round(cols * rows * mineRate), 1, Math.max(1, candidates.length - 1));
  totalMines = wanted;
  minesLabel.textContent = String(totalMines);

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  for (let i = 0; i < wanted; i++) {
    const [col, row] = candidates[i];
    cell(col, row).mine = true;
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (cell(col, row).mine) continue;
      let n = 0;
      for (const [nc, nr] of neighbors(col, row)) {
        if (cell(nc, nr).mine) n++;
      }
      cell(col, row).around = n;
    }
  }
}

function revealFlood(startCol, startRow) {
  const stack = [[startCol, startRow]];
  while (stack.length) {
    const [col, row] = stack.pop();
    const c = cell(col, row);
    if (c.revealed || c.flagged) continue;
    c.revealed = true;
    if (c.around !== 0) continue;
    for (const [nc, nr] of neighbors(col, row)) {
      const next = cell(nc, nr);
      if (!next.revealed && !next.mine) stack.push([nc, nr]);
    }
  }
}

function revealedCount() {
  let n = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (cell(col, row).revealed) n++;
    }
  }
  return n;
}

// Reveals all mines when digging up a mine
function revealAllMines() {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = cell(col, row);
      if (c.mine) c.revealed = true;
    }
  }
}

function setStatus(nextState) {
  gameState = nextState;
  statusLabel.textContent = nextState;
  if (nextState === STATE_WON) statusLabel.style.color = cssVar("--accent");
  else if (nextState === STATE_LOST) statusLabel.style.color = cssVar("--mine");
  else statusLabel.style.color = cssVar("--text");
}

function checkWin() {
  const safeCells = cols * rows - totalMines;
  if (revealedCount() >= safeCells) setStatus(STATE_WON);
}

function screenToCell(x, y) {
  const cs = Math.min(canvas.width / cols, canvas.height / rows);
  const boardW = cs * cols;
  const boardH = cs * rows;
  const ox = (canvas.width - boardW) / 2;
  const oy = (canvas.height - boardH) / 2;
  const col = Math.floor((x - ox) / cs);
  const row = Math.floor((y - oy) / cs);
  return { col, row, cs, ox, oy };
}

// Main dig function to handle player clicks
function handleDig(col, row) {
  if (gameState !== STATE_PLAYING || !inBounds(col, row)) return;
  const target = cell(col, row);
  if (target.revealed || target.flagged) return;
  if (firstClick) {
    placeMines(col, row);
    firstClick = false;
  }
  if (target.mine) {
    target.revealed = true;
    revealAllMines();
    revealedLabel.textContent = String(revealedCount());
    setStatus(STATE_LOST);   // fix: was missing — game stayed in STATE_PLAYING after a loss
    draw();
    return;
  }
  revealFlood(col, row);
  revealedLabel.textContent = String(revealedCount());
  checkWin();
  draw();
}

// Flags cell at coordinates
function handleFlag(col, row) {
  if (gameState !== STATE_PLAYING || !inBounds(col, row)) return;
  const target = cell(col, row);
  if (target.revealed) return;
  target.flagged = !target.flagged;
  draw();
}

// Draws grid
function draw() {
  const bgCell = cssVar("--bg-cell");
  const bgRev = cssVar("--bg-rev");
  const border = cssVar("--border");
  const text = cssVar("--text");
  const mineColor = cssVar("--mine");
  const cs = Math.min(canvas.width / cols, canvas.height / rows);
  const boardW = cs * cols;
  const boardH = cs * rows;
  const ox = (canvas.width - boardW) / 2;
  const oy = (canvas.height - boardH) / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = cssVar("--bg");
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = cell(col, row);
      const x = ox + col * cs;
      const y = oy + row * cs;

      ctx.fillStyle = c.revealed ? bgRev : bgCell;
      ctx.fillRect(x, y, cs, cs);
      ctx.strokeStyle = border;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x + 0.25, y + 0.25, cs - 0.5, cs - 0.5);

      if (c.flagged && !c.revealed) {
        const fx = x + cs / 2;
        const fy = y + cs / 2;
        ctx.strokeStyle = "#D85A30";
        ctx.lineWidth = Math.max(1.5, cs * 0.08);
        ctx.beginPath();
        ctx.moveTo(fx - cs * 0.06, fy - cs * 0.34);
        ctx.lineTo(fx - cs * 0.06, fy + cs * 0.28);
        ctx.stroke();
        ctx.fillStyle = "#D85A30";
        ctx.beginPath();
        ctx.moveTo(fx - cs * 0.06, fy - cs * 0.34);
        ctx.lineTo(fx + cs * 0.30, fy - cs * 0.14);
        ctx.lineTo(fx - cs * 0.06, fy + cs * 0.06);
        ctx.closePath();
        ctx.fill();
      } else if (c.revealed && c.mine) {
        ctx.fillStyle = mineColor;
        ctx.beginPath();
        ctx.arc(x + cs / 2, y + cs / 2, cs * 0.22, 0, Math.PI * 2);
        ctx.fill();
      } else if (c.revealed && c.around > 0) {
        ctx.fillStyle = NUM_COLORS[c.around] || text;
        ctx.font = `600 ${Math.max(11, Math.round(cs * 0.5))}px 'Courier New', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(c.around), x + cs / 2, y + cs / 2 + 1);
      }
    }
  }
}

// Resizes grid to fit screen
function resize() {
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

// Initiates a new game
function startNewGame() {
  readConfig();
  board = [];
  for (let row = 0; row < rows; row++) {
    const line = [];
    for (let col = 0; col < cols; col++) line.push(makeCell());
    board.push(line);
  }
  totalMines = 0;
  minesLabel.textContent = "0";
  revealedLabel.textContent = "0";
  firstClick = true;
  setStatus(STATE_PLAYING);
  draw();
}

// Prevents default menu from displaying when right-clicking
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// Click recognizer for digging and flag
canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const { col, row } = screenToCell(x, y);
  if (e.button === 2) handleFlag(col, row);
  else if (e.button === 0) handleDig(col, row);
});

newGameBtn.addEventListener("click", startNewGame);
new ResizeObserver(resize).observe(wrap);

startNewGame();
resize();