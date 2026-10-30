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
const io = new SocketServer(server, { maxHttpBufferSize: 5e6 });
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
    created_at INTEGER NOT NULL,
    group_name TEXT
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
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    image_data TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, viewer_id)
  );
  CREATE TABLE IF NOT EXISTS reels (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    youtube_id TEXT NOT NULL UNIQUE,
    caption TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reel_likes (
    reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (reel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS reel_views (
    reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    watch_ms INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    last_watched_at INTEGER NOT NULL,
    PRIMARY KEY (reel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS youtube_reel_signals (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    youtube_id TEXT NOT NULL,
    title TEXT NOT NULL,
    channel_title TEXT NOT NULL,
    watch_ms INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    liked INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, youtube_id)
  );
  CREATE TABLE IF NOT EXISTS youtube_feed_cache (
    cache_key TEXT PRIMARY KEY,
    videos_json TEXT NOT NULL,
    next_page_token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_time ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS posts_created_at ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS reels_created_at ON reels(created_at DESC);
`);

const userColumns = new Set(database.prepare("PRAGMA table_info(users)").all().map(column => column.name));
if (!userColumns.has("email")) database.exec("ALTER TABLE users ADD COLUMN email TEXT");
if (!userColumns.has("google_sub")) database.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
const messageColumns = new Set(database.prepare("PRAGMA table_info(messages)").all().map(column => column.name));
if (!messageColumns.has("image_data")) database.exec("ALTER TABLE messages ADD COLUMN image_data TEXT NOT NULL DEFAULT ''");
const conversationColumns = new Set(database.prepare("PRAGMA table_info(conversations)").all().map(column => column.name));
if (!conversationColumns.has("group_name")) database.exec("ALTER TABLE conversations ADD COLUMN group_name TEXT");
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
  const members = database.prepare(`SELECT user_id AS userId FROM conversation_members
    WHERE conversation_id = ?`).all(conversationId);
  if (!members.some(member => member.userId === userId)) return false;
  if (members.length > 2) return true;
  const otherMember = members.find(member => member.userId !== userId);
  return Boolean(otherMember && areMutualFollowers(userId, otherMember.userId));
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    let id = "";
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" || parts[0] === "embed") id = parts[1] || "";
      else if (parts[0] === "watch") id = url.searchParams.get("v") || "";
    } else if (host === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function reelKeywords(caption) {
  const ignored = new Set(["youtube", "shorts", "short", "moments", "릴스", "쇼츠", "영상", "오늘", "정말", "그리고"]);
  return [...new Set(String(caption).toLowerCase().match(/[a-z0-9가-힣]{2,}/g) || [])]
    .filter(keyword => !ignored.has(keyword));
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
    if (error.errcode === 2067) return response.status(409).json({ error: "이미 사용 중인 아이디입니다." });
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
      , EXISTS(SELECT 1 FROM follows mine JOIN follows theirs
        ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
        WHERE mine.follower_id = ? AND mine.followed_id = users.id) AS canGroup
    FROM users
    WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) COLLATE NOCASE
    ORDER BY username LIMIT 20`).all(request.user.id, request.user.id, request.user.id, request.user.id, `%${query}%`, `%${query}%`);
  response.json({ users });
});

app.get("/api/conversations", requireAuth, (request, response) => {
  const conversations = database.prepare(`SELECT conversations.id,
      CASE WHEN COUNT(other.id) = 1 THEN MAX(other.id) ELSE NULL END AS userId,
      CASE WHEN COUNT(other.id) = 1 THEN MAX(other.username) ELSE '' END AS username,
      COALESCE(conversations.group_name, MAX(other.display_name)) AS displayName,
      conversations.group_name AS groupName, COUNT(other.id) + 1 AS memberCount,
      GROUP_CONCAT(other.display_name, ', ') AS memberNames,
      (SELECT CASE WHEN body != '' THEN body ELSE '사진을 보냈습니다.' END FROM messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS lastMessage,
      (SELECT created_at FROM messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS lastMessageAt
    FROM conversation_members mine
    JOIN conversations ON conversations.id = mine.conversation_id
    JOIN conversation_members theirs ON theirs.conversation_id = conversations.id AND theirs.user_id != mine.user_id
    JOIN users other ON other.id = theirs.user_id
    WHERE mine.user_id = ? AND (conversations.group_name IS NOT NULL OR (
      (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = conversations.id) = 2
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = mine.user_id AND followed_id = other.id)
      AND EXISTS(SELECT 1 FROM follows WHERE follower_id = other.id AND followed_id = mine.user_id)))
    GROUP BY conversations.id
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

app.post("/api/conversations/group", requireAuth, (request, response) => {
  const userIds = [...new Set((Array.isArray(request.body.userIds) ? request.body.userIds : []).map(String))]
    .filter(userId => userId !== request.user.id);
  if (userIds.length < 2 || userIds.length > 9) {
    return response.status(400).json({ error: "그룹 대화에는 나를 제외하고 2~9명을 선택해주세요." });
  }
  const participants = userIds.map(userId => statements.userById.get(userId));
  if (participants.some(user => !user)) return response.status(404).json({ error: "선택한 사용자 중 찾을 수 없는 계정이 있습니다." });
  if (userIds.some(userId => !areMutualFollowers(request.user.id, userId))) {
    return response.status(403).json({ error: "그룹에 초대하려면 각 사용자와 서로 팔로우해야 합니다." });
  }
  const groupName = String(request.body.groupName || "").trim().slice(0, 30)
    || participants.map(user => user.displayName).join(", ").slice(0, 30);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  database.exec("BEGIN");
  try {
    database.prepare("INSERT INTO conversations (id, created_at, group_name) VALUES (?, ?, ?)").run(id, createdAt, groupName);
    const addMember = database.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)");
    addMember.run(id, request.user.id);
    userIds.forEach(userId => addMember.run(id, userId));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  response.status(201).json({ conversation: { id, groupName, displayName: groupName, memberCount: userIds.length + 1 } });
});

app.get("/api/stories", requireAuth, (request, response) => {
  const now = Date.now();
  database.prepare("DELETE FROM stories WHERE expires_at <= ?").run(now);
  const stories = database.prepare(`SELECT stories.id, stories.user_id AS userId,
      stories.caption, stories.created_at AS createdAt,
      stories.expires_at AS expiresAt, users.username, users.display_name AS displayName,
      EXISTS(SELECT 1 FROM story_views WHERE story_id = stories.id AND viewer_id = ?) AS viewed,
      (SELECT COUNT(*) FROM story_views WHERE story_id = stories.id) AS views
    FROM stories JOIN users ON users.id = stories.user_id
    WHERE stories.expires_at > ? AND (stories.user_id = ? OR EXISTS(
      SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = stories.user_id))
    ORDER BY stories.created_at DESC LIMIT 100`).all(request.user.id, now, request.user.id, request.user.id);
  response.json({ stories });
});

app.get("/api/stories/:id", requireAuth, (request, response) => {
  const story = database.prepare(`SELECT stories.id, stories.user_id AS userId,
      stories.image_data AS imageData, stories.caption, stories.created_at AS createdAt,
      stories.expires_at AS expiresAt, users.username, users.display_name AS displayName
    FROM stories JOIN users ON users.id = stories.user_id
    WHERE stories.id = ? AND stories.expires_at > ?`).get(request.params.id, Date.now());
  if (!story || (story.userId !== request.user.id
    && !database.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?").get(request.user.id, story.userId))) {
    return response.status(404).json({ error: "스토리가 없거나 만료되었습니다." });
  }
  response.json({ story });
});

app.post("/api/stories", requireAuth, (request, response) => {
  const imageData = String(request.body.imageData || "");
  const caption = String(request.body.caption || "").trim().slice(0, 240);
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) || imageData.length > 4_000_000) {
    return response.status(400).json({ error: "스토리는 4MB 이하의 JPG, PNG, WEBP 사진으로 올려주세요." });
  }
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + 24 * 60 * 60 * 1000;
  database.prepare("INSERT INTO stories (id, user_id, image_data, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, request.user.id, imageData, caption, createdAt, expiresAt);
  response.status(201).json({ story: { id, userId: request.user.id, imageData, caption, createdAt, expiresAt, username: request.user.username, displayName: request.user.displayName, viewed: 0, views: 0 } });
});

app.post("/api/stories/:id/view", requireAuth, (request, response) => {
  const story = database.prepare("SELECT user_id AS userId FROM stories WHERE id = ? AND expires_at > ?")
    .get(request.params.id, Date.now());
  if (!story) return response.status(404).json({ error: "스토리가 없거나 만료되었습니다." });
  if (story.userId !== request.user.id
    && !database.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?").get(request.user.id, story.userId)) return response.status(404).json({ error: "스토리를 찾을 수 없습니다." });
  if (story.userId !== request.user.id) {
    database.prepare("INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)")
      .run(request.params.id, request.user.id, Date.now());
  }
  response.json({ ok: true });
});

app.get("/api/conversations/:id/messages", requireAuth, (request, response) => {
  if (!statements.member.get(request.params.id, request.user.id)) return response.status(404).json({ error: "대화를 찾을 수 없습니다." });
  if (!canChatInConversation(request.params.id, request.user.id)) return response.status(403).json({ error: "서로 팔로우해야 대화를 볼 수 있습니다." });
  const messages = database.prepare(`SELECT messages.id, messages.conversation_id AS conversationId,
      messages.sender_id AS senderId, messages.body, messages.image_data AS imageData, messages.created_at AS createdAt,
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

app.get("/api/reels", requireAuth, (request, response) => {
  const reels = database.prepare(`SELECT reels.id, reels.youtube_id AS youtubeId, reels.caption,
      reels.created_at AS createdAt, users.id AS userId, users.username AS creatorUsername,
      users.display_name AS creatorDisplayName,
      (SELECT COUNT(*) FROM reel_likes WHERE reel_id = reels.id) AS likes,
      EXISTS(SELECT 1 FROM reel_likes WHERE reel_id = reels.id AND user_id = ?) AS liked,
      COALESCE((SELECT watch_ms FROM reel_views WHERE reel_id = reels.id AND user_id = ?), 0) AS watchMs,
      COALESCE((SELECT completed FROM reel_views WHERE reel_id = reels.id AND user_id = ?), 0) AS completed,
      (SELECT COUNT(*) FROM reel_views WHERE reel_id = reels.id) AS viewCount,
      (SELECT COALESCE(SUM(completed), 0) FROM reel_views WHERE reel_id = reels.id) AS completionCount
    FROM reels JOIN users ON users.id = reels.user_id ORDER BY reels.created_at DESC LIMIT 100`)
    .all(request.user.id, request.user.id, request.user.id);
  if (request.query.sort === "latest") {
    return response.json({ reels: reels.map(reel => ({ ...reel, recommendationReason: "최신" })) });
  }
  const preferences = new Map();
  for (const reel of reels) {
    if (!reel.liked && !reel.completed && reel.watchMs < 10000) continue;
    const weight = reel.liked ? 3 : reel.completed ? 2 : 1;
    for (const keyword of reelKeywords(reel.caption)) {
      preferences.set(keyword, (preferences.get(keyword) || 0) + weight);
    }
  }
  const ranked = reels.map(reel => {
    const keywords = reelKeywords(reel.caption);
    const interestScore = keywords.reduce((sum, keyword) => sum + (preferences.get(keyword) || 0), 0)
      / Math.max(1, keywords.length);
    const popularityScore = Math.log1p(reel.likes) * 0.7
      + Math.log1p(reel.completionCount) * 1.4
      + Math.log1p(reel.viewCount) * 0.2;
    const ageDays = Math.max(0, (Date.now() - reel.createdAt) / 86400000);
    const freshnessScore = Math.max(0, 1 - ageDays / 14);
    const watchedPenalty = reel.watchMs > 30000 && !reel.liked ? 1 : 0;
    const score = interestScore * 2.5 + popularityScore + freshnessScore - watchedPenalty;
    return { ...reel, recommendationReason: interestScore > 0 ? "관심 주제" : popularityScore > 0.8 ? "인기 영상" : "새 영상", score };
  }).sort((left, right) => right.score - left.score || right.createdAt - left.createdAt);
  response.json({ reels: ranked.map(({ score, ...reel }) => reel) });
});

app.post("/api/reels", requireAuth, (request, response) => {
  const youtubeId = youtubeVideoId(String(request.body.url || "").trim());
  const caption = String(request.body.caption || "").trim().slice(0, 240);
  if (!youtubeId) return response.status(400).json({ error: "유효한 YouTube Shorts 또는 동영상 링크를 입력해주세요." });
  if (!caption) return response.status(400).json({ error: "영상 소개를 입력해주세요." });
  const id = crypto.randomUUID();
  try {
    database.prepare("INSERT INTO reels (id, user_id, youtube_id, caption, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, request.user.id, youtubeId, caption, Date.now());
  } catch (error) {
    if (error.errcode === 2067) return response.status(409).json({ error: "이미 릴스에 추가된 영상입니다." });
    throw error;
  }
  response.status(201).json({ id, youtubeId, caption });
});

app.post("/api/reels/:id/like", requireAuth, (request, response) => {
  if (!database.prepare("SELECT 1 FROM reels WHERE id = ?").get(request.params.id)) {
    return response.status(404).json({ error: "릴스를 찾을 수 없습니다." });
  }
  const existing = database.prepare("SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?")
    .get(request.params.id, request.user.id);
  if (existing) database.prepare("DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?")
    .run(request.params.id, request.user.id);
  else database.prepare("INSERT INTO reel_likes (reel_id, user_id, created_at) VALUES (?, ?, ?)")
    .run(request.params.id, request.user.id, Date.now());
  response.json({ liked: !existing });
});

app.post("/api/reels/:id/watch", requireAuth, (request, response) => {
  if (!database.prepare("SELECT 1 FROM reels WHERE id = ?").get(request.params.id)) {
    return response.status(404).json({ error: "릴스를 찾을 수 없습니다." });
  }
  const watchMs = Number(request.body.watchMs);
  if (!Number.isFinite(watchMs) || watchMs < 0 || watchMs > 3600000) {
    return response.status(400).json({ error: "시청 기록을 확인해주세요." });
  }
  const completed = request.body.completed === true ? 1 : 0;
  database.prepare(`INSERT INTO reel_views (reel_id, user_id, watch_ms, completed, last_watched_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(reel_id, user_id) DO UPDATE SET
      watch_ms = MAX(reel_views.watch_ms, excluded.watch_ms),
      completed = MAX(reel_views.completed, excluded.completed),
      last_watched_at = excluded.last_watched_at`)
    .run(request.params.id, request.user.id, Math.round(watchMs), completed, Date.now());
  response.json({ ok: true });
});

app.get("/api/reels/recommendations", requireAuth, async (request, response) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return response.json({ configured: false, videos: [], nextPageToken: "" });
  const pageToken = String(request.query.pageToken || "").slice(0, 500);
  const sort = request.query.sort === "latest" ? "date" : "relevance";
  const manualSignals = database.prepare(`SELECT reels.caption, reel_likes.user_id AS liked,
      COALESCE(reel_views.watch_ms, 0) AS watchMs, COALESCE(reel_views.completed, 0) AS completed
    FROM reels
    LEFT JOIN reel_likes ON reel_likes.reel_id = reels.id AND reel_likes.user_id = ?
    LEFT JOIN reel_views ON reel_views.reel_id = reels.id AND reel_views.user_id = ?
    WHERE reel_likes.user_id IS NOT NULL OR reel_views.watch_ms >= 10000 OR reel_views.completed = 1`)
    .all(request.user.id, request.user.id);
  const youtubeSignals = database.prepare("SELECT youtube_id, title, watch_ms AS watchMs, completed, liked FROM youtube_reel_signals WHERE user_id = ?")
    .all(request.user.id);
  const preferences = new Map();
  for (const signal of [...manualSignals, ...youtubeSignals]) {
    const weight = signal.liked ? 3 : signal.completed ? 2 : 1;
    for (const keyword of reelKeywords(signal.caption || signal.title)) {
      preferences.set(keyword, (preferences.get(keyword) || 0) + weight);
    }
  }
  const topics = [...preferences].sort((left, right) => right[1] - left[1]).slice(0, 2).map(([keyword]) => keyword);
  const query = `#shorts ${topics.join(" ")}`.trim();
  const cacheKey = crypto.createHash("sha256").update(`${query}|${sort}|${pageToken}`).digest("hex");
  let cached = database.prepare("SELECT videos_json AS videosJson, next_page_token AS nextPageToken FROM youtube_feed_cache WHERE cache_key = ? AND expires_at > ?")
    .get(cacheKey, Date.now());
  if (!cached) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.search = new URLSearchParams({
        part: "snippet",
        type: "video",
        videoDuration: "short",
        videoEmbeddable: "true",
        maxResults: "15",
        order: sort,
        q: query,
        key: apiKey,
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const youtubeResponse = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!youtubeResponse.ok) return response.status(502).json({ error: "YouTube 검색에 실패했습니다. API 키와 할당량을 확인해주세요." });
      const payload = await youtubeResponse.json();
      const videos = (payload.items || []).filter(item => /^[A-Za-z0-9_-]{11}$/.test(item.id?.videoId || ""))
        .map(item => ({
          youtubeId: item.id.videoId,
          title: String(item.snippet?.title || "YouTube Shorts").slice(0, 240),
          channelTitle: String(item.snippet?.channelTitle || "YouTube").slice(0, 100),
          publishedAt: item.snippet?.publishedAt || "",
        }));
      cached = { videosJson: JSON.stringify(videos), nextPageToken: payload.nextPageToken || "" };
      database.prepare(`INSERT INTO youtube_feed_cache (cache_key, videos_json, next_page_token, expires_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET
          videos_json = excluded.videos_json, next_page_token = excluded.next_page_token, expires_at = excluded.expires_at`)
        .run(cacheKey, cached.videosJson, cached.nextPageToken, Date.now() + 60 * 60 * 1000);
    } catch {
      return response.status(502).json({ error: "YouTube 추천 영상을 불러오지 못했습니다. 잠시 후 다시 시도해주세요." });
    }
  }
  const userSignals = new Map(youtubeSignals.map(signal => [signal.youtube_id, signal]));
  const manualVideoIds = new Set(database.prepare("SELECT youtube_id AS youtubeId FROM reels").all().map(reel => reel.youtubeId));
  const videos = JSON.parse(cached.videosJson).filter(video => !manualVideoIds.has(video.youtubeId)).map(video => {
    const signal = userSignals.get(video.youtubeId);
    const topicsMatched = reelKeywords(video.title).filter(keyword => preferences.has(keyword)).length;
    const ageDays = video.publishedAt ? Math.max(0, (Date.now() - Date.parse(video.publishedAt)) / 86400000) : 14;
    return {
      id: `youtube-${video.youtubeId}`,
      source: "youtube",
      youtubeId: video.youtubeId,
      caption: video.title,
      creatorUsername: video.channelTitle,
      creatorDisplayName: video.channelTitle,
      createdAt: Date.parse(video.publishedAt) || Date.now(),
      likes: database.prepare("SELECT COUNT(*) AS count FROM youtube_reel_signals WHERE youtube_id = ? AND liked = 1")
        .get(video.youtubeId).count,
      liked: Boolean(signal?.liked),
      watchMs: signal?.watchMs || 0,
      completed: signal?.completed || 0,
      recommendationReason: topicsMatched ? "관심 주제" : "YouTube Shorts",
      rankScore: topicsMatched * 2 + Math.max(0, 1 - ageDays / 14),
    };
  }).sort((left, right) => right.rankScore - left.rankScore || right.createdAt - left.createdAt)
    .map(({ rankScore, ...video }) => video);
  response.json({ configured: true, videos, nextPageToken: cached.nextPageToken });
});

app.post("/api/reels/youtube/:videoId/like", requireAuth, (request, response) => {
  const youtubeId = request.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return response.status(400).json({ error: "YouTube 영상 ID를 확인해주세요." });
  const title = String(request.body.title || "YouTube Shorts").slice(0, 240);
  const channelTitle = String(request.body.channelTitle || "YouTube").slice(0, 100);
  const existing = database.prepare("SELECT liked FROM youtube_reel_signals WHERE user_id = ? AND youtube_id = ?")
    .get(request.user.id, youtubeId);
  const liked = !existing?.liked;
  database.prepare(`INSERT INTO youtube_reel_signals (user_id, youtube_id, title, channel_title, liked, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, youtube_id) DO UPDATE SET
      title = excluded.title, channel_title = excluded.channel_title,
      liked = excluded.liked, updated_at = excluded.updated_at`)
    .run(request.user.id, youtubeId, title, channelTitle, liked ? 1 : 0, Date.now());
  response.json({ liked });
});

app.post("/api/reels/youtube/:videoId/watch", requireAuth, (request, response) => {
  const youtubeId = request.params.videoId;
  const watchMs = Number(request.body.watchMs);
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return response.status(400).json({ error: "YouTube 영상 ID를 확인해주세요." });
  if (!Number.isFinite(watchMs) || watchMs < 0 || watchMs > 3600000) return response.status(400).json({ error: "시청 기록을 확인해주세요." });
  const title = String(request.body.title || "YouTube Shorts").slice(0, 240);
  const channelTitle = String(request.body.channelTitle || "YouTube").slice(0, 100);
  const completed = request.body.completed === true ? 1 : 0;
  database.prepare(`INSERT INTO youtube_reel_signals (user_id, youtube_id, title, channel_title, watch_ms, completed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, youtube_id) DO UPDATE SET
      title = excluded.title, channel_title = excluded.channel_title,
      watch_ms = MAX(youtube_reel_signals.watch_ms, excluded.watch_ms),
      completed = MAX(youtube_reel_signals.completed, excluded.completed), updated_at = excluded.updated_at`)
    .run(request.user.id, youtubeId, title, channelTitle, Math.round(watchMs), completed, Date.now());
  response.json({ ok: true });
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
    const imageData = String(payload.imageData || "");
    if (!conversationId || (!body && !imageData) || body.length > 2000
      || imageData.length > 4_000_000
      || (imageData && !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData))) {
      callback({ error: "메시지는 2,000자 이하로 입력하고, 사진은 JPG·PNG·WEBP 형식으로 첨부해주세요." });
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
      imageData,
      createdAt: Date.now(),
    };
    database.prepare("INSERT INTO messages (id, conversation_id, sender_id, body, image_data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, conversationId, socket.user.id, body, imageData, message.createdAt);
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