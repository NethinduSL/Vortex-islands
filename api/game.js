// ─── Vortex Islands — API v4 (No Coins, Task-Based Weapons) ──────────────────
const { v4: uuidv4 } = require('uuid');
if (!global._vortexStore) global._vortexStore = { lobbies:{}, games:{}, online:{} };
const store = global._vortexStore;

// ── Online presence (20s TTL) ─────────────────────────────────────────────────
function getOnlinePlayers() {
  const now = Date.now();
  Object.keys(store.online).forEach(u => { if (now - store.online[u].ts > 20000) delete store.online[u]; });
  return Object.keys(store.online);
}

// ── Seeded RNG ────────────────────────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525,s)+1013904223)>>>0; return s/0xffffffff; };
}

// ── Island grid 32×16 ─────────────────────────────────────────────────────────
function generateIslandGrid(seed) {
  const rng = seededRandom(seed);
  const W=32, H=16, cx=W/2, cy=H/2;
  const rx=11+rng()*3, ry=5+rng()*2;
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
    bots:l.bots||[], privacy:l.privacy||'public',
    createdAt:l.createdAt||Date.now()
  };
}

// ── Create game ───────────────────────────────────────────────────────────────
function createGame(players, lobbyCode, bots) {
  const gameId=uuidv4(), baseGrids={}, grids={}, scores={}, islands={};
  players.forEach(p=>{
    const seed=Math.floor(Math.random()*1e9);
    baseGrids[p]=generateIslandGrid(seed);
    grids[p]=baseGrids[p].map(r=>[...r]);
    scores[p]=0;
    // inventory: cannons & slicers can be stored; shields cannot be stored (they are applied instantly)
    islands[p]={ shields:0, quadrants:[], alive:true, inventory:{cannons:0,slicers:0} };
  });
  return store.games[gameId]={
    gameId, players:[...players], alivePlayers:[...players],
    baseGrids, grids, scores, islands, moves:[],
    phase:'rps', pendingRPS:{}, rpsWinner:null, rpsWinners:[],
    // pendingTasks: { username: tasksRemaining (int) }
    pendingTasks:{},
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
    pendingTasks:g.pendingTasks||{},
    gameOver:g.gameOver, winner:g.winner, bots:g.bots||[]
  };
}

// ── RPS resolution ────────────────────────────────────────────────────────────
function rpsBeats(a,b){
  return ({rock:['scissors'],scissors:['paper'],paper:['rock']}[a]||[]).includes(b);
}
function resolveMultiRPS(choices){
  const players=Object.keys(choices);
  if(players.length===1)return players;
  const moves=[...new Set(Object.values(choices))];
  if(moves.length===1)return players; // full tie
  for(const m of moves){
    const others=moves.filter(x=>x!==m);
    if(others.every(x=>rpsBeats(m,x)))return players.filter(p=>choices[p]===m);
  }
  return players; // partial tie — everyone ties
}

// ── How many tasks does a winner get?
// Tasks = number of players they beat (losers count), minimum 1
function calcTasks(winner, choices) {
  const myMove = choices[winner];
  const losers = Object.entries(choices).filter(([p,m])=> p!==winner && rpsBeats(myMove,m));
  return Math.max(1, losers.length);
}

const RPS_MOVES = ['rock','paper','scissors'];
function botPickRPS() { return RPS_MOVES[Math.floor(Math.random()*RPS_MOVES.length)]; }

function botPickTask(g, botName) {
  const me = g.islands[botName];
  const enemies = g.alivePlayers.filter(p=>p!==botName);
  const target = enemies[Math.floor(Math.random()*enemies.length)];

  // Use stored weapons first
  if (me.inventory.cannons>0 && target) {
    return { act:'cannon', target, fromInv:true };
  }
  if (me.inventory.slicers>0 && target) {
    const t = g.islands[target];
    if (!t || t.shields===0) return { act:'slicer', target, fromInv:true };
  }
  // Buy weapons
  if (Math.random()<0.5) return { act:'buy_cannon', target:null };
  return { act:'buy_slicer', target:null };
}

