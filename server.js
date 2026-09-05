const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// JSONbin.io 設定 (環境変数から取得)
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const BIN_ID = process.env.JSONBIN_BIN_ID || ''; 

// 簡易的なデータ保存・取得ヘルパー (JSONbin.io API連携)
async function getDatabase() {
  if (!JSONBIN_API_KEY || !BIN_ID) {
    return global.fallbackDb || { users: [] };
  }
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    const data = await res.json();
    return data.record || { users: [] };
  } catch (e) {
    console.error('DB Read Error:', e);
    return { users: [] };
  }
}

async function saveDatabase(dbData) {
  if (!JSONBIN_API_KEY || !BIN_ID) {
    global.fallbackDb = dbData;
    return;
  }
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY
      },
      body: JSON.stringify(dbData)
    });
  } catch (e) {
    console.error('DB Write Error:', e);
  }
}

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: 'othello-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// --- 認証系 API ---

app.post('/api/register', async (req, res) => {
  const { username, password, tosAgreed } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください。' });
  }
  if (!tosAgreed) {
    return res.status(400).json({ error: '利用規約への同意が必要です。' });
  }

  try {
    const db = await getDatabase();
    if (db.users.some(u => u.username === username)) {
      return res.status(400).json({ error: 'このユーザー名はすでに使われています。' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: Date.now(),
      username,
      password: hashedPassword,
      elo: 1200,
      tos_agreed: 1
    };

    db.users.push(newUser);
    await saveDatabase(db);

    req.session.userId = newUser.id;
    req.session.username = username;
    res.json({ success: true, username });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラーが発生しました。' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください。' });
  }

  try {
    const db = await getDatabase();
    const user = db.users.find(u => u.username === username);
    if (!user) {
      return res.status(400).json({ error: 'ユーザー名またはパスワードが間違っています。' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'ユーザー名またはパスワードが間違っています。' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, username: user.username, elo: user.elo });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラーが発生しました。' });
  }
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未ログインです。' });
  }
  try {
    const db = await getDatabase();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) {
      return res.status(401).json({ error: 'ユーザーが見つかりません。' });
    }
    res.json({ username: user.username, elo: user.elo, tosAgreed: user.tos_agreed });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラーが発生しました。' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.post('/api/tos', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未ログインです。' });
  }
  try {
    const db = await getDatabase();
    const user = db.users.find(u => u.id === req.session.userId);
    if (user) {
      user.tos_agreed = 1;
      await saveDatabase(db);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新に失敗しました。' });
  }
});

// --- ゲームロジック ---

let waitingPlayer = null;
const activeRooms = {};

function createInitialBoard() {
  const board = Array(8).fill(null).map(() => Array(8).fill(0));
  board[3][3] = 2;
  board[3][4] = 1;
  board[4][3] = 1;
  board[4][4] = 2;
  return board;
}

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

function hasValidMoves(board, player) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (getFlips(board, r, c, player).length > 0) return true;
    }
  }
  return false;
}

function calculateElo(winnerElo, loserElo) {
  const K = 32;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
  const newWinnerElo = Math.round(winnerElo + K * (1 - expectedWinner));
  const newLoserElo = Math.round(loserElo + K * (0 - expectedLoser));
  return { newWinnerElo, newLoserElo };
}

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username ? session.username : 'Guest_' + socket.id.slice(0, 4);
  socket.data.username = username;

  socket.on('find_match', async () => {
    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const p1 = waitingPlayer;
      const p2 = socket;
      waitingPlayer = null;

      const roomId = 'room_' + Date.now();
      p1.join(roomId);
      p2.join(roomId);

      try {
        const db = await getDatabase();
        const u1 = db.users.find(u => u.username === p1.data.username);
        const u2 = db.users.find(u => u.username === p2.data.username);
        
        const elo1 = u1 ? u1.elo : 1200;
        const elo2 = u2 ? u2.elo : 1200;

        activeRooms[roomId] = {
          board: createInitialBoard(),
          turn: 1,
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
      } catch (e) {
        console.error('Matchmaking error:', e);
      }
    } else {
      waitingPlayer = socket;
      socket.emit('waiting', { message: '対戦相手を探しています...' });
    }
  });

  socket.on('cancel_match', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
      socket.emit('match_canceled');
    }
  });

  socket.on('make_move', async ({ roomId, row, col }) => {
    const room = activeRooms[roomId];
    if (!room || room.status !== 'playing') return;

    const playerNum = room.players[1].id === socket.id ? 1 : room.players[2].id === socket.id ? 2 : null;
    if (!playerNum || room.turn !== playerNum) return;

    const flips = getFlips(room.board, row, col, playerNum);
    if (flips.length === 0) return;

    room.board[row][col] = playerNum;
    flips.forEach(f => {
      room.board[f.r][f.c] = playerNum;
    });

    let nextTurn = playerNum === 1 ? 2 : 1;
    if (hasValidMoves(room.board, nextTurn)) {
      room.turn = nextTurn;
    } else if (hasValidMoves(room.board, playerNum)) {
      room.turn = playerNum;
    } else {
      room.status = 'finished';
    }

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
      else winner = 0;

      if (winner === 1 || winner === 2) {
        const winnerP = room.players[winner];
        const loserP = room.players[winner === 1 ? 2 : 1];
        const { newWinnerElo, newLoserElo } = calculateElo(winnerP.elo, loserP.elo);

        try {
          const db = await getDatabase();
          const wUser = db.users.find(u => u.username === winnerP.username);
          const lUser = db.users.find(u => u.username === loserP.username);
          if (wUser) wUser.elo = newWinnerElo;
          if (lUser) lUser.elo = newLoserElo;
          await saveDatabase(db);

          winnerP.elo = newWinnerElo;
          loserP.elo = newLoserElo;
        } catch (e) {
          console.error('Elo update error:', e);
        }
      }
    }

    io.to(roomId).emit('update_game', {
      board: room.board,
      turn: room.turn,
      status: room.status,
      winner
    });
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
