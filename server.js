const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path   = require('path');
const crypto = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const p1 = path.join(__dirname, 'public', 'index.html');
  const p2 = path.join(__dirname, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else res.sendFile(p2);
});

// ── STORES ───────────────────────────────────────────────────
const onlineSockets = new Map();   // socketId → username
const userSockets   = new Map();   // username → socketId
const waitingQueue  = [];
const activePairs   = new Map();
const accountDB     = new Map();   // username → account
const sessionDB     = new Map();   // token → username
const dmRooms       = new Map();   // roomId → dm room
const rooms         = new Map();   // roomId → room
const adminLogs     = [];          // admin action log

// ── FIRST ADMIN ───────────────────────────────────────────────
// First registered user becomes super-admin automatically
// Or set ADMIN_USERNAME env variable
const SUPER_ADMIN = process.env.ADMIN_USERNAME || null;

// ── LEVELS ───────────────────────────────────────────────────
const LEVELS = [
  { name: 'Newcomer', icon: '🌱', min: 0      },
  { name: 'Regular',  icon: '⚡', min: 500    },
  { name: 'Veteran',  icon: '🔮', min: 2000   },
  { name: 'Elite',    icon: '👑', min: 10000  },
  { name: 'Legend',   icon: '🔥', min: 50000  },
];
function getLevelIndex(xp) {
  let l = 0;
  for (let i = LEVELS.length - 1; i >= 0; i--) { if (xp >= LEVELS[i].min) { l = i; break; } }
  return l;
}

// ── ROOM CATEGORIES ───────────────────────────────────────────
const ROOM_CATEGORIES = [
  { id: 'general',    label: 'General',    icon: '💬' },
  { id: 'gaming',     label: 'Gaming',     icon: '🎮' },
  { id: 'music',      label: 'Music',      icon: '🎵' },
  { id: 'tech',       label: 'Tech',       icon: '💻' },
  { id: 'art',        label: 'Art',        icon: '🎨' },
  { id: 'movies',     label: 'Movies',     icon: '🎬' },
  { id: 'sports',     label: 'Sports',     icon: '⚽' },
  { id: 'travel',     label: 'Travel',     icon: '🌍' },
  { id: 'food',       label: 'Food',       icon: '🍕' },
  { id: 'books',      label: 'Books',      icon: '📚' },
  { id: 'chill',      label: 'Chill',      icon: '😌' },
  { id: 'nsfw',       label: 'NSFW',       icon: '🔞' },
];

// ── REACTIONS ────────────────────────────────────────────────
const ALLOWED_REACTIONS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];