const QNAMES = ['TOP-LEFT','TOP-RIGHT','BOT-LEFT','BOT-RIGHT'];

// ── Apply a single task action ────────────────────────────────────────────────
// Returns { error } or {}
function applyTask(g, username, act, targetPlayer, useInventory) {
  const alive = g.alivePlayers;
  const target = (targetPlayer && alive.includes(targetPlayer) && targetPlayer!==username)
    ? targetPlayer : alive.find(p=>p!==username);
  const me = g.islands[username];

  // BUY CANNON — store into inventory, use next win
  if (act==='buy_cannon') {
    me.inventory.cannons++;
    g.moves.unshift(`🔧 ${username} built a 💣 CANNON — stored for next win!`);
    return {};
  }

  // BUY SLICER — store into inventory, use next win
  if (act==='buy_slicer') {
    me.inventory.slicers++;
    g.moves.unshift(`🔧 ${username} forged an ⚔ SLICER — stored for next win!`);
    return {};
  }

  // USE CANNON (from inventory) — removes ONE shield ring; if no shield, destroys a quadrant
  if (act==='cannon') {
    if (!target) return { error:'NO TARGET' };
    if (useInventory) {
      if (me.inventory.cannons<=0) return { error:'NO CANNONS IN INVENTORY' };
      me.inventory.cannons--;
    } else {
      return { error:'CANNON MUST BE USED FROM INVENTORY' };
    }
    const t = g.islands[target];
    if (t.shields>0) {
      t.shields--;
      g.moves.unshift(`💣 ${username}'s CANNON smashed ${target}'s shield! (${t.shields} remaining)`);
    } else {
      // No shield — cannon destroys a quadrant
      const surv=[0,1,2,3].filter(q=>!t.quadrants.includes(q));
      if (surv.length>0) {
        const q=surv[Math.floor(Math.random()*surv.length)];
        t.quadrants.push(q);
        g.moves.unshift(`💥 ${username}'s CANNON blasted ${target}'s ${QNAMES[q]}!`);
        g.grids[target]=applyQuadrantDamage(g.baseGrids[target],t.quadrants);
      }
    }
  }

  // USE SLICER (from inventory) — blocked by any shield; otherwise slices+deletes quadrant
  else if (act==='slicer') {
    if (!target) return { error:'NO TARGET' };
    if (useInventory) {
      if (me.inventory.slicers<=0) return { error:'NO SLICERS IN INVENTORY' };
      me.inventory.slicers--;
    } else {
      return { error:'SLICER MUST BE USED FROM INVENTORY' };
    }
    const t = g.islands[target];
    if (t.shields>0) {
      // Shield blocks — refund the slicer
      me.inventory.slicers++;
      g.moves.unshift(`🛡 ${target}'s shield BLOCKED ${username}'s slicer! Use 💣 CANNON to remove shields first.`);
    } else {
      const surv=[0,1,2,3].filter(q=>!t.quadrants.includes(q));
      if (surv.length>0) {
        const q=surv[Math.floor(Math.random()*surv.length)];
        t.quadrants.push(q);
        g.moves.unshift(`⚔ ${username}'s SLICER cut ${target}'s island — ${QNAMES[q]} destroyed!`);
        g.grids[target]=applyQuadrantDamage(g.baseGrids[target],t.quadrants);
        if (surv.length-1>0)
          g.moves.unshift(`🗺 ${target} has ${surv.length-1} island part(s) remaining.`);
      }
    }
  }

  // USE SHIELD — applies instantly, cannot be stored
  else if (act==='shield') {
    if (me.shields>=3) return { error:'MAX 3 SHIELDS' };
    me.shields++;
    g.moves.unshift(`🛡 ${username} raised shield ring ${me.shields}/3 — slicers are now BLOCKED!`);
  }

  else {
    return { error:'UNKNOWN ACTION' };
  }

  // Elimination check
  if (target && g.islands[target] && g.islands[target].quadrants.length>=4) {
    g.islands[target].alive=false;
    g.alivePlayers=g.alivePlayers.filter(p=>p!==target);
    g.moves.unshift(`💀 ${target}'s island sank — ELIMINATED!`);
  }

  // Win check
  if (g.alivePlayers.length===1) {
    const gw=g.alivePlayers[0];
    g.gameOver=true; g.phase='done'; g.winner=gw; g.scores[gw]+=50;
    if (g.lobbyCode&&store.lobbies[g.lobbyCode]) store.lobbies[g.lobbyCode].status='waiting';
    return { gameOver:true, winner:gw };
  }

  return {};
}

