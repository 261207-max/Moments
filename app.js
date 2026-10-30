const state = {
  user: null,
  posts: [],
  conversations: [],
  notifications: [],
  messages: new Map(),
  activeConversationId: null,
  socket: null,
  storyUserId: null,
};

const app = document.getElementById("app");
const authScreen = document.getElementById("authScreen");
const viewIds = ["home", "explore", "notifications", "profile", "settings"];
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const initials = name => Array.from(String(name || ""))[0] || "?";
const formatTime = timestamp => new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "요청을 처리하지 못했습니다.");
  return result;
}

function showError(message) {
  document.getElementById("authError").textContent = message;
}

async function setupGoogleLogin() {
  const button = document.getElementById("googleButton");
  const note = document.getElementById("googleNote");
  try {
    const { googleClientId } = await api("/api/config");
    if (!googleClientId) {
      note.textContent = "Google 로그인을 사용하려면 서버에 GOOGLE_CLIENT_ID 설정이 필요합니다.";
      return;
    }
    const renderGoogleButton = () => {
      if (!window.google?.accounts?.id) return false;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async ({ credential }) => {
          showError("");
          try {
            const result = await api("/api/auth/google", {
              method: "POST",
              body: JSON.stringify({ credential }),
            });
            state.user = result.user;
            showApp();
          } catch (error) {
            showError(error.message);
          }
        },
      });
      window.google.accounts.id.renderButton(button, {
        theme: "outline",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        width: Math.min(280, Math.floor(button.getBoundingClientRect().width || 280)),
      });
      note.textContent = "Google 계정으로 간편하게 시작하세요.";
      return true;
    };

    if (renderGoogleButton()) return;
    const googleScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    googleScript.addEventListener("load", () => {
      if (!renderGoogleButton()) note.textContent = "Google 로그인 스크립트를 불러오지 못했습니다.";
    }, { once: true });
    googleScript.addEventListener("error", () => {
      note.textContent = "Google 로그인에 연결할 수 없습니다.";
    }, { once: true });
  } catch (error) {
    note.textContent = error.message;
  }
}

function showAuth() {
  state.user = null;
  if (state.socket) state.socket.disconnect();
  authScreen.hidden = false;
  app.hidden = true;
}

function showApp() {
  authScreen.hidden = true;
  app.hidden = false;
  document.getElementById("displayName").value = state.user.displayName;
  document.getElementById("usernameDisplay").value = `@${state.user.username}`;
  document.getElementById("railAvatar").textContent = initials(state.user.displayName);
  document.getElementById("profileInitial").textContent = initials(state.user.displayName);
  document.getElementById("profileName").textContent = state.user.displayName;
  document.getElementById("sideProfileName").textContent = state.user.displayName;
  loadAppData();
  connectSocket();
  setView("home");
}

async function loadAppData() {
  try {
    const [postResult, conversationResult, notificationResult] = await Promise.all([
      api("/api/posts"),
      api("/api/conversations"),
      api("/api/notifications"),
    ]);
    state.posts = postResult.posts;
    state.conversations = conversationResult.conversations;
    state.notifications = notificationResult.notifications;
    renderAll();
  } catch (error) {
    if (error.message.includes("로그인")) showAuth();
    else alert(error.message);
  }
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = window.io({ withCredentials: true });
  state.socket.on("connect", () => {
    if (state.activeConversationId) joinConversation(state.activeConversationId);
  });
  state.socket.on("message:new", message => {
    const messages = state.messages.get(message.conversationId) || [];
    if (!messages.some(existing => existing.id === message.id)) {
      messages.push(message);
      state.messages.set(message.conversationId, messages);
    }
    const conversation = state.conversations.find(item => item.id === message.conversationId);
    if (conversation) {
      conversation.lastMessage = message.body;
      conversation.lastMessageAt = message.createdAt;
    }
    renderThreads();
    if (state.activeConversationId === message.conversationId) renderMessages();
  });
  state.socket.on("notification:new", notification => {
    if (state.notifications.some(item => item.id === notification.id)) return;
    state.notifications.unshift(notification);
    state.notifications = state.notifications.slice(0, 100);
    renderNotifications();
    const userSearch = document.getElementById("userSearch");
    if (document.getElementById("newChatDialog").open && userSearch.value.trim().length >= 2) {
      searchUsers(userSearch.value);
    }
  });
  state.socket.on("connect_error", error => {
    if (error.message.includes("인증")) showAuth();
  });
}

