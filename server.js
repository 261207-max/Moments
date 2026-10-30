const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { Server: SocketServer } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { maxHttpBufferSize: 1e6 });
const database = new DatabaseSync(process.env.MOMENTS_DB_PATH || path.join(__dirname, "moments.db"));
const googleOAuthClient = new OAuth2Client();
const sessionDuration = 30 * 24 * 60 * 60 * 1000;

database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    image_data TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS post_likes (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('like', 'comment')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id != followed_id)
  );
  CREATE TABLE IF NOT EXISTS follow_notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_time ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS posts_created_at ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

const userColumns = new Set(database.prepare("PRAGMA table_info(users)").all().map(column => column.name));
if (!userColumns.has("email")) database.exec("ALTER TABLE users ADD COLUMN email TEXT");
if (!userColumns.has("google_sub")) database.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;");

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

const statements = {
  userById: database.prepare("SELECT id, username, display_name AS displayName FROM users WHERE id = ?"),
  userByUsername: database.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  userByEmail: database.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  userByGoogleSub: database.prepare("SELECT * FROM users WHERE google_sub = ?"),
  sessionUser: database.prepare(`SELECT users.id, users.username, users.display_name AS displayName
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`),
  member: database.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?"),
};

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const [name, ...value] = part.trim().split("=");
    return [name, decodeURIComponent(value.join("="))];
  }).filter(([name]) => name));
}

function createSession(userId, response) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionDuration;
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expiresAt);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `moments_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDuration / 1000}${secure}`);
}

function requireAuth(request, response, next) {
  const token = readCookies(request.headers.cookie).moments_session;
  const user = token && statements.sessionUser.get(hashToken(token), Date.now());
  if (!user) return response.status(401).json({ error: "로그인이 필요합니다." });
  request.user = user;
  request.sessionToken = token;
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function areMutualFollowers(userId, otherUserId) {
  return Boolean(database.prepare(`SELECT 1 FROM follows mine
    JOIN follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
    WHERE mine.follower_id = ? AND mine.followed_id = ?`).get(userId, otherUserId));
}

function canChatInConversation(conversationId, userId) {
  const otherMember = database.prepare(`SELECT user_id AS userId FROM conversation_members
    WHERE conversation_id = ? AND user_id != ?`).get(conversationId, userId);
  return Boolean(otherMember && areMutualFollowers(userId, otherMember.userId));
}

function getPost(postId, viewerId) {
  const post = database.prepare(`SELECT posts.id, posts.text, posts.image_data AS imageData,
      posts.created_at AS createdAt, users.id AS userId, users.username,
      users.display_name AS displayName,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id) AS likes,
      EXISTS(SELECT 1 FROM post_likes WHERE post_id = posts.id AND user_id = ?) AS liked
    FROM posts JOIN users ON users.id = posts.user_id WHERE posts.id = ?`).get(viewerId, postId);
  if (!post) return null;
  post.comments = database.prepare(`SELECT comments.id, comments.text, comments.created_at AS createdAt,
      users.id AS userId, users.username, users.display_name AS displayName
    FROM comments JOIN users ON users.id = comments.user_id
    WHERE comments.post_id = ? ORDER BY comments.created_at ASC`).all(postId);
  return post;
}

app.get("/", (request, response) => response.redirect("/app"));
app.get("/app", (request, response) => response.sendFile(path.join(__dirname, "index.html")));
app.get("/app.js", (request, response) => response.sendFile(path.join(__dirname, "app.js")));
app.get("/robots.txt", (request, response) => {
  const baseUrl = (process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
  response.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nSitemap: ${baseUrl}/sitemap.xml\n`);
});
app.get("/sitemap.xml", (request, response) => {
  const baseUrl = (process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
  response.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseUrl}/</loc><changefreq>weekly</changefreq></url></urlset>`);
});
app.get("/api/config", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "" });
});