// ── After all tasks consumed, reset to RPS ────────────────────────────────────
function finishTaskPhaseIfDone(g) {
  if (g.gameOver) return;
  const anyPending = Object.values(g.pendingTasks).some(n=>n>0);
  if (!anyPending) {
    g.phase='rps'; g.rpsWinner=null; g.rpsWinners=[]; g.rpsChoices={}; g.pendingTasks={};
  }
}

// ── Bot auto-plays all its pending tasks ──────────────────────────────────────
function runBotTasks(g) {
  if (!g||g.gameOver) return;
  const bots = g.bots||[];
  Object.entries(g.pendingTasks).forEach(([bot, tasks])=>{
    if (!bots.includes(bot)||tasks<=0) return;
    while (g.pendingTasks[bot]>0 && !g.gameOver) {
      const {act,target,fromInv}=botPickTask(g,bot);
      applyTask(g,bot,act,target||(target&&target.name)||null,fromInv||false);
      g.pendingTasks[bot]--;
    }
  });
  finishTaskPhaseIfDone(g);
}

function runBotMoves(g) {
  if (!g||g.gameOver||!g.bots||g.bots.length===0) return;
  if (g.phase==='rps') {
    g.bots.forEach(bot=>{
      if (g.alivePlayers.includes(bot)&&!g.pendingRPS[bot]) {
        g.pendingRPS[bot]=botPickRPS(); g.lastAction=Date.now();
      }
    });
    if (g.alivePlayers.every(p=>g.pendingRPS[p])) {
      resolveRPS(g);
    }
  } else if (g.phase==='action') {
    runBotTasks(g);
  }
}

function resolveRPS(g) {
  const choices={...g.pendingRPS};
  g.rpsChoices=choices;
  const winners=resolveMultiRPS(g.pendingRPS);
  const choiceStr=g.alivePlayers.map(p=>`${p}:${g.pendingRPS[p]}`).join(' | ');

  if (winners.length===g.alivePlayers.length) {
    // Full tie
    g.moves.unshift(`🤝 TIE — ${choiceStr} — replay!`);
    g.pendingRPS={}; g.rpsChoices={};
    runBotMoves(g);
    return;
  }

  // Assign tasks to each winner based on how many they beat
  winners.forEach(w=>{
    g.scores[w]+=10;
    const tasks=calcTasks(w, choices);
    g.pendingTasks[w]=tasks;
    g.moves.unshift(`🏆 ${w} wins RPS (${choices[w]}) — earned ${tasks} task${tasks>1?'s':''}!`);
  });
  g.rpsWinners=[...winners]; g.rpsWinner=winners[0];
  g.phase='action'; g.pendingRPS={};

  // Auto-play bots
  runBotTasks(g);
}