// ── CRYPTO ───────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}
function verifyPassword(p, salt, h) { return hashPassword(p, salt).hash === h; }
function generateToken()   { return crypto.randomBytes(32).toString('hex'); }
function generateRoomCode(){ return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// ── BADGES ───────────────────────────────────────────────────
const BADGES = [
  { id: 'first_chat',    icon: '🌱', name: 'First Steps',    desc: 'Completed first chat' },
  { id: 'chat_10',       icon: '💬', name: 'Chatterbox',     desc: 'Sent 10 messages' },
  { id: 'chat_100',      icon: '🗣️',  name: 'Talkative',      desc: 'Sent 100 messages' },
  { id: 'chat_1000',     icon: '📢', name: 'Loudmouth',      desc: 'Sent 1000 messages' },
  { id: 'strangers_5',   icon: '🤝', name: 'Social',         desc: 'Met 5 strangers' },
  { id: 'strangers_25',  icon: '🌍', name: 'Globe Trotter',  desc: 'Met 25 strangers' },
  { id: 'friends_1',     icon: '💛', name: 'First Friend',   desc: 'Made first friend' },
  { id: 'friends_10',    icon: '👥', name: 'Popular',        desc: 'Made 10 friends' },
  { id: 'room_creator',  icon: '🏠', name: 'Room Creator',   desc: 'Created a room' },
  { id: 'verified',      icon: '✅', name: 'Verified',       desc: 'Account verified by admin' },
  { id: 'level_regular', icon: '⚡', name: 'Regular',        desc: 'Reached Regular level' },
  { id: 'level_veteran', icon: '🔮', name: 'Veteran',        desc: 'Reached Veteran level' },
  { id: 'level_elite',   icon: '👑', name: 'Elite',          desc: 'Reached Elite level' },
  { id: 'level_legend',  icon: '🔥', name: 'Legend',         desc: 'Reached Legend level' },
];

function checkBadges(account) {
  const earned = new Set(account.badges || []);
  const newBadges = [];
  const checks = [
    ['first_chat',    account.strangersCount >= 1],
    ['chat_10',       account.messages >= 10],
    ['chat_100',      account.messages >= 100],
    ['chat_1000',     account.messages >= 1000],
    ['strangers_5',   account.strangersCount >= 5],
    ['strangers_25',  account.strangersCount >= 25],
    ['friends_1',     (account.friends||[]).length >= 1],
    ['friends_10',    (account.friends||[]).length >= 10],
    ['room_creator',  (account.roomsCreated||0) >= 1],
    ['level_regular', getLevelIndex(account.xp) >= 1],
    ['level_veteran', getLevelIndex(account.xp) >= 2],
    ['level_elite',   getLevelIndex(account.xp) >= 3],
    ['level_legend',  getLevelIndex(account.xp) >= 4],
  ];
  for (const [id, cond] of checks) {
    if (cond && !earned.has(id)) { earned.add(id); newBadges.push(id); }
  }
  account.badges = Array.from(earned);
  return newBadges;
}

// ── DM HELPERS ───────────────────────────────────────────────
function getDMRoomId(a, b) { return [a,b].sort().join('__dm__'); }
function getOrCreateDMRoom(a, b) {
  const id = getDMRoomId(a, b);
  if (!dmRooms.has(id)) dmRooms.set(id, { id, users:[a,b], messages:[], unread:{[a]:0,[b]:0} });
  return dmRooms.get(id);
}

// ── AUTH MIDDLEWARE ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ','');
  const username = sessionDB.get(token);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  req.account = accountDB.get(username);
  req.username = username;
  if (!req.account) return res.status(404).json({ error: 'Account not found' });
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.account.isAdmin && !req.account.isSuperAdmin)
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── REST: AUTH ───────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  let { username, password, displayName, emoji, bio, gender } = req.body;
  if (!username || !password || !gender)
    return res.status(400).json({ error: 'Username, password and gender required' });
  const key = username.toLowerCase().trim();
  if (key.length < 3 || key.length > 20) return res.status(400).json({ error: 'Username must be 3–20 chars' });
  if (!/^[a-zA-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'Letters, numbers, underscores only' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (!['male','female'].includes(gender)) return res.status(400).json({ error: 'Invalid gender' });
  if (accountDB.has(key)) return res.status(409).json({ error: 'Username already taken' });
  const { hash, salt } = hashPassword(password);
  // First user becomes super-admin
  const isFirstUser = accountDB.size === 0;
  const account = {
    id: crypto.randomBytes(8).toString('hex'),
    username: key,
    displayName: (displayName || username).slice(0, 30),
    emoji: emoji || '🎭',
    bio: (bio || '').slice(0, 160),
    avatar: null,
    gender,
    genderVerified: true,
    passwordHash: hash, passwordSalt: salt,
    xp: 0, messages: 0, strangersCount: 0, roomsCreated: 0,
    badges: [],
    friends: [], friendRequests: [], sentRequests: [],
    blockedUsers: [],
    dmPrivacy: 'all',
    isAdmin: isFirstUser || key === SUPER_ADMIN,
    isSuperAdmin: isFirstUser || key === SUPER_ADMIN,
    isVerified: false,
    isBanned: false,
    isMuted: false,
    muteUntil: null,
    banReason: '',
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  };
  if (account.isAdmin) { account.badges = ['verified']; account.isVerified = true; }
  accountDB.set(key, account);
  if (isFirstUser) logAdmin('system', 'FIRST_USER', key, 'First user registered — granted super-admin');
  const token = generateToken();
  sessionDB.set(token, key);
  res.json({ token, user: sanitizeUser(account) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Required fields missing' });
  const key = username.toLowerCase().trim();
  const account = accountDB.get(key);
  if (!account || !verifyPassword(password, account.passwordSalt, account.passwordHash))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (account.isBanned) return res.status(403).json({ error: `Banned: ${account.banReason || 'Violation of rules'}` });
  account.lastSeen = Date.now();
  const token = generateToken();
  sessionDB.set(token, key);
  res.json({ token, user: sanitizeUser(account) });
});

// ── REST: PROFILE ────────────────────────────────────────────
app.post('/api/profile/update', requireAuth, (req, res) => {
  const { displayName, bio, emoji, avatar, dmPrivacy } = req.body;
  const a = req.account;
  if (a.isMuted && a.muteUntil > Date.now()) return res.status(403).json({ error: 'You are muted' });
  if (displayName) a.displayName = displayName.slice(0,30);
  if (bio !== undefined) a.bio = bio.slice(0,160);
  if (emoji) a.emoji = emoji;
  if (avatar !== undefined) a.avatar = avatar;
  if (dmPrivacy && ['all','friends','none'].includes(dmPrivacy)) a.dmPrivacy = dmPrivacy;
  res.json({ user: sanitizeUser(a) });
});

app.get('/api/profile/:username', (req, res) => {
  const a = accountDB.get(req.params.username.toLowerCase());
  if (!a) return res.status(404).json({ error: 'User not found' });
  res.json({ ...sanitizeUser(a), isOnline: userSockets.has(a.username) });
});

app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q||'').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const results = Array.from(accountDB.values())
    .filter(a => !a.isBanned && a.username !== req.username &&
      (a.username.includes(q) || a.displayName.toLowerCase().includes(q)))
    .slice(0,10)
    .map(a => ({ ...sanitizeUser(a), isOnline: userSockets.has(a.username) }));
  res.json(results);
});

