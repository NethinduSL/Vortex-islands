// ─── Vortex Islands — Vercel-compatible API (no WebSockets) ─────────────────
// All state lives in a global object so it survives warm function instances.
// For production scale, swap `store` for Vercel KV / Redis.

const { v4: uuidv4 } = require('uuid');

// ─── In-memory store (persists across warm invocations on the same instance) ─
if (!global._vortexStore) {
  global._vortexStore = { lobbies: {}, games: {} };
}
const store = global._vortexStore;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

const CELL_DISTRIBUTION = [
  ...Array(25).fill('sky'), ...Array(15).fill('cloud'),
  ...Array(15).fill('dirt'), ...Array(25).fill('grass'),
  ...Array(12).fill('dark_grass'), ...Array(8).fill('stone'),
];

function generateGrid(seed) {
  const rng = seededRandom(seed);
  const grid = [];
  for (let r = 0; r < 10; r++) {
    const row = [];
    for (let c = 0; c < 20; c++) {
      row.push(CELL_DISTRIBUTION[Math.floor(rng() * CELL_DISTRIBUTION.length)]);
    }
    grid.push(row);
  }
  return grid;
}

const DAMAGEABLE = ['grass', 'dark_grass', 'stone', 'dirt'];

function applyDamage(grid, parts) {
  const flat = grid.flat();
  const damageableIndices = flat.map((c, i) => (DAMAGEABLE.includes(c) ? i : -1)).filter(i => i !== -1);
  const toConvert = Math.round(((10 - parts) / 10) * damageableIndices.length);
  const converted = new Set(damageableIndices.slice(0, toConvert));
  const newFlat = flat.map((c, i) => (converted.has(i) ? 'sky' : c));
  const newGrid = [];
  for (let r = 0; r < 10; r++) newGrid.push(newFlat.slice(r * 20, r * 20 + 20));
  return newGrid;
}

function makeLobbyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function publicLobby(lobby) {
  return { code: lobby.code, host: lobby.host, players: lobby.players, maxPlayers: lobby.maxPlayers, status: lobby.status, gameId: lobby.gameId || null };
}

function createGame(players, lobbyCode) {
  const gameId = uuidv4();
  const baseGrids = {}, grids = {}, scores = {}, islands = {};
  players.forEach(p => {
    const seed = Math.floor(Math.random() * 1e9);
    baseGrids[p] = generateGrid(seed);
    grids[p] = baseGrids[p].map(r => [...r]);
    scores[p] = 0;
    islands[p] = { parts: 10, shields: 0, alive: true };
  });
  const game = {
    gameId, players: [...players], alivePlayers: [...players],
    baseGrids, grids, scores, islands, moves: [],
    phase: 'rps', turn: players[0], pendingRPS: {}, rpsWinner: null,
    gameOver: false, winner: null, lobbyCode
  };
  store.games[gameId] = game;
  return game;
}

function publicState(game) {
  return {
    gameId: game.gameId, players: game.players, alivePlayers: game.alivePlayers,
    grids: game.grids, scores: game.scores, islands: game.islands, moves: game.moves,
    phase: game.phase, turn: game.turn,
    pendingRPS: Object.fromEntries(Object.entries(game.pendingRPS).map(([k]) => [k, true])),
    rpsWinner: game.rpsWinner, gameOver: game.gameOver, winner: game.winner
  };
}

function rpsBeats(a, b) {
  return (a === 'rock' && b === 'officer') || (a === 'paper' && b === 'rock') || (a === 'officer' && b === 'paper');
}

function resolveMultiRPS(choices) {
  const players = Object.keys(choices);
  if (players.length === 1) return players;
  const moveSet = new Set(Object.values(choices));
  if (moveSet.size === 1 || moveSet.size === 3) return players; // tie
  const [ma, mb] = [...moveSet];
  const winningMove = rpsBeats(ma, mb) ? ma : mb;
  return players.filter(p => choices[p] === winningMove);
}

function ok(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(data);
}

