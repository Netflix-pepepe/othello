const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ミドルウェア設定
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: 'othello_secret_key',
  resave: false,
  saveUninitialized: true
}));

// データベース初期化 (SQLite)
const db = new sqlite3.Database('./othello.db');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      rate INTEGER DEFAULT 1500
    )
  `);
});

// 状態管理
let matchQueue = [];
const rooms = {};

function generateRoomId() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// レート計算（Eloレーティング法）
function calculateElo(ratingA, ratingB, actualScoreA, kFactor = 32) {
  const expectedScoreA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newRatingA = Math.round(ratingA + kFactor * (actualScoreA - expectedScoreA));
  return newRatingA;
}

// --- REST API (認証 & プロフィール) ---

// 会員登録
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '入力が不十分です' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password, rate) VALUES (?, ?, 1500)', [username, hashedPassword], function(err) {
      if (err) return res.status(400).json({ error: 'このユーザー名は既に使用されています' });
      req.session.userId = this.lastID;
      req.session.username = username;
      res.json({ success: true, username, rate: 1500 });
    });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ログイン
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'ユーザー名またはパスワードが正しくありません' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'ユーザー名またはパスワードが正しくありません' });

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username, rate: user.rate });
  });
});

// ユーザー名変更
app.post('/api/update-name', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'ログインが必要です' });
  const { newName } = req.body;
  
  db.run('UPDATE users SET username = ? WHERE id = ?', [newName, req.session.userId], (err) => {
    if (err) return res.status(400).json({ error: 'その名前は既に使用されています' });
    req.session.username = newName;
    res.json({ success: true, newName });
  });
});

// ランキング取得
app.get('/api/ranking', (req, res) => {
  db.all('SELECT username, rate FROM users ORDER BY rate DESC LIMIT 10', [], (err, rows) => {
    if (err) return res.status(500).json({ error: '取得失敗' });
    res.json(rows);
  });
});

// --- Socket.io リアルタイム通信 ---

io.on('connection', (socket) => {
  let userData = { username: 'ゲスト', rate: 1500, isGuest: true };

  socket.on('set_user', (info) => {
    if (info) userData = { ...info, isGuest: false };
  });

  // レートマッチ検索
  socket.on('join_rate_match', () => {
    if (!matchQueue.find(s => s.socket.id === socket.id)) {
      matchQueue.push({ socket, userData });
    }

    if (matchQueue.length >= 2) {
      const player1 = matchQueue.shift();
      const player2 = matchQueue.shift();
      const roomId = `rate_${generateRoomId()}`;

      player1.socket.join(roomId);
      player2.socket.join(roomId);

      rooms[roomId] = {
        p1: { socketId: player1.socket.id, user: player1.userData, color: 1 },
        p2: { socketId: player2.socket.id, user: player2.userData, color: 2 },
        isRated: true,
        finished: false
      };

      io.to(roomId).emit('matched', { msg: 'マッチングしました！対戦を開始します。' });

      setTimeout(() => {
        player1.socket.emit('start_game', {
          roomId, color: 1,
          myUser: player1.userData,
          enemyUser: player2.userData
        });
        player2.socket.emit('start_game', {
          roomId, color: 2,
          myUser: player2.userData,
          enemyUser: player1.userData
        });
      }, 1500);
    }
  });

  // 部屋作成（部屋マッチでもレートを変動させる場合は isRated: true）
  socket.on('create_room', () => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      p1: { socketId: socket.id, user: userData, color: 1 },
      p2: null,
      isRated: true,
      finished: false
    };
    socket.join(roomId);
    socket.emit('room_created', { roomId, color: 1 });
  });

  // 部屋参加
  socket.on('join_room', (roomId) => {
    const room = rooms[roomId];
    if (!room) {
      return socket.emit('status_message', '部屋が存在しません。');
    }
    if (room.p1.socketId === socket.id) {
      return socket.emit('status_message', '自分が作成した部屋には参加できません。');
    }
    if (room.p2) {
      return socket.emit('status_message', '部屋はすでに満員です。');
    }

    room.p2 = { socketId: socket.id, user: userData, color: 2 };
    socket.join(roomId);

    io.to(roomId).emit('matched', { msg: '対戦相手が参加しました！' });

    setTimeout(() => {
      io.sockets.sockets.get(room.p1.socketId)?.emit('start_game', {
        roomId, color: 1, myUser: room.p1.user, enemyUser: room.p2.user
      });
      socket.emit('start_game', {
        roomId, color: 2, myUser: room.p2.user, enemyUser: room.p1.user
      });
    }, 1000);
  });

  // 着手同期
  socket.on('make_move', (data) => {
    socket.to(data.roomId).emit('enemy_move', data);
  });

  // ゲーム終了時のレート更新処理
  socket.on('game_over', (data) => {
    const { roomId, winnerColor } = data; // 1: 黒勝, 2: 白勝, 0: 引き分け
    const room = rooms[roomId];

    if (room && room.isRated && !room.finished) {
      room.finished = true;

      const p1 = room.p1.user;
      const p2 = room.p2.user;

      let scoreA = 0.5;
      if (winnerColor === 1) scoreA = 1;
      if (winnerColor === 2) scoreA = 0;

      const newRate1 = calculateElo(p1.rate, p2.rate, scoreA);
      const newRate2 = calculateElo(p2.rate, p1.rate, 1 - scoreA);

      if (!p1.isGuest) {
        db.run('UPDATE users SET rate = ? WHERE username = ?', [newRate1, p1.username]);
        p1.rate = newRate1;
      }
      if (!p2.isGuest) {
        db.run('UPDATE users SET rate = ? WHERE username = ?', [newRate2, p2.username]);
        p2.rate = newRate2;
      }

      io.sockets.sockets.get(room.p1.socketId)?.emit('rate_updated', { newRate: newRate1 });
      io.sockets.sockets.get(room.p2.socketId)?.emit('rate_updated', { newRate: newRate2 });
    }
  });

  // 再戦リクエスト処理
  socket.on('request_rematch', (data) => {
    const { roomId } = data;
    const room = rooms[roomId];
    if (!room) return;

    if (!room.rematchRequests) room.rematchRequests = new Set();
    room.rematchRequests.add(socket.id);

    socket.to(roomId).emit('rematch_requested');

    if (room.rematchRequests.size === 2) {
      room.rematchRequests.clear();
      room.finished = false;

      const oldP1 = room.p1;
      const oldP2 = room.p2;

      room.p1 = { ...oldP2, color: 1 };
      room.p2 = { ...oldP1, color: 2 };

      io.sockets.sockets.get(room.p1.socketId)?.emit('start_game', {
        roomId, color: 1, myUser: room.p1.user, enemyUser: room.p2.user
      });
      io.sockets.sockets.get(room.p2.socketId)?.emit('start_game', {
        roomId, color: 2, myUser: room.p2.user, enemyUser: room.p1.user
      });
    }
  });

  socket.on('disconnect', () => {
    matchQueue = matchQueue.filter(s => s.socket.id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
});
