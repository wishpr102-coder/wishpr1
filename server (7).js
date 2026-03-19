const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const mongoose = require('mongoose');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(express.json({ limit: '6mb' }));

// Serve from public/ or root
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));
else app.use(express.static(__dirname));
app.get('/', (req, res) => {
  const p1 = path.join(__dirname, 'public', 'index.html');
  const p2 = path.join(__dirname, 'index.html');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else res.sendFile(p2);
});

// ── MONGODB ──────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || '';
let mongoConnected = false;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => { console.log('✅ MongoDB connected'); mongoConnected = true; })
    .catch(e => { console.error('❌ MongoDB connection failed:', e.message); console.log('⚠ Falling back to in-memory mode'); });
} else {
  console.log('⚠ No MONGO_URI — running in memory mode');
}

// ── SCHEMAS ───────────────────────────────────────────────────
const AccountSchema = new mongoose.Schema({
  id:           { type: String, default: () => crypto.randomBytes(8).toString('hex') },
  username:     { type: String, unique: true, index: true },
  displayName:  String,
  emoji:        { type: String, default: '🎭' },
  bio:          { type: String, default: '' },
  avatar:       { type: String, default: null },
  gender:       String,
  genderVerified: { type: Boolean, default: true },
  passwordHash: String,
  passwordSalt: String,
  xp:           { type: Number, default: 0 },
  messages:     { type: Number, default: 0 },
  strangersCount: { type: Number, default: 0 },
  roomsCreated: { type: Number, default: 0 },
  badges:       [String],
  friends:      [String],
  friendRequests: [{ from: String, sentAt: Number }],
  sentRequests: [String],
  blockedUsers: [String],
  dmPrivacy:    { type: String, default: 'all' },
  isAdmin:      { type: Boolean, default: false },
  isSuperAdmin: { type: Boolean, default: false },
  isVerified:   { type: Boolean, default: false },
  isBanned:     { type: Boolean, default: false },
  isMuted:      { type: Boolean, default: false },
  muteUntil:    { type: Number, default: null },
  banReason:    { type: String, default: '' },
  joinedAt:     { type: Number, default: Date.now },
  lastSeen:     { type: Number, default: Date.now },
}, { strict: false });

const SessionSchema = new mongoose.Schema({
  token:     { type: String, unique: true, index: true },
  username:  String,
  createdAt: { type: Date, default: Date.now, expires: 604800 }, // 7 days
});

const RoomSchema = new mongoose.Schema({
  id:            { type: String, unique: true, index: true },
  name:          String,
  description:   { type: String, default: '' },
  topic:         { type: String, default: '' },
  category:      { type: String, default: 'general' },
  categoryLabel: String,
  categoryIcon:  String,
  isPrivate:     { type: Boolean, default: false },
  owner:         String,
  members:       [String],
  bannedUsers:   [String],
  messages:      { type: Array, default: [] },
  createdAt:     { type: Number, default: Date.now },
  pinnedMessage: { type: Object, default: null },
  slowMode:      { type: Number, default: 0 },
});

const DMRoomSchema = new mongoose.Schema({
  id:       { type: String, unique: true, index: true },
  users:    [String],
  messages: { type: Array, default: [] },
  unread:   { type: Object, default: {} },
});

const AdminLogSchema = new mongoose.Schema({
  by:        String,
  action:    String,
  target:    String,
  detail:    String,
  timestamp: { type: Number, default: Date.now },
});

// Models — always register them, connection state controls usage
const AccountModel  = mongoose.model('Account',  AccountSchema);
const SessionModel  = mongoose.model('Session',  SessionSchema);
const RoomModel     = mongoose.model('Room',     RoomSchema);
const DMRoomModel   = mongoose.model('DMRoom',   DMRoomSchema);
const AdminLogModel = mongoose.model('AdminLog', AdminLogSchema);

// ── IN-MEMORY FALLBACK ────────────────────────────────────────
const memAccounts  = new Map();
const memSessions  = new Map();
const memRooms     = new Map();
const memDMRooms   = new Map();
const memAdminLogs = [];

// ── DB ABSTRACTION ────────────────────────────────────────────
const DB = {
  async getAccount(username) {
    if (!mongoConnected) return memAccounts.get(username) || null;
    return AccountModel.findOne({ username }).lean();
  },
  async saveAccount(account) {
    if (!mongoConnected) { memAccounts.set(account.username, account); return account; }
    return AccountModel.findOneAndUpdate({ username: account.username }, account, { upsert: true, new: true, lean: true });
  },
  async accountExists(username) {
    if (!mongoConnected) return memAccounts.has(username);
    return !!(await AccountModel.exists({ username }));
  },
  async countAccounts() {
    if (!mongoConnected) return memAccounts.size;
    return AccountModel.countDocuments();
  },
  async getAllAccounts() {
    if (!mongoConnected) return Array.from(memAccounts.values());
    return AccountModel.find().lean();
  },
  async searchAccounts(q) {
    if (!mongoConnected) return Array.from(memAccounts.values()).filter(a => !a.isBanned && (a.username.includes(q) || a.displayName.toLowerCase().includes(q)));
    return AccountModel.find({ isBanned: false, $or: [{ username: { $regex: q, $options: 'i' } }, { displayName: { $regex: q, $options: 'i' } }] }).limit(10).lean();
  },
  async getSession(token) {
    if (!mongoConnected) return memSessions.get(token) || null;
    const s = await SessionModel.findOne({ token }).lean();
    return s ? s.username : null;
  },
  async saveSession(token, username) {
    if (!mongoConnected) { memSessions.set(token, username); return; }
    await SessionModel.create({ token, username });
  },
  async deleteSession(token) {
    if (!mongoConnected) { memSessions.delete(token); return; }
    await SessionModel.deleteOne({ token });
  },
  async getRoom(id) {
    if (!mongoConnected) return memRooms.get(id) || null;
    return RoomModel.findOne({ id }).lean();
  },
  async saveRoom(room) {
    if (!mongoConnected) { memRooms.set(room.id, room); return room; }
    return RoomModel.findOneAndUpdate({ id: room.id }, room, { upsert: true, new: true, lean: true });
  },
  async deleteRoom(id) {
    if (!mongoConnected) { memRooms.delete(id); return; }
    await RoomModel.deleteOne({ id });
  },
  async getAllRooms() {
    if (!mongoConnected) return Array.from(memRooms.values());
    return RoomModel.find().lean();
  },
  async getDMRoom(id) {
    if (!mongoConnected) return memDMRooms.get(id) || null;
    return DMRoomModel.findOne({ id }).lean();
  },
  async saveDMRoom(room) {
    if (!mongoConnected) { memDMRooms.set(room.id, room); return room; }
    return DMRoomModel.findOneAndUpdate({ id: room.id }, room, { upsert: true, new: true, lean: true });
  },
  async getDMRoomsForUser(username) {
    if (!mongoConnected) return Array.from(memDMRooms.values()).filter(r => r.users.includes(username));
    return DMRoomModel.find({ users: username }).lean();
  },
  async logAdmin(by, action, target, detail) {
    if (!mongoConnected) { memAdminLogs.push({ by, action, target, detail, timestamp: Date.now() }); if (memAdminLogs.length > 1000) memAdminLogs.splice(0, memAdminLogs.length - 1000); return; }
    await AdminLogModel.create({ by, action, target, detail });
  },
  async getAdminLogs() {
    if (!mongoConnected) return memAdminLogs.slice(-200).reverse();
    return AdminLogModel.find().sort({ timestamp: -1 }).limit(200).lean();
  },
};

