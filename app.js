(function () {
  "use strict";

  const WORKER_URL = ((window.DISC_CONFIG && window.DISC_CONFIG.workerUrl) || "").replace(/\/$/, "");
  const START_MESSAGE = "Hi, I'm ready to start the DISC profiler.";
  const STORE_KEY = "disc-profiler-state";
  const TOKEN_KEY = "disc-profiler-token";

  const $ = (id) => document.getElementById(id);
  const views = { login: $("loginView"), intro: $("introView"), chat: $("chatView") };

  // history: [{ role: "user" | "model", text, hidden? }]
  let history = [];
  let busy = false;

  // ---------- Storage (session only, safe if blocked) ----------
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function getToken() {
    const raw = store.get(TOKEN_KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      if (t.expiresAt * 1000 > Date.now()) return t.token;
    } catch { /* ignore */ }
    store.del(TOKEN_KEY);
    return null;
  }

  function saveHistory() { store.set(STORE_KEY, JSON.stringify(history)); }

  // ---------- Views ----------
  function show(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });
    $("logoutBtn").hidden = name === "login";
  }

  // ---------- API ----------
  async function api(path, body, token) {
    if (!WORKER_URL || WORKER_URL.includes("YOUR-WORKER")) {
      throw new Error("The site isn't connected yet. Add the Worker URL to config.js.");
    }
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let res;
    try {
      res = await fetch(WORKER_URL + path, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong. Please try again.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- Login ----------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("password").value;
    const errEl = $("loginError");
    errEl.hidden = true;
    $("loginBtn").disabled = true;
    try {
      const data = await api("/login", { password: pw });
      store.set(TOKEN_KEY, JSON.stringify(data));
      $("password").value = "";
      enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      $("loginBtn").disabled = false;
    }
  });

  $("logoutBtn").addEventListener("click", () => {
    store.del(TOKEN_KEY);
    store.del(STORE_KEY);
    history = [];
    $("messages").innerHTML = "";
    clearChoices();
    show("login");
  });

  function enterApp() {
    const saved = store.get(STORE_KEY);
    if (saved) {
      try { history = JSON.parse(saved) || []; } catch { history = []; }
    }
    if (history.length) {
      show("chat");
      renderAll();
    } else {
      show("intro");
    }
  }

  // ---------- Start / restart ----------
  $("startBtn").addEventListener("click", startChat);

  $("restartBtn").addEventListener("click", () => {
    if (busy) return;
    if (!confirm("Start over? Your current conversation will be cleared.")) return;
    startChat();
  });

  function startChat() {
    history = [{ role: "user", text: START_MESSAGE, hidden: true }];
    saveHistory();
    $("messages").innerHTML = "";
    clearChoices();
    setProgress(null);
    show("chat");
    requestReply();
  }

  // ---------- Sending ----------
  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("userInput").value.trim();
    if (!text || busy) return;
    $("userInput").value = "";
    autosize();
    sendUser(text);
  });

  $("userInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chatForm").requestSubmit();
    }
  });
  $("userInput").addEventListener("input", autosize);

  function autosize() {
    const t = $("userInput");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 160) + "px";
  }

  function sendUser(text) {
    clearChoices();
    history.push({ role: "user", text });
    saveHistory();
    addUserBubble(text);
    requestReply();
  }

  async function requestReply() {
    const token = getToken();
    if (!token) { show("login"); return; }

    setBusy(true);
    const typing = addTyping();
    try {
      const payload = history.map(({ role, text }) => ({ role, text }));
      const data = await api("/chat", { messages: payload }, token);
      typing.remove();
      history.push({ role: "model", text: data.reply });
      saveHistory();
      renderBot(data.reply, true);
    } catch (err) {
      typing.remove();
      if (err.status === 401) {
        store.del(TOKEN_KEY);
        show("login");
        const errEl = $("loginError");
        errEl.textContent = err.message;
        errEl.hidden = false;
        return;
      }
      addError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    busy = on;
    $("sendBtn").disabled = on;
    $("restartBtn").disabled = on;
    document.querySelectorAll(".choice").forEach((b) => { b.disabled = on; });
  }

  // ---------- Parsing the model's reply ----------
  function parseReply(raw) {
    let text = raw;
    let progress = null;
    let choices = [];

    // Progress marker, e.g. [[progress:40]]
    const p = text.match(/\[\[\s*progress\s*:\s*(\d{1,3})\s*\]\]/i);
    if (p) progress = Math.min(100, parseInt(p[1], 10));
    text = text.replace(/\[\[\s*progress\s*:\s*\d{1,3}\s*\]\]\s*/gi, "");

    // Fallback: plain "40% completed" line at the top
    if (progress === null) {
      const p2 = text.match(/^\s*\**\s*(\d{1,3})\s*(?:%|percent)\s*complete[d]?\.?\s*\**\s*\n/i);
      if (p2) { progress = Math.min(100, parseInt(p2[1], 10)); text = text.slice(p2[0].length); }
    }

    // Choices block
    const c = text.match(/\[\[\s*choices\s*\]\]([\s\S]*?)(?:\[\[\s*\/\s*choices\s*\]\]|$)/i);
    if (c) {
      choices = c[1].split("\n").map((line) => {
        const m = line.trim().match(/^\**([a-h])\**\s*[|).:]\s*(.+)$/i);
        return m ? { key: m[1].toLowerCase(), label: m[2].trim() } : null;
      }).filter(Boolean);
      text = text.replace(c[0], "");
    }

    // Fallback: options written as "a) ..." lines in the text
    if (!choices.length) {
      const lines = text.split("\n");
      const found = [];
      lines.forEach((line) => {
        const m = line.trim().match(/^\**([a-d])\)\**\s+(.+)$/i);
        if (m) found.push({ key: m[1].toLowerCase(), label: m[2].replace(/\*\*/g, "").trim() });
      });
      const keys = found.map((f) => f.key).join("");
      if (found.length >= 2 && "abcd".startsWith(keys)) choices = found;
    }

    return { text: text.trim(), progress, choices };
  }

  // ---------- Rendering ----------
  function renderAll() {
    $("messages").innerHTML = "";
    clearChoices();
    let lastProgress = null;
    history.forEach((m, i) => {
      if (m.hidden) return;
      if (m.role === "user") addUserBubble(m.text);
      else {
        const isLast = i === history.length - 1;
        const parsed = renderBot(m.text, isLast);
        if (parsed.progress !== null) lastProgress = parsed.progress;
      }
    });
    setProgress(lastProgress);
    highlightLatest();
    // If the last message was from the user (e.g. a failed request), offer a retry
    const last = history[history.length - 1];
    if (last && last.role === "user") addError("The last reply didn't come through.");
  }

  function renderBot(raw, showChoices) {
    const parsed = parseReply(raw);
    if (parsed.progress !== null) setProgress(parsed.progress);
    let div = null;
    if (parsed.text) {
      div = document.createElement("div");
      div.className = "msg msg-bot";
      div.innerHTML = renderMarkdown(parsed.text);
      $("messages").appendChild(div);
      highlightLatest();
    }
    if (showChoices && parsed.choices.length) renderChoices(parsed.choices);
    scrollDown();
    return parsed;
  }

  // Fade everything except the newest AI message (and anything sent after it)
  function highlightLatest() {
    const msgs = Array.from($("messages").querySelectorAll(".msg"));
    let lastBot = -1;
    msgs.forEach((m, i) => { if (m.classList.contains("msg-bot")) lastBot = i; });
    msgs.forEach((m, i) => {
      m.classList.toggle("is-old", i < lastBot);
      const current = i === lastBot;
      m.classList.toggle("is-current", current);
      const label = m.querySelector(".new-label");
      if (current && !label) {
        const tag = document.createElement("span");
        tag.className = "new-label";
        tag.textContent = "Latest";
        m.prepend(tag);
      } else if (!current && label) {
        label.remove();
      }
    });
  }


  function renderMarkdown(md) {
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(window.marked.parse(md, { breaks: true, gfm: true }));
    }
    // Safe fallback if the libraries fail to load
    const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
  }

  function addUserBubble(text) {
    const div = document.createElement("div");
    div.className = "msg msg-user";
    div.textContent = text;
    $("messages").appendChild(div);
    // Once the user answers, the previous AI message is no longer "latest"
    $("messages").querySelectorAll(".msg-bot").forEach((m) => {
      m.classList.add("is-old");
      m.classList.remove("is-current");
      const l = m.querySelector(".new-label");
      if (l) l.remove();
    });
    scrollDown();
  }

  function addTyping() {
    const div = document.createElement("div");
    div.className = "typing";
    div.setAttribute("aria-label", "Assistant is typing");
    div.innerHTML = "<span></span><span></span><span></span>";
    $("messages").appendChild(div);
    scrollDown();
    return div;
  }

  function addError(message) {
    const div = document.createElement("div");
    div.className = "msg msg-error";
    div.textContent = message + " ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "link-btn";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      div.remove();
      const last = history[history.length - 1];
      if (last && last.role === "user") requestReply();
    });
    const last = history[history.length - 1];
    if (last && last.role === "user") div.appendChild(retry);
    $("messages").appendChild(div);
    scrollDown();
  }

  function renderChoices(choices) {
    const box = $("choices");
    box.innerHTML = "";
    choices.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      const letter = document.createElement("span");
      letter.className = "choice-letter";
      letter.textContent = c.key;
      const label = document.createElement("span");
      label.textContent = c.label;
      btn.append(letter, label);
      btn.addEventListener("click", () => {
        if (busy) return;
        sendUser(c.key + ") " + c.label);
      });
      box.appendChild(btn);
    });
    const hint = document.createElement("p");
    hint.className = "choices-hint";
    hint.textContent = "Pick one, or type your own answer below.";
    box.appendChild(hint);
    box.hidden = false;
    scrollDown();
  }

  function clearChoices() {
    $("choices").innerHTML = "";
    $("choices").hidden = true;
  }

  function setProgress(pct) {
    const wrap = $("progressWrap");
    if (pct === null || pct === undefined) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $("progressFill").style.width = pct + "%";
    $("progressText").textContent = pct + "%";
    $("progressBar").setAttribute("aria-valuenow", String(pct));
  }

  // Scroll to the newest message. Runs again after layout settles
  // (answer buttons appearing or fonts loading can change the height).
  function scrollDown() {
    const m = $("messages");
    const go = () => { m.scrollTop = m.scrollHeight; };
    requestAnimationFrame(go);
    setTimeout(go, 60);
    setTimeout(go, 250);
  }

  // ---------- Boot ----------
  if (getToken()) enterApp();
  else show("login");
})();