app.post("/api/auth/google", async (request, response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const credential = String(request.body.credential || "");
  if (!clientId) return response.status(503).json({ error: "Google 로그인이 아직 설정되지 않았습니다." });
  if (!credential || credential.length > 10000) return response.status(400).json({ error: "Google 인증 정보를 확인해주세요." });
  try {
    const ticket = await googleOAuthClient.verifyIdToken({ idToken: credential, audience: clientId });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      return response.status(401).json({ error: "인증된 Google 이메일을 확인할 수 없습니다." });
    }
    const email = profile.email.toLowerCase();
    let user = statements.userByGoogleSub.get(profile.sub);
    if (!user) {
      user = statements.userByEmail.get(email);
      if (user?.google_sub && user.google_sub !== profile.sub) {
        return response.status(409).json({ error: "이 이메일은 다른 Google 계정에 연결되어 있습니다." });
      }
      if (user) {
        database.prepare("UPDATE users SET google_sub = ?, email = ?, display_name = ? WHERE id = ?")
          .run(profile.sub, email, String(profile.name || user.display_name).slice(0, 30), user.id);
        user = statements.userByGoogleSub.get(profile.sub);
      } else {
        const baseUsername = (email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 18) || "moments");
        let username = baseUsername;
        while (statements.userByUsername.get(username)) {
          username = `${baseUsername.slice(0, 17)}_${crypto.randomBytes(3).toString("hex")}`;
        }
        const userId = crypto.randomUUID();
        const displayName = String(profile.name || email.split("@")[0]).slice(0, 30);
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
        database.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at, email, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(userId, username, displayName, passwordHash, Date.now(), email, profile.sub);
        user = statements.userByGoogleSub.get(profile.sub);
      }
    }
    createSession(user.id, response);
    response.json({ user: publicUser(user) });
  } catch {
    response.status(401).json({ error: "Google 로그인 검증에 실패했습니다." });
  }
});

