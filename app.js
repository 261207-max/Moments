const state = {
  user: null,
  posts: [],
  stories: [],
  activeStoryUserId: null,
  activeStoryIndex: 0,
  storyRequestToken: 0,
  storyTimer: null,
  reels: [],
  reelSort: "recommended",
  reelNextPageToken: "",
  reelDiscoveryConfigured: false,
  reelDiscoveryError: "",
  reelLoadingMore: false,
  reelPlayers: new Map(),
  reelPlayerLoading: new Set(),
  reelWatchSessions: new Map(),
  reelPlayingSince: new Map(),
  reelWatchTimers: new Map(),
  reelObserver: null,
  reelLoadObserver: null,
  activeReelId: null,
  conversations: [],
  notifications: [],
  messages: new Map(),
  groupMode: false,
  selectedGroupUsers: new Map(),
  activeConversationId: null,
  socket: null,
  storyUserId: null,
  pendingMessageImage: "",
};

const app = document.getElementById("app");
const authScreen = document.getElementById("authScreen");
const viewIds = ["home", "reels", "explore", "notifications", "profile", "settings"];
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
    const [postResult, conversationResult, notificationResult, storyResult] = await Promise.all([
      api("/api/posts"),
      api("/api/conversations"),
      api("/api/notifications"),
      api("/api/stories"),
    ]);
    state.posts = postResult.posts;
    state.conversations = conversationResult.conversations;
    state.notifications = notificationResult.notifications;
    state.stories = storyResult.stories;
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
      conversation.lastMessage = message.body || (message.imageData ? "사진을 보냈습니다." : "");
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
  if (view !== "reels") {
    state.activeReelId = null;
    state.reelPlayers.forEach(player => player.pauseVideo());
  }
  app.dataset.view = view === "messages" ? "messages" : view;
  viewIds.forEach(id => {
    document.getElementById(`${id}View`).hidden = id !== view;
  });
  document.querySelector(".inbox").hidden = view !== "messages";
  document.querySelector(".chat").hidden = view !== "messages" || !state.activeConversationId;
  app.classList.toggle("show-chat", view === "messages" && Boolean(state.activeConversationId));
  document.querySelectorAll(".rail-button[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (view === "messages") renderThreads();
  if (view === "reels") loadReels();
}

function renderStories() {
  const groupedStories = new Map();
  for (const story of state.stories) {
    if (!groupedStories.has(story.userId)) groupedStories.set(story.userId, []);
    groupedStories.get(story.userId).push(story);
  }
  const ownStories = groupedStories.get(state.user.id) || [];
  const ownStory = `<div class="story-item"><button class="story story-open" type="button" ${ownStories.length ? `data-story-user="${escapeHtml(state.user.id)}"` : "data-story-add"} aria-label="${ownStories.length ? "내 스토리 보기" : "스토리 추가"}"><span class="story-ring ${ownStories.length && ownStories.every(story => story.viewed) ? "seen" : ""}"><span>${escapeHtml(initials(state.user.displayName))}</span></span><span class="story-name">내 스토리</span></button><button class="story-add-badge" type="button" data-story-add aria-label="스토리 추가" title="스토리 추가">+</button></div>`;
  const others = [...groupedStories.entries()]
    .filter(([userId]) => userId !== state.user.id)
    .map(([userId, stories]) => {
      const story = stories[0];
      const seen = stories.every(item => item.viewed);
      return `<button class="story" type="button" data-story-user="${escapeHtml(userId)}" aria-label="${escapeHtml(story.displayName)}의 스토리 보기"><span class="story-ring ${seen ? "seen" : ""}"><span>${escapeHtml(initials(story.displayName))}</span></span><span class="story-name">${escapeHtml(story.displayName)}</span></button>`;
    });
  document.getElementById("stories").innerHTML = [ownStory, ...others].join("");
}