function setView(view) {
  app.dataset.view = view === "messages" ? "messages" : view;
  viewIds.forEach(id => {
    document.getElementById(`${id}View`).hidden = id !== view;
  });
  document.querySelector(".inbox").hidden = view !== "messages";
  document.querySelector(".chat").hidden = view !== "messages" || !state.activeConversationId;
  app.classList.toggle("show-chat", view === "messages" && Boolean(state.activeConversationId));
  document.querySelectorAll(".rail-button[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (view === "messages") renderThreads();
}

function renderStories() {
  const authors = new Map();
  for (const post of state.posts) {
    if (!authors.has(post.userId)) authors.set(post.userId, post);
  }
  const stories = [
    `<button class="story" type="button" data-story="mine" aria-label="내 모먼츠 작성"><span class="story-ring"><span>${escapeHtml(initials(state.user.displayName))}</span></span><span class="story-name">내 모먼츠</span></button>`,
    ...[...authors.values()].filter(post => post.userId !== state.user.id).map(post => `<button class="story" type="button" data-story="${escapeHtml(post.userId)}" aria-label="${escapeHtml(post.displayName)}의 모먼츠"><span class="story-ring"><span>${escapeHtml(initials(post.displayName))}</span></span><span class="story-name">${escapeHtml(post.username)}</span></button>`),
  ];
  document.getElementById("stories").innerHTML = stories.join("");
}

function emptyState(title, message) {
  return `<div class="empty-feed"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

function renderPost(post) {
  const comments = (post.comments || []).map(comment => `<div class="comment"><strong>${escapeHtml(comment.displayName)}</strong>${escapeHtml(comment.text)}</div>`).join("");
  const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(post.createdAt));
  return `<article class="post-card" data-post="${escapeHtml(post.id)}"><div class="post-head"><span class="initial-avatar">${escapeHtml(initials(post.displayName))}</span><div><div class="post-author">${escapeHtml(post.username)}</div><div class="post-time">${escapeHtml(date)}</div></div></div>${post.text ? `<p class="post-copy">${escapeHtml(post.text)}</p>` : ""}${post.imageData ? `<img class="post-image" src="${post.imageData}" alt="게시물에 첨부한 사진">` : ""}<div class="post-actions"><button class="post-action ${post.liked ? "liked" : ""}" type="button" data-like="${escapeHtml(post.id)}" aria-label="좋아요"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/></svg>${post.likes}</button><span class="post-action"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>${post.comments.length}</span></div><div class="comments">${comments}</div><form class="comment-form" data-comment="${escapeHtml(post.id)}"><input name="comment" maxlength="240" placeholder="댓글 남기기" aria-label="댓글 입력" required><button type="submit">등록</button></form></article>`;
}

function renderPosts(target, posts, message) {
  target.innerHTML = posts.length ? posts.map(renderPost).join("") : emptyState("아직 게시물이 없어요", message);
}

function renderAll() {
  const posts = [...state.posts];
  const feedPosts = state.storyUserId ? posts.filter(post => post.userId === state.storyUserId) : posts;
  renderStories();
  renderPosts(document.getElementById("homePosts"), feedPosts, "가입한 사람들이 순간을 공유하면 여기에 보여요.");
  renderPosts(document.getElementById("profilePosts"), posts.filter(post => post.userId === state.user.id), "첫 순간을 남기면 프로필에 모여요.");
  document.getElementById("postCount").textContent = `${posts.length}개의 순간`;
  document.getElementById("profileName").textContent = state.user.displayName;
  document.getElementById("sideProfileName").textContent = state.user.displayName;
  document.getElementById("profileInitial").textContent = initials(state.user.displayName);
  document.getElementById("railAvatar").textContent = initials(state.user.displayName);
  document.getElementById("displayName").value = state.user.displayName;
  document.getElementById("usernameDisplay").value = `@${state.user.username}`;
  renderExplore();
  renderThreads();
  renderNotifications();
  renderMessages();
}

function renderExplore() {
  const query = document.getElementById("exploreSearch").value.trim().toLowerCase();
  const results = state.posts.filter(post => `${post.text} ${post.username} ${post.displayName}`.toLowerCase().includes(query));
  renderPosts(document.getElementById("explorePosts"), results, "게시물을 검색하거나 첫 순간을 공유해보세요.");
}

function renderNotifications() {
  const target = document.getElementById("notificationList");
  if (!state.notifications.length) {
    target.innerHTML = emptyState("새 알림이 없어요", "팔로우, 좋아요, 댓글 알림이 여기에 표시됩니다.");
    return;
  }
  target.innerHTML = state.notifications.map(item => {
    const date = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt));
    const action = item.type === "follow" ? "님이 회원님을 팔로우하기 시작했습니다." : item.type === "like" ? "님이 회원님의 게시물을 좋아합니다." : "님이 회원님의 게시물에 댓글을 남겼습니다.";
    const followBack = item.type === "follow" && !item.isFollowing ? `<button class="follow-button notification-follow" type="button" data-follow="${escapeHtml(item.userId)}" data-following="false">팔로우</button>` : "";
    return `<div class="side-panel notification-item"><div><strong>${escapeHtml(item.displayName)} ${action}</strong><p>${escapeHtml(date)}</p></div>${followBack}</div>`;
  }).join("");
}

function renderThreads() {
  const query = document.getElementById("search").value.trim().toLowerCase();
  const conversations = state.conversations.filter(item => `${item.username} ${item.displayName}`.toLowerCase().includes(query));
  const target = document.getElementById("threadList");
  if (!conversations.length) {
    target.innerHTML = emptyState(query ? "검색 결과가 없어요" : "메시지를 시작해보세요", query ? "아이디나 이름을 다시 확인해주세요." : "새 메시지 버튼에서 실제 가입 사용자를 찾아 대화를 시작할 수 있어요.");
    return;
  }
  target.innerHTML = conversations.map(item => `<button class="thread ${item.id === state.activeConversationId ? "selected" : ""}" type="button" data-chat="${escapeHtml(item.id)}"><span class="initial-avatar">${escapeHtml(initials(item.displayName))}</span><span class="thread-copy"><span class="thread-top"><span class="thread-name">${escapeHtml(item.displayName)}</span><span class="thread-time">${item.lastMessageAt ? escapeHtml(formatTime(item.lastMessageAt)) : ""}</span></span><span class="thread-bottom"><span class="preview">${escapeHtml(item.lastMessage || `@${item.username}`)}</span></span></span></button>`).join("");
}

function renderMessages() {
  const conversationId = state.activeConversationId;
  if (!conversationId) return;
  const conversation = state.conversations.find(item => item.id === conversationId);
  if (!conversation) return;
  const target = document.getElementById("conversation");
  const messages = state.messages.get(conversationId) || [];
  if (!messages.length) {
    target.innerHTML = emptyState(`${escapeHtml(conversation.displayName)}님과의 대화`, "첫 메시지를 보내보세요.");
    return;
  }
  target.innerHTML = `<div class="day-divider">메시지</div>${messages.map(message => {
    const mine = message.senderId === state.user.id;
    const date = formatTime(message.createdAt);
    return `<div class="message-row ${mine ? "mine" : "theirs"}">${mine ? "" : `<span class="initial-avatar">${escapeHtml(initials(message.senderDisplayName))}</span>`}<div class="bubble">${escapeHtml(message.body)}</div><span class="message-meta">${escapeHtml(date)}</span></div>`;
  }).join("")}`;
  target.scrollTop = target.scrollHeight;
}

function joinConversation(id) {
  if (!state.socket?.connected) return;
  state.socket.emit("conversation:join", id, result => {
    if (result?.error) alert(result.error);
  });
}

async function openConversation(id) {
  state.activeConversationId = id;
  app.dataset.view = "messages";
  setView("messages");
  const conversation = state.conversations.find(item => item.id === id);
  if (conversation) {
    document.getElementById("chatName").textContent = conversation.displayName;
    document.getElementById("chatAvatar").textContent = initials(conversation.displayName);
  }
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(id)}/messages`);
    state.messages.set(id, result.messages);
    joinConversation(id);
    renderMessages();
    document.getElementById("messageInput").focus();
  } catch (error) {
    alert(error.message);
  }
}