app.get('/api/leaderboard', (req, res) => res.json(getLeaderboard()));
app.get('/api/categories', (req, res) => res.json(ROOM_CATEGORIES));

// ── REST: FRIENDS ────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, (req, res) => {
  const { to } = req.body;
  const toAcc = accountDB.get(to?.toLowerCase());
  if (!toAcc) return res.status(404).json({ error: 'User not found' });
  if (toAcc.username === req.username) return res.status(400).json({ error: 'Cannot friend yourself' });
  const myAcc = req.account;
  if (myAcc.friends.includes(toAcc.username)) return res.status(400).json({ error: 'Already friends' });
  if (myAcc.sentRequests.includes(toAcc.username)) return res.status(400).json({ error: 'Already sent' });
  myAcc.sentRequests.push(toAcc.username);
  toAcc.friendRequests.push({ from: req.username, sentAt: Date.now() });
  const s = userSockets.get(toAcc.username);
  if (s) io.to(s).emit('friendRequest', { from: req.username, fromDisplay: myAcc.displayName, fromEmoji: myAcc.emoji, fromAvatar: myAcc.avatar });
  res.json({ ok: true });
});

app.post('/api/friends/respond', requireAuth, (req, res) => {
  const { from, accept } = req.body;
  const myAcc = req.account;
  const fromAcc = accountDB.get(from?.toLowerCase());
  if (!fromAcc) return res.status(404).json({ error: 'User not found' });
  const idx = myAcc.friendRequests.findIndex(r => r.from === fromAcc.username);
  if (idx === -1) return res.status(400).json({ error: 'No request found' });
  myAcc.friendRequests.splice(idx, 1);
  const si = fromAcc.sentRequests.indexOf(myAcc.username);
  if (si !== -1) fromAcc.sentRequests.splice(si, 1);
  if (accept) {
    if (!myAcc.friends.includes(fromAcc.username)) myAcc.friends.push(fromAcc.username);
    if (!fromAcc.friends.includes(myAcc.username)) fromAcc.friends.push(myAcc.username);
    checkBadges(myAcc); checkBadges(fromAcc);
    const s = userSockets.get(fromAcc.username);
    if (s) io.to(s).emit('friendAccepted', { by: myAcc.username, byDisplay: myAcc.displayName, byEmoji: myAcc.emoji });
  }
  res.json({ ok: true, user: sanitizeUser(myAcc) });
});

app.post('/api/friends/remove', requireAuth, (req, res) => {
  const { username } = req.body;
  const myAcc = req.account;
  const other = accountDB.get(username?.toLowerCase());
  if (!other) return res.status(404).json({ error: 'User not found' });
  myAcc.friends = myAcc.friends.filter(f => f !== other.username);
  other.friends = other.friends.filter(f => f !== myAcc.username);
  res.json({ ok: true, user: sanitizeUser(myAcc) });
});

app.post('/api/users/block', requireAuth, (req, res) => {
  const { username } = req.body;
  const myAcc = req.account;
  if (!myAcc.blockedUsers) myAcc.blockedUsers = [];
  if (!myAcc.blockedUsers.includes(username)) myAcc.blockedUsers.push(username);
  myAcc.friends = myAcc.friends.filter(f => f !== username);
  res.json({ ok: true, user: sanitizeUser(myAcc) });
});

app.post('/api/users/unblock', requireAuth, (req, res) => {
  req.account.blockedUsers = (req.account.blockedUsers||[]).filter(u => u !== req.body.username);
  res.json({ ok: true, user: sanitizeUser(req.account) });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = (req.account.friends||[]).map(u => {
    const a = accountDB.get(u); if (!a) return null;
    return { ...sanitizeUser(a), isOnline: userSockets.has(u) };
  }).filter(Boolean).sort((a,b) => b.isOnline - a.isOnline);
  res.json({ friends, requests: req.account.friendRequests||[], blocked: req.account.blockedUsers||[] });
});

// ── REST: DMs ────────────────────────────────────────────────
app.get('/api/dm/:username', requireAuth, (req, res) => {
  const other = req.params.username.toLowerCase();
  const otherAcc = accountDB.get(other);
  if (!otherAcc) return res.status(404).json({ error: 'User not found' });
  if (!canDM(req.username, otherAcc)) return res.status(403).json({ error: `${otherAcc.displayName} is not accepting messages` });
  const room = getOrCreateDMRoom(req.username, other);
  room.unread[req.username] = 0;
  res.json({ messages: room.messages.slice(-100), partner: { ...sanitizeUser(otherAcc), isOnline: userSockets.has(other) } });
});