app.post("/api/auth/register", async (request, response, next) => {
  try {
    const username = String(request.body.username || "").trim().toLowerCase();
    const displayName = String(request.body.displayName || "").trim();
    const password = String(request.body.password || "");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return response.status(400).json({ error: "아이디는 영문 소문자, 숫자, 밑줄로 3~24자 입력해주세요." });
    if (!displayName || displayName.length > 30) return response.status(400).json({ error: "이름은 1~30자로 입력해주세요." });
    if (password.length < 8 || password.length > 72) return response.status(400).json({ error: "비밀번호는 8~72자로 입력해주세요." });
    const user = { id: crypto.randomUUID(), username, displayName };
    const passwordHash = await bcrypt.hash(password, 12);
    database.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.username, user.displayName, passwordHash, Date.now());
    createSession(user.id, response);
    response.status(201).json({ user });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return response.status(409).json({ error: "이미 사용 중인 아이디입니다." });
    next(error);
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const username = String(request.body.username || "").trim();
    const password = String(request.body.password || "");
    const user = statements.userByUsername.get(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return response.status(401).json({ error: "아이디 또는 비밀번호를 확인해주세요." });
    }
    createSession(user.id, response);
    response.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (request, response) => {
  const token = readCookies(request.headers.cookie).moments_session;
  if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  response.setHeader("Set-Cookie", "moments_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  response.json({ ok: true });
});

app.get("/api/me", requireAuth, (request, response) => response.json({ user: request.user }));

app.patch("/api/me", requireAuth, (request, response) => {
  const displayName = String(request.body.displayName || "").trim();
  if (!displayName || displayName.length > 30) return response.status(400).json({ error: "이름은 1~30자로 입력해주세요." });
  database.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, request.user.id);
  response.json({ user: publicUser(statements.userById.get(request.user.id)) });
});

app.post("/api/users/:id/follow", requireAuth, (request, response) => {
  const followedId = request.params.id;
  if (followedId === request.user.id) return response.status(400).json({ error: "자기 자신은 팔로우할 수 없습니다." });
  if (!statements.userById.get(followedId)) return response.status(404).json({ error: "사용자를 찾을 수 없습니다." });
  const result = database.prepare("INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)")
    .run(request.user.id, followedId, Date.now());
  if (result.changes) {
    const notification = { id: crypto.randomUUID(), type: "follow", userId: request.user.id,
      username: request.user.username, displayName: request.user.displayName, createdAt: Date.now(),
      isFollowing: Boolean(database.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?")
        .get(followedId, request.user.id)) };
    database.prepare("INSERT INTO follow_notifications (id, recipient_id, actor_id, created_at) VALUES (?, ?, ?, ?)")
      .run(notification.id, followedId, request.user.id, notification.createdAt);
    io.to(`user:${followedId}`).emit("notification:new", notification);
  }
  response.json({ following: true, mutual: areMutualFollowers(request.user.id, followedId) });
});

app.delete("/api/users/:id/follow", requireAuth, (request, response) => {
  database.prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?").run(request.user.id, request.params.id);
  response.json({ following: false, mutual: false });
});

app.get("/api/users", requireAuth, (request, response) => {
  const query = String(request.query.q || "").trim().slice(0, 40);
  if (query.length < 2) return response.json({ users: [] });
  const users = database.prepare(`SELECT id, username, display_name AS displayName,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = users.id) AS isFollowing,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = users.id AND followed_id = ?) AS followsYou
    FROM users
    WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) COLLATE NOCASE
    ORDER BY username LIMIT 20`).all(request.user.id, request.user.id, request.user.id, `%${query}%`, `%${query}%`);
  response.json({ users });
});

app.get("/api/conversations", requireAuth, (request, response) => {
  const conversations = database.prepare(`SELECT conversations.id, other.id AS userId,
      other.username, other.display_name AS displayName,
      (SELECT body FROM messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS lastMessage,
      (SELECT created_at FROM messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS lastMessageAt
    FROM conversation_members mine
    JOIN conversations ON conversations.id = mine.conversation_id
    JOIN conversation_members theirs ON theirs.conversation_id = conversations.id AND theirs.user_id != mine.user_id
    JOIN users other ON other.id = theirs.user_id
    WHERE mine.user_id = ?
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = mine.user_id AND followed_id = other.id)
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = other.id AND followed_id = mine.user_id)
    ORDER BY COALESCE(lastMessageAt, conversations.created_at) DESC`).all(request.user.id);
  response.json({ conversations });
});

app.post("/api/conversations", requireAuth, (request, response) => {
  const userId = String(request.body.userId || "");
  if (!userId || userId === request.user.id) return response.status(400).json({ error: "대화할 사용자를 선택해주세요." });
  if (!statements.userById.get(userId)) return response.status(404).json({ error: "사용자를 찾을 수 없습니다." });
  if (!areMutualFollowers(request.user.id, userId)) return response.status(403).json({ error: "서로 팔로우해야 메시지를 주고받을 수 있습니다." });
  let conversation = database.prepare(`SELECT conversations.id FROM conversations
    JOIN conversation_members mine ON mine.conversation_id = conversations.id AND mine.user_id = ?
    JOIN conversation_members theirs ON theirs.conversation_id = conversations.id AND theirs.user_id = ?
    WHERE (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = conversations.id) = 2 LIMIT 1`)
    .get(request.user.id, userId);
  if (!conversation) {
    const id = crypto.randomUUID();
    database.exec("BEGIN");
    try {
      database.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").run(id, Date.now());
      const addMember = database.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)");
      addMember.run(id, request.user.id);
      addMember.run(id, userId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    conversation = { id };
  }
  response.status(201).json({ conversation: { ...conversation, user: publicUser(statements.userById.get(userId)) } });
});

app.get("/api/conversations/:id/messages", requireAuth, (request, response) => {
  if (!statements.member.get(request.params.id, request.user.id)) return response.status(404).json({ error: "대화를 찾을 수 없습니다." });
  if (!canChatInConversation(request.params.id, request.user.id)) return response.status(403).json({ error: "서로 팔로우해야 대화를 볼 수 있습니다." });
  const messages = database.prepare(`SELECT messages.id, messages.conversation_id AS conversationId,
      messages.sender_id AS senderId, messages.body, messages.created_at AS createdAt,
      users.username AS senderUsername, users.display_name AS senderDisplayName
    FROM messages JOIN users ON users.id = messages.sender_id
    WHERE messages.conversation_id = ? ORDER BY messages.created_at ASC LIMIT 500`).all(request.params.id);
  response.json({ messages });
});

app.get("/api/posts", requireAuth, (request, response) => {
  const posts = database.prepare(`SELECT id FROM posts ORDER BY created_at DESC LIMIT 100`).all();
  response.json({ posts: posts.map(post => getPost(post.id, request.user.id)) });
});

app.get("/api/notifications", requireAuth, (request, response) => {
  const notifications = database.prepare(`SELECT notifications.id, notifications.type,
      notifications.post_id AS postId, notifications.created_at AS createdAt,
      users.id AS userId, users.username, users.display_name AS displayName,
      0 AS isFollowing
    FROM notifications JOIN users ON users.id = notifications.actor_id
    WHERE notifications.recipient_id = ? ORDER BY notifications.created_at DESC LIMIT 100`).all(request.user.id);
  const followNotifications = database.prepare(`SELECT follow_notifications.id, 'follow' AS type,
      NULL AS postId, follow_notifications.created_at AS createdAt,
      users.id AS userId, users.username, users.display_name AS displayName,
      EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = users.id) AS isFollowing
    FROM follow_notifications JOIN users ON users.id = follow_notifications.actor_id
    WHERE follow_notifications.recipient_id = ? ORDER BY follow_notifications.created_at DESC LIMIT 100`)
    .all(request.user.id, request.user.id);
  response.json({ notifications: [...notifications, ...followNotifications]
    .sort((left, right) => right.createdAt - left.createdAt).slice(0, 100) });
});

app.post("/api/posts", requireAuth, (request, response) => {
  const text = String(request.body.text || "").trim().slice(0, 1000);
  const imageData = String(request.body.imageData || "");
  if (!text && !imageData) return response.status(400).json({ error: "글이나 사진을 추가해주세요." });
  if (imageData && !/^data:image\/(?:jpeg|png|webp);base64,/.test(imageData)) return response.status(400).json({ error: "JPG, PNG, WEBP 사진만 올릴 수 있어요." });
  const id = crypto.randomUUID();
  database.prepare("INSERT INTO posts (id, user_id, text, image_data, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, request.user.id, text, imageData, Date.now());
  response.status(201).json({ post: getPost(id, request.user.id) });
});

app.post("/api/posts/:id/like", requireAuth, (request, response) => {
  if (!database.prepare("SELECT 1 FROM posts WHERE id = ?").get(request.params.id)) return response.status(404).json({ error: "게시물을 찾을 수 없습니다." });
  const existing = database.prepare("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?").get(request.params.id, request.user.id);
  if (existing) database.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?").run(request.params.id, request.user.id);
  else {
    database.prepare("INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)").run(request.params.id, request.user.id, Date.now());
    const owner = database.prepare("SELECT user_id FROM posts WHERE id = ?").get(request.params.id);
    if (owner.user_id !== request.user.id) {
      database.prepare("INSERT INTO notifications (id, recipient_id, actor_id, post_id, type, created_at) VALUES (?, ?, ?, ?, 'like', ?)")
        .run(crypto.randomUUID(), owner.user_id, request.user.id, request.params.id, Date.now());
    }
  }
  response.json({ post: getPost(request.params.id, request.user.id) });
});

app.post("/api/posts/:id/comments", requireAuth, (request, response) => {
  const text = String(request.body.text || "").trim().slice(0, 240);
  if (!text) return response.status(400).json({ error: "댓글을 입력해주세요." });
  if (!database.prepare("SELECT 1 FROM posts WHERE id = ?").get(request.params.id)) return response.status(404).json({ error: "게시물을 찾을 수 없습니다." });
  database.prepare("INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), request.params.id, request.user.id, text, Date.now());
  const owner = database.prepare("SELECT user_id FROM posts WHERE id = ?").get(request.params.id);
  if (owner.user_id !== request.user.id) {
    database.prepare("INSERT INTO notifications (id, recipient_id, actor_id, post_id, type, created_at) VALUES (?, ?, ?, ?, 'comment', ?)")
      .run(crypto.randomUUID(), owner.user_id, request.user.id, request.params.id, Date.now());
  }
  response.status(201).json({ post: getPost(request.params.id, request.user.id) });
});

io.use((socket, next) => {
  const token = readCookies(socket.handshake.headers.cookie).moments_session;
  const user = token && statements.sessionUser.get(hashToken(token), Date.now());
  if (!user) return next(new Error("인증이 필요합니다."));
  socket.user = user;
  next();
});

io.on("connection", socket => {
  socket.join(`user:${socket.user.id}`);
  socket.on("conversation:join", (conversationId, callback = () => {}) => {
    if (typeof conversationId !== "string" || !statements.member.get(conversationId, socket.user.id)
      || !canChatInConversation(conversationId, socket.user.id)) {
      callback({ error: "대화에 참여할 수 없습니다." });
      return;
    }
    socket.join(`conversation:${conversationId}`);
    callback({ ok: true });
  });

  socket.on("message:send", (payload = {}, callback = () => {}) => {
    const conversationId = String(payload.conversationId || "");
    const body = String(payload.body || "").trim();
    if (!conversationId || !body || body.length > 2000) {
      callback({ error: "메시지는 1~2000자로 입력해주세요." });
      return;
    }
    if (!statements.member.get(conversationId, socket.user.id) || !canChatInConversation(conversationId, socket.user.id)) {
      callback({ error: "대화에 참여할 수 없습니다." });
      return;
    }
    const message = {
      id: crypto.randomUUID(),
      conversationId,
      senderId: socket.user.id,
      senderUsername: socket.user.username,
      senderDisplayName: socket.user.displayName,
      body,
      createdAt: Date.now(),
    };
    database.prepare("INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(message.id, conversationId, socket.user.id, body, message.createdAt);
    io.to(`conversation:${conversationId}`).emit("message:new", message);
    callback({ message });
  });
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: "서버 오류가 발생했습니다." });
});

const port = Number(process.env.PORT || 3000);
setInterval(() => database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()), 60 * 60 * 1000).unref();
server.listen(port, "0.0.0.0", () => {
  console.log(`Moments server listening on http://0.0.0.0:${port}`);
});