function renderGroupSelection() {
  const target = document.getElementById("groupSelectedUsers");
  target.innerHTML = [...state.selectedGroupUsers.values()].map(user => `<button class="group-selected-chip" type="button" data-group-remove="${escapeHtml(user.id)}" aria-label="${escapeHtml(user.displayName)} 제외">${escapeHtml(user.displayName)} ×</button>`).join("");
  const createButton = document.getElementById("createGroupButton");
  createButton.disabled = state.selectedGroupUsers.size < 2 || state.selectedGroupUsers.size > 9;
  createButton.textContent = `그룹 대화 시작 (${state.selectedGroupUsers.size + 1}명)`;
}

async function closeStoryViewer() {
  clearTimeout(state.storyTimer);
  state.storyRequestToken += 1;
  state.activeStoryUserId = null;
  const dialog = document.getElementById("storyViewer");
  if (dialog.open) dialog.close();
  document.getElementById("storyViewerImage").removeAttribute("src");
}

async function stepStory(direction) {
  const stories = state.stories.filter(story => story.userId === state.activeStoryUserId);
  const nextIndex = state.activeStoryIndex + direction;
  if (nextIndex < 0 || nextIndex >= stories.length) return closeStoryViewer();
  state.activeStoryIndex = nextIndex;
  await renderStoryViewer();
}

async function openStoryGroup(userId, index = 0) {
  const stories = state.stories.filter(story => story.userId === userId);
  if (!stories.length) return;
  clearTimeout(state.storyTimer);
  state.activeStoryUserId = userId;
  state.activeStoryIndex = index;
  const dialog = document.getElementById("storyViewer");
  if (!dialog.open) dialog.showModal();
  await renderStoryViewer();
}

async function renderStoryViewer() {
  const stories = state.stories.filter(story => story.userId === state.activeStoryUserId);
  const story = stories[state.activeStoryIndex];
  if (!story) {
    closeStoryViewer();
    return;
  }
  clearTimeout(state.storyTimer);
  const requestToken = ++state.storyRequestToken;
  let result;
  try {
    result = await api(`/api/stories/${encodeURIComponent(story.id)}`);
  } catch (error) {
    alert(error.message);
    closeStoryViewer();
    return;
  }
  if (!document.getElementById("storyViewer").open || requestToken !== state.storyRequestToken) return;
  const profileName = document.getElementById("storyViewerName");
  profileName.textContent = result.story.displayName;
  document.getElementById("storyViewerTime").textContent = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date(story.createdAt));
  document.getElementById("storyViewerImage").src = result.story.imageData;
  document.getElementById("storyViewerCaption").textContent = result.story.caption;
  story.viewed = 1;
  renderStories();
  document.getElementById("storyViewerProgress").innerHTML = stories.map((item, index) => `<span class="story-progress-track"><span class="${index < state.activeStoryIndex ? "complete" : index === state.activeStoryIndex ? "current" : ""}"></span></span>`).join("");
  api(`/api/stories/${encodeURIComponent(story.id)}/view`, { method: "POST" }).catch(() => {});
  state.storyTimer = setTimeout(() => {
    state.activeStoryIndex += 1;
    renderStoryViewer();
  }, 5000);
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

let youtubeApiPromise;
function ensureYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeApiPromise) {
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousCallback?.();
        resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("YouTube 플레이어를 불러오지 못했습니다."));
      document.head.append(script);
    });
  }
  return youtubeApiPromise;
}

