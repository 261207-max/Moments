const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const database = new DatabaseSync(process.env.MOMENTS_DB_PATH || path.join(__dirname, "moments.db"));

try {
  const username = String(process.argv[2] || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new Error("사용법: npm run grant-developer -- 가입한_아이디");
  }

  const columns = new Set(database.prepare("PRAGMA table_info(users)").all().map(column => column.name));
  if (!columns.has("role")) database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'developer'))");
  database.exec(`CREATE TABLE IF NOT EXISTS account_roles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    updated_at INTEGER NOT NULL
  )`);
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_single_developer ON users(role) WHERE role = 'developer'");

  const user = database.prepare("SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user) throw new Error(`@${username} 계정이 없습니다. 먼저 앱에서 해당 아이디로 가입해주세요.`);
  const currentDeveloper = database.prepare("SELECT id, username FROM users WHERE role = 'developer'").get();
  if (currentDeveloper && currentDeveloper.id !== user.id) {
    throw new Error(`개발자 권한은 @${currentDeveloper.username} 계정에 이미 지정되어 있습니다.`);
  }

  database.prepare("DELETE FROM account_roles WHERE user_id = ?").run(user.id);
  database.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(user.id);
  console.log(`@${user.username} 계정에 개발자 권한을 부여했습니다. 다시 로그인하면 개발자 콘솔이 표시됩니다.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  database.close();
}