function compressImage(file) {
  if (!file) return Promise.resolve("");
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("이미지 파일만 첨부할 수 있어요."));
  if (file.size > 12 * 1024 * 1024) return Promise.reject(new Error("사진은 12MB 이하로 선택해주세요."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("사진을 읽지 못했어요."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("사진을 열지 못했어요."));
      image.onload = () => {
        const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function searchUsers(query) {
  const target = document.getElementById("userResults");
  if (query.trim().length < 2) {
    target.innerHTML = "";
    return;
  }
  try {
    const result = await api(`/api/users?q=${encodeURIComponent(query.trim())}`);
    target.innerHTML = result.users.length ? result.users.map(user => `<div class="user-result"><span class="initial-avatar">${escapeHtml(initials(user.displayName))}</span><span class="user-result-copy"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.displayName)}</span></span><span class="user-result-actions"><button class="follow-button" type="button" data-follow="${escapeHtml(user.id)}" data-following="${user.isFollowing ? "true" : "false"}">${user.isFollowing ? "팔로잉" : "팔로우"}</button>${user.isFollowing && user.followsYou ? `<button class="chat-user-button" type="button" data-chat-user="${escapeHtml(user.id)}">채팅</button>` : `<span class="follow-hint">상호 팔로우 후 채팅</span>`}</span></div>`).join("") : emptyState("사용자가 없어요", "가입한 아이디 또는 이름을 다시 검색해보세요.");
  } catch (error) {
    target.innerHTML = emptyState("검색할 수 없어요", error.message);
  }
}

let searchTimer;
document.getElementById("userSearch").addEventListener("input", event => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchUsers(event.target.value), 220);
});

document.getElementById("authSwitch").addEventListener("click", () => {
  const login = document.getElementById("loginForm");
  const register = document.getElementById("registerForm");
  const registering = register.hidden;
  register.hidden = !registering;
  login.hidden = registering;
  document.getElementById("authSwitchLabel").textContent = registering ? "이미 계정이 있으신가요?" : "계정이 없으신가요?";
  document.getElementById("authSwitch").textContent = registering ? "로그인" : "가입하기";
  showError("");
});

async function handleAuth(event, endpoint) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  showError("");
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(values) });
    state.user = result.user;
    showApp();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