async function loadReels() {
  await destroyReelPlayers();
  state.reelNextPageToken = "";
  state.reelDiscoveryError = "";
  try {
    const [manualResult, discoveryResult] = await Promise.all([
      api(`/api/reels?sort=${state.reelSort}`),
      api(`/api/reels/recommendations?sort=${state.reelSort}`).catch(error => ({ configured: true, error })),
    ]);
    state.reelDiscoveryConfigured = discoveryResult.configured === true;
    state.reelDiscoveryError = discoveryResult.error?.message || "";
    state.reelNextPageToken = discoveryResult.nextPageToken || "";
    const recommended = discoveryResult.videos || [];
    const recommendedIds = new Set(recommended.map(reel => reel.youtubeId));
    state.reels = [...recommended, ...manualResult.reels.filter(reel => !recommendedIds.has(reel.youtubeId))];
    renderReels();
  } catch (error) {
    document.getElementById("reelsFeed").innerHTML = emptyState("릴스를 불러오지 못했어요", error.message);
  }
}

function renderReels() {
  const feed = document.getElementById("reelsFeed");
  destroyReelPlayers();
  const status = document.getElementById("reelApiStatus");
  status.textContent = state.reelDiscoveryError || (!state.reelDiscoveryConfigured
    ? "자동 추천을 사용하려면 서버에 YouTube Data API 키가 필요합니다."
    : "");
  document.querySelectorAll("[data-reels-sort]").forEach(button => {
    button.classList.toggle("active", button.dataset.reelsSort === state.reelSort);
  });
  if (!state.reels.length) {
    feed.innerHTML = emptyState(state.reelDiscoveryConfigured ? "추천 영상을 찾지 못했어요" : "아직 릴스가 없어요", "Shorts 링크를 직접 추가하거나 자동 추천을 설정할 수 있습니다.");
    return;
  }
  feed.innerHTML = `${state.reels.map(renderReel).join("")}<div class="reel-load-sentinel" id="reelLoadSentinel" aria-hidden="true"></div>`;
  observeReelCards();
}

function renderReel(reel) {
  const creator = reel.source === "youtube" ? reel.creatorDisplayName : `@${reel.creatorUsername}`;
  return `<article class="reel-card" data-reel-card="${escapeHtml(reel.id)}"><div class="reel-player" id="reel-player-${escapeHtml(reel.id)}" data-youtube-id="${escapeHtml(reel.youtubeId)}" aria-label="${escapeHtml(reel.caption)}"></div><div class="reel-shade"></div><div class="reel-copy"><span class="reel-reason">${escapeHtml(reel.recommendationReason)}</span><strong>${escapeHtml(creator)}</strong><p>${escapeHtml(reel.caption)}</p><a href="https://www.youtube.com/shorts/${encodeURIComponent(reel.youtubeId)}" target="_blank" rel="noopener noreferrer">YouTube에서 열기</a></div><div class="reel-actions"><button class="reel-like ${reel.liked ? "liked" : ""}" type="button" data-reel-like="${escapeHtml(reel.id)}" aria-label="좋아요" aria-pressed="${Boolean(reel.liked)}"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/></svg><span>${reel.likes}</span></button><span class="reel-signal" title="내 시청 기록">${reel.completed ? "완주" : reel.watchMs ? "시청" : ""}</span></div></article>`;
}

async function loadMoreReels() {
  if (state.reelLoadingMore || !state.reelNextPageToken || !state.reelDiscoveryConfigured) return;
  state.reelLoadingMore = true;
  try {
    const result = await api(`/api/reels/recommendations?sort=${state.reelSort}&pageToken=${encodeURIComponent(state.reelNextPageToken)}`);
    state.reelNextPageToken = result.nextPageToken || "";
    const existing = new Set(state.reels.map(reel => reel.youtubeId));
    const added = result.videos.filter(reel => !existing.has(reel.youtubeId));
    state.reels.push(...added);
    const sentinel = document.getElementById("reelLoadSentinel");
    if (sentinel && added.length) {
      sentinel.insertAdjacentHTML("beforebegin", added.map(renderReel).join(""));
      added.forEach(reel => {
        const card = document.querySelector(`[data-reel-card="${CSS.escape(reel.id)}"]`);
        if (card) state.reelObserver?.observe(card);
      });
    }
    if (!state.reelNextPageToken) sentinel?.remove();
  } catch (error) {
    state.reelDiscoveryError = error.message;
    document.getElementById("reelApiStatus").textContent = error.message;
    state.reelNextPageToken = "";
  } finally {
    state.reelLoadingMore = false;
  }
}

