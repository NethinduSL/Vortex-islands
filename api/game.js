// ─── Vortex Islands — API v4 (Win-Slot Economy, No Coins) ─────────────────────
const { v4: uuidv4 } = require('uuid');

if (!global._vortexStore) {
  global._vortexStore = { lobbies:{}, games:{}, online:{}, _botLocks:{} };
}
const store = global._vortexStore;
if (!store._botLocks) store._botLocks = {};

// Online: expire after 35s
function getOnlinePlayers() {
  const now = Date.now();
  Object.keys(store.online).forEach(u => {
    if (now - store.online[u].ts > 35000) delete store.online[u];
  });
  return Object.keys(store.online);
}

function cleanupStaleGames() {
  const now = Date.now();
  Object.keys(store.games).forEach(id => {
    if (now - (store.games[id].lastAction||0) > 7200000) {
      delete store.games[id]; delete store._botLocks[id];
    }
  });
  Object.keys(store.lobbies).forEach(code => {
    const l = store.lobbies[code];
    if (now - (l.lastActivity||l.createdAt||0) > 1800000) delete store.lobbies[code];
  });
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525,s)+1013904223)>>>0; return s/0xffffffff; };
}

// 4× resolution: 64×32
function generateIslandGrid(seed) {
  const rng = seededRandom(seed);
  const W=64, H=32, cx=W/2, cy=H/2;
  const rx=22+rng()*5, ry=10+rng()*3;
  const LAND=['grass','grass','grass','dark_grass','dark_grass','stone','dirt','sand'];
  return Array.from({length:H},(_,r)=>Array.from({length:W},(_,c)=>{
    const dx=(c+.5-cx)/rx, dy=(r+.5-cy)/ry;
    const dist=Math.sqrt(dx*dx+dy*dy), noise=(rng()-.5)*.35;
    return dist+noise<1 ? (dist<.45?LAND[Math.floor(rng()*5)]:LAND[Math.floor(rng()*LAND.length)]) : 'sea';
  }));
}

function applyQuadrantDamage(baseGrid, destroyed) {
  const H=baseGrid.length, W=baseGrid[0].length;
  const midR=Math.floor(H/2), midC=Math.floor(W/2);
  return baseGrid.map((row,r)=>row.map((cell,c)=>{
    const q=(r<midR?0:2)+(c<midC?0:1);
    return destroyed.includes(q) ? 'sea' : cell;
  }));
}

function makeLobbyCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

function publicLobby(l) {
  return {
    code:l.code, host:l.host, players:l.players,
    maxPlayers:l.maxPlayers, status:l.status, gameId:l.gameId||null,
    bots:l.bots||[], privacy:l.privacy||'public', createdAt:l.createdAt||Date.now()
  };
}

function createGame(players, lobbyCode, bots) {
  const gameId=uuidv4(), baseGrids={}, grids={}, scores={}, islands={};
  players.forEach(p=>{
    const seed=Math.floor(Math.random()*1e9);
    baseGrids[p]=generateIslandGrid(seed);
    grids[p]=baseGrids[p].map(r=>[...r]);
    scores[p]=0;
    // inventory: stored cannons & slicers; winSlots: actions available this turn
    islands[p]={ shields:0, quadrants:[], alive:true, inventory:{cannons:0,slicers:0}, winSlots:0 };
  });
  return store.games[gameId]={
    gameId, players:[...players], alivePlayers:[...players],
    baseGrids, grids, scores, islands, moves:[],
    phase:'rps', pendingRPS:{}, rpsWinner:null, rpsWinners:[],
    pendingActions:{}, // { player: slotsRemaining }
    rpsChoices:{},
    gameOver:false, winner:null, lobbyCode, bots:bots||[], lastAction:Date.now()
  };
}

function publicState(g) {
  return {
    gameId:g.gameId, players:g.players, alivePlayers:g.alivePlayers,
    grids:g.grids, scores:g.scores, islands:g.islands, moves:g.moves,
    phase:g.phase,
    pendingRPS:Object.fromEntries(Object.entries(g.pendingRPS).map(([k])=>[k,true])),
    rpsChoices:g.rpsChoices||{},
    rpsWinner:g.rpsWinner, rpsWinners:g.rpsWinners||[],
    pendingActions:g.pendingActions||{},
    gameOver:g.gameOver, winner:g.winner, bots:g.bots||[]
  };
}

