/**
 * 音の記憶リレー — サーバー側(Google Apps Script)
 *
 * 部屋の状態は CacheService に JSON で保存する(最大6時間で自動的に消える)。
 * 書き込みは LockService で1つずつ処理して、同時押しで状態が壊れないようにしている。
 * クライアントは getState を1秒ごとに呼んで(ポーリング)、変化があれば受け取る。
 * ポーリングのたびに「最後に見えた時刻」を記録して、画面を閉じた人(離席)を判定する。
 */

const ROOM_TTL_SEC = 21600; // 6時間(CacheService の上限)
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_EVENTS = 300;     // 部屋に残しておくイベント数(長い並びをまとめて送っても取りこぼさない量)
const BUTTON_COUNT = 4;
const AWAY_MS = 15000;      // これだけ通信がない人は「離席」扱い
const MAX_BATCH = 200;      // 1回で送れるボタンの数

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('音の記憶リレー')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// ============================================================
// クライアントから google.script.run で呼ぶ関数
// ============================================================

/** 部屋を作る。作った人がホストになる。 */
function createRoom(name) {
  return withLock_(function () {
    let code = null;
    for (let i = 0; i < 50 && !code; i++) {
      const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
      if (!load_(c)) code = c;
    }
    if (!code) throw new Error('部屋を作れませんでした。もう一度試してください。');

    const id = Utilities.getUuid();
    const room = {
      code: code,
      version: 0,
      status: 'waiting',          // waiting / playing / finished
      hostId: id,
      players: [{ id: id, name: cleanName_(name, 1), alive: true }],
      sequence: [],               // これまでに積み上がったボタン(0〜3)
      turnIndex: 0,               // 今の番の人(players の添字)
      inputPos: 0,                // 今の番の人が何個目まで押したか
      turnSerial: 0,              // 番が変わるたびに増える
      winnerId: null,
      events: [],
      nextEventId: 0,
      secrets: {}                 // 公開IDごとの合言葉(ほかの人には送らない)
    };
    const token = issueToken_(room, id);
    addEvent_(room, { type: 'join', player: id, name: room.players[0].name, count: 1 });
    save_(room);
    touch_(code, id);
    return { playerId: id, token: token, state: public_(room), away: [] };
  });
}

/** 部屋番号で参加する。 */
function joinRoom(code, name) {
  code = normCode_(code);
  return withLock_(function () {
    const room = mustLoad_(code);
    if (room.status === 'playing') throw new Error('この部屋はゲーム中です。終わるまで待ってください。');
    removeLeftPlayers_(room);
    if (room.players.length >= MAX_PLAYERS) throw new Error('この部屋は満員です(最大4人)。');

    const id = Utilities.getUuid();
    // 同じ名前の人がいたら「こた2」のように番号をつける(読み上げで区別できるように)
    const base = cleanName_(name, room.players.length + 1);
    let unique = base;
    for (let k = 2; room.players.some(function (p) { return p.name === unique; }); k++) unique = base + k;
    const player = { id: id, name: unique, alive: true };
    room.players.push(player);
    const token = issueToken_(room, id);
    addEvent_(room, { type: 'join', player: id, name: player.name, count: room.players.length });
    save_(room);
    touch_(code, id);
    return { playerId: id, token: token, state: public_(room), away: awayIds_(room) };
  });
}

/**
 * 画面を閉じてしまった人が、同じ部屋に戻る。
 * 端末に保存しておいた合言葉(token)で本人確認する。
 */
function resumeRoom(code, token) {
  code = normCode_(code);
  const room = load_(code);
  if (!room) throw new Error('前の部屋はもうありません。');
  const playerId = idOf_(room, token);
  const p = room.players.find(function (q) { return q.id === playerId; });
  if (!p || p.left) throw new Error('前の部屋にはもう戻れません。');
  touch_(code, playerId);
  return { playerId: playerId, token: token, state: public_(room), away: awayIds_(room) };
}