async function destroyReelPlayers() {
  state.reelObserver?.disconnect();
  state.reelLoadObserver?.disconnect();
  const pendingSaves = [];
  state.reelPlayers.forEach((player, reelId) => {
    if (state.reelPlayingSince.has(reelId)) pendingSaves.push(saveReelWatch(reelId));
    player.destroy();
  });
  state.reelWatchTimers.forEach(timer => clearInterval(timer));
  state.reelPlayers.clear();
  state.reelPlayerLoading.clear();
  state.reelWatchTimers.clear();
  state.reelWatchSessions.clear();
  state.reelPlayingSince.clear();
  await Promise.all(pendingSaves);
}

function observeReelCards() {
  state.reelObserver?.disconnect();
  state.reelLoadObserver?.disconnect();
  state.reelObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const reelId = entry.target.dataset.reelCard;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.65) {
        activateReel(reelId);
      } else if (state.activeReelId === reelId) {
        state.reelPlayers.get(reelId)?.pauseVideo();
        state.activeReelId = null;
      }
    }
  }, { root: document.getElementById("reelsFeed"), threshold: [0.65] });
  document.querySelectorAll("[data-reel-card]").forEach(card => state.reelObserver.observe(card));
  const sentinel = document.getElementById("reelLoadSentinel");
  if (sentinel && state.reelNextPageToken) {
    state.reelLoadObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreReels();
    }, { root: document.getElementById("reelsFeed"), rootMargin: "280px 0px" });
    state.reelLoadObserver.observe(sentinel);
  }
}

async function activateReel(reelId) {
  state.activeReelId = reelId;
  if (state.reelPlayers.has(reelId) || state.reelPlayerLoading.has(reelId)) {
    state.reelPlayers.get(reelId)?.playVideo();
    return;
  }
  state.reelPlayerLoading.add(reelId);
  try {
    const youtube = await ensureYouTubeApi();
    const element = document.getElementById(`reel-player-${reelId}`);
    if (!element || state.activeReelId !== reelId) return;
    const player = new youtube.Player(element, {
      videoId: element.dataset.youtubeId,
      playerVars: { autoplay: 1, controls: 1, playsinline: 1, rel: 0, origin: window.location.origin },
      events: {
        onReady: event => {
          if (state.activeReelId === reelId) {
            event.target.mute();
            event.target.playVideo();
          }
        },
        onStateChange: event => handleReelPlayerState(reelId, event.data),
      },
    });
    state.reelPlayers.set(reelId, player);
  } catch (error) {
    document.getElementById("reelsFeed").dataset.playerError = error.message;
  } finally {
    state.reelPlayerLoading.delete(reelId);
  }
}

function saveReelWatch(reelId, completed = false) {
  const startedAt = state.reelPlayingSince.get(reelId);
  if (startedAt) {
    state.reelWatchSessions.set(reelId, (state.reelWatchSessions.get(reelId) || 0) + Date.now() - startedAt);
    state.reelPlayingSince.set(reelId, Date.now());
  }
  const reel = state.reels.find(item => item.id === reelId);
  if (!reel) return;
  const watchMs = Math.min(3600000, (reel.watchMs || 0) + (state.reelWatchSessions.get(reelId) || 0));
  const isYouTubeSuggestion = reel.source === "youtube";
  return api(isYouTubeSuggestion
    ? `/api/reels/youtube/${encodeURIComponent(reel.youtubeId)}/watch`
    : `/api/reels/${encodeURIComponent(reelId)}/watch`, {
    method: "POST",
    body: JSON.stringify({ watchMs, completed, title: reel.caption, channelTitle: reel.creatorDisplayName }),
  }).then(() => {
    if (completed) reel.completed = 1;
  }).catch(() => {});
}