function rpsBeats(a,b){
  return ({rock:['scissors'],scissors:['paper'],paper:['rock']}[a]||[]).includes(b);
}
function resolveMultiRPS(choices){
  const players=Object.keys(choices);
  if(players.length===1)return players;
  const moves=[...new Set(Object.values(choices))];
  if(moves.length===1)return players; // all same = tie
  for(const m of moves){
    const others=moves.filter(x=>x!==m);
    if(others.every(x=>rpsBeats(m,x)))return players.filter(p=>choices[p]===m);
  }
  return players; // 3-way tie
}

// ── Win-slot calculation: winner gets 1 slot per loser they beat ──────────────
// In 2p: winner beats 1 → 1 slot
// In 3p: if 1 winner beats 2 losers → 2 slots
// In 6p: if 1 winner beats 5 losers → 5 slots
function calcWinSlots(winnerChoice, allChoices, winnerName) {
  let slots = 0;
  Object.entries(allChoices).forEach(([p, c]) => {
    if (p !== winnerName && rpsBeats(winnerChoice, c)) slots++;
  });
  return Math.max(1, slots); // at least 1
}

const RPS_MOVES = ['rock','paper','scissors'];
function botPickRPS() { return RPS_MOVES[Math.floor(Math.random()*RPS_MOVES.length)]; }

// Bot picks what to do with a single slot
function botPickOneAction(g, botName) {
  const me = g.islands[botName];
  const enemies = g.alivePlayers.filter(p=>p!==botName);
  const target = enemies[Math.floor(Math.random()*enemies.length)];

  // Use stored weapons first
  if (me.inventory.cannons > 0 && target) {
    return { act:'cannon', target, fromInv:true };
  }
  if (me.inventory.slicers > 0 && target) {
    const t = g.islands[target];
    if (!t || t.shields === 0) return { act:'slicer', target, fromInv:true };
    // target has shield, use cannon to remove it
    if (me.inventory.cannons > 0) return { act:'cannon', target, fromInv:true };
  }

  // Buy something
  const enemyHasShield = target && g.islands[target] && g.islands[target].shields > 0;
  if (enemyHasShield) return { act:'buy_cannon', target }; // need to strip shield
  if (me.shields < 2 && Math.random() < 0.3) return { act:'buy_shield', target:null };
  if (Math.random() < 0.55) return { act:'buy_slicer', target };
  return { act:'buy_cannon', target };
}

const QNAMES = ['TOP-LEFT','TOP-RIGHT','BOT-LEFT','BOT-RIGHT'];

