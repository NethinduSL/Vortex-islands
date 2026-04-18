// ─── Vortex Islands — API v3 + Coin Economy + Public Lobbies ──────────────────
const { v4: uuidv4 } = require('uuid');
if (!global._vortexStore) global._vortexStore = { lobbies:{}, games:{} };
const store = global._vortexStore;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525,s)+1013904223)>>>0; return s/0xffffffff; };
}

// Higher resolution grid: 32×16 (was 20×10)
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

function createGame(players, lobbyCode, bots) {
  const gameId=uuidv4(), baseGrids={}, grids={}, scores={}, islands={};
  players.forEach(p=>{
    const seed=Math.floor(Math.random()*1e9);
    baseGrids[p]=generateIslandGrid(seed);
    grids[p]=baseGrids[p].map(r=>[...r]);
    scores[p]=0;
    islands[p]={ shields:0, quadrants:[], alive:true, inventory:{cannons:0,slicers:0}, coins:0 };
  });
  return store.games[gameId]={
    gameId, players:[...players], alivePlayers:[...players],
    baseGrids, grids, scores, islands, moves:[],
    phase:'rps', pendingRPS:{}, rpsWinner:null,
    gameOver:false, winner:null, lobbyCode, bots:bots||[], lastAction:Date.now()
  };
}

function publicState(g) {
  return {
    gameId:g.gameId, players:g.players, alivePlayers:g.alivePlayers,
    grids:g.grids, scores:g.scores, islands:g.islands, moves:g.moves,
    phase:g.phase,
    pendingRPS:Object.fromEntries(Object.entries(g.pendingRPS).map(([k])=>[k,true])),
    rpsWinner:g.rpsWinner, gameOver:g.gameOver, winner:g.winner, bots:g.bots||[]
  };
}

function rpsBeats(a,b){
  return ({rock:['scissors'],scissors:['paper'],paper:['rock']}[a]||[]).includes(b);
}
function resolveMultiRPS(choices){
  const players=Object.keys(choices);
  if(players.length===1)return players;
  const moves=[...new Set(Object.values(choices))];
  if(moves.length===1)return players;
  for(const m of moves){
    const others=moves.filter(x=>x!==m);
    if(others.every(x=>rpsBeats(m,x)))return players.filter(p=>choices[p]===m);
  }
  return players;
}

const RPS_MOVES = ['rock','paper','scissors'];
function botPickRPS() { return RPS_MOVES[Math.floor(Math.random()*RPS_MOVES.length)]; }

function botPickAction(g, botName) {
  const me = g.islands[botName];
  const enemies = g.alivePlayers.filter(p=>p!==botName);
  const target = enemies[Math.floor(Math.random()*enemies.length)];
  const coins = me.coins||0;

  if (coins >= 1) {
    const enemyHasShield = target && g.islands[target] && g.islands[target].shields>0;
    if (enemyHasShield && Math.random()<0.7) return { act:'buy_cannon', target };
    if (!enemyHasShield && Math.random()<0.6) return { act:'buy_slicer', target };
    if (me.shields===0 && Math.random()<0.5) return { act:'buy_shield', target:null };
  }
  if (me.inventory.cannons>0 && target && Math.random()<0.6)
    return { act:'cannon', target, fromInv:true };
  if (me.inventory.slicers>0 && target && Math.random()<0.5) {
    const t=g.islands[target];
    if (!t||t.shields===0) return { act:'slicer', target, fromInv:true };
  }
  return { act:'store', target:null, fromInv:false };
}

const QNAMES = ['TOP-LEFT','TOP-RIGHT','BOT-LEFT','BOT-RIGHT'];
const SHOP_PRICE = 1;