function handleReelPlayerState(reelId, playerState) {
  if (playerState === window.YT.PlayerState.PLAYING) {
    if (!state.reelPlayingSince.has(reelId)) state.reelPlayingSince.set(reelId, Date.now());
    if (!state.reelWatchTimers.has(reelId)) {
      state.reelWatchTimers.set(reelId, setInterval(() => saveReelWatch(reelId), 10000));
    }
    return;
  }
  if (playerState === window.YT.PlayerState.PAUSED || playerState === window.YT.PlayerState.ENDED) {
    clearInterval(state.reelWatchTimers.get(reelId));
    state.reelWatchTimers.delete(reelId);
    saveReelWatch(reelId, playerState === window.YT.PlayerState.ENDED);
    state.reelPlayingSince.delete(reelId);
  }
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
  target.innerHTML = conversations.map(item => `<button class="thread ${item.id === state.activeConversationId ? "selected" : ""}" type="button" data-chat="${escapeHtml(item.id)}"><span class="initial-avatar">${escapeHtml(initials(item.displayName))}</span><span class="thread-copy"><span class="thread-top"><span class="thread-name">${escapeHtml(item.displayName)}</span><span class="thread-time">${item.lastMessageAt ? escapeHtml(formatTime(item.lastMessageAt)) : ""}</span></span><span class="thread-bottom"><span class="preview">${escapeHtml(item.lastMessage || (item.groupName ? `${item.memberCount}명 그룹 대화` : `@${item.username}`))}</span></span></span></button>`).join("");
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
    const image = message.imageData ? `<img class="photo-message" src="${escapeHtml(message.imageData)}" alt="메시지 사진" loading="lazy">` : "";
    const text = message.body ? `<div class="bubble">${escapeHtml(message.body)}</div>` : "";
    return `<div class="message-row ${mine ? "mine" : "theirs"}">${mine ? "" : `<span class="initial-avatar">${escapeHtml(initials(message.senderDisplayName))}</span>`}<div class="message-content">${image}${text}</div><span class="message-meta">${escapeHtml(date)}</span></div>`;
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
    document.getElementById("chatStatus").textContent = conversation.groupName ? `${conversation.memberCount}명 그룹 대화` : `@${conversation.username}`;
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
    target.innerHTML = result.users.length ? result.users.map(user => {
      const action = state.groupMode
        ? user.canGroup ? `<button class="chat-user-button" type="button" data-group-select="${escapeHtml(user.id)}">${state.selectedGroupUsers.has(user.id) ? "선택됨" : "추가"}</button>` : `<span class="follow-hint">맞팔로우 후 초대 가능</span>`
        : `<button class="follow-button" type="button" data-follow="${escapeHtml(user.id)}" data-following="${user.isFollowing ? "true" : "false"}">${user.isFollowing ? "팔로잉" : "팔로우"}</button>${user.isFollowing && user.followsYou ? `<button class="chat-user-button" type="button" data-chat-user="${escapeHtml(user.id)}">채팅</button>` : `<span class="follow-hint">상호 팔로우 후 채팅</span>`}`;
      return `<div class="user-result"><span class="initial-avatar">${escapeHtml(initials(user.displayName))}</span><span class="user-result-copy"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.displayName)}</span></span><span class="user-result-actions">${action}</span></div>`;
    }).join("") : emptyState("사용자가 없어요", "가입한 아이디 또는 이름을 다시 검색해보세요.");
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
document.getElementById("storyUpload").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imageData = await compressImage(file);
    if (imageData.length > 4_000_000) throw new Error("사진을 압축한 뒤에도 용량이 큽니다. 다른 사진을 선택해주세요.");
    await api("/api/stories", { method: "POST", body: JSON.stringify({ imageData }) });
    await loadAppData();
    await openStoryGroup(state.user.id);
  } catch (error) {
    alert(error.message);
  } finally {
    event.target.value = "";
  }
});
document.getElementById("storyViewer").addEventListener("close", () => {
  clearTimeout(state.storyTimer);
  state.activeStoryUserId = null;
});
document.getElementById("closeStoryViewer").addEventListener("click", closeStoryViewer);
document.querySelectorAll("[data-story-step]").forEach(button => button.addEventListener("click", () => stepStory(Number(button.dataset.storyStep))));
document.querySelectorAll("[data-reels-sort]").forEach(button => button.addEventListener("click", () => {
  if (state.reelSort === button.dataset.reelsSort) return;
  state.reelSort = button.dataset.reelsSort;
  loadReels();
}));
document.getElementById("openReelDialog").addEventListener("click", () => {
  document.getElementById("reelFormError").textContent = "";
  document.getElementById("addReelDialog").showModal();
});
document.getElementById("cancelReelDialog").addEventListener("click", () => document.getElementById("addReelDialog").close());
document.getElementById("addReelForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector("button[type=submit]");
  submitButton.disabled = true;
  document.getElementById("reelFormError").textContent = "";
  try {
    await api("/api/reels", {
      method: "POST",
      body: JSON.stringify({
        url: document.getElementById("reelUrl").value.trim(),
        caption: document.getElementById("reelCaption").value.trim(),
      }),
    });
    form.reset();
    document.getElementById("addReelDialog").close();
    await loadReels();
    document.getElementById("reelsFeed").scrollTop = 0;
  } catch (error) {
    document.getElementById("reelFormError").textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});