// applyOneAction handles ONE action slot (buy or use)
// Returns { error? } or { gameOver?, winner? }
function applyOneAction(g, username, act, targetPlayer, useInventory) {
  const alive = g.alivePlayers;
  const target = (targetPlayer && alive.includes(targetPlayer) && targetPlayer !== username)
    ? targetPlayer : alive.find(p => p !== username);
  const me = g.islands[username];

  // ── BUY CANNON (store for later) ──────────────────────────────────────────
  if (act === 'buy_cannon') {
    me.inventory.cannons++;
    g.moves.unshift(`💣 ${username} bought & stored a CANNON (now has ${me.inventory.cannons})`);
    g.lastAction = Date.now();
    return {};
  }

  // ── BUY SLICER (store for later) ─────────────────────────────────────────
  if (act === 'buy_slicer') {
    me.inventory.slicers++;
    g.moves.unshift(`⚔ ${username} bought & stored a SLICER (now has ${me.inventory.slicers})`);
    g.lastAction = Date.now();
    return {};
  }

  // ── BUY SHIELD (immediate, does NOT use inventory, max 3) ─────────────────
  if (act === 'buy_shield') {
    if (me.shields >= 3) return { error:'MAX 3 SHIELDS — use a slot for something else' };
    me.shields++;
    g.moves.unshift(`🛡 ${username} raised shield ring ${me.shields}/3 — SLICER attacks are now BLOCKED!`);
    g.lastAction = Date.now();
    return {};
  }

  // ── USE CANNON (from inventory — removes shield OR destroys quadrant) ─────
  if (act === 'cannon') {
    if (!target) return { error:'NO TARGET' };
    if (!useInventory || me.inventory.cannons <= 0) return { error:'NO CANNON IN STORAGE — buy one first' };
    me.inventory.cannons--;
    const t = g.islands[target];
    if (t.shields > 0) {
      t.shields--;
      g.moves.unshift(`💣 ${username}'s CANNON stripped ${target}'s shield! (${t.shields} rings left)`);
    } else {
      const surv = [0,1,2,3].filter(q => !t.quadrants.includes(q));
      if (surv.length > 0) {
        const q = surv[Math.floor(Math.random()*surv.length)];
        t.quadrants.push(q);
        g.moves.unshift(`💥 ${username}'s CANNON destroyed ${target}'s ${QNAMES[q]} quadrant!`);
        g.grids[target] = applyQuadrantDamage(g.baseGrids[target], t.quadrants);
      }
    }
    g.scores[username] += 5;
    g.lastAction = Date.now();
    // Elimination check
    return checkElim(g, target);
  }

  // ── USE SLICER (from inventory — BLOCKED by shield; slices quadrant) ──────
  if (act === 'slicer') {
    if (!target) return { error:'NO TARGET' };
    if (!useInventory || me.inventory.slicers <= 0) return { error:'NO SLICER IN STORAGE — buy one first' };
    const t = g.islands[target];
    if (t.shields > 0) {
      // Refund — slicer bounced off shield, player should use cannon first
      me.inventory.slicers++;
      return { error:`🛡 ${target} has shields — use CANNON to remove shields first, then SLICER!` };
    }
    me.inventory.slicers--;
    const surv = [0,1,2,3].filter(q => !t.quadrants.includes(q));
    if (surv.length > 0) {
      const q = surv[Math.floor(Math.random()*surv.length)];
      t.quadrants.push(q);
      g.moves.unshift(`⚔ ${username}'s SLICER carved off ${target}'s ${QNAMES[q]} quadrant!`);
      g.grids[target] = applyQuadrantDamage(g.baseGrids[target], t.quadrants);
      g.moves.unshift(`🗺 ${target} has ${surv.length-1} quadrant(s) remaining.`);
    }
    g.scores[username] += 3;
    g.lastAction = Date.now();
    return checkElim(g, target);
  }

  return { error:'UNKNOWN ACTION' };
}

function checkElim(g, target) {
  if (target && g.islands[target] && g.islands[target].quadrants.length >= 4) {
    g.islands[target].alive = false;
    g.alivePlayers = g.alivePlayers.filter(p => p !== target);
    g.moves.unshift(`💀 ${target}'s island fully sank — ELIMINATED!`);
    if (g.alivePlayers.length === 1) {
      const gw = g.alivePlayers[0];
      g.gameOver = true; g.phase = 'done'; g.winner = gw; g.scores[gw] += 50;
      if (g.lobbyCode && store.lobbies[g.lobbyCode]) store.lobbies[g.lobbyCode].status = 'waiting';
      return { gameOver:true, winner:gw };
    }
  }
  return {};
}

function resolveRPSPhase(g) {
  const choices = {...g.pendingRPS};
  g.rpsChoices = choices;
  const winners = resolveMultiRPS(choices);
  const choiceStr = g.alivePlayers.map(p=>`${p}:${choices[p]}`).join(' | ');

  if (winners.length === g.alivePlayers.length) {
    // Full tie
    g.moves.unshift(`🤝 TIE — ${choiceStr} — retry!`);
    g.pendingRPS = {}; g.rpsChoices = {};
    return false; // not resolved
  }

  // Winners get slots based on how many losers they beat
  winners.forEach(w => {
    const slots = calcWinSlots(choices[w], choices, w);
    g.pendingActions[w] = slots; // slots remaining for this player
    g.islands[w].winSlots = slots;
    g.scores[w] += 10;
  });
  g.rpsWinners = [...winners];
  g.rpsWinner = winners[0];
  g.phase = 'action';
  g.pendingRPS = {};
  const slotDesc = winners.map(w=>`${w}(×${g.pendingActions[w]})`).join(', ');
  g.moves.unshift(`🏆 ${slotDesc} WIN RPS (${choiceStr})`);
  return true;
}