function applyAction(g, username, act, targetPlayer, useInventory) {
  const alive=g.alivePlayers;
  const target=(targetPlayer&&alive.includes(targetPlayer)&&targetPlayer!==username)
    ? targetPlayer : alive.find(p=>p!==username);
  const me=g.islands[username];

  // ── SHOP: buy with coins ──────────────────────────────────────────────────
  if (act==='buy_cannon'||act==='buy_slicer'||act==='buy_shield') {
    if ((me.coins||0)<SHOP_PRICE) return {error:'NOT ENOUGH COINS — WIN RPS TO EARN COINS!'};
    me.coins-=SHOP_PRICE;
    if (act==='buy_shield') {
      if (me.shields>=3) { me.coins+=SHOP_PRICE; return {error:'MAX 3 SHIELDS'}; }
      me.shields++;
      g.moves.unshift(`🪙 ${username} bought 🛡 SHIELD (${me.shields}/3) — slicers can no longer cut you!`);
    } else if (act==='buy_cannon') {
      me.inventory.cannons++;
      g.moves.unshift(`🪙 ${username} bought 💣 CANNON — stored in inventory!`);
    } else {
      me.inventory.slicers++;
      g.moves.unshift(`🪙 ${username} bought ⚔ SLICER — stored in inventory!`);
    }
    return {};
  }

  // ── CANNON: removes shield OR destroys quadrant ───────────────────────────
  if (act==='cannon') {
    if (!target) return {error:'NO TARGET'};
    if (useInventory) {
      if (me.inventory.cannons<=0) return {error:'NO CANNONS IN INVENTORY'};
      me.inventory.cannons--;
    }
    const t=g.islands[target];
    if (t.shields>0) {
      t.shields--;
      g.moves.unshift(`💣 ${username}'s CANNON blasted through ${target}'s shield! (${t.shields} rings left)`);
    } else {
      const surv=[0,1,2,3].filter(q=>!t.quadrants.includes(q));
      if (surv.length>0) {
        const q=surv[Math.floor(Math.random()*surv.length)];
        t.quadrants.push(q);
        g.moves.unshift(`💥 ${username}'s CANNON destroyed ${target}'s ${QNAMES[q]}!`);
        g.grids[target]=applyQuadrantDamage(g.baseGrids[target],t.quadrants);
      }
    }
    if (!useInventory) {
      me.inventory.cannons++;
      g.moves.unshift(`📦 ${username} banked a 💣 Cannon`);
    }

  // ── SLICER: BLOCKED by shield; cuts+deletes quadrant if no shield ─────────
  } else if (act==='slicer') {
    if (!target) return {error:'NO TARGET'};
    if (useInventory) {
      if (me.inventory.slicers<=0) return {error:'NO SLICERS IN INVENTORY'};
      me.inventory.slicers--;
    }
    const t=g.islands[target];
    if (t.shields>0) {
      // Shield blocks slicer completely — refund it
      if (useInventory) me.inventory.slicers++;
      g.moves.unshift(`🛡 ${target}'s shield BLOCKED ${username}'s slicer! Use 💣 CANNON to remove the shield first!`);
    } else {
      // No shield: slicer slices island into 4 then deletes one part
      const surv=[0,1,2,3].filter(q=>!t.quadrants.includes(q));
      if (surv.length>0) {
        const q=surv[Math.floor(Math.random()*surv.length)];
        t.quadrants.push(q);
        g.moves.unshift(`⚔ ${username}'s SLICER split ${target}'s island into ${4} parts and deleted ${QNAMES[q]}!`);
        g.grids[target]=applyQuadrantDamage(g.baseGrids[target],t.quadrants);
        if (surv.length-1>0)
          g.moves.unshift(`🗺 ${target} has ${surv.length-1} island part(s) remaining.`);
      }
      if (!useInventory) {
        me.inventory.slicers++;
        g.moves.unshift(`📦 ${username} banked a ⚔ Slicer`);
      }
    }

  // ── SHIELD: free action, up to 3 rings ───────────────────────────────────
  } else if (act==='shield') {
    if (me.shields>=3) return {error:'MAX 3 SHIELDS'};
    me.shields++;
    g.moves.unshift(`🛡 ${username} raised shield ring ${me.shields}/3 — SLICER is now BLOCKED!`);
    const bonus=Math.random()<.5?'cannons':'slicers';
    me.inventory[bonus]++;
    g.moves.unshift(`📦 ${username} got a ${bonus==='cannons'?'💣 Cannon':'⚔ Slicer'} bonus!`);

  // ── STORE: bank both weapons ──────────────────────────────────────────────
  } else if (act==='store') {
    me.inventory.cannons++;
    me.inventory.slicers++;
    g.moves.unshift(`📦 ${username} banked 💣 Cannon + ⚔ Slicer!`);

  } else {
    return {error:'UNKNOWN ACTION'};
  }

  // Elimination check
  if (target&&g.islands[target]&&g.islands[target].quadrants.length>=4) {
    g.islands[target].alive=false;
    g.alivePlayers=g.alivePlayers.filter(p=>p!==target);
    g.moves.unshift(`💀 ${target}'s island sank — ELIMINATED!`);
  }

  // Win check
  if (g.alivePlayers.length===1) {
    const gw=g.alivePlayers[0];
    g.gameOver=true; g.phase='done'; g.winner=gw; g.scores[gw]+=50;
    if (g.lobbyCode&&store.lobbies[g.lobbyCode]) store.lobbies[g.lobbyCode].status='waiting';
    return {gameOver:true,winner:gw};
  }

  g.phase='rps'; g.rpsWinner=null; g.pendingRPS={};
  return {};
}