document.querySelector('[data-action="focus-post"]').addEventListener("click", () => {
  document.getElementById("postText").focus();
  document.getElementById("postForm").scrollIntoView({ behavior: "smooth", block: "center" });
});
document.querySelector(".compose").addEventListener("click", () => {
  state.groupMode = false;
  state.selectedGroupUsers.clear();
  document.getElementById("groupModeToggle").textContent = "단체 대화 만들기";
  document.getElementById("groupNameInput").value = "";
  document.getElementById("groupNameWrap").hidden = true;
  document.getElementById("groupSelectedUsers").hidden = true;
  document.getElementById("createGroupButton").hidden = true;
  renderGroupSelection();
  document.getElementById("userSearch").value = "";
  document.getElementById("userResults").innerHTML = "";
  document.getElementById("newChatDialog").showModal();
  document.getElementById("userSearch").focus();
});
document.getElementById("groupModeToggle").addEventListener("click", () => {
  state.groupMode = !state.groupMode;
  state.selectedGroupUsers.clear();
  document.getElementById("groupModeToggle").textContent = state.groupMode ? "개인 대화로 전환" : "단체 대화 만들기";
  document.getElementById("groupNameWrap").hidden = !state.groupMode;
  document.getElementById("groupSelectedUsers").hidden = !state.groupMode;
  document.getElementById("createGroupButton").hidden = !state.groupMode;
  renderGroupSelection();
  searchUsers(document.getElementById("userSearch").value);
});
document.getElementById("newChatForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.groupMode || state.selectedGroupUsers.size < 2 || state.selectedGroupUsers.size > 9) return;
  const button = document.getElementById("createGroupButton");
  button.disabled = true;
  try {
    const result = await api("/api/conversations/group", {
      method: "POST",
      body: JSON.stringify({ userIds: [...state.selectedGroupUsers.keys()], groupName: document.getElementById("groupNameInput").value.trim() }),
    });
    document.getElementById("newChatDialog").close();
    await loadAppData();
    await openConversation(result.conversation.id);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});
document.getElementById("cancelNewChat").addEventListener("click", () => document.getElementById("newChatDialog").close());