function runBotMoves(g) {
  if (!g || g.gameOver || !g.bots || g.bots.length === 0) return;
  const lockKey = g.gameId;
  if (store._botLocks[lockKey]) return;
  store._botLocks[lockKey] = true;
  try {
    if (g.phase === 'rps') {
      g.bots.forEach(bot => {
        if (g.alivePlayers.includes(bot) && !g.pendingRPS[bot]) {
          g.pendingRPS[bot] = botPickRPS();
        }
      });
      if (g.alivePlayers.every(p => g.pendingRPS[p])) {
        const resolved = resolveRPSPhase(g);
        if (!resolved) {
          store._botLocks[lockKey] = false;
          runBotMoves(g);
          return;
        }
        // Auto-play bot winners — each uses ALL their slots
        g.rpsWinners.filter(w => g.bots.includes(w)).forEach(w => {
          while ((g.pendingActions[w]||0) > 0 && !g.gameOver) {
            const {act,target} = botPickOneAction(g, w);
            applyOneAction(g, w, act, target?(target.name||target):null, act==='cannon'||act==='slicer');
            g.pendingActions[w]--;
          }
          delete g.pendingActions[w];
        });
        if (Object.keys(g.pendingActions).length === 0 && !g.gameOver) {
          g.phase='rps'; g.rpsWinner=null; g.rpsWinners=[]; g.rpsChoices={}; g.pendingActions={};
        }
      }
    } else if (g.phase === 'action') {
      const botActors = Object.keys(g.pendingActions).filter(w => g.bots.includes(w));
      botActors.forEach(w => {
        while ((g.pendingActions[w]||0) > 0 && !g.gameOver) {
          const {act,target} = botPickOneAction(g, w);
          applyOneAction(g, w, act, target?(target.name||target):null, act==='cannon'||act==='slicer');
          g.pendingActions[w]--;
        }
        delete g.pendingActions[w];
      });
      if (Object.keys(g.pendingActions).length === 0 && !g.gameOver) {
        g.phase='rps'; g.rpsWinner=null; g.rpsWinners=[]; g.rpsChoices={}; g.pendingActions={};
      }
    }
  } finally {
    store._botLocks[lockKey] = false;
  }
}

