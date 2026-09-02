const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// データベースのセットアップ（ローカルファイル保存）
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database opening error: ', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// テーブル作成
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    elo INTEGER DEFAULT 1200,
    tos_agreed INTEGER DEFAULT 0
  )`);
});

// ミドルウェアの設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: 'othello-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // 本番環境でHTTPSの場合はtrue推奨ですが環境に合わせて調整
});

app.use(sessionMiddleware);

// Socket.ioとセッションの連携
io.engine.use(sessionMiddleware);

// --- 認証系 API ---

// ユーザー登録
app.post('/api/register', async (req, res) => {
  const { username, password, tosAgreed } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください。' });
  }
  if (!tosAgreed) {
    return res.status(400).json({ error: '利用規約への同意が必要です。' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users (username, password, tos_agreed) VALUES (?, ?, 1)`,
      [username, hashedPassword],
      function (err) {
        if (err) {
          return res.status(400).json({ error: 'このユーザー名はすでに使われています。' });
        }
        req.session.userId = this.lastID;
        req.session.username = username;
        res.json({ success: true, username });
      }
    );
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラーが発生しました。' });
  }
});

// ログイン
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください。' });
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'ユーザー名またはパスワードが間違っています。' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'ユーザー名またはパスワードが間違っています。' });
    }

    // 利用規約に未同意の場合はログインを弾く（またはモーダルを出す）
    if (!user.tos_agreed) {
      return res.status(403).json({ error: '利用規約への同意が必要です。', requireTos: true });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username, elo: user.elo });
  });
});

// ログイン状態確認
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未ログインです。' });
  }
  db.get(`SELECT username, elo, tos_agreed FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'ユーザーが見つかりません。' });
    }
    res.json({ username: user.username, elo: user.elo, tosAgreed: user.tos_agreed });
  });
});

// ログアウト
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// 利用規約の同意更新
app.post('/api/tos', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未ログインです。' });
  }
  db.run(`UPDATE users SET tos_agreed = 1 WHERE id = ?`, [req.session.userId], (err) => {
    if (err) {
      return res.status(500).json({ error: '更新に失敗しました。' });
    }
    res.json({ success: true });
  });
});

// --- オセロ・マッチメイキングのゲームロジック ---

let waitingPlayer = null; // マッチング待ちのプレイヤー
const activeRooms = {};   // 進行中の部屋データ

// オセロの初期ボード生成 (0:空, 1:黒, 2:白)
function createInitialBoard() {
  const board = Array(8).fill(null).map(() => Array(8).fill(0));
  board[3][3] = 2;
  board[3][4] = 1;
  board[4][3] = 1;
  board[4][4] = 2;
  return board;
}

// 指定位置に石が置けるか判定し、裏返せる座標を返す関数
function getFlips(board, row, col, player) {
  if (board[row][col] !== 0) return [];
  const opponent = player === 1 ? 2 : 1;
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1]
  ];
  let allFlips = [];

  for (const [dr, dc] of directions) {
    let r = row + dr;
    let c = col + dc;
    let tempFlips = [];

    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opponent) {
      tempFlips.push({ r, c });
      r += dr;
      c += dc;
    }

    if (tempFlips.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === player) {
      allFlips = allFlips.concat(tempFlips);
    }
  }
  return allFlips;
}

// 置ける場所があるかチェック
function hasValidMoves(board, player) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (getFlips(board, r, c, player).length > 0) return true;
    }
  }
  return false;
}

// Eloレーティング計算関数
function calculateElo(winnerElo, loserElo) {
  const K = 32;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
  const newWinnerElo = Math.round(winnerElo + K * (1 - expectedWinner));
  const newLoserElo = Math.round(loserElo + K * (0 - expectedLoser));
  return { newWinnerElo, newLoserElo };
}

// Socket.io 接続管理
io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username ? session.username : 'Guest_' + socket.id.slice(0, 4);
  socket.data.username = username;

  console.log(`User connected: ${username}`);

  // マッチメイキング開始
  socket.on('find_match', () => {
    // すでにマッチング待ちや対戦中でなければ登録
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      const roomId = 'room_' + Date.now();
      p1.join(roomId);
      p2.join(roomId);

      db.get(`SELECT elo FROM users WHERE username = ?`, [p1.data.username], (err, row1) => {
        db.get(`SELECT elo FROM users WHERE username = ?`, [p2.data.username], (err, row2) => {
          const elo1 = row1 ? row1.elo : 1200;
          const elo2 = row2 ? row2.elo : 1200;

          activeRooms[roomId] = {
            board: createInitialBoard(),
            turn: 1, // 1: 黒（p1）, 2: 白（p2）
            players: {
              1: { id: p1.id, username: p1.data.username, elo: elo1 },
              2: { id: p2.id, username: p2.data.username, elo: elo2 }
            },
            status: 'playing'
          };

          io.to(roomId).emit('match_found', {
            roomId,
            players: {
              1: { username: p1.data.username, elo: elo1 },
              2: { username: p2.data.username, elo: elo2 }
            },
            board: activeRooms[roomId].board,
            turn: 1
          });
        });
      });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting', { message: '対戦相手を探しています...' });
    }
  });

  // キャンセル
  socket.on('cancel_match', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
      socket.emit('match_canceled');
    }
  });

  // 石を置くアクション
  socket.on('make_move', ({ roomId, row, col }) => {
    const room = activeRooms[roomId];
    if (!room || room.status !== 'playing') return;

    // プレイヤーの割り当てを確認
    const playerNum = room.players[1].id === socket.id ? 1 : room.players[2].id === socket.id ? 2 : null;
    if (!playerNum || room.turn !== playerNum) return;

    const flips = getFlips(room.board, row, col, playerNum);
    if (flips.length === 0) return; // 置けない場所

    // ボード更新
    room.board[row][col] = playerNum;
    flips.forEach(f => {
      room.board[f.r][f.c] = playerNum;
    });

    // ターン交代の判定
    let nextTurn = playerNum === 1 ? 2 : 1;
    if (hasValidMoves(room.board, nextTurn)) {
      room.turn = nextTurn;
    } else if (hasValidMoves(room.board, playerNum)) {
      // 相手が置けない場合は連続手番
      room.turn = playerNum;
    } else {
      // 両者置けない場合はゲーム終了
      room.status = 'finished';
    }

    // 勝敗判定
    let winner = null;
    if (room.status === 'finished') {
      let blackCount = 0;
      let whiteCount = 0;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          if (room.board[r][c] === 1) blackCount++;
          if (room.board[r][c] === 2) whiteCount++;
        }
      }
      if (blackCount > whiteCount) winner = 1;
      else if (whiteCount > blackCount) winner = 2;
      else winner = 0; // 引き分け

      // Eloレーティングの更新処理（ゲスト以外）
      if (winner === 1 || winner === 2) {
        const winnerP = room.players[winner];
        const loserP = room.players[winner === 1 ? 2 : 1];
        const { newWinnerElo, newLoserElo } = calculateElo(winnerP.elo, loserP.elo);

        db.run(`UPDATE users SET elo = ? WHERE username = ?`, [newWinnerElo, winnerP.username]);
        db.run(`UPDATE users SET elo = ? WHERE username = ?`, [newLoserElo, loserP.username]);
        winnerP.elo = newWinnerElo;
        loserP.elo = newLoserElo;
      }
    }

    io.to(roomId).emit('update_game', {
      board: room.board,
      turn: room.turn,
      status: room.status,
      winner
    });
  });

  // 切断時の処理
  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    // 対戦中の部屋があれば相手の勝ちとするなどの処理もここに追加可能
    console.log(`User disconnected: ${username}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