app.get('/api/dms', requireAuth, (req, res) => {
  const my = req.username;
  const convs = [];
  for (const [, room] of dmRooms) {
    if (!room.users.includes(my)) continue;
    const other = room.users.find(u => u !== my);
    const otherAcc = accountDB.get(other);
    if (!otherAcc) continue;
    convs.push({ roomId: room.id, partner: { ...sanitizeUser(otherAcc), isOnline: userSockets.has(other) }, lastMessage: room.messages[room.messages.length-1]||null, unread: room.unread[my]||0 });
  }
  convs.sort((a,b) => (b.lastMessage?.timestamp||0) - (a.lastMessage?.timestamp||0));
  res.json(convs);
});

// ── REST: ROOMS ──────────────────────────────────────────────
app.post('/api/rooms/create', requireAuth, (req, res) => {
  const { name, description, isPrivate, topic, category } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Room name required' });
  const isAdmin = req.account.isAdmin || req.account.isSuperAdmin;
  const resolvedCategory = isAdmin ? category : 'general';
  const catObj = ROOM_CATEGORIES.find(c => c.id === resolvedCategory) || ROOM_CATEGORIES[0];
  const roomId = generateRoomCode();
  const room = {
    id: roomId,
    name: name.trim().slice(0,40),
    description: (description||'').slice(0,120),
    topic: (topic||'').slice(0,60),
    category: catObj.id,
    categoryLabel: catObj.label,
    categoryIcon: catObj.icon,
    isPrivate: !!isPrivate,
    owner: req.username,
    members: [req.username],
    bannedUsers: [],
    messages: [],
    createdAt: Date.now(),
    pinnedMessage: null,
    slowMode: 0,   // seconds between messages
  };
  rooms.set(roomId, room);
  req.account.roomsCreated = (req.account.roomsCreated||0) + 1;
  checkBadges(req.account);
  res.json({ room: sanitizeRoom(room, req.username) });
});

app.get('/api/rooms', (req, res) => {
  const cat = req.query.category;
  let list = Array.from(rooms.values()).filter(r => !r.isPrivate);
  if (cat) list = list.filter(r => r.category === cat);
  res.json(list.map(r => sanitizeRoom(r, '')).sort((a,b) => b.onlineCount - a.onlineCount));
});

app.get('/api/rooms/:id', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.isPrivate && !room.members.includes(req.username)) return res.status(403).json({ error: 'Private room — you need an invite' });
  res.json({ room: sanitizeRoom(room, req.username), messages: room.messages.slice(-100) });
});

app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.bannedUsers?.includes(req.username)) return res.status(403).json({ error: 'You are banned from this room' });
  if (room.isPrivate && !room.members.includes(req.username)) return res.status(403).json({ error: 'Private — need invite' });
  if (!room.members.includes(req.username)) room.members.push(req.username);
  res.json({ room: sanitizeRoom(room, req.username), messages: room.messages.slice(-100) });
});

app.post('/api/rooms/:id/invite', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner can invite' });
  const invitee = accountDB.get(req.body.username?.toLowerCase());
  if (!invitee) return res.status(404).json({ error: 'User not found' });
  if (!room.members.includes(invitee.username)) room.members.push(invitee.username);
  const s = userSockets.get(invitee.username);
  if (s) io.to(s).emit('roomInvite', { room: sanitizeRoom(room, invitee.username), from: req.username, fromDisplay: req.account.displayName });
  res.json({ ok: true });
});

app.patch('/api/rooms/:id', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner or admin' });
  const { name, description, topic, category, slowMode } = req.body;
  if (name) room.name = name.slice(0,40);
  if (description !== undefined) room.description = description.slice(0,120);
  if (topic !== undefined) room.topic = topic.slice(0,60);
  if (category) { const c = ROOM_CATEGORIES.find(x => x.id === category); if (c) { room.category=c.id; room.categoryLabel=c.label; room.categoryIcon=c.icon; } }
  if (slowMode !== undefined) room.slowMode = Math.max(0, parseInt(slowMode)||0);
  io.to(`room_${room.id}`).emit('roomUpdated', sanitizeRoom(room, req.username));
  res.json({ room: sanitizeRoom(room, req.username) });
});

app.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner or admin' });
  logAdmin(req.username, 'DELETE_ROOM', room.id, room.name);
  io.to(`room_${room.id}`).emit('roomDeleted', { roomId: room.id });
  rooms.delete(room.id);
  res.json({ ok: true });
});

// ── REST: ADMIN ──────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = Array.from(accountDB.values()).map(a => ({
    ...sanitizeUser(a),
    gender: a.gender,         // admin can see gender
    isBanned: a.isBanned,
    isMuted: a.isMuted,
    muteUntil: a.muteUntil,
    banReason: a.banReason,
    isAdmin: a.isAdmin,
    isSuperAdmin: a.isSuperAdmin,
    joinedAt: a.joinedAt,
    lastSeen: a.lastSeen,
    isOnline: userSockets.has(a.username),
  })).sort((a,b) => b.joinedAt - a.joinedAt);
  res.json(users);
});

