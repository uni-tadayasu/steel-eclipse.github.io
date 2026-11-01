'use strict';
/** STEEL ECLIPSE: dependency-free LAN/internet room relay server. Node.js 20+.
 *  Each room hosts up to four players, PVE enemy AI is simulated by room owner.
 *  PVP health is server mediated with ability cooldown and damage limits.
 *  For untrusted/public internet deployments, add accounts, moderation, persistence,
 *  state verification, TLS proxy, logging and abuse protection.
 */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PORT=+process.env.PORT||3000;
const HOST=process.env.HOST||'0.0.0.0';
const frames=require('./frames.json');
const frameData=new Map(frames.map(f=>[f.id,f]));
const rooms=new Map();
const peers=new Set();
const LIMIT=64000;
const clamp=(n,a,b)=>Math.min(b,Math.max(a,Number.isFinite(+n)?+n:a));
const sanitizeName=n=>String(n||'PILOT').trim().replace(/[<>\r\n]/g,'').slice(0,16)||'PILOT';
const clampFrame=f=>frameData.has(f)?f:frames[0].id;
const randCode=()=>{let s='';const abc='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let i=0;i<6;i++)s+=abc[crypto.randomInt(abc.length)];return s};
function send(p,obj){if(p.closed)return;const raw=Buffer.from(JSON.stringify(obj));const n=raw.length;let head;
 if(n<126){head=Buffer.from([129,n])}else if(n<65536){head=Buffer.alloc(4);head[0]=129;head[1]=126;head.writeUInt16BE(n,2)}else{head=Buffer.alloc(10);head[0]=129;head[1]=127;head.writeBigUInt64BE(BigInt(n),2)}
 try{p.sock.write(Buffer.concat([head,raw]));}catch{drop(p)}
}
function wsClose(p){if(p.closed)return;try{p.sock.end(Buffer.from([0x88,0x00]));}catch{}drop(p)}
function broad(room,msg,except=null){for(const m of room.players)if(m!==except)send(m,msg)}
function memberList(room){return room.players.map((m,i)=>({id:m.id,name:m.name,frame:m.frame,hp:Math.round(m.hp),maxHp:m.maxHp,x:m.x,z:m.z,rot:m.rot,seat:i,kills:m.kills}));}
function roomState(r){return {type:'state',room:r.code,playMode:r.mode,stage:r.stage,hostId:r.hostId,started:r.started,members:memberList(r)}}
function state(r){broad(r,roomState(r))}
function removeRoom(p){const r=p.room;if(!r)return; p.room=null;r.players=r.players.filter(m=>m!==p);if(!r.players.length){rooms.delete(r.code);return}
 if(r.hostId===p.id)r.hostId=r.players[0].id;
 if(r.started&&r.mode==='versus'&&r.players.filter(a=>a.hp>0).length<=1){const survivor=r.players.find(a=>a.hp>0);r.started=false;broad(r,{type:'finish',winnerId:survivor?.id||null,reason:'相手が退出しました'});}
 state(r);
}
function drop(p){if(p.closed)return;p.closed=true;peers.delete(p);removeRoom(p);try{p.sock.destroy()}catch{}}
function playerIn(p,r){p.room=r;p.name=sanitizeName(p.name);r.players.push(p);p.hp=frameData.get(p.frame).hp;p.maxHp=p.hp;p.kills=0;p.x=0;p.z=0;p.rot=0}
function reject(p,message){send(p,{type:'error',message})}
function enter(p,r){p.lastAttack=Object.create(null);send(p,{type:'welcome',id:p.id,room:r.code});state(r)}
function handle(p,msg){if(!msg||typeof msg!=='object'||typeof msg.type!=='string')return;
 if(msg.type==='ping'){send(p,{type:'pong'});return}
 if(msg.type==='create'){
   if(p.room)return reject(p,'既にルームにいます');if(rooms.size>=200)return reject(p,'作成できる部屋数の上限です');
   let code;do{code=randCode()}while(rooms.has(code));p.name=sanitizeName(msg.name);p.frame=clampFrame(msg.frame);
   const r={code,hostId:p.id,mode:msg.playMode==='versus'?'versus':'coop',stage:Math.round(clamp(msg.stage,0,47)),started:false,players:[]};rooms.set(code,r);playerIn(p,r);enter(p,r);
 }else if(msg.type==='join'){
   if(p.room)return reject(p,'既にルームにいます');const code=String(msg.room||'').trim().toUpperCase(),r=rooms.get(code);
   if(!r)return reject(p,'部屋コードが見つかりません');if(r.started)return reject(p,'戦闘中の部屋には途中参加できません');if(r.players.length>=4)return reject(p,'この部屋は4人で満員です');
   p.name=sanitizeName(msg.name);p.frame=clampFrame(msg.frame);playerIn(p,r);enter(p,r);
 }else if(msg.type==='leave'){removeRoom(p);send(p,{type:'left'});}
 else{const r=p.room;if(!r)return;
  switch(msg.type){
  case 'profile':if(r.started)break;p.name=sanitizeName(msg.name);p.frame=clampFrame(msg.frame);p.hp=frameData.get(p.frame).hp;p.maxHp=p.hp;state(r);break;
  case 'stage':if(!r.started&&r.hostId===p.id){r.stage=Math.round(clamp(msg.stage,0,47));state(r)}break;
  case 'start':if(r.started||r.hostId!==p.id)return;if(r.players.length<2)return reject(p,'協力・対戦には2人以上が必要です');r.started=true;
    for(const [i,m] of r.players.entries()){m.maxHp=frameData.get(m.frame).hp;m.hp=m.maxHp;m.kills=0;m.x=(i%2?1:-1)*19;m.z=(i>1?14:-14);m.rot=i%2?Math.PI:0;m.lastAttack=Object.create(null)}
    broad(r,{type:'start',stage:r.stage,playMode:r.mode,members:memberList(r)});break;
  case 'move':if(!r.started||p.hp<=0)return;p.x=clamp(msg.x,-75,75);p.z=clamp(msg.z,-75,75);p.rot=clamp(msg.rot,-Math.PI*10,Math.PI*10);
    if(r.mode==='coop'&&r.hostId===p.id&&Number.isFinite(+msg.hp)){p.hp=clamp(msg.hp,0,p.maxHp)}
    broad(r,{type:'position',id:p.id,x:p.x,z:p.z,rot:p.rot,hp:p.hp,frame:p.frame,name:p.name},p);break;
  case 'enemySync':if(!r.started||r.mode!=='coop'||r.hostId!==p.id||!Array.isArray(msg.enemies))return;
    broad(r,{type:'enemySync',wave:Math.round(clamp(msg.wave,1,4)),enemies:msg.enemies.slice(0,30).map(e=>({id:Math.round(clamp(e.id,0,999999)),frame:clampFrame(e.frame),kind:String(e.kind||'trooper').slice(0,20),name:String(e.name||'HOSTILE').slice(0,28),x:clamp(e.x,-76,76),z:clamp(e.z,-76,76),rot:clamp(e.rot,-Math.PI*20,Math.PI*20),hp:clamp(e.hp,0,1e6),maxHp:clamp(e.maxHp,1,1e6),scale:clamp(e.scale,.5,3),boss:!!e.boss,atk:clamp(e.atk,1,1e5),def:clamp(e.def,0,1e4)}))},p);break;
  case 'fx':if(!r.started||p.hp<=0)return;{const t=Date.now();if(t-(p.lastFx||0)<85)return;p.lastFx=t;const style=['shot','slash','cannon','special'].includes(msg.style)?msg.style:'shot';broad(r,{type:'fx',id:p.id,style},p)}break;
  case 'enemyHit':if(!r.started||r.mode!=='coop'||r.hostId===p.id||p.hp<=0)return;
    if(Date.now()-(p.lastEnemyHit||0)<36)return;p.lastEnemyHit=Date.now();
    {const host=r.players.find(m=>m.id===r.hostId);if(host)send(host,{type:'enemyHit',fromId:p.id,enemyId:Math.round(clamp(msg.enemyId,0,999999)),amount:clamp(msg.amount,1,2000)});}break;
  case 'hurt':if(!r.started||r.mode!=='coop'||r.hostId!==p.id)return;
    {const who=r.players.find(m=>m.id===msg.targetId);if(who&&who.hp>0){who.hp=Math.max(0,who.hp-clamp(msg.amount,0,1000));broad(r,{type:'health',id:who.id,hp:who.hp});}}break;
  case 'pvpHit':if(!r.started||r.mode!=='versus'||p.hp<=0)return;
    {const who=r.players.find(m=>m.id===msg.targetId);if(!who||who===p||who.hp<=0)return;
     if(Math.hypot(who.x-p.x,who.z-p.z)>100)return;
     const style=['shot','slash','special'].includes(msg.style)?msg.style:'shot';
     const cd={shot:52,slash:540,special:12200}[style];const now=Date.now();if(now-(p.lastAttack[style]||0)<cd)return;p.lastAttack[style]=now;
     const cap={shot:410,slash:700,special:1550}[style];const armor=frameData.get(who.frame).def;const dmg=Math.round(clamp(msg.amount,1,cap)*(1-Math.min(.62,armor/(armor+145))));
     who.hp=Math.max(0,who.hp-dmg);if(who.hp===0)p.kills++;
     broad(r,{type:'health',id:who.id,hp:who.hp,by:p.id,damage:dmg,style});
     if(r.players.filter(m=>m.hp>0).length<=1){r.started=false;const winner=r.players.find(m=>m.hp>0);broad(r,{type:'finish',winnerId:winner?.id||null,reason:'LAST UNIT STANDING'});state(r)}
    }break;
  case 'finish':if(r.mode!=='coop'||!r.started||r.hostId!==p.id)return;r.started=false;broad(r,{type:'finish',success:!!msg.success});state(r);break;
  }
 }
}
// RFC6455 text message parser, with browser masking and 64KiB message limit.
function parseFrame(p){let b=p.buf;
 while(b.length>=2){const fin=!!(b[0]&128),op=b[0]&15,mask=!!(b[1]&128);let len=b[1]&127,h=2;
  if(len===126){if(b.length<4)break;len=b.readUInt16BE(2);h=4}
  else if(len===127){if(b.length<10)break;const l=b.readBigUInt64BE(2);if(l>BigInt(LIMIT))return wsClose(p);len=Number(l);h=10}
  if(!mask||len>LIMIT)return wsClose(p);if(b.length<h+4+len)break;
  const key=b.subarray(h,h+4),payload=Buffer.from(b.subarray(h+4,h+4+len));for(let i=0;i<len;i++)payload[i]^=key[i%4];b=b.subarray(h+4+len);
  if(op===8){wsClose(p);return}if(op===9){try{p.sock.write(Buffer.from([0x8a,payload.length,...payload]))}catch{}continue}if(op===10)continue;
  if(op!==1||!fin)return wsClose(p);
  const now=Date.now();if(now-p.rateAt>1000){p.rateAt=now;p.rate=0}if(++p.rate>90)return wsClose(p);
  try{handle(p,JSON.parse(payload.toString('utf8')))}catch{reject(p,'通信形式が不正です')}
 }
 p.buf=b;
}
const server=http.createServer((req,res)=>{
 let pathname;try{pathname=new URL(req.url,'http://localhost').pathname}catch{pathname='/'}
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,rooms:rooms.size,players:peers.size}));return}
 if(pathname!=='/'&&pathname!=='/index.html'){res.writeHead(404);res.end('Not found');return}
 fs.readFile(path.join(__dirname,'index.html'),(err,data)=>{if(err){res.writeHead(500);res.end('File unavailable');return}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(data)})
});
server.on('upgrade',(req,sock,head)=>{
 if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||!req.headers['sec-websocket-key']){sock.destroy();return}
 if(peers.size>=500){sock.destroy();return}
 const key=String(req.headers['sec-websocket-key']);const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 const p={id:crypto.randomBytes(6).toString('hex'),sock,buf:Buffer.alloc(0),closed:false,room:null,name:'PILOT',frame:frames[0].id,rateAt:Date.now(),rate:0,lastAttack:Object.create(null)};peers.add(p);
 sock.on('data',chunk=>{if(p.closed)return;p.buf=Buffer.concat([p.buf,chunk]);if(p.buf.length>LIMIT*3)return wsClose(p);parseFrame(p)});
 sock.on('close',()=>drop(p));sock.on('error',()=>drop(p));sock.setTimeout(120000,()=>wsClose(p));if(head?.length){p.buf=Buffer.concat([p.buf,head]);parseFrame(p)}
});
server.listen(PORT,HOST,()=>{console.log(`STEEL ECLIPSE listening at http://localhost:${PORT} (LAN: http://YOUR-PC-IPv4:${PORT})`)});
process.on('SIGINT',()=>{server.close();process.exit(0)});