/** ゲームを始める(終了後の「もう一度」もこれ)。ホストが離席中ならほかの人でも始められる。 */
function startGame(code, token) {
  code = normCode_(code);
  return withLock_(function () {
    const room = mustLoad_(code);
    const playerId = idOf_(room, token);
    claimManage_(room, playerId, 'ゲームを始められるのはホストだけです。');
    if (room.status === 'playing') return { state: public_(room) };
    removeLeftPlayers_(room);
    if (room.players.length < MIN_PLAYERS) throw new Error('2人以上そろうと始められます。');

    room.players.forEach(function (p) { p.alive = true; });
    room.sequence = [];
    room.winnerId = null;
    room.status = 'playing';
    room.turnIndex = 0;
    addEvent_(room, { type: 'start' });
    beginTurn_(room);
    save_(room);
    return { state: public_(room) };
  });
}

/** ボタンを1つ押す(互換用)。 */
function press(code, token, button, pos) {
  return pressBatch(code, token, pos, [button]);
}

/**
 * ボタンをまとめて押す。
 * pos は buttons[0] が「何個目のボタンか」(0始まり)。通信の順番が入れ替わったときに気づくため。
 * 通信中に押されたボタンをまとめて送れるので、速く押しても遅れがたまらない。
 */
function pressBatch(code, token, pos, buttons) {
  code = normCode_(code);
  pos = Number(pos);
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > MAX_BATCH) {
    throw new Error('ボタンの送信内容が正しくありません。');
  }
  buttons = buttons.map(Number);
  buttons.forEach(function (b) {
    if (!(Number.isInteger(b) && b >= 0 && b < BUTTON_COUNT)) throw new Error('ボタン番号が正しくありません。');
  });

  return withLock_(function () {
    const room = mustLoad_(code);
    const playerId = idOf_(room, token);
    touch_(code, playerId);
    if (room.status !== 'playing') return { error: 'not_playing', state: public_(room) };
    const cur = room.players[room.turnIndex];
    if (!cur || cur.id !== playerId) return { error: 'not_your_turn', state: public_(room) };
    if (pos !== room.inputPos) return { error: 'out_of_sync', state: public_(room) };

    const serial = room.turnSerial;
    for (let k = 0; k < buttons.length && room.turnSerial === serial && room.status === 'playing'; k++) {
      const button = buttons[k];
      const p = room.inputPos;
      const seq = room.sequence;
      if (p < seq.length) {
        // 前の人までの並びを再現しているところ
        addEvent_(room, { type: 'press', player: playerId, button: button, pos: p });
        if (seq[p] === button) {
          room.inputPos++;
        } else {
          cur.alive = false;
          addEvent_(room, { type: 'miss', player: playerId, pos: p, expected: seq[p] });
          advance_(room);
        }
      } else {
        // 全部正解して、最後に1つ足した
        seq.push(button);
        addEvent_(room, { type: 'press', player: playerId, button: button, pos: p, added: true });
        advance_(room);
      }
    }
    save_(room);
    return { state: public_(room) };
  });
}

/**
 * 今の番の人をスキップ(脱落扱い)にする。
 * ホストはいつでも、ほかの人は「今の番の人」か「ホスト」が離席しているときだけできる。
 */
function skipCurrent(code, token, targetId) {
  code = normCode_(code);
  return withLock_(function () {
    const room = mustLoad_(code);
    const playerId = idOf_(room, token);
    requireMember_(room, playerId);
    if (room.status !== 'playing') return { state: public_(room) };
    const cur = room.players[room.turnIndex];
    // 押している間に番が変わっていたら、別の人をスキップしないよう取りやめる
    if (targetId && cur.id !== targetId) return { error: 'turn_changed', state: public_(room) };
    const away = awayIds_(room);
    const allowed = room.hostId === playerId
      || away.indexOf(room.hostId) >= 0
      || away.indexOf(cur.id) >= 0;
    if (!allowed) throw new Error('スキップできるのは、ホストか、今の番の人が離席しているときだけです。');
    if (room.hostId !== playerId && away.indexOf(room.hostId) >= 0) room.hostId = playerId;

    cur.alive = false;
    addEvent_(room, { type: 'miss', player: cur.id, reason: 'skip' });
    advance_(room);
    save_(room);
    return { state: public_(room) };
  });
}