app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  res.json(Array.from(rooms.values()).map(r => ({ ...sanitizeRoom(r,''), owner: r.owner, bannedUsers: r.bannedUsers })));
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json(adminLogs.slice(-200).reverse());
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    totalUsers: accountDB.size,
    onlineUsers: onlineSockets.size,
    totalRooms: rooms.size,
    totalMessages: Array.from(accountDB.values()).reduce((s,a) => s + (a.messages||0), 0),
    bannedUsers: Array.from(accountDB.values()).filter(a => a.isBanned).length,
    verifiedUsers: Array.from(accountDB.values()).filter(a => a.isVerified).length,
    admins: Array.from(accountDB.values()).filter(a => a.isAdmin).length,
  });
});

// Ban / Unban
app.post('/api/admin/users/:username/ban', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.isSuperAdmin) return res.status(403).json({ error: 'Cannot ban super-admin' });
  target.isBanned = true;
  target.banReason = (req.body.reason||'Violation of rules').slice(0,200);
  // Kick from server
  const s = userSockets.get(target.username);
  if (s) { io.to(s).emit('banned', { reason: target.banReason }); io.sockets.sockets.get(s)?.disconnect(); }
  logAdmin(req.username, 'BAN', target.username, target.banReason);
  res.json({ ok: true });
});

app.post('/api/admin/users/:username/unban', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.isBanned = false; target.banReason = '';
  logAdmin(req.username, 'UNBAN', target.username, '');
  res.json({ ok: true });
});

// Mute / Unmute
app.post('/api/admin/users/:username/mute', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  const minutes = parseInt(req.body.minutes)||60;
  target.isMuted = true;
  target.muteUntil = Date.now() + minutes * 60 * 1000;
  const s = userSockets.get(target.username);
  if (s) io.to(s).emit('muted', { until: target.muteUntil, minutes });
  logAdmin(req.username, 'MUTE', target.username, `${minutes} minutes`);
  res.json({ ok: true });
});

app.post('/api/admin/users/:username/unmute', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.isMuted = false; target.muteUntil = null;
  logAdmin(req.username, 'UNMUTE', target.username, '');
  res.json({ ok: true });
});

// Verify / Unverify
app.post('/api/admin/users/:username/verify', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.isVerified = true;
  if (!target.badges) target.badges = [];
  if (!target.badges.includes('verified')) target.badges.push('verified');
  const s = userSockets.get(target.username);
  if (s) io.to(s).emit('verified', { message: 'Your account has been verified by an admin! ✅' });
  logAdmin(req.username, 'VERIFY', target.username, '');
  res.json({ ok: true });
});

app.post('/api/admin/users/:username/unverify', requireAdmin, (req, res) => {
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.isVerified = false;
  target.badges = (target.badges||[]).filter(b => b !== 'verified');
  logAdmin(req.username, 'UNVERIFY', target.username, '');
  res.json({ ok: true });
});

// Make / Remove Admin
app.post('/api/admin/users/:username/make-admin', requireAdmin, (req, res) => {
  if (!req.account.isSuperAdmin) return res.status(403).json({ error: 'Only super-admin can manage admins' });
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  target.isAdmin = true;
  logAdmin(req.username, 'MAKE_ADMIN', target.username, '');
  res.json({ ok: true });
});

app.post('/api/admin/users/:username/remove-admin', requireAdmin, (req, res) => {
  if (!req.account.isSuperAdmin) return res.status(403).json({ error: 'Only super-admin' });
  const target = accountDB.get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.isSuperAdmin) return res.status(403).json({ error: 'Cannot remove super-admin' });
  target.isAdmin = false;
  logAdmin(req.username, 'REMOVE_ADMIN', target.username, '');
  res.json({ ok: true });
});

// Delete room (admin)
app.delete('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  logAdmin(req.username, 'ADMIN_DELETE_ROOM', room.id, room.name);
  io.to(`room_${room.id}`).emit('roomDeleted', { roomId: room.id });
  rooms.delete(room.id);
  res.json({ ok: true });
});

// Ban from room
app.post('/api/admin/rooms/:id/ban/:username', requireAdmin, (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const username = req.params.username.toLowerCase();
  if (!room.bannedUsers) room.bannedUsers = [];
  if (!room.bannedUsers.includes(username)) room.bannedUsers.push(username);
  room.members = room.members.filter(m => m !== username);
  const s = userSockets.get(username);
  if (s) io.to(s).emit('kickedFromRoom', { roomId: room.id, roomName: room.name });
  logAdmin(req.username, 'ROOM_BAN', username, `Room: ${room.id}`);
  res.json({ ok: true });
});

// Broadcast message
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  io.emit('adminBroadcast', { message: message.slice(0,500), from: req.account.displayName, timestamp: Date.now() });
  logAdmin(req.username, 'BROADCAST', 'all', message.slice(0,100));
  res.json({ ok: true });
});