const ok=(res,d)=>{res.setHeader('Content-Type','application/json');res.status(200).json(d);};
const fail=(res,m,c=400)=>{res.setHeader('Content-Type','application/json');res.status(c).json({error:m});};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (Math.random() < 0.01) cleanupStaleGames();

  const action = req.query.action;

  if (req.method === 'GET') {
    if (action === 'lobby') {
      const l = store.lobbies[req.query.code];
      return l ? ok(res,{lobby:publicLobby(l)}) : fail(res,'LOBBY NOT FOUND',404);
    }
    if (action === 'public_lobbies') {
      const now = Date.now();
      const list = Object.values(store.lobbies)
        .filter(l=>l.privacy==='public'&&l.status==='waiting')
        .filter(l=>now-(l.lastActivity||l.createdAt||0)<600000)
        .map(l=>({code:l.code,host:l.host,players:l.players.length,maxPlayers:l.maxPlayers,bots:(l.bots||[]).length}))
        .slice(0,10);
      return ok(res,{lobbies:list});
    }
    if (action === 'game') {
      const g = store.games[req.query.gameId];
      if (!g) return fail(res,'GAME NOT FOUND',404);
      const stalledMs = Date.now() - (g.lastAction||0);
      if (stalledMs > 3000) runBotMoves(g);
      return ok(res,{state:publicState(g)});
    }
    if (action === 'online_players') {
      const players = getOnlinePlayers();
      const invites = req.query.username ? (store.online[req.query.username]?.pendingInvites||[]) : [];
      if (req.query.username && store.online[req.query.username]) store.online[req.query.username].pendingInvites = [];
      return ok(res,{players, count:players.length, invites});
    }
    return fail(res,'Unknown action',400);
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      if (typeof req.body==='object'&&req.body!==null) { body=req.body; }
      else {
        const raw = await new Promise((resolve,reject)=>{
          let d=''; req.on('data',c=>{d+=c;}); req.on('end',()=>resolve(d)); req.on('error',reject);
        });
        body = JSON.parse(raw||'{}');
      }
    } catch { body={}; }

    if (action === 'register') {
      const n=(body.username||'').trim().slice(0,14);
      if (!n) return fail(res,'INVALID USERNAME');
      return ok(res,{username:n});
    }
    if (action === 'create_lobby') {
      const{username,maxPlayers,privacy}=body;
      if (!username) return fail(res,'NO USERNAME');
      const max=Math.min(6,Math.max(2,parseInt(maxPlayers)||2));
      let code; do{ code=makeLobbyCode(); }while(store.lobbies[code]);
      store.lobbies[code]={
        code,host:username,players:[username],maxPlayers:max,
        status:'waiting',bots:[],lastActivity:Date.now(),createdAt:Date.now(),
        privacy:privacy==='private'?'private':'public'
      };
      return ok(res,{lobby:publicLobby(store.lobbies[code])});
    }
    if (action === 'add_bot') {
      const{username,code}=body;
      const l=store.lobbies[code];
      if (!l) return fail(res,'LOBBY NOT FOUND');
      if (l.host!==username) return fail(res,'ONLY HOST CAN ADD BOTS');
      if (l.status!=='waiting') return fail(res,'GAME ALREADY STARTED');
      if (l.players.length>=l.maxPlayers) return fail(res,'LOBBY FULL');
      const BOT_NAMES=['BOT-ALPHA','BOT-BRAVO','BOT-DELTA','BOT-ECHO','BOT-FOXTROT','BOT-GAMMA'];
      const existing=new Set(l.players);
      const botName=BOT_NAMES.find(n=>!existing.has(n))||`BOT-${Math.floor(Math.random()*9000+1000)}`;
      l.players.push(botName); l.bots.push(botName); l.lastActivity=Date.now();
      return ok(res,{lobby:publicLobby(l)});
    }
    if (action === 'remove_bot') {
      const{username,code,botName}=body;
      const l=store.lobbies[code];
      if (!l) return fail(res,'LOBBY NOT FOUND');
      if (l.host!==username) return fail(res,'ONLY HOST CAN REMOVE BOTS');
      if (!l.bots.includes(botName)) return fail(res,'NOT A BOT');
      l.players=l.players.filter(p=>p!==botName);
      l.bots=l.bots.filter(b=>b!==botName);
      l.lastActivity=Date.now();
      return ok(res,{lobby:publicLobby(l)});
    }
    if (action === 'join_lobby') {
      const{username,code}=body;
      if (!username) return fail(res,'NO USERNAME');
      const l=store.lobbies[code];
      if (!l) return fail(res,'LOBBY NOT FOUND');
      if (l.status!=='waiting') return fail(res,'GAME ALREADY STARTED');
      if (!l.players.includes(username)) {
        if (l.players.length>=l.maxPlayers) return fail(res,'LOBBY FULL');
        l.players.push(username);
      }
      l.lastActivity=Date.now();
      return ok(res,{lobby:publicLobby(l)});
    }
    if (action === 'leave_lobby') {
      const{username,code}=body;
      const l=store.lobbies[code];
      if (!l) return ok(res,{ok:true});
      l.players=l.players.filter(p=>p!==username);
      if (l.players.length===0){ delete store.lobbies[code]; }
      else { if(l.host===username) l.host=l.players[0]; l.lastActivity=Date.now(); }
      return ok(res,{ok:true});
    }
    if (action === 'start_game') {
      const{username,code}=body;
      const l=store.lobbies[code];
      if (!l) return fail(res,'LOBBY NOT FOUND');
      if (l.host!==username) return fail(res,'ONLY HOST CAN START');
      if (l.players.length<2) return fail(res,'NEED AT LEAST 2 PLAYERS');
      l.status='in_game';
      const g=createGame(l.players,code,l.bots||[]);
      l.gameId=g.gameId;
      runBotMoves(g);
      return ok(res,{gameId:g.gameId,state:publicState(g)});
    }
    if (action === 'rps_choice') {
      const{gameId,username,choice}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (g.gameOver||g.phase!=='rps') return fail(res,'NOT RPS PHASE');
      if (!g.alivePlayers.includes(username)) return fail(res,'NOT IN GAME');
      if (g.pendingRPS[username]) return ok(res,{state:publicState(g)});
      if (!['rock','paper','scissors'].includes(choice)) return fail(res,'INVALID CHOICE');
      g.pendingRPS[username]=choice; g.lastAction=Date.now();
      // Fill bots
      g.bots.forEach(bot=>{
        if (g.alivePlayers.includes(bot)&&!g.pendingRPS[bot]) g.pendingRPS[bot]=botPickRPS();
      });
      if (g.alivePlayers.every(p=>g.pendingRPS[p])) {
        const resolved = resolveRPSPhase(g);
        if (!resolved) {
          runBotMoves(g); // retry if tie
        } else {
          // Auto-play bot winners
          g.rpsWinners.filter(w=>g.bots.includes(w)).forEach(w=>{
            while ((g.pendingActions[w]||0)>0&&!g.gameOver) {
              const {act,target}=botPickOneAction(g,w);
              applyOneAction(g,w,act,target?(target.name||target):null,act==='cannon'||act==='slicer');
              g.pendingActions[w]--;
            }
            delete g.pendingActions[w];
          });
          if (Object.keys(g.pendingActions).length===0&&!g.gameOver){
            g.phase='rps'; g.rpsWinner=null; g.rpsWinners=[]; g.rpsChoices={}; g.pendingActions={};
          }
        }
      }
      return ok(res,{state:publicState(g)});
    }
    if (action === 'action_choice') {
      const{gameId,username,action:act,targetPlayer,useInventory}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (g.gameOver||g.phase!=='action') return fail(res,'NOT YOUR TURN');
      const winners=g.rpsWinners||[g.rpsWinner];
      if (!winners.includes(username)||(g.pendingActions[username]||0)<=0) return fail(res,'NOT YOUR TURN');
      g.lastAction=Date.now();
      const result=applyOneAction(g,username,act,targetPlayer,useInventory||false);
      if (result.error) return fail(res,result.error);
      // Consume one slot
      g.pendingActions[username]--;
      if (g.pendingActions[username] <= 0) delete g.pendingActions[username];
      // If all winners done, back to RPS
      if (Object.keys(g.pendingActions).length===0){
        if (!result.gameOver){
          g.phase='rps'; g.rpsWinner=null; g.rpsWinners=[]; g.rpsChoices={}; g.pendingActions={};
        }
      }
      runBotMoves(g);
      if (result.gameOver) return ok(res,{gameOver:true,winner:result.winner,state:publicState(g)});
      return ok(res,{state:publicState(g),slotsLeft:g.pendingActions[username]||0});
    }
    if (action === 'heartbeat') {
      const{username}=body;
      if (!username) return fail(res,'NO USERNAME');
      if (!store.online[username]) store.online[username]={ts:Date.now(),pendingInvites:[]};
      else store.online[username].ts=Date.now();
      return ok(res,{ok:true,online:getOnlinePlayers().length});
    }
    if (action === 'send_invite') {
      const{from,to,lobbyCode}=body;
      if (!from||!to||!lobbyCode) return fail(res,'MISSING FIELDS');
      if (!store.online[to]) return fail(res,'PLAYER NOT ONLINE');
      if (!store.online[to].pendingInvites) store.online[to].pendingInvites=[];
      store.online[to].pendingInvites=store.online[to].pendingInvites.filter(i=>i.lobbyCode!==lobbyCode);
      store.online[to].pendingInvites.push({from,lobbyCode,ts:Date.now()});
      return ok(res,{ok:true});
    }
    return fail(res,'Unknown action');
  }
  return fail(res,'Method not allowed',405);
};