/** 待機状態に戻す。ホストが離席中ならほかの人でもできる。 */
function backToLobby(code, token) {
  code = normCode_(code);
  return withLock_(function () {
    const room = mustLoad_(code);
    const playerId = idOf_(room, token);
    claimManage_(room, playerId, '待機に戻せるのはホストだけです。');
    removeLeftPlayers_(room);
    room.status = 'waiting';
    room.sequence = [];
    room.winnerId = null;
    room.turnIndex = 0;
    room.inputPos = 0;
    room.players.forEach(function (p) { p.alive = true; });
    addEvent_(room, { type: 'reset' });
    save_(room);
    return { state: public_(room) };
  });
}

/** 部屋を出る。 */
function leaveRoom(code, token) {
  code = normCode_(code);
  return withLock_(function () {
    const room = load_(code);
    if (!room) return { ok: true };
    const playerId = findId_(room, token);
    if (!playerId) return { ok: true };
    removePlayer_(room, playerId, false);
    return { ok: true };
  });
}

/**
 * ホストがほかの人を強制的に退出させる。
 * ホストが離席中なら、ほかの人でもできる(操作した人がホストになる)。
 */
function kickPlayer(code, token, targetId) {
  code = normCode_(code);
  return withLock_(function () {
    const room = mustLoad_(code);
    const playerId = idOf_(room, token);
    claimManage_(room, playerId, '退出させられるのはホストだけです。');
    if (targetId === playerId) throw new Error('自分は退出させられません。「退出」ボタンを使ってください。');
    const target = room.players.find(function (p) { return p.id === targetId; });
    if (!target || target.left) return { state: public_(room) };
    removePlayer_(room, targetId, true);
    const after = load_(code);
    return { state: after ? public_(after) : null };
  });
}

/** 部屋から1人取り除く(自分で出る・退出させられる の共通処理)。保存までする。 */
function removePlayer_(room, playerId, kicked) {
  const idx = room.players.findIndex(function (p) { return p.id === playerId; });
  if (idx < 0) return;
  const p = room.players[idx];
  if (p.left) return;
  // 合言葉を消して、その人の端末からは操作できないようにする
  if (room.secrets) delete room.secrets[playerId];
  const ev = { type: 'leave', player: p.id, name: p.name, kicked: !!kicked };

  if (room.status === 'playing') {
    // ゲーム中は順番が崩れないよう、リストに残したまま退出扱いにする
    const wasCurrent = idx === room.turnIndex;
    const wasAlive = p.alive;
    p.alive = false;
    p.left = true;
    addEvent_(room, ev);
    if (wasCurrent && wasAlive) {
      advance_(room);
    } else if (aliveCount_(room) <= 1) {
      finish_(room);
    }
  } else {
    room.players.splice(idx, 1);
    room.turnIndex = 0;
    addEvent_(room, ev);
  }

  const remaining = room.players.filter(function (q) { return !q.left; });
  if (remaining.length === 0) {
    cache_().remove(key_(room.code));
    return;
  }
  if (room.hostId === playerId) room.hostId = remaining[0].id;
  save_(room);
}

/**
 * 状態を取る。knownVersion と同じなら中身は返さない(通信量を減らすため)。
 * playerId を渡すと「まだここにいる」と記録する。away は離席中の人のID一覧。
 */
function getState(code, knownVersion, token) {
  code = normCode_(code);
  const room = load_(code);
  if (!room) return { gone: true };
  const playerId = findId_(room, token);
  if (playerId) touch_(code, playerId);
  const away = awayIds_(room);
  if (room.version === knownVersion) return { changed: false, away: away };
  return { changed: true, state: public_(room), away: away };
}

// ============================================================
// ゲームの進行
// ============================================================

function beginTurn_(room) {
  room.inputPos = 0;
  room.turnSerial++;
  addEvent_(room, {
    type: 'turn',
    player: room.players[room.turnIndex].id,
    serial: room.turnSerial,
    length: room.sequence.length
  });
}

/** 次の生き残っている人に番を回す。1人以下なら終了。 */
function advance_(room) {
  if (aliveCount_(room) <= 1) {
    finish_(room);
    return;
  }
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const idx = (room.turnIndex + k) % n;
    if (room.players[idx].alive) {
      room.turnIndex = idx;
      break;
    }
  }
  beginTurn_(room);
}