// ── HELPERS ──────────────────────────────────────────────────
function canDM(fromUsername, toAccount) {
  if (toAccount.dmPrivacy === 'all') return true;
  if (toAccount.dmPrivacy === 'friends') return (toAccount.friends||[]).includes(fromUsername);
  return false;
}

function sanitizeUser(a) {
  const { passwordHash, passwordSalt, gender, blockedUsers, ...safe } = a;
  safe.level = getLevelIndex(safe.xp);
  safe.levelName = LEVELS[safe.level].name;
  safe.levelIcon = LEVELS[safe.level].icon;
  return safe;
}

function sanitizeRoom(room, myUsername) {
  const onlineMembers = room.members.filter(m => userSockets.has(m));
  return {
    id: room.id, name: room.name, description: room.description, topic: room.topic,
    category: room.category, categoryLabel: room.categoryLabel, categoryIcon: room.categoryIcon,
    isPrivate: room.isPrivate, owner: room.owner,
    memberCount: room.members.length, onlineCount: onlineMembers.length,
    isOwner: room.owner === myUsername, isMember: room.members.includes(myUsername),
    createdAt: room.createdAt, slowMode: room.slowMode||0,
    pinnedMessage: room.pinnedMessage||null,
  };
}

function getLeaderboard() {
  return Array.from(accountDB.values())
    .filter(a => !a.isBanned)
    .sort((a,b) => b.xp - a.xp).slice(0,20)
    .map((u,i) => ({
      rank: i+1, name: u.displayName, username: u.username,
      emoji: u.emoji, avatar: u.avatar,
      xp: u.xp, messages: u.messages, strangersCount: u.strangersCount,
      level: getLevelIndex(u.xp), badges: (u.badges||[]).slice(0,4),
      isOnline: userSockets.has(u.username),
      isVerified: u.isVerified,
    }));
}

function logAdmin(by, action, target, detail) {
  adminLogs.push({ by, action, target, detail, timestamp: Date.now() });
  if (adminLogs.length > 1000) adminLogs.splice(0, adminLogs.length - 1000);
}

// ── SOCKET.IO ────────────────────────────────────────────────
const roomSlowModeTracker = new Map(); // `${roomId}_${username}` → last message timestamp