document.getElementById("loginForm").addEventListener("submit", event => handleAuth(event, "/api/auth/login"));
document.getElementById("registerForm").addEventListener("submit", event => handleAuth(event, "/api/auth/register"));

document.getElementById("authScreen").addEventListener("click", event => {
  if (!event.target.closest("#authSwitch")) return;
});

document.querySelectorAll(".rail-button[data-view], .rail-avatar, .page-top [data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelector('[data-action="focus-post"]').addEventListener("click", () => {
  document.getElementById("postText").focus();
  document.getElementById("postForm").scrollIntoView({ behavior: "smooth", block: "center" });
});
document.querySelector(".compose").addEventListener("click", () => {
  document.getElementById("userSearch").value = "";
  document.getElementById("userResults").innerHTML = "";
  document.getElementById("newChatDialog").showModal();
  document.getElementById("userSearch").focus();
});
document.getElementById("newChatForm").addEventListener("submit", event => event.preventDefault());
document.getElementById("cancelNewChat").addEventListener("click", () => document.getElementById("newChatDialog").close());

document.addEventListener("click", async event => {
  const thread = event.target.closest("[data-chat]");
  if (thread) await openConversation(thread.dataset.chat);
  const followButton = event.target.closest("[data-follow]");
  if (followButton) {
    try {
      const method = followButton.dataset.following === "true" ? "DELETE" : "POST";
      await api(`/api/users/${encodeURIComponent(followButton.dataset.follow)}/follow`, { method });
      await loadAppData();
      await searchUsers(document.getElementById("userSearch").value);
    } catch (error) {
      alert(error.message);
    }
  }
  const chatUser = event.target.closest("[data-chat-user]");
  if (chatUser) {
    try {
      const result = await api("/api/conversations", { method: "POST", body: JSON.stringify({ userId: chatUser.dataset.chatUser }) });
      document.getElementById("newChatDialog").close();
      await loadAppData();
      await openConversation(result.conversation.id);
    } catch (error) {
      alert(error.message);
    }
  }
  const likeButton = event.target.closest("[data-like]");
  if (likeButton) {
    try {
      await api(`/api/posts/${encodeURIComponent(likeButton.dataset.like)}/like`, { method: "POST" });
      await loadAppData();
    } catch (error) {
      alert(error.message);
    }
  }
  const storyButton = event.target.closest("[data-story]");
  if (storyButton) {
    state.storyUserId = storyButton.dataset.story === "mine" ? state.user.id : storyButton.dataset.story;
    renderAll();
    document.getElementById("homePosts").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

document.addEventListener("submit", async event => {
  if (event.target.id === "postForm") {
    event.preventDefault();
    const text = document.getElementById("postText").value.trim();
    const imageInput = document.getElementById("postImage");
    if (!text && !imageInput.files[0]) return;
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const imageData = await compressImage(imageInput.files[0]);
      await api("/api/posts", { method: "POST", body: JSON.stringify({ text, imageData }) });
      event.target.reset();
      state.storyUserId = null;
      await loadAppData();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }
  if (event.target.matches(".comment-form")) {
    event.preventDefault();
    const input = event.target.elements.comment;
    try {
      await api(`/api/posts/${encodeURIComponent(event.target.dataset.comment)}/comments`, { method: "POST", body: JSON.stringify({ text: input.value.trim() }) });
      await loadAppData();
    } catch (error) {
      alert(error.message);
    }
  }
});

document.getElementById("search").addEventListener("input", renderThreads);
document.getElementById("exploreSearch").addEventListener("input", renderExplore);
document.getElementById("backButton").addEventListener("click", () => {
  state.activeConversationId = null;
  setView("messages");
});
document.getElementById("messageForm").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.getElementById("messageInput");
  const body = input.value.trim();
  if (!body || !state.activeConversationId || !state.socket?.connected) return;
  state.socket.emit("message:send", { conversationId: state.activeConversationId, body }, result => {
    if (result?.error) {
      alert(result.error);
      return;
    }
    input.value = "";
    input.focus();
  });
});
document.getElementById("attachMessage").addEventListener("click", () => document.getElementById("messageImage").click());
document.getElementById("messageImage").addEventListener("change", () => alert("사진 메시지는 현재 준비 중이에요. 게시물 사진 공유를 이용해주세요."));
document.getElementById("insertEmoji").addEventListener("click", () => {
  const input = document.getElementById("messageInput");
  input.value += "🙂";
  input.focus();
});
document.getElementById("renameChat").addEventListener("click", () => alert("대화 상대 이름은 프로필에서 관리됩니다."));

document.getElementById("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/me", { method: "PATCH", body: JSON.stringify({ displayName: document.getElementById("displayName").value.trim() }) });
    state.user = result.user;
    showApp();
    setView("settings");
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    state.activeConversationId = null;
    showAuth();
  } catch (error) {
    alert(error.message);
  }
});

async function start() {
  setupGoogleLogin();
  try {
    const result = await api("/api/me");
    state.user = result.user;
    showApp();
  } catch {
    showAuth();
  }
}

start();