function finish_(room) {
  const winner = room.players.find(function (p) { return p.alive; }) || null;
  room.status = 'finished';
  room.winnerId = winner ? winner.id : null;
  room.winnerName = winner ? winner.name : null; // 勝った人が退出しても名前を言えるように
  addEvent_(room, { type: 'win', player: room.winnerId, name: room.winnerName, length: room.sequence.length });
}

function aliveCount_(room) {
  return room.players.filter(function (p) { return p.alive; }).length;
}

function removeLeftPlayers_(room) {
  room.players = room.players.filter(function (p) { return !p.left; });
}

// ============================================================
// 参加者のチェック・離席の判定
// ============================================================

/** 合言葉を発行する。 */
function issueToken_(room, id) {
  if (!room.secrets) room.secrets = {};
  const token = Utilities.getUuid();
  room.secrets[id] = token;
  return token;
}

/** 合言葉から公開IDを探す(見つからなければ null)。 */
function findId_(room, token) {
  if (!token || !room.secrets) return null;
  const ids = Object.keys(room.secrets);
  for (let i = 0; i < ids.length; i++) {
    if (room.secrets[ids[i]] === token) return ids[i];
  }
  return null;
}

/** 合言葉から公開IDを探す(見つからなければエラー)。 */
function idOf_(room, token) {
  const id = findId_(room, token);
  if (!id) throw new Error('この部屋の参加者ではありません。');
  return id;
}

/** クライアントに送る用に、合言葉を取り除いたコピーを作る。 */
function public_(room) {
  const copy = Object.assign({}, room);
  delete copy.secrets;
  return copy;
}

function requireMember_(room, playerId) {
  const ok = room.players.some(function (p) { return p.id === playerId && !p.left; });
  if (!ok) throw new Error('この部屋の参加者ではありません。');
}

/** ホスト専用の操作。ホストが離席中なら、操作した人に引き継ぐ。 */
function claimManage_(room, playerId, message) {
  requireMember_(room, playerId);
  if (room.hostId === playerId) return;
  if (awayIds_(room).indexOf(room.hostId) >= 0) {
    room.hostId = playerId;
    return;
  }
  throw new Error(message);
}

function seenKey_(code, id) { return 'seen_' + code + '_' + id; }

function touch_(code, id) {
  cache_().put(seenKey_(code, id), String(Date.now()), ROOM_TTL_SEC);
}

function awayIds_(room) {
  const active = room.players.filter(function (p) { return !p.left; });
  if (active.length === 0) return [];
  const got = cache_().getAll(active.map(function (p) { return seenKey_(room.code, p.id); }));
  const now = Date.now();
  return active
    .filter(function (p) {
      const t = Number(got[seenKey_(room.code, p.id)] || 0);
      return now - t > AWAY_MS;
    })
    .map(function (p) { return p.id; });
}

// ============================================================
// 保存まわり
// ============================================================

function cache_() { return CacheService.getScriptCache(); }
function key_(code) { return 'room_' + code; }

function load_(code) {
  const s = cache_().get(key_(code));
  return s ? JSON.parse(s) : null;
}

function mustLoad_(code) {
  const room = load_(code);
  if (!room) throw new Error('部屋番号 ' + code + ' の部屋が見つかりません。');
  return room;
}

function save_(room) {
  room.version++;
  cache_().put(key_(room.code), JSON.stringify(room), ROOM_TTL_SEC);
}

function addEvent_(room, ev) {
  room.nextEventId++;
  ev.id = room.nextEventId;
  room.events.push(ev);
  if (room.events.length > MAX_EVENTS) {
    room.events.splice(0, room.events.length - MAX_EVENTS);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('混み合っています。もう一度押してください。');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function cleanName_(name, n) {
  const s = String(name || '').trim().slice(0, 12);
  return s || ('プレイヤー' + n);
}

/** 全角数字も受け付けて、4桁の部屋番号にそろえる。 */
function normCode_(code) {
  const s = String(code || '')
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[^0-9]/g, '');
  if (s.length !== 4) throw new Error('部屋番号は4桁の数字です。');
  return s;
}