const ok=(res,d)=>{res.setHeader('Content-Type','application/json');res.status(200).json(d);};
const fail=(res,m,c=400)=>{res.setHeader('Content-Type','application/json');res.status(c).json({error:m});};

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action=req.query.action;

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method==='GET') {
    if (action==='lobby') {
      const l=store.lobbies[req.query.code];
      return l ? ok(res,{lobby:publicLobby(l)}) : fail(res,'LOBBY NOT FOUND',404);
    }
    if (action==='public_lobbies') {
      const now=Date.now();
      const list=Object.values(store.lobbies)
        .filter(l=>l.privacy==='public'&&l.status==='waiting')
        .filter(l=>now-(l.lastActivity||l.createdAt||0)<10*60*1000)
        .map(l=>({code:l.code,host:l.host,players:l.players.length,maxPlayers:l.maxPlayers,bots:(l.bots||[]).length}))
        .slice(0,10);
      return ok(res,{lobbies:list});
    }
    if (action==='game') {
      const g=store.games[req.query.gameId];
      if (!g) return fail(res,'GAME NOT FOUND',404);
      runBotMoves(g);
      return ok(res,{state:publicState(g)});
    }
    if (action==='online_players') {
      const players=getOnlinePlayers();
      const invites=req.query.username ? (store.online[req.query.username]?.pendingInvites||[]) : [];
      if (req.query.username&&store.online[req.query.username]) store.online[req.query.username].pendingInvites=[];
      return ok(res,{players,count:players.length,invites});
    }
    return fail(res,'Unknown action',400);
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method==='POST') {
    let body={};
    try {
      if (typeof req.body==='object'&&req.body!==null){ body=req.body; }
      else {
        const raw=await new Promise((resolve,reject)=>{
          let d=''; req.on('data',c=>{d+=c;}); req.on('end',()=>resolve(d)); req.on('error',reject);
        });
        body=JSON.parse(raw||'{}');
      }
    } catch{ body={}; }

    if (action==='register') {
      const n=(body.username||'').trim().slice(0,14);
      if (!n) return fail(res,'INVALID USERNAME');
      return ok(res,{username:n});
    }
    if (action==='create_lobby') {
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
    if (action==='add_bot') {
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
    if (action==='remove_bot') {
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
    if (action==='join_lobby') {
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
    if (action==='leave_lobby') {
      const{username,code}=body;
      const l=store.lobbies[code];
      if (!l) return ok(res,{ok:true});
      l.players=l.players.filter(p=>p!==username);
      if (l.players.length===0){ delete store.lobbies[code]; }
      else{ if (l.host===username) l.host=l.players[0]; l.lastActivity=Date.now(); }
      return ok(res,{ok:true});
    }
    if (action==='start_game') {
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
    if (action==='rps_choice') {
      const{gameId,username,choice}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (g.gameOver||g.phase!=='rps') return fail(res,'NOT RPS PHASE');
      if (!g.alivePlayers.includes(username)) return fail(res,'NOT IN GAME');
      if (g.pendingRPS[username]) return ok(res,{state:publicState(g)});
      if (!['rock','paper','scissors'].includes(choice)) return fail(res,'INVALID CHOICE');
      g.pendingRPS[username]=choice; g.lastAction=Date.now();
      // Auto-fill bots
      g.bots.forEach(bot=>{
        if (g.alivePlayers.includes(bot)&&!g.pendingRPS[bot]) g.pendingRPS[bot]=botPickRPS();
      });
      if (g.alivePlayers.every(p=>g.pendingRPS[p])) {
        resolveRPS(g);
      }
      return ok(res,{state:publicState(g)});
    }
    if (action==='task_action') {
      // Single task action by a winner
      const{gameId,username,action:act,targetPlayer,useInventory}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (g.gameOver||g.phase!=='action') return fail(res,'NOT ACTION PHASE');
      const tasks=g.pendingTasks[username];
      if (!tasks||tasks<=0) return fail(res,'NO TASKS REMAINING');
      g.lastAction=Date.now();
      const result=applyTask(g,username,act,targetPlayer,useInventory||false);
      if (result.error) return fail(res,result.error);
      g.pendingTasks[username]--;
      // Run any bot tasks that may have been unlocked
      runBotTasks(g);
      finishTaskPhaseIfDone(g);
      if (result.gameOver) return ok(res,{gameOver:true,winner:result.winner,state:publicState(g)});
      return ok(res,{state:publicState(g),tasksLeft:g.pendingTasks[username]||0});
    }
    if (action==='heartbeat') {
      const{username}=body;
      if (!username) return fail(res,'NO USERNAME');
      if (!store.online[username]) store.online[username]={ts:Date.now(),pendingInvites:[]};
      else store.online[username].ts=Date.now();
      return ok(res,{ok:true,online:getOnlinePlayers().length});
    }
    if (action==='send_invite') {
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
