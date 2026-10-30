const path = require("node:path");
const { createInterface } = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");

const database = new DatabaseSync(process.env.MOMENTS_DB_PATH || path.join(__dirname, "moments.db"));

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("비밀번호를 안전하게 입력하려면 터미널에서 직접 실행해주세요."));
      return;
    }
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = chunk => {
      const input = chunk.toString("utf8");
      if (input === "\u0003") {
        cleanup();
        reject(new Error("비밀번호 재설정을 취소했습니다."));
        return;
      }
      if (input === "\r" || input === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (input === "\u007f" || input === "\b") value = value.slice(0, -1);
      else if (!input.startsWith("\u001b")) value += input;
    };
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const username = (await prompt.question("재설정할 아이디: ")).trim().toLowerCase();
  prompt.close();
  const user = database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user) throw new Error("해당 아이디를 moments.db에서 찾을 수 없습니다.");

  const password = await promptHidden("새 비밀번호 (8~72자): ");
  if (password.length < 8 || password.length > 72) throw new Error("비밀번호는 8~72자로 입력해주세요.");
  const confirmation = await promptHidden("새 비밀번호 확인: ");
  if (password !== confirmation) throw new Error("비밀번호가 서로 다릅니다. 다시 실행해주세요.");

  const passwordHash = await bcrypt.hash(password, 12);
  database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
  database.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  console.log("비밀번호를 변경했습니다. 새 비밀번호로 로그인해주세요.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => database.close());