function err(res, msg, code = 400) {
  res.setHeader('Content-Type', 'application/json');
  res.status(code).json({ error: msg });
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET: state polling ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (action === 'lobby') {
      const { code } = req.query;
      const lobby = store.lobbies[code];
      if (!lobby) return err(res, 'LOBBY NOT FOUND', 404);
      return ok(res, { lobby: publicLobby(lobby) });
    }

    if (action === 'game') {
      const { gameId } = req.query;
      const game = store.games[gameId];
      if (!game) return err(res, 'GAME NOT FOUND', 404);
      return ok(res, { state: publicState(game) });
    }

    return err(res, 'Unknown action', 400);
  }

  // ── POST: mutations ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = {};
    try {
      if (typeof req.body === 'object' && req.body !== null) {
        body = req.body;
      } else {
        const raw = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        body = JSON.parse(raw || '{}');
      }
    } catch { body = {}; }

    // register — just validate name availability
    if (action === 'register') {
      const name = (body.username || '').trim().slice(0, 14);
      if (!name) return err(res, 'INVALID USERNAME');
      return ok(res, { username: name });
    }

    // create_lobby
    if (action === 'create_lobby') {
      const { username, maxPlayers } = body;
      if (!username) return err(res, 'NO USERNAME');
      const max = Math.min(6, Math.max(2, parseInt(maxPlayers) || 2));
      let code;
      do { code = makeLobbyCode(); } while (store.lobbies[code]);
      store.lobbies[code] = { code, host: username, players: [username], maxPlayers: max, status: 'waiting', lastActivity: Date.now() };
      return ok(res, { lobby: publicLobby(store.lobbies[code]) });
    }

    // join_lobby
    if (action === 'join_lobby') {
      const { username, code } = body;
      if (!username) return err(res, 'NO USERNAME');
      const lobby = store.lobbies[code];
      if (!lobby) return err(res, 'LOBBY NOT FOUND');
      if (lobby.status !== 'waiting') return err(res, 'GAME ALREADY STARTED');
      if (!lobby.players.includes(username)) {
        if (lobby.players.length >= lobby.maxPlayers) return err(res, 'LOBBY FULL');
        lobby.players.push(username);
      }
      lobby.lastActivity = Date.now();
      return ok(res, { lobby: publicLobby(lobby) });
    }

    // leave_lobby
    if (action === 'leave_lobby') {
      const { username, code } = body;
      const lobby = store.lobbies[code];
      if (!lobby) return ok(res, { ok: true });
      lobby.players = lobby.players.filter(p => p !== username);
      if (lobby.players.length === 0) {
        delete store.lobbies[code];
      } else {
        if (lobby.host === username) lobby.host = lobby.players[0];
        lobby.lastActivity = Date.now();
      }
      return ok(res, { ok: true });
    }

    // start_game
    if (action === 'start_game') {
      const { username, code } = body;
      const lobby = store.lobbies[code];
      if (!lobby) return err(res, 'LOBBY NOT FOUND');
      if (lobby.host !== username) return err(res, 'ONLY HOST CAN START');
      if (lobby.players.length < 2) return err(res, 'NEED AT LEAST 2 PLAYERS');
      lobby.status = 'in_game';
      const game = createGame(lobby.players, code);
      lobby.gameId = game.gameId; // guests can find this via lobby polling
      return ok(res, { gameId: game.gameId, state: publicState(game) });
    }

    // rps_choice
    if (action === 'rps_choice') {
      const { gameId, username, choice } = body;
      const game = store.games[gameId];
      if (!game) return err(res, 'GAME NOT FOUND');
      if (game.gameOver || game.phase !== 'rps') return err(res, 'NOT RPS PHASE');
      if (!game.alivePlayers.includes(username)) return err(res, 'NOT IN GAME');
      if (game.pendingRPS[username]) return ok(res, { state: publicState(game) }); // already submitted
      if (!['rock', 'paper', 'officer'].includes(choice)) return err(res, 'INVALID CHOICE');

      game.pendingRPS[username] = choice;
      const allIn = game.alivePlayers.every(p => game.pendingRPS[p]);

      if (allIn) {
        const winners = resolveMultiRPS(game.pendingRPS);
        const choiceStr = game.alivePlayers.map(p => `${p}:${game.pendingRPS[p]}`).join(' | ');
        if (winners.length > 1) {
          game.moves.unshift(`🤝 TIE — ${choiceStr}`);
          game.pendingRPS = {};
        } else {
          const winner = winners[0];
          game.moves.unshift(`⚔ ${winner} WON RPS (${choiceStr})`);
          game.scores[winner] += 10;
          game.rpsWinner = winner;
          game.phase = 'action';
          game.pendingRPS = {};
        }
      }

      return ok(res, { state: publicState(game) });
    }

    // action_choice
    if (action === 'action_choice') {
      const { gameId, username, action: gameAction, targetPlayer } = body;
      const game = store.games[gameId];
      if (!game) return err(res, 'GAME NOT FOUND');
      if (game.gameOver || game.phase !== 'action' || game.rpsWinner !== username) return err(res, 'NOT YOUR TURN');

      const alive = game.alivePlayers;
      let target = (targetPlayer && alive.includes(targetPlayer) && targetPlayer !== username)
        ? targetPlayer
        : alive.find(p => p !== username);

      if (gameAction === 'mortar') {
        if (!target) return err(res, 'NO TARGET');
        game.islands[target].shields = Math.max(0, game.islands[target].shields - 1);
        game.moves.unshift(`💣 ${username} fired CANNON at ${target} — shields -1`);
      } else if (gameAction === 'shield') {
        if (game.islands[username].shields >= 3) return err(res, 'MAX SHIELDS REACHED');
        game.islands[username].shields = Math.min(3, game.islands[username].shields + 1);
        game.moves.unshift(`🛡 ${username} equipped SHIELD`);
      } else if (gameAction === 'slicer') {
        if (!target) return err(res, 'NO TARGET');
        if (game.islands[target].shields > 0) {
          game.moves.unshift(`⚔ ${username} used SLICER on ${target} — 🛡 BLOCKED!`);
          game.phase = 'rps'; game.rpsWinner = null; game.pendingRPS = {};
          const wi = game.alivePlayers.indexOf(username);
          game.turn = game.alivePlayers[(wi + 1) % game.alivePlayers.length];
          return ok(res, { flash: 'BLOCKED BY SHIELD!', state: publicState(game) });
        } else {
          game.islands[target].parts = Math.max(0, game.islands[target].parts - 1);
          game.moves.unshift(`⚔ ${username} SLICED ${target}'s island!`);
          game.grids[target] = applyDamage(game.baseGrids[target], game.islands[target].parts);
        }
      } else {
        return err(res, 'UNKNOWN ACTION');
      }

      // Check elimination
      if (target && game.islands[target] && game.islands[target].parts <= 0) {
        game.islands[target].alive = false;
        game.alivePlayers = game.alivePlayers.filter(p => p !== target);
        game.moves.unshift(`💀 ${target} HAS BEEN ELIMINATED!`);
      }

      // Check win
      if (game.alivePlayers.length === 1) {
        const gameWinner = game.alivePlayers[0];
        game.gameOver = true; game.phase = 'done'; game.winner = gameWinner;
        game.scores[gameWinner] += 50;
        if (game.lobbyCode && store.lobbies[game.lobbyCode]) store.lobbies[game.lobbyCode].status = 'waiting';
        return ok(res, { gameOver: true, winner: gameWinner, state: publicState(game) });
      }

      game.phase = 'rps'; game.rpsWinner = null; game.pendingRPS = {};
      const wi = game.alivePlayers.indexOf(username);
      game.turn = game.alivePlayers[(wi + 1) % game.alivePlayers.length];

      return ok(res, { state: publicState(game) });
    }

    return err(res, 'Unknown action');
  }

  return err(res, 'Method not allowed', 405);
};
