(function () {
  "use strict";

  const STORAGE_KEY = "roundready-state-v1";
  const MAX_AUDIO_SIZE = 25_000_000;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  if (window.lucide) window.lucide.createIcons();

  let state = loadState();
  let activeLogTab = "live";
  let selectedAudio = null;
  let displayStream = null;
  let audioRecorder = null;
  let audioChunkCount = 0;
  let pendingChunkUploads = 0;
  let failedChunkUploads = 0;
  let chunkUploadPromises = [];
  let captureTimer = null;
  let captureInterviewId = "";
  let liveDialogueText = "";
  let liveDialogueChunks = [];
  let nextLiveDialogueChunk = 1;
  let savedConversations = [];
  let toastTimer;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        memoryOn: saved.memoryOn !== false,
        memories: [],
        promises: [],
        interviews: []
      };
    } catch (error) {
      console.warn("RoundReady could not read saved browser memory.", error);
      return { memoryOn: true, memories: [], promises: [], interviews: [] };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        memoryOn: state.memoryOn
      }));
      return true;
    } catch (error) {
      console.error("RoundReady could not save browser memory.", error);
      showToast("Couldn't save to browser memory. Check available storage.");
      return false;
    }
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function formatLocalDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "");
    const localDate = date.toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric"
    });
    const localTime = date.toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit"
    });
    return `${localDate} at ${localTime}`;
  }

  function formatPromiseDue(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return String(value || "");
    const due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(due.getTime())) return String(value);
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dayOffset = Math.round((due.getTime() - todayStart.getTime()) / 86_400_000);
    if (dayOffset === 0) return "Today";
    if (dayOffset === 1) return "Tomorrow";
    return due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  async function apiRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      throw new Error("Could not reach the RoundReady server. Make sure the Flask app is running.");
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`The server returned an invalid response (${response.status}).`);
    }
    if (!response.ok || payload.status === "error") {
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return payload;
  }

  function showPanelError(container, message) {
    container.innerHTML = `<div class="side-empty">${escapeHTML(message)}</div>`;
  }

  function jsonOptions(data) {
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  }

  function renderMemory() {
    const items = state.memoryOn ? state.memories : [];
    $("#memoryList").innerHTML = items.length ? items.slice(0, 5).map((item) => `
      <article class="memory-item">
        <p>${escapeHTML(item.text)}</p>
        <div class="memory-item-meta">
          ${item.company ? `<span class="company-tag">${escapeHTML(item.company)}</span>` : ""}
          ${item.score ? `<span class="similarity-badge">${escapeHTML(item.score)} match</span>` : ""}
          ${item.source ? `<span class="source-badge">${escapeHTML(item.source)}</span>` : ""}
        </div>
      </article>
    `).join("") : `<div class="side-empty">${state.memoryOn ? "Your saved interview notes will appear here." : "Memory is off. Turn it on to see saved notes."}</div>`;
  }

  function renderPromises() {
    const openCount = state.promises.filter((promise) => !promise.done).length;
    $("#promiseCount").textContent = String(openCount);
    $("#promiseList").innerHTML = state.promises.length ? state.promises.map((promise, index) => `
      <div class="promise-item ${promise.done ? "is-done" : ""}">
        <input type="checkbox" id="promise-${index}" data-promise-index="${index}" ${promise.done ? "checked" : ""} aria-label="Mark ${escapeHTML(promise.text)} ${promise.done ? "not done" : "done"}">
        <label for="promise-${index}">${escapeHTML(promise.text)}${promise.kind === "remembered_note" ? `<span class="promise-due">Remember this</span>` : ""}${promise.due ? `<span class="promise-due">Due ${escapeHTML(formatPromiseDue(promise.due))}</span>` : ""}</label>
      </div>
    `).join("") : `<div class="side-empty">No open commitments. You're all caught up.</div>`;
  }

  function renderPatterns(patterns = []) {
    $("#patternsContainer").innerHTML = patterns.length ? patterns.map((pattern) => `
      <article class="analytics-card">
        <div class="analytics-topline">
          <span class="pattern-icon" aria-hidden="true">${escapeHTML(pattern.icon)}</span>
          <span class="pattern-frequency">${escapeHTML(pattern.frequency)}</span>
        </div>
        <h3>${escapeHTML(pattern.title)}</h3>
        <p>${escapeHTML(pattern.detail)}</p>
        <div class="pattern-meter" aria-label="${escapeHTML(pattern.amount)} percent"><span style="width:${Math.max(0, Math.min(100, Number(pattern.amount) || 0))}%"></span></div>
      </article>
    `).join("") : `<div class="side-empty">No interview patterns found yet. Log interviews to build your cross-company view.</div>`;
  }

  function renderProgress(items = [], improvementAreas = []) {
    const comparisons = items.length ? items.map((item) => `
      <article class="progress-card">
        <h3>${escapeHTML(item.question)}</h3>
        <div class="progress-comparison">
          <div class="progress-answer">
            <div class="progress-answer-label"><span>Interview 1</span><span class="score">${escapeHTML(item.firstScore)} / 10</span></div>
            <p>${escapeHTML(item.first)}</p>
          </div>
          <div class="progress-answer latest">
            <div class="progress-answer-label"><span>Interview 4</span><span class="score">${escapeHTML(item.latestScore)} / 10</span></div>
            <p>${escapeHTML(item.latest)}</p>
          </div>
        </div>
        <span class="improvement">${escapeHTML(item.improvement)} since your first interview</span>
      </article>
    `).join("") : `<div class="side-empty">More interviews will enable score comparisons over time.</div>`;
    const areas = improvementAreas.length ? improvementAreas.map((item) => `
      <article class="progress-card improvement-focus-card">
        <div class="analytics-topline">
          <span class="pattern-frequency">${escapeHTML(item.company || "Interview")}${item.interview ? ` · ${escapeHTML(item.interview)}` : ""}</span>
          ${item.confidence_score !== null && item.confidence_score !== undefined
            ? `<span class="score">Observed confidence ${escapeHTML(item.confidence_score)} / 10</span>` : ""}
        </div>
        <h3>${escapeHTML(item.area || "Answer improvement")}</h3>
        <p><strong>Observed:</strong> ${escapeHTML(item.issue)}</p>
        ${item.evidence ? `<p><strong>Evidence:</strong> ${escapeHTML(item.evidence)}</p>` : ""}
        ${item.recommendation ? `<p><strong>Try next:</strong> ${escapeHTML(item.recommendation)}</p>` : ""}
      </article>
    `).join("") : `<div class="side-empty">No specific mistakes or improvement areas were identified yet. Add a transcript with enough answer detail to assess approach, confidence, and technical gaps.</div>`;
    $("#progressContainer").innerHTML = `
      <section class="progress-focus">
        <h2>Areas to improve next</h2>
        <div class="progress-focus-list">${areas}</div>
      </section>
      <section class="progress-comparisons">
        <h2>Answer quality over time</h2>
        <div class="progress-comparison-list">${comparisons}</div>
      </section>`;
  }

  function setMemoryEnabled(enabled, persist = true, refresh = true) {
    state.memoryOn = enabled;
    const toggle = $("#memoryToggle");
    toggle.classList.toggle("is-on", enabled);
    toggle.classList.toggle("is-off", !enabled);
    toggle.setAttribute("aria-pressed", String(enabled));
    $("#memoryState").textContent = enabled ? "MEMORY ON" : "MEMORY OFF";
    $("#memoryEnabledNote").innerHTML = `<span class="status-dot"></span> ${enabled ? "Saved to Hindsight memory" : "Memory is off"}`;
    $(".remember-card").classList.toggle("memory-disabled", !enabled);
    $("#rememberSubmit").disabled = !enabled;
    renderMemory();
    if (persist) saveState();
    if (enabled && refresh) {
      refreshSidebar();
    } else {
      state.memories = [];
      state.promises = [];
      renderMemory();
      renderPromises();
      if (!enabled) {
        renderPatterns([]);
        renderProgress([]);
      }
    }
  }

  function setActiveTab(tab) {
    $$(".workspace-tab").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$(".tab-panel").forEach((panel) => {
      const active = panel.dataset.panel === tab;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  function setLogTab(tab) {
    activeLogTab = tab;
    $$("[data-log-tab]").forEach((button) => {
      const active = button.dataset.logTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $$("[data-log-panel]").forEach((panel) => {
      const active = panel.dataset.logPanel === tab;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
    $("#processInterviewRow").hidden = tab === "history";
    if (tab === "history") refreshSavedConversations();
  }

  function roadmapWarningsMarkup(warnings = []) {
    if (!warnings.length) return "";
    return `<div role="alert" class="side-empty roadmap-warning">
      ${warnings.map(escapeHTML).join("<br>")}
    </div>`;
  }

  function roadmapCompanyContextMarkup(company, context = {}) {
    const conversations = Array.isArray(context.conversations) ? context.conversations : [];
    const promises = Array.isArray(context.promises) ? context.promises : [];
    const emptyText = context.memoryOn
      ? "No saved interview conversations were found for this company."
      : "Turn Personal Memory on to include saved company conversations.";
    const conversationItems = conversations.length ? conversations.map((item) => `
      <article class="roadmap-context-item">
        <div><strong>${escapeHTML(item.name || company)}</strong>${item.round_number ? ` · ${escapeHTML(item.round_number)}` : ""}</div>
        ${item.created_at ? `<time>${escapeHTML(formatLocalDateTime(item.created_at))}</time>` : ""}
        ${item.summary ? `<p>${escapeHTML(item.summary)}</p>` : ""}
      </article>
    `).join("") : `<p class="roadmap-context-empty">${escapeHTML(emptyText)}</p>`;
    const promiseItems = promises.length ? promises.map((item) => `
      <article class="roadmap-context-item">
        <div><strong>${escapeHTML(item.kind === "next_step" ? "To do" : "Promised")}:</strong> ${escapeHTML(item.text)}</div>
        <div class="roadmap-context-meta">${item.round_number ? `${escapeHTML(item.round_number)} · ` : ""}${item.due ? `Due ${escapeHTML(item.due)}` : "No due date recorded"}</div>
      </article>
    `).join("") : `<p class="roadmap-context-empty">${context.memoryOn
      ? `No pending promises or follow-ups were found for ${escapeHTML(company)}.`
      : "Turn Personal Memory on to include saved promises and follow-ups."}</p>`;
    return `
      <div class="roadmap-context-grid">
        <section class="roadmap-context-card">
          <h3>${escapeHTML(company)} conversation history</h3>
          <div class="roadmap-context-list">${conversationItems}</div>
        </section>
        <section class="roadmap-context-card roadmap-followups">
          <h3>${escapeHTML(company)} follow-ups to remember</h3>
          <div class="roadmap-context-list">${promiseItems}</div>
        </section>
      </div>`;
  }

  function renderRoadmapMarkdown(company, role, days, markdown, intelligence = {}, warnings = [], context = {}) {
    const inline = (text) => escapeHTML(text).replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>'
    );
    const lines = markdown.split(/\r?\n/);
    const rendered = [];
    let listOpen = false;
    lines.forEach((line) => {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        if (listOpen) { rendered.push("</ul>"); listOpen = false; }
        const level = Math.min(3, heading[1].length + 1);
        rendered.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (!listOpen) { rendered.push("<ul>"); listOpen = true; }
        rendered.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      } else {
        if (listOpen) { rendered.push("</ul>"); listOpen = false; }
        if (line.trim()) rendered.push(`<p>${inline(line)}</p>`);
      }
    });
    if (listOpen) rendered.push("</ul>");
    const analyzed = [
      `${Number(intelligence.saved_conversations_analyzed) || 0} conversation files`,
      `${Number(intelligence.hindsight_memories_recalled) || 0} Hindsight memories`,
      `${Number(intelligence.open_promises_reviewed) || 0} open commitments`,
      `${Number(intelligence.improvement_areas_reviewed) || 0} improvement areas`,
      `${Number(intelligence.web_sources_reviewed) || 0} web sources`
    ];
    $("#roadmapResults").innerHTML = `
      ${roadmapWarningsMarkup(warnings)}
      <div class="roadmap-header"><h2>${escapeHTML(company)} · ${escapeHTML(role)}</h2><span class="roadmap-days">${days} day${days === 1 ? "" : "s"} to prepare</span></div>
      ${roadmapCompanyContextMarkup(company, context)}
      <article class="roadmap-markdown">${rendered.join("")}</article>
      <p class="roadmap-evidence">Built from ${analyzed.map(escapeHTML).join(" · ")}.</p>`;
  }

  function renderRoadmap(company, role, days, items, warnings = []) {
    $("#roadmapResults").innerHTML = `
      ${roadmapWarningsMarkup(warnings)}
      <div class="roadmap-header"><h2>${escapeHTML(company)} · ${escapeHTML(role)}</h2><span class="roadmap-days">${days} day${days === 1 ? "" : "s"} to prepare</span></div>
      <div class="roadmap-list">${items.map((item) => `
        <article class="roadmap-day">
          <span class="day-label">${escapeHTML(item.day)}</span>
          <div><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.detail)}</p><div class="citation-list"><span class="citation-badge ${item.source === "General preparation" ? "source-muted" : ""}">✦ ${escapeHTML(item.source || "Preparation plan")}</span>${(item.citations || []).map((citation) => `<a class="citation-badge source-muted" href="${escapeHTML(citation.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(citation.title || "Research source")} ↗</a>`).join("")}</div></div>
        </article>
      `).join("")}</div>`;
  }

  async function generateRoadmap(company, role, days) {
    const button = $("#roadmapForm button[type=submit]");
    const results = $("#roadmapResults");
    const originalButtonHTML = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = '<span class="loading-spinner" aria-hidden="true">◌</span> Preparing your roadmap…';
    results.setAttribute("aria-busy", "true");
    results.innerHTML = `
      <div class="roadmap-skeleton" role="status" aria-label="Building your roadmap">
        <span class="skeleton-line skeleton-title"></span>
        <span class="skeleton-line skeleton-short"></span>
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
        <span class="skeleton-block"></span>
      </div>`;
    const spinner = $(".loading-spinner", button);
    if (spinner && typeof spinner.animate === "function") {
      spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: 900,
        iterations: Infinity
      });
    }
    try {
      const result = await apiRequest("/api/roadmap", jsonOptions({
        company,
        role,
        days_left: days,
        memory_enabled: state.memoryOn,
        current_local_datetime: new Date().toLocaleString()
      }));
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      if (typeof result.roadmap_markdown === "string") {
        renderRoadmapMarkdown(company, role, days, result.roadmap_markdown, result.intelligence_summary, warnings, {
          conversations: result.company_conversations,
          promises: result.company_promises,
          memoryOn: state.memoryOn
        });
      } else if (Array.isArray(result.roadmap)) {
        renderRoadmap(company, role, days, result.roadmap, warnings);
      } else {
        throw new Error("The server returned no roadmap.");
      }
      if (state.memoryOn && Array.isArray(result.memories)) {
        state.memories = result.memories;
        renderMemory();
      }
    } catch (error) {
      console.error("RoundReady roadmap request failed.", error);
      showPanelError($("#roadmapResults"), `Could not generate the roadmap: ${error.message}`);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = originalButtonHTML;
      results.removeAttribute("aria-busy");
    }
  }

  async function refreshSidebar() {
    if (!state.memoryOn) return;
    const [memoryResult, promiseResult] = await Promise.allSettled([
      apiRequest("/api/memories"),
      apiRequest("/api/promises")
    ]);
    if (memoryResult.status === "fulfilled") {
      state.memories = memoryResult.value.memories;
      renderMemory();
    } else {
      showPanelError($("#memoryList"), memoryResult.reason.message);
    }
    if (promiseResult.status === "fulfilled") {
      state.promises = promiseResult.value.promises;
      renderPromises();
    } else {
      showPanelError($("#promiseList"), promiseResult.reason.message);
    }
    return promiseResult.status === "fulfilled";
  }

  async function refreshPatterns() {
    try {
      const result = await apiRequest("/api/patterns");
      renderPatterns(result.patterns);
    } catch (error) {
      showPanelError($("#patternsContainer"), error.message);
    }
  }

  async function refreshProgress() {
    try {
      const result = await apiRequest("/api/progress");
      renderProgress(result.progress, result.improvement_areas);
    } catch (error) {
      showPanelError($("#progressContainer"), error.message);
    }
  }

  function setCaptureStatus(status, message) {
    const statusNode = $("#captureStatus");
    statusNode.classList.toggle("is-listening", status === "listening");
    statusNode.classList.toggle("has-error", status === "error");
    $("#captureStatusText").textContent = message;
  }

  function appendFeedEntry(message) {
    const feed = $("#transcriptFeed");
    const placeholder = $(".feed-placeholder", feed);
    if (placeholder) placeholder.remove();
    const entry = document.createElement("article");
    entry.className = "feed-entry";
    entry.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>${escapeHTML(message)}`;
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
  }

  function appendLiveDialogue(dialogue) {
    const feed = $("#liveTranscriptFeed");
    const placeholder = $(".live-transcript-placeholder", feed);
    if (placeholder) placeholder.remove();
    const lines = dialogue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    liveDialogueText = [liveDialogueText, ...lines].filter(Boolean).join("\n");
    lines.forEach((line) => {
      const entry = document.createElement("p");
      entry.className = "live-dialogue-line";
      entry.textContent = line;
      feed.appendChild(entry);
    });
    feed.scrollTop = feed.scrollHeight;
  }

  function queueLiveDialogueChunk(index, dialogue) {
    liveDialogueChunks[index - 1] = dialogue || "";
    while (nextLiveDialogueChunk <= liveDialogueChunks.length
      && liveDialogueChunks[nextLiveDialogueChunk - 1] !== undefined) {
      const nextDialogue = liveDialogueChunks[nextLiveDialogueChunk - 1];
      if (nextDialogue) appendLiveDialogue(nextDialogue);
      nextLiveDialogueChunk += 1;
    }
  }

  function renderSavedConversations() {
    const container = $("#savedConversations");
    if (!savedConversations.length) {
      container.innerHTML = `<div class="side-empty">No saved conversations yet. Capture and save a dialogue to see it here.</div>`;
      return;
    }
    container.innerHTML = savedConversations.map((conversation) => {
      const formattedDate = formatLocalDateTime(conversation.created_at);
      const isCleaned = conversation.status === "cleaned";
      const savedContent = isCleaned && conversation.summary
        ? JSON.stringify(conversation.summary, null, 2)
        : conversation.transcript || conversation.condensed_summary || "No transcript or summary is available.";
      return `
        <article class="saved-conversation-card">
          <div class="saved-conversation-meta">
            <div><h3>${escapeHTML(conversation.name)}</h3><p>${escapeHTML(conversation.company)}${conversation.round_number ? ` · ${escapeHTML(conversation.round_number)}` : ""} · ${escapeHTML(formattedDate)}</p></div>
            <div class="conversation-actions">
              <button class="button button-quiet load-conversation" type="button" data-conversation-id="${escapeHTML(conversation.id)}">Load into live stream</button>
              <button class="button button-delete delete-conversation" type="button" data-conversation-id="${escapeHTML(conversation.id)}" aria-label="Delete ${escapeHTML(conversation.name)} conversation">Delete</button>
            </div>
          </div>
          <details>
            <summary>${isCleaned ? "View Cleaned Summary (processed after 7 days)" : ["pruned", "pruned_condensed"].includes(conversation.status) ? "View Condensed Summary (processed after 7 days)" : "View Full Dialogue"}</summary>
            <pre>${escapeHTML(savedContent)}</pre>
          </details>
        </article>`;
    }).join("");
  }

  async function refreshSavedConversations() {
    const container = $("#savedConversations");
    if (!savedConversations.length) container.innerHTML = `<div class="side-empty">Loading saved conversations…</div>`;
    try {
      const result = await apiRequest("/api/saved-conversations");
      savedConversations = Array.isArray(result.conversations) ? result.conversations : [];
      renderSavedConversations();
    } catch (error) {
      container.innerHTML = `<div class="side-empty">${escapeHTML(error.message)}</div>`;
    }
  }

  async function deleteSavedConversation(conversationId, button) {
    const conversation = savedConversations.find((item) => item.id === conversationId);
    if (!conversation || !window.confirm(`Delete the saved ${conversation.company} conversation and its linked follow-ups? This cannot be undone.`)) {
      return;
    }
    button.disabled = true;
    try {
      await apiRequest(`/api/saved-conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
      await refreshSavedConversations();
      showToast(`Deleted ${conversation.company} conversation from Hindsight.`);
    } catch (error) {
      button.disabled = false;
      showToast(`Could not delete conversation: ${error.message}`);
    }
  }

  async function saveConversation() {
    if (!state.memoryOn) {
      $("#saveConversationStatus").textContent = "Turn Personal Memory on before saving to Hindsight.";
      $("#saveConversationStatus").className = "save-conversation-status is-error";
      return;
    }
    if (!liveDialogueText.trim()) {
      $("#saveConversationStatus").textContent = "Capture some dialogue before saving.";
      $("#saveConversationStatus").className = "save-conversation-status is-error";
      return;
    }
    const suggestedCompany = $("#liveCompany").value.trim();
    const company = suggestedCompany || window.prompt("Company name (used as the conversation name)", "");
    if (company === null) return;
    if (!company.trim()) {
      $("#saveConversationStatus").textContent = "Enter a company name to save.";
      $("#saveConversationStatus").className = "save-conversation-status is-error";
      return;
    }
    if (!suggestedCompany) $("#liveCompany").value = company.trim();

    const button = $("#saveConversation");
    button.disabled = true;
    $("#saveConversationStatus").textContent = "Saving conversation…";
    $("#saveConversationStatus").className = "save-conversation-status";
    try {
      await apiRequest("/api/save-conversation", jsonOptions({
        company: company.trim(),
        round_number: $("#liveRound").value.trim(),
        transcript: liveDialogueText,
        interview_id: audioChunkCount > 0 ? captureInterviewId : ""
      }));
      $("#saveConversationStatus").textContent = `✓ Saved to Hindsight as “${company.trim()}”`;
      $("#saveConversationStatus").className = "save-conversation-status is-success";
      await refreshSavedConversations();
    } catch (error) {
      $("#saveConversationStatus").textContent = `Could not save: ${error.message}`;
      $("#saveConversationStatus").className = "save-conversation-status is-error";
    } finally {
      button.disabled = false;
    }
  }

  function loadSavedConversation(conversationId) {
    const conversation = savedConversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    liveDialogueText = "";
    audioChunkCount = 0;
    captureInterviewId = "";
    $("#liveTranscriptFeed").innerHTML = "";
    appendLiveDialogue(conversation.transcript || conversation.condensed_summary);
    $("#liveCompany").value = conversation.company;
    $("#liveRound").value = conversation.round_number || "";
    $("#saveConversationStatus").textContent = `Loaded “${conversation.name}” into the live stream.`;
    $("#saveConversationStatus").className = "save-conversation-status";
    setLogTab("live");
  }

  async function sendAudioChunk(blob, index) {
    pendingChunkUploads += 1;
    $("#feedLabel").textContent = `Transcribing chunk ${index}…`;
    const formData = new FormData();
    formData.append("audio", blob, `live-interview-${index}.webm`);
    formData.append("company", $("#liveCompany").value.trim());
    formData.append("round_number", $("#liveRound").value.trim());
    formData.append("interview_id", captureInterviewId);
    formData.append("memory_enabled", String(state.memoryOn));
    const upload = (async () => {
      try {
        const result = await apiRequest("/api/live-audio-chunk", { method: "POST", body: formData });
        appendFeedEntry(`Transcript: ${result.transcript_snippet}`);
        if (typeof result.formatted_dialogue !== "string" || !result.formatted_dialogue.trim()) {
          throw new Error("The server returned no formatted dialogue for this audio chunk.");
        }
        queueLiveDialogueChunk(index, result.formatted_dialogue);
        $("#liveStatusBadge").textContent = displayStream
          ? "🟢 Silently listening & logging dialogue..."
          : "⚪ Capture complete";
        if (!result.saved_to_memory) appendFeedEntry("Memory was off; this chunk was transcribed but not retained.");
        $("#feedLabel").textContent = `${index} chunk${index === 1 ? "" : "s"} transcribed`;
        if (result.saved_to_memory) await refreshSidebar();
      } catch (error) {
        failedChunkUploads += 1;
        queueLiveDialogueChunk(index, "");
        $("#liveStatusBadge").textContent = "⚠️ Dialogue capture error";
        appendFeedEntry(`Chunk ${index} failed: ${error.message}`);
        $("#captureNote").textContent = `Audio chunk ${index} could not be transcribed or saved: ${error.message}`;
      } finally {
        pendingChunkUploads -= 1;
        if (!displayStream && pendingChunkUploads === 0) {
          $("#feedLabel").textContent = failedChunkUploads ? "Capture finished with errors" : "Capture complete";
          $("#captureNote").textContent = `${audioChunkCount} audio chunk${audioChunkCount === 1 ? "" : "s"} processed${failedChunkUploads ? ` · ${failedChunkUploads} failed` : ""}.`;
        }
        chunkUploadPromises = chunkUploadPromises.filter((pending) => pending !== upload);
      }
    })();
    chunkUploadPromises.push(upload);
    await upload;
  }

  function finishCapture() {
    audioRecorder = null;
    $("#startCapture").disabled = false;
    $("#stopCapture").disabled = true;
    $("#feedLabel").textContent = pendingChunkUploads ? "Finishing transcription…" : "Capture stopped";
    $(".live-indicator").classList.remove("is-live");
    setCaptureStatus(failedChunkUploads ? "error" : "idle", failedChunkUploads ? "Some chunks failed" : "Not listening");
    $("#liveStatusBadge").textContent = failedChunkUploads ? "⚠️ Capture stopped with errors" : "⚪ Idle";
    $("#captureNote").textContent = `${audioChunkCount} audio chunk${audioChunkCount === 1 ? "" : "s"} captured · ${pendingChunkUploads} still uploading${failedChunkUploads ? ` · ${failedChunkUploads} failed` : ""}.`;
    appendFeedEntry(`Capture stopped. ${audioChunkCount} audio chunk${audioChunkCount === 1 ? "" : "s"} sent for transcription.`);
  }

  function startRecorderSegment() {
    if (!displayStream) return false;
    try {
      const activeAudioTracks = displayStream.getAudioTracks().filter((track) => track.readyState === "live" && track.enabled);
      if (!activeAudioTracks.length) {
        setCaptureStatus("error", "Tab audio ended");
        $("#captureNote").textContent = "The shared tab audio track is no longer active. Start capture again and share tab audio.";
        stopCapture();
        return false;
      }
      const audioStream = new MediaStream(activeAudioTracks);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
      audioRecorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data || !event.data.size) return;
        audioChunkCount += 1;
        appendFeedEntry(`Audio chunk ${audioChunkCount} captured (${Math.round(event.data.size / 1024)} KB); sending for transcription.`);
        sendAudioChunk(event.data, audioChunkCount);
      });
      recorder.addEventListener("error", (event) => {
        console.error("RoundReady audio recorder error.", event.error || event);
        setCaptureStatus("error", "Recording error");
        $("#captureNote").textContent = "The browser recorder reported an error. Stop capture and try again.";
        stopCapture();
      });
      recorder.addEventListener("stop", () => {
        if (audioRecorder === recorder) audioRecorder = null;
        if (displayStream) {
          startRecorderSegment();
        } else {
          finishCapture();
        }
      }, { once: true });
      recorder.start();
      captureTimer = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 15000);
      return true;
    } catch (error) {
      console.error("RoundReady could not record an audio chunk.", error);
      setCaptureStatus("error", "Recording error");
      $("#captureNote").textContent = `Audio recording failed: ${error.message}`;
      stopCapture();
      return false;
    }
  }

  function stopCapture() {
    if (!displayStream) return;
    const stream = displayStream;
    displayStream = null;
    window.clearTimeout(captureTimer);
    if (audioRecorder && audioRecorder.state === "recording") {
      audioRecorder.stop();
    } else {
      finishCapture();
    }
    stream.getTracks().forEach((track) => track.stop());
  }

  async function startSilentLiveTabCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !window.MediaRecorder) {
      setCaptureStatus("error", "Capture unavailable");
      $("#captureNote").textContent = "This browser does not support tab audio capture. Try a current version of Chrome or Edge over HTTPS or localhost.";
      return;
    }

    $("#startCapture").disabled = true;
    setCaptureStatus("idle", "Waiting for permission");
    $("#captureNote").textContent = "Choose a browser tab and enable its audio in the sharing dialog.";
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const audioTracks = stream.getAudioTracks().filter((track) => track.readyState === "live" && track.enabled);
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        setCaptureStatus("error", "No tab audio selected");
        $("#captureNote").textContent = "No audio track was shared. Stop sharing, then choose a tab and enable “Share tab audio.”";
        $("#startCapture").disabled = false;
        return;
      }

      displayStream = stream;
      liveDialogueText = "";
      liveDialogueChunks = [];
      nextLiveDialogueChunk = 1;
      $("#liveTranscriptFeed").innerHTML = `<p class="live-transcript-placeholder">Listening for the first dialogue chunk…</p>`;
      $("#saveConversationStatus").textContent = "";
      $("#saveConversationStatus").className = "save-conversation-status";
      displayStream.getVideoTracks().forEach((track) => {
        track.onended = stopCapture;
      });
      audioChunkCount = 0;
      pendingChunkUploads = 0;
      failedChunkUploads = 0;
      chunkUploadPromises = [];
      captureInterviewId = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!startRecorderSegment()) return;
      $("#startCapture").disabled = true;
      $("#stopCapture").disabled = false;
      $("#feedLabel").textContent = "Audio capture active";
      $(".live-indicator").classList.add("is-live");
      setCaptureStatus("listening", "Silently listening...");
      $("#liveStatusBadge").textContent = "🟢 Listening for dialogue...";
      $("#captureNote").textContent = `Audio is uploaded in independent 15-second WebM chunks for transcription${state.memoryOn ? " and Hindsight storage" : " only; memory is off"}.`;
      appendFeedEntry("Tab audio capture started. Complete 15-second WebM segments are being sent to the server.");
    } catch (error) {
      const failedStream = displayStream;
      displayStream = null;
      audioRecorder = null;
      if (failedStream) failedStream.getTracks().forEach((track) => track.stop());
      $("#startCapture").disabled = false;
      $("#stopCapture").disabled = true;
      if (error && error.name === "NotAllowedError") {
        setCaptureStatus("idle", "Permission not granted");
        $("#captureNote").textContent = "Tab capture was cancelled or permission was denied. Allow sharing and try again when you're ready.";
      } else {
        console.error("RoundReady could not start tab audio capture.", error);
        setCaptureStatus("error", "Capture failed");
        $("#captureNote").textContent = `Capture could not start: ${error && error.message ? error.message : "unexpected browser error"}.`;
      }
    }
  }

  function interviewAnalysisMarkup(result) {
    const notes = result.notes || {};
    const areas = Array.isArray(notes.improvement_areas) ? notes.improvement_areas : [];
    const weaknesses = Array.isArray(notes.weak_points) ? notes.weak_points : [];
    const promises = Array.isArray(notes.promises) ? notes.promises : [];
    const feedback = [
      ...weaknesses.map((item) => `<li><strong>Needs work:</strong> ${escapeHTML(item)}</li>`),
      ...areas.map((item) => {
        if (!item || typeof item !== "object") return "";
        const score = Number(item.confidence_score);
        const confidence = Number.isFinite(score) && score >= 1 && score <= 10
          ? ` <span class="analysis-confidence">(observed confidence ${escapeHTML(score)} / 10)</span>` : "";
        return `<li><strong>${escapeHTML(item.area || "Improvement")}:</strong> ${escapeHTML(item.issue || "")}${confidence}${item.recommendation ? `<br><span class="analysis-recommendation">Try next: ${escapeHTML(item.recommendation)}</span>` : ""}</li>`;
      }).filter(Boolean),
      ...promises.map((item) => item && item.promise
        ? `<li><strong>Follow-up:</strong> ${escapeHTML(item.promise)}${item.due_date ? ` (due ${escapeHTML(item.due_date)})` : ""}</li>` : "")
    ].filter(Boolean);
    const summary = notes.summary ? `<p>${escapeHTML(notes.summary)}</p>` : "";
    return `<strong>Interview processed.</strong> ${escapeHTML(result.transcript_snippet || "")}${summary}${feedback.length ? `<ul class="interview-analysis-list">${feedback.join("")}</ul>` : `<p>No specific improvement points were identified from this transcript.</p>`}`;
  }

  async function processInterview() {
    const feedback = $("#logFeedback");
    if (activeLogTab === "history") return;
    if (!state.memoryOn && activeLogTab !== "live") {
      feedback.textContent = "Turn memory on before saving an interview to Hindsight.";
      return;
    }
    const button = $("#processInterview");
    button.disabled = true;
    feedback.textContent = "Processing interview…";
    try {
      if (activeLogTab === "live") {
        if (!audioChunkCount) {
          feedback.textContent = "Start tab capture and wait for an audio chunk before saving.";
          return;
        }
        await Promise.all([...chunkUploadPromises]);
        if (failedChunkUploads) {
          feedback.textContent = `${failedChunkUploads} audio chunk${failedChunkUploads === 1 ? "" : "s"} failed. Check the live feed and server configuration.`;
          return;
        }
        if (displayStream) {
          feedback.textContent = "Stop capture before processing the complete live interview.";
          return;
        }
        feedback.textContent = state.memoryOn
          ? `${audioChunkCount} audio chunk${audioChunkCount === 1 ? "" : "s"} transcribed and saved to Hindsight.`
          : `${audioChunkCount} audio chunk${audioChunkCount === 1 ? "" : "s"} transcribed; memory was off, so nothing was retained.`;
      } else {
        let result;
        if (activeLogTab === "text") {
          const transcript = $("#transcriptInput").value.trim();
          if (!transcript) {
            feedback.textContent = "Add a transcript before saving.";
            return;
          }
          result = await apiRequest("/api/log-interview", jsonOptions({
            transcript,
            company: $("#textCompany").value.trim(),
            round_number: $("#textRound").value.trim()
          }));
        } else {
          if (!selectedAudio) {
            feedback.textContent = "Choose an MP3 or WAV file first.";
            return;
          }
          const formData = new FormData();
          formData.append("audio", selectedAudio, selectedAudio.name);
          formData.append("company", $("#audioCompany").value.trim());
          formData.append("round_number", $("#audioRound").value.trim());
          result = await apiRequest("/api/log-interview", { method: "POST", body: formData });
        }
        feedback.innerHTML = interviewAnalysisMarkup(result);
      }
      if (state.memoryOn) {
        showToast("Interview saved to Hindsight.");
        await Promise.all([refreshSidebar(), refreshPatterns(), refreshProgress()]);
      } else {
        showToast("Interview processed without saving memory.");
      }
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function loadDemoData() {
    const button = $("#loadDemo");
    button.disabled = true;
    setMemoryEnabled(true, true, false);
    setActiveTab("roadmap");
    $("#companyInput").value = "Stripe";
    $("#roleInput").value = "Product Designer";
    $("#daysInput").value = "5";
    try {
      const localToday = new Date();
      await apiRequest("/api/seed-demo", jsonOptions({
        local_date: [
          localToday.getFullYear(),
          String(localToday.getMonth() + 1).padStart(2, "0"),
          String(localToday.getDate()).padStart(2, "0")
        ].join("-")
      }));
      await Promise.all([refreshSidebar(), refreshPatterns(), refreshProgress()]);
      await generateRoadmap("Stripe", "Product Designer", 5);
      showToast("Demo interviews saved to Hindsight.");
    } catch (error) {
      showToast(`Could not load demo data: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  $$(".workspace-tab").forEach((button, index, buttons) => {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.tab);
      if (button.dataset.tab === "patterns" && state.memoryOn) refreshPatterns();
      if (button.dataset.tab === "progress" && state.memoryOn) refreshProgress();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = buttons[(index + offset + buttons.length) % buttons.length];
      next.focus();
      setActiveTab(next.dataset.tab);
    });
  });

  $$("[data-log-tab]").forEach((button) => button.addEventListener("click", () => setLogTab(button.dataset.logTab)));
  $$("[data-open-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.openTab)));
  $("#memoryToggle").addEventListener("click", () => {
    const enabled = !state.memoryOn;
    setMemoryEnabled(enabled);
    if (!enabled && displayStream) {
      stopCapture();
      showToast("Memory is off. Capture stopped; chunks already sent may have been saved.");
    }
  });
  $("#loadDemo").addEventListener("click", loadDemoData);
  $("#startCapture").addEventListener("click", startSilentLiveTabCapture);
  $("#stopCapture").addEventListener("click", stopCapture);
  $("#saveConversation").addEventListener("click", saveConversation);
  $("#refreshHistory").addEventListener("click", refreshSavedConversations);
  $("#savedConversations").addEventListener("click", (event) => {
    const button = event.target.closest(".load-conversation");
    if (button) loadSavedConversation(button.dataset.conversationId);
    const deleteButton = event.target.closest(".delete-conversation");
    if (deleteButton) deleteSavedConversation(deleteButton.dataset.conversationId, deleteButton);
  });

  $("#roadmapForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const company = $("#companyInput").value.trim();
    const role = $("#roleInput").value.trim();
    const days = Number($("#daysInput").value);
    if (!company || !role || !Number.isInteger(days) || days < 1 || days > 30) return;
    generateRoadmap(company, role, days);
  });

  $("#consistencyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const answer = $("#answerInput").value.trim();
    if (!answer) return;
    const button = $("#consistencyForm button[type=submit]");
    button.disabled = true;
    apiRequest("/api/check-consistency", jsonOptions({ answer, memory_enabled: state.memoryOn }))
      .then((result) => {
        $("#consistencyResults").innerHTML = `
          <div class="consistency-result ${result.warning ? "is-warning" : "is-clear"}">
            <div class="consistency-result-heading"><span aria-hidden="true">${result.warning ? "!" : "✓"}</span>${escapeHTML(result.title)}</div>
            <p>${escapeHTML(result.detail)}</p>
            ${result.previous ? `<div class="consistency-match">Past statement: “${escapeHTML(result.previous)}”</div>` : ""}
          </div>`;
      })
      .catch((error) => showPanelError($("#consistencyResults"), error.message))
      .finally(() => { button.disabled = false; });
  });

  $("#rememberForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#rememberInput");
    const text = input.value.trim();
    const dueDate = $("#rememberDueDate").value;
    if (!text) {
      $("#rememberFeedback").textContent = "Write a quick note first.";
      return;
    }
    if (!state.memoryOn) {
      $("#rememberFeedback").textContent = "Turn memory on before saving a note.";
      return;
    }
    const button = $("#rememberSubmit");
    button.disabled = true;
    apiRequest("/api/remember", jsonOptions({
      content: text,
      due_date: dueDate
    }))
      .then(async (result) => {
        input.value = "";
        $("#rememberDueDate").value = "";
        const promisesLoaded = await refreshSidebar();
        if (!promisesLoaded) {
          $("#rememberFeedback").textContent = "Saved to Hindsight, but Pending promises could not be loaded. Check the Hindsight connection.";
        } else if (result.reminder_status === "failed") {
          $("#rememberFeedback").textContent = `Saved to Pending promises, but the email was not sent: ${result.reminder_message || "Check your email provider settings."}`;
        } else if (result.reminder_status === "sent") {
          $("#rememberFeedback").textContent = "Saved to Pending promises. Resend accepted the immediate reminder.";
        } else {
          $("#rememberFeedback").textContent = dueDate
            ? "Saved to Pending promises. Email reminders are scheduled for the day before and due date."
            : "Saved to Hindsight and added to Pending promises.";
        }
      })
      .catch((error) => { $("#rememberFeedback").textContent = error.message; })
      .finally(() => { button.disabled = !state.memoryOn; });
  });

  $("#promiseList").addEventListener("change", (event) => {
    const index = Number(event.target.dataset.promiseIndex);
    if (!Number.isInteger(index) || !state.promises[index]) return;
    const promise = state.promises[index];
    event.target.disabled = true;
    apiRequest("/api/promises/complete", jsonOptions({
      promise_id: promise.id,
      text: promise.text,
      company: promise.company
    }))
      .then(() => refreshSidebar())
      .catch((error) => {
        event.target.checked = false;
        showToast(`Could not update promise: ${error.message}`);
      })
      .finally(() => { event.target.disabled = false; });
  });

  $("#processInterview").addEventListener("click", processInterview);

  $("#audioFile").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setAudioFile(file);
  });

  function setAudioFile(file) {
    const validType = /\.(mp3|wav)$/i.test(file.name);
    if (!validType) {
      selectedAudio = null;
      $("#selectedFile").textContent = "Please choose an MP3 or WAV file.";
      return;
    }
    if (file.size > MAX_AUDIO_SIZE) {
      selectedAudio = null;
      $("#selectedFile").textContent = "This file is over the 25 MB upload limit.";
      return;
    }
    selectedAudio = file;
    $("#selectedFile").textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  }

  const dropzone = $("#audioDropzone");
  ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  }));
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) setAudioFile(file);
  });

  $("#companyInput").value = "";
  $("#roleInput").value = "";
  const rememberDueDate = $("#rememberDueDate");
  if (rememberDueDate) {
    const localToday = new Date();
    const localDate = new Date(localToday.getTime() - localToday.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    rememberDueDate.min = localDate;
  }
  renderMemory();
  renderPromises();
  renderPatterns();
  renderProgress();
  setMemoryEnabled(state.memoryOn, false);
  if (!state.memoryOn) {
    renderPatterns([]);
    renderProgress([]);
  }
  window.addEventListener("beforeunload", () => {
    if (displayStream) displayStream.getTracks().forEach((track) => track.stop());
  });
})();