function awardCoin(g, winner) {
  g.islands[winner].coins=(g.islands[winner].coins||0)+1;
  g.moves.unshift(`🪙 ${winner} won RPS and earned 1 COIN! (Total: ${g.islands[winner].coins})`);
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
      const winners=resolveMultiRPS(g.pendingRPS);
      const choiceStr=g.alivePlayers.map(p=>`${p}:${g.pendingRPS[p]}`).join(' | ');
      if (winners.length>1) {
        g.moves.unshift(`🤝 TIE — ${choiceStr}`);
        g.pendingRPS={};
        runBotMoves(g);
      } else {
        const w=winners[0];
        g.scores[w]+=10;
        g.rpsWinner=w; g.phase='action'; g.pendingRPS={};
        awardCoin(g, w);
        if (g.bots.includes(w)) {
          const {act,target,fromInv}=botPickAction(g,w);
          applyAction(g,w,act,target?(target.name||target):null,fromInv||false);
        }
      }
    }
  } else if (g.phase==='action'&&g.rpsWinner&&g.bots.includes(g.rpsWinner)) {
    const {act,target,fromInv}=botPickAction(g,g.rpsWinner);
    applyAction(g,g.rpsWinner,act,target?(target.name||target):null,fromInv||false);
  }
}

const ok=(res,d)=>{res.setHeader('Content-Type','application/json');res.status(200).json(d);};
const fail=(res,m,c=400)=>{res.setHeader('Content-Type','application/json');res.status(c).json({error:m});};

// Promo codes
const PROMO_CODES={
  'VORTEX2025':{coins:5,desc:'5 FREE COINS!'},
  'ISLAND10':{coins:3,desc:'3 BONUS COINS!'},
  'BATTLEPASS':{coins:10,desc:'10 COINS LOADED!'},
};
if (!global._vortexPromo) global._vortexPromo={};
const promoUsed=global._vortexPromo;

module.exports=async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action=req.query.action;

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
    return fail(res,'Unknown action',400);
  }

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
      g.bots.forEach(bot=>{
        if (g.alivePlayers.includes(bot)&&!g.pendingRPS[bot]) g.pendingRPS[bot]=botPickRPS();
      });
      if (g.alivePlayers.every(p=>g.pendingRPS[p])) {
        const winners=resolveMultiRPS(g.pendingRPS);
        const choiceStr=g.alivePlayers.map(p=>`${p}:${g.pendingRPS[p]}`).join(' | ');
        if (winners.length>1) {
          g.moves.unshift(`🤝 TIE — ${choiceStr}`);
          g.pendingRPS={};
          runBotMoves(g);
        } else {
          const w=winners[0];
          g.scores[w]+=10; g.rpsWinner=w; g.phase='action'; g.pendingRPS={};
          awardCoin(g,w);
          if (g.bots.includes(w)) {
            const{act,target,fromInv}=botPickAction(g,w);
            applyAction(g,w,act,target?(target.name||target):null,fromInv||false);
          }
        }
      }
      return ok(res,{state:publicState(g)});
    }
    if (action==='action_choice') {
      const{gameId,username,action:act,targetPlayer,useInventory}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (g.gameOver||g.phase!=='action'||g.rpsWinner!==username) return fail(res,'NOT YOUR TURN');
      g.lastAction=Date.now();
      const result=applyAction(g,username,act,targetPlayer,useInventory||false);
      if (result.error) return fail(res,result.error);
      runBotMoves(g);
      if (result.gameOver) return ok(res,{gameOver:true,winner:result.winner,state:publicState(g)});
      return ok(res,{state:publicState(g)});
    }
    if (action==='redeem_promo') {
      const{gameId,username,code:promoCode}=body;
      const g=store.games[gameId];
      if (!g) return fail(res,'GAME NOT FOUND');
      if (!g.players.includes(username)) return fail(res,'NOT IN GAME');
      const promo=PROMO_CODES[(promoCode||'').toUpperCase()];
      if (!promo) return fail(res,'INVALID PROMO CODE');
      const key=`${gameId}:${username}:${promoCode.toUpperCase()}`;
      if (promoUsed[key]) return fail(res,'PROMO ALREADY USED IN THIS GAME');
      promoUsed[key]=true;
      g.islands[username].coins=(g.islands[username].coins||0)+promo.coins;
      g.moves.unshift(`🎁 ${username} redeemed promo "${promoCode.toUpperCase()}": ${promo.desc}`);
      return ok(res,{coins:g.islands[username].coins,desc:promo.desc,state:publicState(g)});
    }
    return fail(res,'Unknown action');
  }
  return fail(res,'Method not allowed',405);
};
