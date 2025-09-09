const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const bodyParser = require('body-parser');
const mongo = require('mongodb').MongoClient;
const path = require('path');

app.use(express.static(__dirname));
app.use(bodyParser.json());

let db;

// MongoDB setup (locally)
mongo.connect('mongodb://localhost:27017/ilseparatio', { useUnifiedTopology: true }, (err, client) => {
  if (err) throw err;
  db = client.db('ilseparatio');
});

const MAX_USERNAME = 10;
const FILE_LIMIT_MB = 20;
const MINUTE_LIMIT_MB = 100;
const FILE_LIFETIME = 60 * 1000; // 1 min
const CHAT_LIFETIME = 10 * 60 * 1000; // 10 min

// Serve client.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));

// Register user
app.post('/register', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const { username } = req.body;
  if (!/^[a-zA-Z0-9]{1,10}$/.test(username)) return res.status(400).send('Nume invalid');
  const exists = await db.collection('users').findOne({ username });
  if (exists) return res.status(409).send('Numele există deja');
  const banned = await db.collection('bans').findOne({ ip, expires: { $gt: Date.now() } });
  if (banned) return res.status(403).send('Ești interzis până la ' + new Date(banned.expires).toLocaleString());
  await db.collection('users').insertOne({ username, ip, friends: [], requests: [], muted: false, banExpires: null });
  res.send({ success: true, username });
});

// Panel admin actions (mute, ban, unban)
app.post('/admin-action', async (req, res) => {
  const { admin, action, target, time } = req.body;
  if (admin !== 'lucabos22') return res.status(403).send('Nu ești admin');
  const user = await db.collection('users').findOne({ username: target });
  if (!user) return res.status(404).send('User inexistent');
  if (action === 'mute') {
    await db.collection('users').updateOne({ username: target }, { $set: { muted: true, muteExpires: Date.now() + time * 60000 } });
    res.send('User mutat');
  } else if (action === 'unmute') {
    await db.collection('users').updateOne({ username: target }, { $set: { muted: false, muteExpires: null } });
    res.send('User demutat');
  } else if (action === 'ban') {
    await db.collection('bans').insertOne({ ip: user.ip, expires: Date.now() + time * 60000 });
    res.send('User interzis');
  } else if (action === 'unban') {
    await db.collection('bans').deleteMany({ ip: user.ip });
    res.send('Interdicție anulată');
  } else {
    res.status(400).send('Acțiune invalidă');
  }
});

// Socket.io logic (chat, prieteni, voice, files)
let chatRooms = {};
let files = [];

io.on('connection', (socket) => {
  socket.on('login', async ({ username }) => {
    socket.username = username;
    const user = await db.collection('users').findOne({ username });
    if (!user) return;
    // Send prieteni, cereri, mute, ban info
    socket.emit('setup', { friends: user.friends, requests: user.requests, muted: !!user.muted, muteExpires: user.muteExpires });
  });

  socket.on('add-request', async ({ from, to }) => {
    const target = await db.collection('users').findOne({ username: to });
    if (!target) return;
    await db.collection('users').updateOne({ username: to }, { $push: { requests: from } });
    io.emit('request-update', { to });
  });

  socket.on('accept-request', async ({ from, to }) => {
    await db.collection('users').updateOne({ username: to }, { $push: { friends: from }, $pull: { requests: from } });
    await db.collection('users').updateOne({ username: from }, { $push: { friends: to } });
    io.emit('friend-update', { from, to });
  });

  socket.on('chat-msg', ({ room, from, text }) => {
    if (!chatRooms[room]) chatRooms[room] = [];
    chatRooms[room].push({ from, text, ts: Date.now() });
    io.to(room).emit('chat-msg', { from, text });
  });

  socket.on('join-room', ({ room }) => {
    socket.join(room);
    if (!chatRooms[room]) chatRooms[room] = [];
    // Remove messages older than CHAT_LIFETIME
    chatRooms[room] = chatRooms[room].filter(m => m.ts > Date.now() - CHAT_LIFETIME);
    socket.emit('chat-history', chatRooms[room]);
  });

  socket.on('file-upload', ({ room, from, file, type, size }) => {
    if (size > FILE_LIMIT_MB * 1024 * 1024) return;
    files.push({ room, from, file, type, size, ts: Date.now() });
    io.to(room).emit('file-receive', { from, type, file });
    // Remove files older than FILE_LIFETIME every upload
    files = files.filter(f => f.ts > Date.now() - FILE_LIFETIME);
  });

  // Admin spionaj
  socket.on('spy', ({ target }) => {
    // Simulează voice spy, trimite stream la admin
    if (socket.username === 'lucabos22') {
      io.to(target).emit('spy-request', { admin: 'lucabos22' });
    }
  });

  // Periodic cleanup chat
  setInterval(() => {
    Object.keys(chatRooms).forEach(room => {
      chatRooms[room] = chatRooms[room].filter(m => m.ts > Date.now() - CHAT_LIFETIME);
      io.to(room).emit('chat-history', chatRooms[room]);
    });
    files = files.filter(f => f.ts > Date.now() - FILE_LIFETIME);
  }, 10000);
});

http.listen(3001, () => console.log('Il Separatio server running on http://localhost:3001'));