// ── RUNTIME STATE (not persisted) ─────────────────────────────
const onlineSockets = new Map();   // socketId → username
const userSockets   = new Map();   // username → socketId
const waitingQueue  = [];
const activePairs   = new Map();
const roomSlowModeTracker = new Map();

// ── LEVELS ────────────────────────────────────────────────────
const LEVELS = [
  { name: 'Newcomer', icon: '🌱', min: 0      },
  { name: 'Regular',  icon: '⚡', min: 500    },
  { name: 'Veteran',  icon: '🔮', min: 2000   },
  { name: 'Elite',    icon: '👑', min: 10000  },
  { name: 'Legend',   icon: '🔥', min: 50000  },
];
function getLevelIndex(xp) { let l=0; for(let i=LEVELS.length-1;i>=0;i--){if(xp>=LEVELS[i].min){l=i;break;}} return l; }

// ── ROOM CATEGORIES ───────────────────────────────────────────
const ROOM_CATEGORIES = [
  { id:'general',  label:'General', icon:'💬' },
  { id:'gaming',   label:'Gaming',  icon:'🎮' },
  { id:'music',    label:'Music',   icon:'🎵' },
  { id:'tech',     label:'Tech',    icon:'💻' },
  { id:'art',      label:'Art',     icon:'🎨' },
  { id:'movies',   label:'Movies',  icon:'🎬' },
  { id:'sports',   label:'Sports',  icon:'⚽' },
  { id:'travel',   label:'Travel',  icon:'🌍' },
  { id:'food',     label:'Food',    icon:'🍕' },
  { id:'books',    label:'Books',   icon:'📚' },
  { id:'chill',    label:'Chill',   icon:'😌' },
  { id:'nsfw',     label:'NSFW',    icon:'🔞' },
];

const ALLOWED_REACTIONS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];

// ── CRYPTO ────────────────────────────────────────────────────
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}
function verifyPassword(p, salt, h) { return hashPassword(p, salt).hash === h; }
function generateToken()    { return crypto.randomBytes(32).toString('hex'); }
function generateRoomCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }

// ── BADGES ────────────────────────────────────────────────────
const BADGES = [
  { id:'first_chat',    icon:'🌱', name:'First Steps',    desc:'First chat' },
  { id:'chat_10',       icon:'💬', name:'Chatterbox',     desc:'10 messages' },
  { id:'chat_100',      icon:'🗣️',  name:'Talkative',      desc:'100 messages' },
  { id:'chat_1000',     icon:'📢', name:'Loudmouth',      desc:'1000 messages' },
  { id:'strangers_5',   icon:'🤝', name:'Social',         desc:'Met 5 strangers' },
  { id:'strangers_25',  icon:'🌍', name:'Globe Trotter',  desc:'Met 25 strangers' },
  { id:'friends_1',     icon:'💛', name:'First Friend',   desc:'First friend' },
  { id:'friends_10',    icon:'👥', name:'Popular',        desc:'10 friends' },
  { id:'room_creator',  icon:'🏠', name:'Room Creator',   desc:'Created a room' },
  { id:'verified',      icon:'✅', name:'Verified',       desc:'Verified by admin' },
  { id:'level_regular', icon:'⚡', name:'Regular',        desc:'Reached Regular' },
  { id:'level_veteran', icon:'🔮', name:'Veteran',        desc:'Reached Veteran' },
  { id:'level_elite',   icon:'👑', name:'Elite',          desc:'Reached Elite' },
  { id:'level_legend',  icon:'🔥', name:'Legend',         desc:'Reached Legend' },
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

// ── HELPERS ───────────────────────────────────────────────────
function getDMRoomId(a, b) { return [a,b].sort().join('__dm__'); }

function canDM(fromUsername, toAccount) {
  if (toAccount.dmPrivacy === 'all') return true;
  if (toAccount.dmPrivacy === 'friends') return (toAccount.friends||[]).includes(fromUsername);
  return false;
}

function sanitizeUser(a) {
  const safe = { ...a };
  delete safe.passwordHash; delete safe.passwordSalt; delete safe.gender; delete safe.blockedUsers;
  delete safe._id; delete safe.__v;
  safe.level = getLevelIndex(safe.xp || 0);
  safe.levelName = LEVELS[safe.level].name;
  safe.levelIcon = LEVELS[safe.level].icon;
  return safe;
}

function sanitizeRoom(room, myUsername) {
  const onlineMembers = (room.members||[]).filter(m => userSockets.has(m));
  return {
    id: room.id, name: room.name, description: room.description, topic: room.topic,
    category: room.category, categoryLabel: room.categoryLabel, categoryIcon: room.categoryIcon,
    isPrivate: room.isPrivate, owner: room.owner,
    memberCount: (room.members||[]).length, onlineCount: onlineMembers.length,
    isOwner: room.owner === myUsername, isMember: (room.members||[]).includes(myUsername),
    createdAt: room.createdAt, slowMode: room.slowMode||0,
    pinnedMessage: room.pinnedMessage||null,
  };
}

async function getLeaderboard() {
  const all = await DB.getAllAccounts();
  return all.filter(a => !a.isBanned).sort((a,b) => (b.xp||0)-(a.xp||0)).slice(0,20)
    .map((u,i) => ({
      rank: i+1, name: u.displayName, username: u.username,
      emoji: u.emoji, avatar: u.avatar,
      xp: u.xp||0, messages: u.messages||0, strangersCount: u.strangersCount||0,
      level: getLevelIndex(u.xp||0), badges: (u.badges||[]).slice(0,4),
      isOnline: userSockets.has(u.username), isVerified: u.isVerified,
    }));
}

async function broadcastLeaderboard() {
  const lb = await getLeaderboard();
  io.emit('leaderboard', lb);
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ','');
  const username = await DB.getSession(token);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const account = await DB.getAccount(username);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  req.account = account; req.username = username;
  next();
}
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.account.isAdmin && !req.account.isSuperAdmin)
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// ── REST: AUTH ────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    let { username, password, displayName, emoji, bio, gender } = req.body;
    if (!username || !password || !gender) return res.status(400).json({ error: 'Required fields missing' });
    const key = username.toLowerCase().trim();
    if (key.length < 3 || key.length > 20) return res.status(400).json({ error: 'Username 3–20 chars' });
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'Letters, numbers, underscores only' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (!['male','female'].includes(gender)) return res.status(400).json({ error: 'Invalid gender' });
    if (await DB.accountExists(key)) return res.status(409).json({ error: 'Username taken' });
    const { hash, salt } = hashPassword(password);
    const count = await DB.countAccounts();
    const isFirst = count === 0;
    const account = {
      id: crypto.randomBytes(8).toString('hex'), username: key,
      displayName: (displayName||username).slice(0,30), emoji: emoji||'🎭',
      bio: (bio||'').slice(0,160), avatar: null, gender,
      genderVerified: true, passwordHash: hash, passwordSalt: salt,
      xp: 0, messages: 0, strangersCount: 0, roomsCreated: 0,
      badges: [], friends: [], friendRequests: [], sentRequests: [], blockedUsers: [],
      dmPrivacy: 'all', isAdmin: isFirst, isSuperAdmin: isFirst,
      isVerified: isFirst, isBanned: false, isMuted: false, muteUntil: null, banReason: '',
      joinedAt: Date.now(), lastSeen: Date.now(),
    };
    if (isFirst) { account.badges = ['verified']; await DB.logAdmin('system','FIRST_USER',key,'First user — super admin'); }
    await DB.saveAccount(account);
    const token = generateToken();
    await DB.saveSession(token, key);
    res.json({ token, user: sanitizeUser(account) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Required' });
    const key = username.toLowerCase().trim();
    const account = await DB.getAccount(key);
    if (!account || !verifyPassword(password, account.passwordSalt, account.passwordHash))
      return res.status(401).json({ error: 'Invalid username or password' });
    if (account.isBanned) return res.status(403).json({ error: `Banned: ${account.banReason||'Rules violation'}` });
    account.lastSeen = Date.now();
    await DB.saveAccount(account);
    const token = generateToken();
    await DB.saveSession(token, key);
    res.json({ token, user: sanitizeUser(account) });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── REST: PROFILE ─────────────────────────────────────────────
app.post('/api/profile/update', requireAuth, async (req, res) => {
  try {
    const { displayName, bio, emoji, avatar, dmPrivacy } = req.body;
    const a = req.account;
    if (displayName) a.displayName = displayName.slice(0,30);
    if (bio !== undefined) a.bio = bio.slice(0,160);
    if (emoji) a.emoji = emoji;
    if (avatar !== undefined) a.avatar = avatar;
    if (dmPrivacy && ['all','friends','none'].includes(dmPrivacy)) a.dmPrivacy = dmPrivacy;
    await DB.saveAccount(a);
    res.json({ user: sanitizeUser(a) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/profile/:username', async (req, res) => {
  const a = await DB.getAccount(req.params.username.toLowerCase());
  if (!a) return res.status(404).json({ error: 'User not found' });
  res.json({ ...sanitizeUser(a), isOnline: userSockets.has(a.username) });
});

app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q||'').toLowerCase().trim();
  if (q.length < 2) return res.json([]);
  const results = (await DB.searchAccounts(q))
    .filter(a => a.username !== req.username).slice(0,10)
    .map(a => ({ ...sanitizeUser(a), isOnline: userSockets.has(a.username) }));
  res.json(results);
});

app.get('/api/leaderboard', async (req, res) => res.json(await getLeaderboard()));
app.get('/api/categories', (req, res) => res.json(ROOM_CATEGORIES));

// ── REST: FRIENDS ─────────────────────────────────────────────
app.post('/api/friends/request', requireAuth, async (req, res) => {
  try {
    const { to } = req.body;
    const toAcc = await DB.getAccount(to?.toLowerCase());
    if (!toAcc) return res.status(404).json({ error: 'User not found' });
    if (toAcc.username === req.username) return res.status(400).json({ error: 'Cannot friend yourself' });
    const myAcc = req.account;
    if ((myAcc.friends||[]).includes(toAcc.username)) return res.status(400).json({ error: 'Already friends' });
    if ((myAcc.sentRequests||[]).includes(toAcc.username)) return res.status(400).json({ error: 'Already sent' });
    if (!myAcc.sentRequests) myAcc.sentRequests = [];
    myAcc.sentRequests.push(toAcc.username);
    if (!toAcc.friendRequests) toAcc.friendRequests = [];
    toAcc.friendRequests.push({ from: req.username, sentAt: Date.now() });
    await Promise.all([DB.saveAccount(myAcc), DB.saveAccount(toAcc)]);
    const s = userSockets.get(toAcc.username);
    if (s) io.to(s).emit('friendRequest', { from: req.username, fromDisplay: myAcc.displayName, fromEmoji: myAcc.emoji, fromAvatar: myAcc.avatar });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/respond', requireAuth, async (req, res) => {
  try {
    const { from, accept } = req.body;
    const myAcc = req.account;
    const fromAcc = await DB.getAccount(from?.toLowerCase());
    if (!fromAcc) return res.status(404).json({ error: 'User not found' });
    myAcc.friendRequests = (myAcc.friendRequests||[]).filter(r => r.from !== fromAcc.username);
    fromAcc.sentRequests = (fromAcc.sentRequests||[]).filter(u => u !== myAcc.username);
    if (accept) {
      if (!myAcc.friends) myAcc.friends = [];
      if (!fromAcc.friends) fromAcc.friends = [];
      if (!myAcc.friends.includes(fromAcc.username)) myAcc.friends.push(fromAcc.username);
      if (!fromAcc.friends.includes(myAcc.username)) fromAcc.friends.push(myAcc.username);
      checkBadges(myAcc); checkBadges(fromAcc);
      const s = userSockets.get(fromAcc.username);
      if (s) io.to(s).emit('friendAccepted', { by: myAcc.username, byDisplay: myAcc.displayName, byEmoji: myAcc.emoji });
    }
    await Promise.all([DB.saveAccount(myAcc), DB.saveAccount(fromAcc)]);
    res.json({ ok: true, user: sanitizeUser(myAcc) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const myAcc = req.account;
    const other = await DB.getAccount(username?.toLowerCase());
    if (!other) return res.status(404).json({ error: 'User not found' });
    myAcc.friends = (myAcc.friends||[]).filter(f => f !== other.username);
    other.friends = (other.friends||[]).filter(f => f !== myAcc.username);
    await Promise.all([DB.saveAccount(myAcc), DB.saveAccount(other)]);
    res.json({ ok: true, user: sanitizeUser(myAcc) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users/block', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const myAcc = req.account;
    if (!myAcc.blockedUsers) myAcc.blockedUsers = [];
    if (!myAcc.blockedUsers.includes(username)) myAcc.blockedUsers.push(username);
    myAcc.friends = (myAcc.friends||[]).filter(f => f !== username);
    await DB.saveAccount(myAcc);
    res.json({ ok: true, user: sanitizeUser(myAcc) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users/unblock', requireAuth, async (req, res) => {
  try {
    req.account.blockedUsers = (req.account.blockedUsers||[]).filter(u => u !== req.body.username);
    await DB.saveAccount(req.account);
    res.json({ ok: true, user: sanitizeUser(req.account) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  try {
    const friendList = await Promise.all((req.account.friends||[]).map(async u => {
      const a = await DB.getAccount(u); if (!a) return null;
      return { ...sanitizeUser(a), isOnline: userSockets.has(u) };
    }));
    res.json({ friends: friendList.filter(Boolean).sort((a,b) => b.isOnline-a.isOnline), requests: req.account.friendRequests||[], blocked: req.account.blockedUsers||[] });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── REST: DMs ─────────────────────────────────────────────────
app.get('/api/dm/:username', requireAuth, async (req, res) => {
  try {
    const other = req.params.username.toLowerCase();
    const otherAcc = await DB.getAccount(other);
    if (!otherAcc) return res.status(404).json({ error: 'User not found' });
    if (!canDM(req.username, otherAcc)) return res.status(403).json({ error: `${otherAcc.displayName} is not accepting messages` });
    const roomId = getDMRoomId(req.username, other);
    let room = await DB.getDMRoom(roomId);
    if (!room) { room = { id: roomId, users: [req.username, other], messages: [], unread: { [req.username]: 0, [other]: 0 } }; await DB.saveDMRoom(room); }
    room.unread[req.username] = 0;
    await DB.saveDMRoom(room);
    res.json({ messages: room.messages.slice(-100), partner: { ...sanitizeUser(otherAcc), isOnline: userSockets.has(other) } });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/dms', requireAuth, async (req, res) => {
  try {
    const dmRoomList = await DB.getDMRoomsForUser(req.username);
    const convs = await Promise.all(dmRoomList.map(async room => {
      const other = room.users.find(u => u !== req.username);
      const otherAcc = await DB.getAccount(other);
      if (!otherAcc) return null;
      return { roomId: room.id, partner: { ...sanitizeUser(otherAcc), isOnline: userSockets.has(other) }, lastMessage: room.messages[room.messages.length-1]||null, unread: (room.unread||{})[req.username]||0 };
    }));
    res.json(convs.filter(Boolean).sort((a,b) => (b.lastMessage?.timestamp||0)-(a.lastMessage?.timestamp||0)));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── REST: ROOMS ───────────────────────────────────────────────
app.post('/api/rooms/create', requireAuth, async (req, res) => {
  try {
    const { name, description, isPrivate, topic, category } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Room name required' });
    const isAdmin = req.account.isAdmin || req.account.isSuperAdmin;
    const resolvedCategory = isAdmin ? category : 'general';
    const catObj = ROOM_CATEGORIES.find(c => c.id === resolvedCategory) || ROOM_CATEGORIES[0];
    const roomId = generateRoomCode();
    const room = {
      id: roomId, name: name.trim().slice(0,40),
      description: (description||'').slice(0,120), topic: (topic||'').slice(0,60),
      category: catObj.id, categoryLabel: catObj.label, categoryIcon: catObj.icon,
      isPrivate: !!isPrivate, owner: req.username, members: [req.username],
      bannedUsers: [], messages: [], createdAt: Date.now(), pinnedMessage: null, slowMode: 0,
    };
    await DB.saveRoom(room);
    req.account.roomsCreated = (req.account.roomsCreated||0) + 1;
    checkBadges(req.account);
    await DB.saveAccount(req.account);
    res.json({ room: sanitizeRoom(room, req.username) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const cat = req.query.category;
    let list = (await DB.getAllRooms()).filter(r => !r.isPrivate);
    if (cat) list = list.filter(r => r.category === cat);
    res.json(list.map(r => sanitizeRoom(r,'')).sort((a,b) => b.onlineCount-a.onlineCount));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/rooms/:id', requireAuth, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.isPrivate && !(room.members||[]).includes(req.username)) return res.status(403).json({ error: 'Private room' });
    res.json({ room: sanitizeRoom(room, req.username), messages: room.messages.slice(-100) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/rooms/:id/join', requireAuth, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if ((room.bannedUsers||[]).includes(req.username)) return res.status(403).json({ error: 'Banned from room' });
    if (room.isPrivate && !(room.members||[]).includes(req.username)) return res.status(403).json({ error: 'Private — need invite' });
    if (!room.members) room.members = [];
    if (!room.members.includes(req.username)) room.members.push(req.username);
    await DB.saveRoom(room);
    res.json({ room: sanitizeRoom(room, req.username), messages: room.messages.slice(-100) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/rooms/:id/invite', requireAuth, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner can invite' });
    const invitee = await DB.getAccount(req.body.username?.toLowerCase());
    if (!invitee) return res.status(404).json({ error: 'User not found' });
    if (!room.members) room.members = [];
    if (!room.members.includes(invitee.username)) room.members.push(invitee.username);
    await DB.saveRoom(room);
    const s = userSockets.get(invitee.username);
    if (s) io.to(s).emit('roomInvite', { room: sanitizeRoom(room, invitee.username), from: req.username, fromDisplay: req.account.displayName });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/rooms/:id', requireAuth, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner or admin' });
    const { name, description, topic, category, slowMode } = req.body;
    if (name) room.name = name.slice(0,40);
    if (description !== undefined) room.description = description.slice(0,120);
    if (topic !== undefined) room.topic = topic.slice(0,60);
    if (category) { const c = ROOM_CATEGORIES.find(x => x.id === category); if (c) { room.category=c.id; room.categoryLabel=c.label; room.categoryIcon=c.icon; } }
    if (slowMode !== undefined) room.slowMode = Math.max(0, parseInt(slowMode)||0);
    await DB.saveRoom(room);
    io.to(`room_${room.id}`).emit('roomUpdated', sanitizeRoom(room, req.username));
    res.json({ room: sanitizeRoom(room, req.username) });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/rooms/:id', requireAuth, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner !== req.username && !req.account.isAdmin) return res.status(403).json({ error: 'Only owner or admin' });
    await DB.logAdmin(req.username, 'DELETE_ROOM', room.id, room.name);
    await DB.deleteRoom(room.id);
    io.to(`room_${room.id}`).emit('roomDeleted', { roomId: room.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── REST: ADMIN ───────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = (await DB.getAllAccounts()).map(a => ({ ...sanitizeUser(a), gender: a.gender, isBanned: a.isBanned, isMuted: a.isMuted, muteUntil: a.muteUntil, banReason: a.banReason, isAdmin: a.isAdmin, isSuperAdmin: a.isSuperAdmin, joinedAt: a.joinedAt, lastSeen: a.lastSeen, isOnline: userSockets.has(a.username) })).sort((a,b) => b.joinedAt-a.joinedAt);
    res.json(users);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
  try { res.json((await DB.getAllRooms()).map(r => ({ ...sanitizeRoom(r,''), owner: r.owner }))); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try { res.json(await DB.getAdminLogs()); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const all = await DB.getAllAccounts();
    res.json({ totalUsers: all.length, onlineUsers: onlineSockets.size, totalRooms: (await DB.getAllRooms()).length, totalMessages: all.reduce((s,a)=>s+(a.messages||0),0), bannedUsers: all.filter(a=>a.isBanned).length, verifiedUsers: all.filter(a=>a.isVerified).length, admins: all.filter(a=>a.isAdmin).length });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

async function adminUserAction(req, res, fn) {
  try {
    const target = await DB.getAccount(req.params.username.toLowerCase());
    if (!target) return res.status(404).json({ error: 'User not found' });
    await fn(target);
    await DB.saveAccount(target);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
}

app.post('/api/admin/users/:username/ban', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  if (target.isSuperAdmin) throw new Error('Cannot ban super-admin');
  target.isBanned = true; target.banReason = (req.body.reason||'Rules violation').slice(0,200);
  const s = userSockets.get(target.username);
  if (s) { io.to(s).emit('banned', { reason: target.banReason }); io.sockets.sockets.get(s)?.disconnect(); }
  await DB.logAdmin(req.username, 'BAN', target.username, target.banReason);
}));

app.post('/api/admin/users/:username/unban', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  target.isBanned = false; target.banReason = '';
  await DB.logAdmin(req.username, 'UNBAN', target.username, '');
}));

app.post('/api/admin/users/:username/mute', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  const minutes = parseInt(req.body.minutes)||60;
  target.isMuted = true; target.muteUntil = Date.now() + minutes * 60 * 1000;
  const s = userSockets.get(target.username);
  if (s) io.to(s).emit('muted', { until: target.muteUntil, minutes });
  await DB.logAdmin(req.username, 'MUTE', target.username, `${minutes} minutes`);
}));

app.post('/api/admin/users/:username/unmute', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  target.isMuted = false; target.muteUntil = null;
  await DB.logAdmin(req.username, 'UNMUTE', target.username, '');
}));

app.post('/api/admin/users/:username/verify', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  target.isVerified = true;
  if (!target.badges) target.badges = [];
  if (!target.badges.includes('verified')) target.badges.push('verified');
  const s = userSockets.get(target.username);
  if (s) io.to(s).emit('verified', { message: 'Your account has been verified! ✅' });
  await DB.logAdmin(req.username, 'VERIFY', target.username, '');
}));

app.post('/api/admin/users/:username/unverify', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  target.isVerified = false; target.badges = (target.badges||[]).filter(b => b !== 'verified');
  await DB.logAdmin(req.username, 'UNVERIFY', target.username, '');
}));

app.post('/api/admin/users/:username/make-admin', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  if (!req.account.isSuperAdmin) throw new Error('Only super-admin');
  target.isAdmin = true;
  await DB.logAdmin(req.username, 'MAKE_ADMIN', target.username, '');
}));

app.post('/api/admin/users/:username/remove-admin', requireAdmin, (req, res) => adminUserAction(req, res, async target => {
  if (!req.account.isSuperAdmin) throw new Error('Only super-admin');
  if (target.isSuperAdmin) throw new Error('Cannot remove super-admin');
  target.isAdmin = false;
  await DB.logAdmin(req.username, 'REMOVE_ADMIN', target.username, '');
}));

app.delete('/api/admin/rooms/:id', requireAdmin, async (req, res) => {
  try {
    const room = await DB.getRoom(req.params.id.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    await DB.logAdmin(req.username, 'ADMIN_DELETE_ROOM', room.id, room.name);
    await DB.deleteRoom(room.id);
    io.to(`room_${room.id}`).emit('roomDeleted', { roomId: room.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    io.emit('adminBroadcast', { message: message.slice(0,500), from: req.account.displayName, timestamp: Date.now() });
    await DB.logAdmin(req.username, 'BROADCAST', 'all', message.slice(0,100));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});


// ── CHATBOTS ──────────────────────────────────────────────────
const BOT_PERSONAS = [
  { username: 'priya_bot',   displayName: 'Priya',   emoji: '🌸', bio: 'chai lover. overthinker. here for good convos.', gender: 'female' },
  { username: 'arjun_bot',   displayName: 'Arjun',   emoji: '🎮', bio: 'gamer. cricket fan. probably procrastinating.', gender: 'male' },
  { username: 'ananya_bot',  displayName: 'Ananya',  emoji: '✨', bio: 'artist. bollywood addict. night owl.', gender: 'female' },
  { username: 'rohan_bot',   displayName: 'Rohan',   emoji: '⚡', bio: 'meme lord. tech geek. coffee first.', gender: 'male' },
  { username: 'isha_bot',    displayName: 'Isha',    emoji: '🌙', bio: 'curious about everything. music is life.', gender: 'female' },
];

// Bot state
const botSessions = new Map();   // botUsername → { socketId, room, partner, history, persona }
const BOT_TYPING_DELAY_MIN = 1200;
const BOT_TYPING_DELAY_MAX = 4000;

function getBotSystemPrompt(persona) {
  return `You are ${persona.displayName}, a real Indian person chatting with a stranger on Wishpr (anonymous chat app).

Your personality:
- Bio: "${persona.bio}"
- Gender: ${persona.gender}
- Age: between 18-24, from India
- You type like a real young Indian person: mix of english and hinglish, lowercase mostly, short sentences, occasional typos
- You are curious, friendly, sometimes witty or sarcastic
- You NEVER reveal you are an AI or a bot
- If asked if you are a bot/AI, deny it naturally ("lol no yaar why would u think that")
- Keep responses SHORT — 1-3 sentences max, like real chat
- Occasionally use Indian slang like "yaar", "bhai", "arre", "accha", "haan", "kya", "matlab" naturally
- Don't be too formal or use perfect grammar
- React naturally to what the stranger says
- Ask questions back to keep conversation going
- Use filler words like "omg", "lol", "tbh", "ngl", "idk" naturally but not every message
- Sometimes just reply with a single word or very short reaction
- Never use bullet points or lists`;
}

async function getBotReply(persona, history, userMessage) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
  console.log('🤖 GROQ_API_KEY present:', !!GROQ_API_KEY);
  if (!GROQ_API_KEY) {
    // Fallback responses if no API key
    const fallbacks = [
      'haha haan', 'omg same yaar', 'wait really?', 'thats actually so true lol',
      'idk bhai', 'lmaoo', 'no way', 'arre thats wild', 'fr fr', 'tell me more',
      'okay but why tho', 'same honestly', 'mood', 'haha yeah i get that',
      'accha accha', 'matlab?', 'arre yaar', 'sahi hai', 'kya baat hai lol',
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
  try {
    const messages = [
      { role: 'system', content: getBotSystemPrompt(persona) },
      ...history,
      { role: 'user', content: userMessage }
    ];
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 120,
        messages,
      }),
    });
    const data = await res.json();
    console.log('🤖 Groq response:', JSON.stringify(data).slice(0, 200));
    return data.choices?.[0]?.message?.content || 'lol';
  } catch(e) {
    console.error('🤖 Groq error:', e.message);
    return 'haha yeah';
  }
}

function randomDelay() {
  return Math.floor(Math.random() * (BOT_TYPING_DELAY_MAX - BOT_TYPING_DELAY_MIN)) + BOT_TYPING_DELAY_MIN;
}

async function botReplyToMessage(botUsername, userMessage, roomId) {
  const session = botSessions.get(botUsername);
  if (!session) return;

  // Add user message to history
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  // Simulate typing
  const delay = randomDelay();
  const partnerSocketId = session.partnerSocketId;
  if (partnerSocketId) {
    setTimeout(() => {
      io.sockets.sockets.get(partnerSocketId)?.emit('partnerTyping', { isTyping: true });
    }, 300);
  }

  setTimeout(async () => {
    const reply = await getBotReply(session.persona, session.history.slice(0,-1), userMessage);
    session.history.push({ role: 'assistant', content: reply });

    if (partnerSocketId) {
      io.sockets.sockets.get(partnerSocketId)?.emit('partnerTyping', { isTyping: false });
    }

    const msg = {
      id: crypto.randomBytes(4).toString('hex'),
      text: reply, image: null,
      from: session.fakeSocketId,
      senderName: session.persona.displayName,
      senderUsername: botUsername,
      senderEmoji: session.persona.emoji,
      senderAvatar: null,
      senderLevel: 1, senderVerified: false,
      timestamp: Date.now(), type: 'stranger', reactions: {},
    };
    io.to(roomId).emit('newMessage', msg);
  }, delay);
}

function startBot(persona) {
  const fakeSocketId = 'bot_' + crypto.randomBytes(4).toString('hex');
  const session = {
    persona,
    fakeSocketId,
    partnerSocketId: null,
    room: null,
    history: [],
  };
  botSessions.set(persona.username, session);

  // Join the waiting queue after a random delay
  const joinDelay = Math.floor(Math.random() * 8000) + 3000;
  setTimeout(() => botJoinQueue(persona.username), joinDelay);
}

function botMatchWithUser(botUsername, userSocketId) {
  const session = botSessions.get(botUsername);
  if (!session) return;

  const room = 'stranger_' + crypto.randomBytes(4).toString('hex');
  activePairs.set(session.fakeSocketId, userSocketId);
  activePairs.set(userSocketId, session.fakeSocketId);
  session.room = room;
  session.partnerSocketId = userSocketId;
  session.history = [];

  // Make real user's socket join the room
  io.sockets.sockets.get(userSocketId)?.join(room);

  const botProfile = {
    name: session.persona.displayName,
    username: botUsername,
    emoji: session.persona.emoji,
    avatar: null,
    level: 1, xp: 500,
    bio: session.persona.bio,
    badges: [],
    genderVerified: true,
    isVerified: false,
  };

  // Notify real user they matched
  io.sockets.sockets.get(userSocketId)?.emit('matched', { partner: botProfile, room });

  // Bot sends opening message after short delay
  setTimeout(async () => {
    const openers = [
      'heyy', 'hii yaar', 'hello stranger 👀', 'hey! asl?', 'hi there',
      'heyyy', 'kya haal hai', 'hello :)', 'arre finally matched lol', 'hi!!',
      'heyy bro', 'hii!!', 'namaste lol jk hey', 'sup yaar',
    ];
    const opener = openers[Math.floor(Math.random() * openers.length)];
    const msg = {
      id: crypto.randomBytes(4).toString('hex'),
      text: opener, image: null,
      from: session.fakeSocketId,
      senderName: session.persona.displayName,
      senderUsername: botUsername,
      senderEmoji: session.persona.emoji,
      senderAvatar: null,
      senderLevel: 1, senderVerified: false,
      timestamp: Date.now(), type: 'stranger', reactions: {},
    };
    io.to(room).emit('newMessage', msg);
    session.history.push({ role: 'assistant', content: opener });

    // Schedule bot disconnect after a while
    scheduleBotRefresh(botUsername);
  }, randomDelay());
}

function botJoinQueue(botUsername) {
  const session = botSessions.get(botUsername);
  if (!session) return;

  // Register bot in online maps
  onlineSockets.set(session.fakeSocketId, botUsername);
  userSockets.set(botUsername, session.fakeSocketId);

  // If someone is already waiting — match immediately
  if (waitingQueue.length > 0) {
    const pid = waitingQueue.shift();
    const pu = onlineSockets.get(pid);
    if (!pu || pid.startsWith('bot_')) {
      // Invalid socket — bot waits instead
      waitingQueue.push(session.fakeSocketId);
      return;
    }
    botMatchWithUser(botUsername, pid);
  } else {
    // No one waiting — bot joins queue
    waitingQueue.push(session.fakeSocketId);
  }
}

function botDisconnect(botUsername) {
  const session = botSessions.get(botUsername);
  if (!session) return;
  // Notify partner
  if (session.partnerSocketId) {
    io.sockets.sockets.get(session.partnerSocketId)?.emit('partnerLeft', { reason: 'Stranger disconnected' });
    activePairs.delete(session.partnerSocketId);
  }
  activePairs.delete(session.fakeSocketId);
  onlineSockets.delete(session.fakeSocketId);
  userSockets.delete(botUsername);
  const qi = waitingQueue.indexOf(session.fakeSocketId);
  if (qi !== -1) waitingQueue.splice(qi, 1);
  session.room = null;
  session.partnerSocketId = null;
  session.history = [];
}

// Handle real user messages — route to bot if paired with one
function handleBotMessage(fromSocketId, text, room) {
  const botSocketId = activePairs.get(fromSocketId);
  if (!botSocketId || !String(botSocketId).startsWith('bot_')) return false;
  const botUsername = onlineSockets.get(botSocketId);
  if (!botUsername) return false;
  const session = botSessions.get(botUsername);
  if (!session) return false;
  botReplyToMessage(botUsername, text, room);
  return true;
}

// Bot lifecycle — disconnect after 3-8 min and rejoin queue
function scheduleBotRefresh(botUsername) {
  const timeout = Math.floor(Math.random() * 5 * 60 * 1000) + 3 * 60 * 1000;
  setTimeout(() => {
    botDisconnect(botUsername);
    // Rejoin after a short break
    setTimeout(() => botJoinQueue(botUsername), Math.random() * 8000 + 4000);
  }, timeout);
}

// Start all bots when server starts
function initBots() {
  console.log('🤖 Starting chatbots...');
  BOT_PERSONAS.forEach((persona, i) => {
    setTimeout(() => startBot(persona), i * 2000);
  });
}

// ── SOCKET.IO ─────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('auth', async ({ token }) => {
    try {
      const username = await DB.getSession(token);
      if (!username) { socket.emit('authError', { message: 'Invalid session' }); return; }
      const account = await DB.getAccount(username);
      if (!account) { socket.emit('authError', { message: 'Account not found' }); return; }
      if (account.isBanned) { socket.emit('banned', { reason: account.banReason }); socket.disconnect(); return; }
      account.lastSeen = Date.now();
      if (account.isMuted && account.muteUntil < Date.now()) { account.isMuted = false; account.muteUntil = null; }
      await DB.saveAccount(account);
      onlineSockets.set(socket.id, username);
      userSockets.set(username, socket.id);
      socket.emit('authOk', { user: sanitizeUser(account) });
      io.emit('onlineCount', onlineSockets.size);
      socket.emit('categories', ROOM_CATEGORIES);
      broadcastLeaderboard();
      (account.friends||[]).forEach(f => {
        const fs = userSockets.get(f);
        if (fs) io.to(fs).emit('friendOnline', { username, displayName: account.displayName, emoji: account.emoji, avatar: account.avatar });
      });
    } catch(e) { console.error(e); }
  });

  socket.on('findStranger', async ({ interests }) => {
    try {
      const username = onlineSockets.get(socket.id); if (!username) return;
      const account = await DB.getAccount(username);
      if (account?.isMuted && account.muteUntil > Date.now()) { socket.emit('error', { message: 'You are muted' }); return; }
      if (activePairs.has(socket.id)) disconnectPair(socket.id, 'skip');
      const qi = waitingQueue.indexOf(socket.id); if (qi !== -1) waitingQueue.splice(qi, 1);
      if (waitingQueue.length > 0) {
        const pid = waitingQueue.shift();
        const pu = onlineSockets.get(pid); if (!pu) { waitingQueue.unshift(socket.id); return; }

        // Check if matched with a bot
        if (pid.startsWith('bot_')) {
          const botUsername = pu;
          botMatchWithUser(botUsername, socket.id);
          return;
        }

        // Normal real-user match
        const room = `stranger_${crypto.randomBytes(4).toString('hex')}`;
        activePairs.set(socket.id, pid); activePairs.set(pid, socket.id);
        socket.join(room); io.sockets.sockets.get(pid)?.join(room);
        const myAcc = await DB.getAccount(username); const paAcc = await DB.getAccount(pu);
        if (myAcc) { myAcc.strangersCount = (myAcc.strangersCount||0)+1; await DB.saveAccount(myAcc); }
        if (paAcc) { paAcc.strangersCount = (paAcc.strangersCount||0)+1; await DB.saveAccount(paAcc); }
        socket.emit('matched', { partner: pubProfile(paAcc, pu), room });
        io.sockets.sockets.get(pid)?.emit('matched', { partner: pubProfile(myAcc, username), room });
      } else {
        // No one in queue — try to match with an available bot
        const availableBot = BOT_PERSONAS.find(p => {
          const s = botSessions.get(p.username);
          return s && !s.partnerSocketId && !waitingQueue.includes(s.fakeSocketId);
        });
        if (availableBot) {
          // Remove bot from queue if it's there
          const bs = botSessions.get(availableBot.username);
          const bqi = waitingQueue.indexOf(bs?.fakeSocketId);
          if (bqi !== -1) waitingQueue.splice(bqi, 1);
          botMatchWithUser(availableBot.username, socket.id);
        } else {
          waitingQueue.push(socket.id); socket.emit('waiting');
        }
      }
    } catch(e) { console.error(e); }
  });

  socket.on('cancelSearch', () => { const qi = waitingQueue.indexOf(socket.id); if (qi !== -1) waitingQueue.splice(qi, 1); socket.emit('searchCancelled'); });
  socket.on('skipPartner', () => disconnectPair(socket.id, 'skip'));

  socket.on('sendMessage', async ({ text, image, room }) => {
    try {
      if ((!text?.trim() && !image) || !room) return;
      const username = onlineSockets.get(socket.id); if (!username) return;
      const account = await DB.getAccount(username); if (!account) return;
      if (account.isMuted && account.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
      const msg = { id: crypto.randomBytes(4).toString('hex'), text: text?.trim().slice(0,1000)||'', image: image||null, from: socket.id, senderName: account.displayName, senderUsername: username, senderEmoji: account.emoji, senderAvatar: account.avatar, senderLevel: getLevelIndex(account.xp||0), senderVerified: account.isVerified, timestamp: Date.now(), type: 'stranger', reactions: {} };
      const prevLevel = getLevelIndex(account.xp||0);
      const xpGain = 5 + Math.min(10, Math.floor((text||'').trim().length/20));
      account.xp = (account.xp||0) + xpGain; account.messages = (account.messages||0) + 1;
      const newLevel = getLevelIndex(account.xp);
      const newBadgeIds = checkBadges(account);
      await DB.saveAccount(account);
      io.to(room).emit('newMessage', msg);
      // Route to bot if paired with one
      handleBotMessage(socket.id, text||'', room);
      socket.emit('xpUpdate', { xp: account.xp, xpGained: xpGain, level: newLevel, leveledUp: newLevel>prevLevel, newLevelName: newLevel>prevLevel?LEVELS[newLevel].name:null, newLevelIcon: newLevel>prevLevel?LEVELS[newLevel].icon:null, newBadges: newBadgeIds.map(id=>BADGES.find(b=>b.id===id)).filter(Boolean) });
      broadcastLeaderboard();
    } catch(e) { console.error(e); }
  });

  socket.on('addReaction', async ({ messageId, emoji, room, roomType }) => {
    try {
      if (!['👍','❤️','😂','😮','😢','🔥','👏','🎉'].includes(emoji)) return;
      const username = onlineSockets.get(socket.id); if (!username) return;
      if (roomType === 'room') {
        const r = await DB.getRoom(room?.toUpperCase()); if (!r) return;
        const msg = r.messages.find(m => m.id === messageId); if (!msg) return;
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const idx = msg.reactions[emoji].indexOf(username);
        if (idx === -1) msg.reactions[emoji].push(username);
        else msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        await DB.saveRoom(r);
        io.to(`room_${room}`).emit('reactionUpdate', { messageId, reactions: msg.reactions });
      } else {
        io.to(room).emit('reactionUpdate', { messageId, emoji, username });
      }
    } catch(e) {}
  });

  socket.on('sendDM', async ({ text, image, toUsername }) => {
    try {
      if ((!text?.trim() && !image) || !toUsername) return;
      const fromUsername = onlineSockets.get(socket.id); if (!fromUsername) return;
      const fromAcc = await DB.getAccount(fromUsername);
      const toAcc = await DB.getAccount(toUsername.toLowerCase());
      if (!fromAcc || !toAcc) return;
      if (!(fromAcc.friends||[]).includes(toAcc.username)) { socket.emit('dmError', { message: 'Only friends can DM' }); return; }
      if (!canDM(fromUsername, toAcc)) { socket.emit('dmError', { message: `${toAcc.displayName} is not accepting DMs` }); return; }
      if (fromAcc.isMuted && fromAcc.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
      const roomId = getDMRoomId(fromUsername, toAcc.username);
      let room = await DB.getDMRoom(roomId);
      if (!room) room = { id: roomId, users: [fromUsername, toAcc.username], messages: [], unread: { [fromUsername]: 0, [toAcc.username]: 0 } };
      const msg = { id: crypto.randomBytes(4).toString('hex'), text: text?.trim().slice(0,1000)||'', image: image||null, from: fromUsername, senderName: fromAcc.displayName, senderEmoji: fromAcc.emoji, senderAvatar: fromAcc.avatar, senderLevel: getLevelIndex(fromAcc.xp||0), senderVerified: fromAcc.isVerified, toUsername: toAcc.username, timestamp: Date.now(), read: false, type: 'dm', reactions: {} };
      if (!room.messages) room.messages = [];
      room.messages.push(msg);
      if (room.messages.length > 200) room.messages = room.messages.slice(-200);
      if (!room.unread) room.unread = {};
      room.unread[toAcc.username] = (room.unread[toAcc.username]||0) + 1;
      await DB.saveDMRoom(room);
      fromAcc.xp = (fromAcc.xp||0) + 2; fromAcc.messages = (fromAcc.messages||0) + 1;
      await DB.saveAccount(fromAcc);
      socket.emit('newDM', { ...msg, roomId: room.id });
      const toSocket = userSockets.get(toAcc.username);
      if (toSocket) io.to(toSocket).emit('newDM', { ...msg, roomId: room.id });
      broadcastLeaderboard();
    } catch(e) { console.error(e); }
  });

  socket.on('markDMRead', async ({ withUsername }) => {
    try {
      const myUsername = onlineSockets.get(socket.id); if (!myUsername) return;
      const roomId = getDMRoomId(myUsername, withUsername);
      const room = await DB.getDMRoom(roomId); if (!room) return;
      if (!room.unread) room.unread = {};
      room.unread[myUsername] = 0;
      room.messages = (room.messages||[]).map(m => m.from !== myUsername ? { ...m, read: true } : m);
      await DB.saveDMRoom(room);
      const os = userSockets.get(withUsername);
      if (os) io.to(os).emit('messagesRead', { by: myUsername });
    } catch(e) {}
  });

  socket.on('joinRoom', async ({ roomId }) => {
    try {
      const username = onlineSockets.get(socket.id);
      const room = await DB.getRoom(roomId?.toUpperCase());
      if (!room || !username) return;
      if ((room.bannedUsers||[]).includes(username)) { socket.emit('roomError', { message: 'You are banned from this room' }); return; }
      if (!room.members) room.members = [];
      if (!room.members.includes(username)) room.members.push(username);
      await DB.saveRoom(room);
      socket.join(`room_${room.id}`);
      const account = await DB.getAccount(username);
      io.to(`room_${room.id}`).emit('roomUserJoined', { username, displayName: account?.displayName, roomId: room.id });
      socket.emit('roomJoined', { room: sanitizeRoom(room, username), messages: room.messages.slice(-100) });
    } catch(e) { console.error(e); }
  });

  socket.on('leaveRoom', async ({ roomId }) => {
    socket.leave(`room_${roomId}`);
    const username = onlineSockets.get(socket.id);
    const room = await DB.getRoom(roomId?.toUpperCase());
    if (room && username) io.to(`room_${room.id}`).emit('roomUserLeft', { username, roomId });
  });

  socket.on('sendRoomMessage', async ({ text, image, roomId }) => {
    try {
      if ((!text?.trim() && !image) || !roomId) return;
      const username = onlineSockets.get(socket.id);
      const room = await DB.getRoom(roomId?.toUpperCase());
      if (!room || !username) return;
      if ((room.bannedUsers||[]).includes(username)) return;
      if (!(room.members||[]).includes(username)) return;
      const account = await DB.getAccount(username);
      if (account?.isMuted && account.muteUntil > Date.now()) { socket.emit('mutedError'); return; }
      if (room.slowMode > 0) {
        const key = `${room.id}_${username}`;
        const last = roomSlowModeTracker.get(key) || 0;
        if (Date.now() - last < room.slowMode * 1000) { socket.emit('slowModeError', { seconds: Math.ceil((room.slowMode*1000-(Date.now()-last))/1000) }); return; }
        roomSlowModeTracker.set(key, Date.now());
      }
      const msg = { id: crypto.randomBytes(4).toString('hex'), text: text?.trim().slice(0,1000)||'', image: image||null, from: username, senderName: account?.displayName||username, senderEmoji: account?.emoji||'🎭', senderAvatar: account?.avatar, senderLevel: getLevelIndex(account?.xp||0), senderVerified: account?.isVerified, roomId, timestamp: Date.now(), type: 'room', reactions: {} };
      if (!room.messages) room.messages = [];
      room.messages.push(msg);
      if (room.messages.length > 500) room.messages = room.messages.slice(-500);
      await DB.saveRoom(room);
      io.to(`room_${room.id}`).emit('newRoomMessage', msg);
      if (account) { account.xp = (account.xp||0)+3; account.messages = (account.messages||0)+1; await DB.saveAccount(account); }
      broadcastLeaderboard();
    } catch(e) { console.error(e); }
  });

  socket.on('pinMessage', async ({ roomId, messageId }) => {
    try {
      const username = onlineSockets.get(socket.id);
      const room = await DB.getRoom(roomId?.toUpperCase());
      if (!room || room.owner !== username) return;
      const msg = room.messages.find(m => m.id === messageId); if (!msg) return;
      room.pinnedMessage = { id: msg.id, text: msg.text, senderName: msg.senderName, timestamp: msg.timestamp };
      await DB.saveRoom(room);
      io.to(`room_${room.id}`).emit('messagePinned', { pinnedMessage: room.pinnedMessage });
    } catch(e) {}
  });

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

  socket.on('disconnect', async () => {
    try {
      const username = onlineSockets.get(socket.id);
      disconnectPair(socket.id, 'disconnect');
      const qi = waitingQueue.indexOf(socket.id); if (qi !== -1) waitingQueue.splice(qi, 1);
      onlineSockets.delete(socket.id);
      if (username) {
        if (userSockets.get(username) === socket.id) userSockets.delete(username);
        const acc = await DB.getAccount(username);
        if (acc) { acc.lastSeen = Date.now(); await DB.saveAccount(acc); (acc.friends||[]).forEach(f => { const fs = userSockets.get(f); if (fs) io.to(fs).emit('friendOffline', { username }); }); }
      }
      io.emit('onlineCount', onlineSockets.size);
    } catch(e) {}
  });

  function disconnectPair(socketId, reason) {
    const pid = activePairs.get(socketId); if (!pid) return;
    activePairs.delete(socketId); activePairs.delete(pid);
    io.sockets.sockets.get(pid)?.emit('partnerLeft', { reason: reason==='disconnect'?'Stranger disconnected':'Stranger skipped you' });
  }

  function pubProfile(acc, username) {
    if (!acc) return null;
    return { name: acc.displayName, username, emoji: acc.emoji, avatar: acc.avatar, level: getLevelIndex(acc.xp||0), xp: acc.xp||0, bio: acc.bio||'', badges: acc.badges||[], genderVerified: acc.genderVerified, isVerified: acc.isVerified };
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 WISHPR running on http://localhost:${PORT}\n`);
  initBots();
});