document.addEventListener("click", async event => {
  const storyAdd = event.target.closest("[data-story-add]");
  if (storyAdd) document.getElementById("storyUpload").click();
  const storyUser = event.target.closest("[data-story-user]");
  if (storyUser) await openStoryGroup(storyUser.dataset.storyUser);
  const groupSelect = event.target.closest("[data-group-select]");
  if (groupSelect) {
    const user = [...document.querySelectorAll("[data-group-select]")]
      .find(button => button.dataset.groupSelect === groupSelect.dataset.groupSelect)?.closest(".user-result");
    if (state.selectedGroupUsers.has(groupSelect.dataset.groupSelect)) state.selectedGroupUsers.delete(groupSelect.dataset.groupSelect);
    else if (state.selectedGroupUsers.size < 9 && user) {
      state.selectedGroupUsers.set(groupSelect.dataset.groupSelect, {
        id: groupSelect.dataset.groupSelect,
        username: user.querySelector(".user-result-copy strong").textContent,
        displayName: user.querySelector(".user-result-copy span").textContent,
      });
    }
    renderGroupSelection();
    await searchUsers(document.getElementById("userSearch").value);
  }
  const groupRemove = event.target.closest("[data-group-remove]");
  if (groupRemove) {
    state.selectedGroupUsers.delete(groupRemove.dataset.groupRemove);
    renderGroupSelection();
    await searchUsers(document.getElementById("userSearch").value);
  }
  const reelLike = event.target.closest("[data-reel-like]");
  if (reelLike) {
    const reel = state.reels.find(item => item.id === reelLike.dataset.reelLike);
    if (reel) {
      try {
        const isYouTubeSuggestion = reel.source === "youtube";
        const result = await api(isYouTubeSuggestion
          ? `/api/reels/youtube/${encodeURIComponent(reel.youtubeId)}/like`
          : `/api/reels/${encodeURIComponent(reel.id)}/like`, {
          method: "POST",
          ...(isYouTubeSuggestion ? { body: JSON.stringify({ title: reel.caption, channelTitle: reel.creatorDisplayName }) } : {}),
        });
        reel.liked = result.liked;
        reel.likes = Math.max(0, reel.likes + (result.liked ? 1 : -1));
        reelLike.classList.toggle("liked", reel.liked);
        reelLike.setAttribute("aria-pressed", String(reel.liked));
        reelLike.querySelector("span").textContent = reel.likes;
      } catch (error) {
        alert(error.message);
      }
    }
  }
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
  const imageData = state.pendingMessageImage;
  if ((!body && !imageData) || !state.activeConversationId) return;
  if (!state.socket?.connected) {
    alert("메시지 서버에 연결되지 않았습니다. 잠시 후 다시 시도해주세요.");
    return;
  }
  const sendButton = event.currentTarget.querySelector("button[type=submit]");
  sendButton.disabled = true;
  state.socket.emit("message:send", { conversationId: state.activeConversationId, body, imageData }, result => {
    sendButton.disabled = false;
    if (result?.error) {
      alert(result.error);
      return;
    }
    input.value = "";
    state.pendingMessageImage = "";
    document.getElementById("messageImagePreview").hidden = true;
    document.getElementById("messageImagePreviewImage").removeAttribute("src");
    input.focus();
  });
});
document.getElementById("attachMessage").addEventListener("click", () => document.getElementById("messageImage").click());
document.getElementById("messageImage").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imageData = await compressImage(file);
    if (imageData.length > 4_000_000) throw new Error("압축 후 사진이 너무 큽니다. 더 작은 사진을 선택해주세요.");
    state.pendingMessageImage = imageData;
    document.getElementById("messageImagePreviewImage").src = imageData;
    document.getElementById("messageImagePreview").hidden = false;
  } catch (error) {
    alert(error.message);
  } finally {
    event.target.value = "";
  }
});
document.getElementById("removeMessageImage").addEventListener("click", () => {
  state.pendingMessageImage = "";
  document.getElementById("messageImagePreview").hidden = true;
  document.getElementById("messageImagePreviewImage").removeAttribute("src");
});
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