io.on('connection', (socket) => {

  socket.on('auth', ({ token }) => {
    const username = sessionDB.get(token);
    if (!username) { socket.emit('authError', { message: 'Invalid session' }); return; }
    const account = accountDB.get(username);
    if (!account) { socket.emit('authError', { message: 'Account not found' }); return; }
    if (account.isBanned) { socket.emit('banned', { reason: account.banReason }); socket.disconnect(); return; }
    account.lastSeen = Date.now();
    onlineSockets.set(socket.id, username);
    userSockets.set(username, socket.id);
    socket.emit('authOk', { user: sanitizeUser(account) });
    io.emit('onlineCount', onlineSockets.size);
    socket.emit('leaderboard', getLeaderboard());
    socket.emit('categories', ROOM_CATEGORIES);
    (account.friends||[]).forEach(f => {
      const fs = userSockets.get(f);
      if (fs) io.to(fs).emit('friendOnline', { username, displayName: account.displayName, emoji: account.emoji, avatar: account.avatar });
    });
    // Unmute if time passed
    if (account.isMuted && account.muteUntil < Date.now()) { account.isMuted = false; account.muteUntil = null; }
  });

  // ── STRANGER ──
  socket.on('findStranger', ({ interests }) => {
    const username = onlineSockets.get(socket.id);
    if (!username) return;
    const account = accountDB.get(username);
    if (account?.isMuted && account.muteUntil > Date.now()) { socket.emit('error', { message: 'You are muted' }); return; }
    if (activePairs.has(socket.id)) disconnectPair(socket.id, 'skip');
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    if (waitingQueue.length > 0) {
      const pid = waitingQueue.shift();
      const pu = onlineSockets.get(pid);
      if (!pu) { waitingQueue.unshift(socket.id); return; }
      const room = `stranger_${crypto.randomBytes(4).toString('hex')}`;
      activePairs.set(socket.id, pid); activePairs.set(pid, socket.id);
      socket.join(room); io.sockets.sockets.get(pid)?.join(room);
      const myAcc = accountDB.get(username); const paAcc = accountDB.get(pu);
      if (myAcc) myAcc.strangersCount++;
      if (paAcc) paAcc.strangersCount++;
      socket.emit('matched', { partner: pubProfile(paAcc, pu), room });
      io.sockets.sockets.get(pid)?.emit('matched', { partner: pubProfile(myAcc, username), room });
    } else {
      waitingQueue.push(socket.id); socket.emit('waiting');
    }
  });

  socket.on('cancelSearch', () => { const qi = waitingQueue.indexOf(socket.id); if (qi !== -1) waitingQueue.splice(qi, 1); socket.emit('searchCancelled'); });
  socket.on('skipPartner', () => disconnectPair(socket.id, 'skip'));

  socket.on('sendMessage', ({ text, image, room }) => {
    if ((!text?.trim() && !image) || !room) return;
    const username = onlineSockets.get(socket.id); if (!username) return;
    const account = accountDB.get(username); if (!account) return;
    if (account.isMuted && account.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
    const msg = {
      id: crypto.randomBytes(4).toString('hex'),
      text: text?.trim().slice(0,1000)||'', image: image||null,
      from: socket.id, senderName: account.displayName, senderUsername: username,
      senderEmoji: account.emoji, senderAvatar: account.avatar,
      senderLevel: getLevelIndex(account.xp), senderVerified: account.isVerified,
      timestamp: Date.now(), type: 'stranger', reactions: {},
    };
    const prevLevel = getLevelIndex(account.xp);
    const xpGain = 5 + Math.min(10, Math.floor((text||'').trim().length/20));
    account.xp += xpGain; account.messages++;
    const newLevel = getLevelIndex(account.xp);
    const newBadgeIds = checkBadges(account);
    io.to(room).emit('newMessage', msg);
    socket.emit('xpUpdate', { xp:account.xp, xpGained:xpGain, level:newLevel, leveledUp:newLevel>prevLevel, newLevelName:newLevel>prevLevel?LEVELS[newLevel].name:null, newLevelIcon:newLevel>prevLevel?LEVELS[newLevel].icon:null, newBadges:newBadgeIds.map(id=>BADGES.find(b=>b.id===id)).filter(Boolean) });
    io.emit('leaderboard', getLeaderboard());
  });

  // ── REACTIONS ──
  socket.on('addReaction', ({ messageId, emoji, room, roomType }) => {
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    const username = onlineSockets.get(socket.id); if (!username) return;
    if (roomType === 'room') {
      const r = rooms.get(room?.toUpperCase()); if (!r) return;
      const msg = r.messages.find(m => m.id === messageId); if (!msg) return;
      if (!msg.reactions) msg.reactions = {};
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      const idx = msg.reactions[emoji].indexOf(username);
      if (idx === -1) msg.reactions[emoji].push(username);
      else msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      io.to(`room_${room}`).emit('reactionUpdate', { messageId, reactions: msg.reactions });
    } else {
      io.to(room).emit('reactionUpdate', { messageId, emoji, username });
    }
  });

  // ── DM ──
  socket.on('sendDM', ({ text, image, toUsername }) => {
    if ((!text?.trim() && !image) || !toUsername) return;
    const fromUsername = onlineSockets.get(socket.id); if (!fromUsername) return;
    const fromAcc = accountDB.get(fromUsername);
    const toAcc = accountDB.get(toUsername.toLowerCase());
    if (!fromAcc || !toAcc) return;
    if (!fromAcc.friends.includes(toAcc.username)) { socket.emit('dmError', { message: 'Only friends can DM' }); return; }
    if (!canDM(fromUsername, toAcc)) { socket.emit('dmError', { message: `${toAcc.displayName} is not accepting DMs` }); return; }
    if (fromAcc.isMuted && fromAcc.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
    const room = getOrCreateDMRoom(fromUsername, toAcc.username);
    const msg = {
      id: crypto.randomBytes(4).toString('hex'),
      text: text?.trim().slice(0,1000)||'', image: image||null,
      from: fromUsername, senderName: fromAcc.displayName,
      senderEmoji: fromAcc.emoji, senderAvatar: fromAcc.avatar,
      senderLevel: getLevelIndex(fromAcc.xp), senderVerified: fromAcc.isVerified,
      toUsername: toAcc.username, timestamp: Date.now(), read: false, type: 'dm', reactions: {},
    };
    room.messages.push(msg);
    room.unread[toAcc.username] = (room.unread[toAcc.username]||0) + 1;
    socket.emit('newDM', { ...msg, roomId: room.id });
    const toSocket = userSockets.get(toAcc.username);
    if (toSocket) io.to(toSocket).emit('newDM', { ...msg, roomId: room.id });
    fromAcc.xp += 2; fromAcc.messages++;
    io.emit('leaderboard', getLeaderboard());
  });

  socket.on('markDMRead', ({ withUsername }) => {
    const myUsername = onlineSockets.get(socket.id); if (!myUsername) return;
    const room = dmRooms.get(getDMRoomId(myUsername, withUsername)); if (!room) return;
    room.unread[myUsername] = 0;
    room.messages.forEach(m => { if (m.from !== myUsername) m.read = true; });
    const os = userSockets.get(withUsername);
    if (os) io.to(os).emit('messagesRead', { by: myUsername });
  });

  // ── ROOM CHAT ──
  socket.on('joinRoom', ({ roomId }) => {
    const username = onlineSockets.get(socket.id);
    const room = rooms.get(roomId?.toUpperCase());
    if (!room || !username) return;
    if (room.bannedUsers?.includes(username)) { socket.emit('roomError', { message: 'You are banned from this room' }); return; }
    if (!room.members.includes(username)) room.members.push(username);
    socket.join(`room_${room.id}`);
    const account = accountDB.get(username);
    io.to(`room_${room.id}`).emit('roomUserJoined', { username, displayName: account?.displayName, roomId: room.id });
    socket.emit('roomJoined', { room: sanitizeRoom(room, username), messages: room.messages.slice(-100) });
  });

  socket.on('leaveRoom', ({ roomId }) => {
    socket.leave(`room_${roomId}`);
    const username = onlineSockets.get(socket.id);
    const room = rooms.get(roomId?.toUpperCase());
    if (room && username) {
      io.to(`room_${room.id}`).emit('roomUserLeft', { username, roomId });
    }
  });

  socket.on('sendRoomMessage', ({ text, image, roomId }) => {
    if ((!text?.trim() && !image) || !roomId) return;
    const username = onlineSockets.get(socket.id);
    const room = rooms.get(roomId?.toUpperCase());
    if (!room || !username) return;
    if (room.bannedUsers?.includes(username)) return;
    if (!room.members.includes(username)) return;
    const account = accountDB.get(username);
    if (account?.isMuted && account.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
    // Slow mode check
    if (room.slowMode > 0) {
      const key = `${room.id}_${username}`;
      const last = roomSlowModeTracker.get(key) || 0;
      if (Date.now() - last < room.slowMode * 1000) {
        socket.emit('slowModeError', { seconds: Math.ceil((room.slowMode*1000 - (Date.now()-last))/1000) });
        return;
      }
      roomSlowModeTracker.set(key, Date.now());
    }
    const msg = {
      id: crypto.randomBytes(4).toString('hex'),
      text: text?.trim().slice(0,1000)||'', image: image||null,
      from: username, senderName: account?.displayName||username,
      senderEmoji: account?.emoji||'🎭', senderAvatar: account?.avatar,
      senderLevel: getLevelIndex(account?.xp||0), senderVerified: account?.isVerified,
      roomId, timestamp: Date.now(), type: 'room', reactions: {},
    };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    io.to(`room_${room.id}`).emit('newRoomMessage', msg);
    if (account) { account.xp += 3; account.messages++; }
    io.emit('leaderboard', getLeaderboard());
  });

  socket.on('pinMessage', ({ roomId, messageId }) => {
    const username = onlineSockets.get(socket.id);
    const room = rooms.get(roomId?.toUpperCase());
    if (!room || room.owner !== username) return;
    const msg = room.messages.find(m => m.id === messageId);
    if (!msg) return;
    room.pinnedMessage = { id: msg.id, text: msg.text, senderName: msg.senderName, timestamp: msg.timestamp };
    io.to(`room_${room.id}`).emit('messagePinned', { pinnedMessage: room.pinnedMessage });
  });

  // ── TYPING ──
  socket.on('typing', ({ room, isTyping }) => {
    const pid = activePairs.get(socket.id);
    if (pid) io.sockets.sockets.get(pid)?.emit('partnerTyping', { isTyping });
  });
  socket.on('dmTyping', ({ toUsername, isTyping }) => {
    const from = onlineSockets.get(socket.id);
    const ts = userSockets.get(toUsername);
    if (ts && from) io.to(ts).emit('dmPartnerTyping', { from, isTyping });
  });
  socket.on('roomTyping', ({ roomId, isTyping }) => {
    const username = onlineSockets.get(socket.id);
    if (username) socket.to(`room_${roomId}`).emit('roomTyping', { username, isTyping });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const username = onlineSockets.get(socket.id);
    disconnectPair(socket.id, 'disconnect');
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    onlineSockets.delete(socket.id);
    if (username) {
      if (userSockets.get(username) === socket.id) userSockets.delete(username);
      const acc = accountDB.get(username);
      if (acc) { acc.lastSeen = Date.now(); (acc.friends||[]).forEach(f => { const fs = userSockets.get(f); if (fs) io.to(fs).emit('friendOffline', { username }); }); }
    }
    io.emit('onlineCount', onlineSockets.size);
  });

  function disconnectPair(socketId, reason) {
    const pid = activePairs.get(socketId); if (!pid) return;
    activePairs.delete(socketId); activePairs.delete(pid);
    io.sockets.sockets.get(pid)?.emit('partnerLeft', { reason: reason==='disconnect'?'Stranger disconnected':'Stranger skipped you' });
  }

  function pubProfile(acc, username) {
    if (!acc) return null;
    return { name: acc.displayName, username, emoji: acc.emoji, avatar: acc.avatar, level: getLevelIndex(acc.xp), xp: acc.xp, bio: acc.bio||'', badges: acc.badges||[], genderVerified: acc.genderVerified, isVerified: acc.isVerified };
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WISHPR running on http://localhost:${PORT}`);
  console.log(`👑 First user to register will become super-admin\n`);
});
