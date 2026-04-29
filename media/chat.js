"use strict";
(() => {
  // src/webview/dom.ts
  var messagesEl = document.getElementById("messages");
  var inputEl = document.getElementById("input");
  var btnSend = document.getElementById("btn-send");
  var btnStop = document.getElementById("btn-stop");
  var btnNew = document.getElementById("btn-new");
  var btnSessions = document.getElementById("btn-sessions");
  var btnSettings = document.getElementById("btn-settings");
  var sessionsPanelEl = document.getElementById("sessions-panel");
  var settingsPanelEl = document.getElementById("settings-panel");
  var statusEl = document.getElementById("status");
  var agentStatusEl = document.getElementById("agent-status");
  var mentionPopup = document.getElementById("mention-popup");
  var scrollSentinel = document.createElement("div");
  scrollSentinel.style.cssText = "height:1px;flex-shrink:0;pointer-events:none;";
  messagesEl.appendChild(scrollSentinel);
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }
  function scrollToBottom(force = false) {
    if (force || isNearBottom()) {
      messagesEl.appendChild(scrollSentinel);
      scrollSentinel.scrollIntoView({ block: "end" });
    }
  }

  // src/webview/markdown.ts
  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(text) {
    return text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      if (!/^(https?:|mailto:|vscode:)/i.test(url))
        return label;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
  }
  function renderMarkdown(text) {
    const blocks = [];
    let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = escapeHtml(code.trimEnd());
      const label = lang || "code";
      const block = `<div class="code-block"><div class="code-header">${label}<button class="copy-btn" data-action="copy">Copy</button></div><pre><code>${escaped}</code></pre></div>`;
      blocks.push(block);
      return `\0BLOCK${blocks.length - 1}\0`;
    });
    s = escapeHtml(s);
    const lines = s.split("\n");
    const out = [];
    let inUl = false;
    let inOl = false;
    let inBq = false;
    const tableSep = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
    const splitRow = (line) => {
      const trimmed = line.trim().replace(/^\||\|$/g, "");
      return trimmed.split("|").map((c) => c.trim());
    };
    const closeLists = () => {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
    };
    const closeBlocks = () => {
      closeLists();
      if (inBq) {
        out.push("</blockquote>");
        inBq = false;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("|") && i + 1 < lines.length && tableSep.test(lines[i + 1])) {
        closeBlocks();
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const left = c.startsWith(":");
          const right = c.endsWith(":");
          if (left && right)
            return "center";
          if (right)
            return "right";
          return "left";
        });
        let tbl = "<table><thead><tr>";
        header.forEach((h, idx) => {
          tbl += `<th style="text-align:${aligns[idx] ?? "left"}">${inline(h)}</th>`;
        });
        tbl += "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          const cells = splitRow(lines[i]);
          tbl += "<tr>";
          cells.forEach((c, idx) => {
            tbl += `<td style="text-align:${aligns[idx] ?? "left"}">${inline(c)}</td>`;
          });
          tbl += "</tr>";
          i++;
        }
        tbl += "</tbody></table>";
        out.push(tbl);
        i--;
        continue;
      }
      if (/^>\s?/.test(line)) {
        if (!inBq) {
          closeLists();
          out.push("<blockquote>");
          inBq = true;
        }
        out.push(inline(line.replace(/^>\s?/, "")) + "<br>");
        continue;
      }
      if (inBq) {
        out.push("</blockquote>");
        inBq = false;
      }
      if (/^### /.test(line)) {
        closeLists();
        out.push(`<h3>${inline(line.slice(4))}</h3>`);
        continue;
      }
      if (/^## /.test(line)) {
        closeLists();
        out.push(`<h2>${inline(line.slice(3))}</h2>`);
        continue;
      }
      if (/^# /.test(line)) {
        closeLists();
        out.push(`<h1>${inline(line.slice(2))}</h1>`);
        continue;
      }
      if (/^---+$/.test(line.trim())) {
        closeLists();
        out.push("<hr>");
        continue;
      }
      const ulMatch = line.match(/^( {0,4})[-*] (.+)/);
      if (ulMatch) {
        if (!inUl) {
          if (inOl) {
            out.push("</ol>");
            inOl = false;
          }
          out.push("<ul>");
          inUl = true;
        }
        out.push(`<li>${inline(ulMatch[2])}</li>`);
        continue;
      }
      const olMatch = line.match(/^( {0,4})\d+\. (.+)/);
      if (olMatch) {
        if (!inOl) {
          if (inUl) {
            out.push("</ul>");
            inUl = false;
          }
          out.push("<ol>");
          inOl = true;
        }
        out.push(`<li>${inline(olMatch[2])}</li>`);
        continue;
      }
      closeLists();
      if (line.trim() === "") {
        out.push("<br>");
        continue;
      }
      out.push(inline(line) + "<br>");
    }
    closeBlocks();
    s = out.join("");
    s = s.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[+i]);
    return s;
  }
  function copyCodeBlock(btn) {
    const block = btn.closest(".code-block");
    const code = block?.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code).then(
      () => {
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 2e3);
      },
      () => {
        btn.textContent = "Failed";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 2e3);
      }
    );
  }

  // src/webview/state.ts
  var state = {
    configOptions: [],
    currentMode: "manual",
    providers: [],
    providersUnavailable: false,
    currentAssistantEl: null,
    currentToolGroupEl: null,
    currentThoughtEl: null,
    currentPlanEl: null,
    isStreaming: false,
    lastErrorEl: null,
    toolCallItems: /* @__PURE__ */ new Map(),
    mention: null,
    mentionQueryId: 0,
    mentionDebounce: null
  };
  var vscode = acquireVsCodeApi();

  // src/webview/messages.ts
  function appendMessage(role, text) {
    const div = document.createElement("div");
    div.className = `message ${role}`;
    const roleEl = document.createElement("div");
    roleEl.className = "message-role";
    roleEl.textContent = role === "user" ? "You" : role === "assistant" ? "Codeep" : "";
    if (role !== "system")
      div.appendChild(roleEl);
    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    contentEl.innerHTML = renderMarkdown(text);
    div.appendChild(contentEl);
    messagesEl.appendChild(div);
    if (role === "system")
      state.lastErrorEl = div;
    scrollToBottom(true);
    return contentEl;
  }
  function dismissLastError() {
    const el = state.lastErrorEl;
    if (!el)
      return;
    state.lastErrorEl = null;
    el.style.transition = "opacity 0.4s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }
  function setAgentStatus(text, isThinking) {
    agentStatusEl.innerHTML = "";
    const icon = document.createElement("span");
    icon.id = "agent-status-icon";
    if (isThinking) {
      icon.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
    } else {
      icon.textContent = "\u25B8";
    }
    const label = document.createElement("span");
    label.id = "agent-status-text";
    label.textContent = text;
    agentStatusEl.appendChild(icon);
    agentStatusEl.appendChild(label);
    agentStatusEl.classList.add("visible");
  }
  function clearAgentStatus() {
    agentStatusEl.classList.remove("visible");
    agentStatusEl.innerHTML = "";
  }
  function appendToolCall(text, toolCallId) {
    if (!state.currentToolGroupEl) {
      const group = document.createElement("div");
      group.className = "tool-group collapsed";
      const label = document.createElement("span");
      label.className = "tool-group-label";
      label.addEventListener("click", () => group.classList.toggle("collapsed"));
      const statusSpan = document.createElement("span");
      statusSpan.className = "tool-group-status";
      statusSpan.textContent = "Working...";
      const countSpan2 = document.createElement("span");
      countSpan2.className = "tool-group-count";
      label.append(statusSpan, " ", countSpan2);
      const items = document.createElement("div");
      items.className = "tool-group-items";
      group.appendChild(label);
      group.appendChild(items);
      messagesEl.appendChild(group);
      state.currentToolGroupEl = group;
    }
    const item = document.createElement("div");
    item.className = "tool-item";
    item.textContent = text;
    if (toolCallId)
      state.toolCallItems.set(toolCallId, item);
    state.currentToolGroupEl.querySelector(".tool-group-items")?.appendChild(item);
    const n = state.currentToolGroupEl.querySelectorAll(".tool-item").length;
    const countSpan = state.currentToolGroupEl.querySelector(".tool-group-count");
    if (countSpan)
      countSpan.textContent = `(${n})`;
    scrollToBottom(true);
  }
  function updateToolCall(toolCallId, status) {
    const item = state.toolCallItems.get(toolCallId);
    if (!item)
      return;
    item.dataset.status = status;
    if (status === "completed")
      item.style.opacity = "0.5";
    if (status === "failed")
      item.style.color = "#f87171";
    state.toolCallItems.delete(toolCallId);
  }
  function finalizeToolGroup() {
    if (!state.currentToolGroupEl)
      return;
    const statusSpan = state.currentToolGroupEl.querySelector(".tool-group-status");
    if (statusSpan) {
      statusSpan.textContent = "\u2713 Done";
      statusSpan.style.color = "#4ade80";
    }
  }
  function appendThought(text) {
    if (!state.currentThoughtEl) {
      const card = document.createElement("div");
      card.className = "thought-card collapsed";
      const label = document.createElement("div");
      label.className = "thought-label";
      label.textContent = "\u2726 Thinking";
      label.addEventListener("click", () => card.classList.toggle("collapsed"));
      const body = document.createElement("div");
      body.className = "thought-body";
      card.appendChild(label);
      card.appendChild(body);
      messagesEl.appendChild(card);
      state.currentThoughtEl = body;
    }
    state.currentThoughtEl.dataset.raw = (state.currentThoughtEl.dataset.raw ?? "") + text;
    state.currentThoughtEl.textContent = state.currentThoughtEl.dataset.raw ?? "";
    scrollToBottom();
  }
  var PLAN_STATUS_ICON = {
    pending: "\u25CB",
    in_progress: "\u25D0",
    completed: "\u25CF"
  };
  function renderPlan(entries) {
    if (!entries || entries.length === 0) {
      state.currentPlanEl?.remove();
      state.currentPlanEl = null;
      return;
    }
    if (!state.currentPlanEl) {
      const card = document.createElement("div");
      card.className = "plan-card";
      const label = document.createElement("div");
      label.className = "plan-label";
      label.textContent = "Plan";
      card.appendChild(label);
      const list2 = document.createElement("div");
      list2.className = "plan-list";
      card.appendChild(list2);
      messagesEl.appendChild(card);
      state.currentPlanEl = card;
    }
    const list = state.currentPlanEl.querySelector(".plan-list");
    if (!list)
      return;
    list.innerHTML = "";
    entries.forEach((e) => {
      const row = document.createElement("div");
      row.className = `plan-item plan-${e.status ?? "pending"}`;
      if (e.priority === "high")
        row.classList.add("plan-high");
      const icon = document.createElement("span");
      icon.className = "plan-icon";
      icon.textContent = PLAN_STATUS_ICON[e.status] ?? "\u25CB";
      const text = document.createElement("span");
      text.className = "plan-text";
      text.textContent = e.content ?? "";
      row.appendChild(icon);
      row.appendChild(text);
      list.appendChild(row);
    });
    scrollToBottom();
  }
  function resetTurn() {
    state.currentAssistantEl = null;
    state.currentToolGroupEl = null;
    state.currentThoughtEl = null;
  }

  // src/webview/permission.ts
  function renderPermissionPreview(toolName, input) {
    if (!input || typeof input !== "object")
      return null;
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      const wrap = document.createElement("div");
      wrap.className = "permission-diff";
      const oldLines = input.old_string.split("\n");
      const newLines = input.new_string.split("\n");
      oldLines.forEach((l) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-del";
        row.textContent = "- " + l;
        wrap.appendChild(row);
      });
      newLines.forEach((l) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-add";
        row.textContent = "+ " + l;
        wrap.appendChild(row);
      });
      return wrap;
    }
    if (typeof input.new_content === "string") {
      const wrap = document.createElement("div");
      wrap.className = "permission-diff";
      input.new_content.split("\n").forEach((l) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-add";
        row.textContent = "+ " + l;
        wrap.appendChild(row);
      });
      return wrap;
    }
    if (toolName === "execute_command" && typeof input.command === "string") {
      const wrap = document.createElement("div");
      wrap.className = "permission-cmd";
      const cmdLine = document.createElement("div");
      cmdLine.className = "permission-cmd-line";
      const fullCmd = input.args ? `${input.command} ${input.args}` : input.command;
      cmdLine.textContent = "$ " + fullCmd;
      wrap.appendChild(cmdLine);
      if (input.cwd) {
        const cwd = document.createElement("div");
        cwd.className = "permission-cwd";
        cwd.textContent = "cwd: " + input.cwd;
        wrap.appendChild(cwd);
      }
      return wrap;
    }
    return null;
  }
  function appendPermission(requestId, label, detail, toolName, toolInput) {
    const div = document.createElement("div");
    div.className = "permission-card";
    div.dataset.requestId = String(requestId);
    const title = document.createElement("div");
    title.className = "permission-title";
    const strong = document.createElement("strong");
    strong.textContent = label;
    title.append("\u26A0 Allow ", strong, "?");
    div.appendChild(title);
    if (detail) {
      const det = document.createElement("div");
      det.className = "permission-detail";
      det.textContent = detail;
      div.appendChild(det);
    }
    const preview = renderPermissionPreview(toolName, toolInput);
    if (preview)
      div.appendChild(preview);
    const actions = document.createElement("div");
    actions.className = "permission-actions";
    const choices = [
      ["allow_once", "Allow once"],
      ["allow_always", "Allow always"],
      ["reject_once", "Reject"]
    ];
    choices.forEach(([choice, btnLabel]) => {
      const btn = document.createElement("button");
      btn.textContent = btnLabel;
      if (choice === "reject_once")
        btn.className = "reject";
      btn.dataset.choice = choice;
      actions.appendChild(btn);
    });
    div.appendChild(actions);
    messagesEl.appendChild(div);
    setTimeout(() => div.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }
  function respondPermission(card, choice) {
    const label = card.querySelector(`[data-choice="${choice}"]`)?.textContent ?? choice;
    card.innerHTML = "";
    const resolved = document.createElement("div");
    resolved.className = "permission-resolved";
    resolved.textContent = label;
    card.appendChild(resolved);
    vscode.postMessage({
      type: "permissionResponse",
      requestId: Number(card.dataset.requestId),
      choice
    });
    setTimeout(() => {
      card.style.transition = "opacity 0.4s";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 400);
    }, 3e3);
  }
  function cancelAllPermissions() {
    messagesEl.querySelectorAll(".permission-card").forEach((node) => {
      const card = node;
      if (!card.querySelector(".permission-resolved")) {
        card.innerHTML = '<div class="permission-resolved">Cancelled</div>';
      }
      setTimeout(() => {
        card.style.transition = "opacity 0.4s";
        card.style.opacity = "0";
        setTimeout(() => card.remove(), 400);
      }, 1e3);
    });
  }

  // src/webview/mention.ts
  function getMentionContext() {
    const caret = inputEl.selectionStart;
    if (caret === null)
      return null;
    const before = inputEl.value.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!m)
      return null;
    return { start: caret - m[1].length - 1, query: m[1] };
  }
  function updateMentionPopup() {
    const ctx = getMentionContext();
    if (!ctx) {
      closeMentionPopup();
      return;
    }
    state.mention = state.mention ?? { start: ctx.start, query: ctx.query, items: [], selected: 0 };
    state.mention.start = ctx.start;
    state.mention.query = ctx.query;
    if (state.mentionDebounce)
      clearTimeout(state.mentionDebounce);
    state.mentionDebounce = setTimeout(() => {
      const id = ++state.mentionQueryId;
      vscode.postMessage({ type: "fileSearch", query: ctx.query, queryId: id });
    }, 100);
    renderMentionPopup();
  }
  function renderMentionPopup() {
    if (!state.mention) {
      mentionPopup.style.display = "none";
      return;
    }
    mentionPopup.innerHTML = "";
    if (state.mention.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mention-empty";
      empty.textContent = state.mention.query ? `No matches for "${state.mention.query}"` : "Type to search files\u2026";
      mentionPopup.appendChild(empty);
    } else {
      state.mention.items.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "mention-item" + (i === state.mention.selected ? " selected" : "");
        row.dataset.index = String(i);
        const name = document.createElement("span");
        name.className = "mention-name";
        name.textContent = it.name;
        const path = document.createElement("span");
        path.className = "mention-path";
        const dir = it.path.slice(0, Math.max(0, it.path.length - it.name.length - 1));
        path.textContent = dir;
        row.appendChild(name);
        if (dir)
          row.appendChild(path);
        mentionPopup.appendChild(row);
      });
    }
    mentionPopup.style.display = "block";
  }
  function closeMentionPopup() {
    state.mention = null;
    mentionPopup.style.display = "none";
    if (state.mentionDebounce) {
      clearTimeout(state.mentionDebounce);
      state.mentionDebounce = null;
    }
  }
  function commitMention(item) {
    if (!state.mention || !item)
      return;
    const before = inputEl.value.slice(0, state.mention.start);
    const after = inputEl.value.slice(inputEl.selectionStart ?? state.mention.start);
    const insert = "@" + item.path + " ";
    inputEl.value = before + insert + after;
    const newCaret = before.length + insert.length;
    inputEl.setSelectionRange(newCaret, newCaret);
    closeMentionPopup();
    inputEl.focus();
  }
  function applyFileSearchResults(queryId, items) {
    if (!state.mention || queryId !== state.mentionQueryId)
      return;
    state.mention.items = items;
    state.mention.selected = 0;
    renderMentionPopup();
  }

  // src/webview/settings.ts
  function makeSection(title) {
    const sec = document.createElement("div");
    sec.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = title;
    sec.appendChild(h);
    return sec;
  }
  function makeRow(labelText, control) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("label");
    label.className = "settings-label";
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }
  function makeSelect(options, currentValue, action, configId) {
    const select = document.createElement("select");
    select.className = "settings-select";
    select.dataset.action = action;
    if (configId)
      select.dataset.configId = configId;
    options.forEach((o) => {
      const value = Array.isArray(o) ? o[0] : o.value;
      const name = Array.isArray(o) ? o[1] : o.name;
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = name;
      if (value === currentValue)
        opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }
  function providerGroupLabel(id) {
    return state.providers.find((p) => p.id === id)?.groupLabel ?? id;
  }
  function makeGroupedModelSelect(options, currentValue, action, configId) {
    const select = document.createElement("select");
    select.className = "settings-select";
    select.dataset.action = action;
    if (configId)
      select.dataset.configId = configId;
    const groups = /* @__PURE__ */ new Map();
    options.forEach((o) => {
      const slash = o.value.indexOf("/");
      const pid = slash !== -1 ? o.value.slice(0, slash) : "_";
      if (!groups.has(pid))
        groups.set(pid, []);
      groups.get(pid).push(o);
    });
    groups.forEach((models, pid) => {
      const group = document.createElement("optgroup");
      group.label = providerGroupLabel(pid);
      models.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.name;
        if (o.value === currentValue)
          opt.selected = true;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
    return select;
  }
  var SHORTCUTS = [
    ["Cmd+Shift+C", "Open chat"],
    ["Cmd+Shift+I", "Edit selection inline"],
    ["Cmd+Shift+X", "Send selection"],
    ["Enter", "Send message"],
    ["Shift+Enter", "New line"],
    ["@", "Attach a workspace file"]
  ];
  var COMMANDS = [
    ["/help", "Show all commands"],
    ["/review", "AI code review"],
    ["/diff", "Review git diff"],
    ["/commit", "Generate commit message"],
    ["/scan", "Scan project structure"],
    ["/fix", "Fix bugs"],
    ["/test", "Write or run tests"],
    ["/status", "Show session info"],
    ["/cost", "Show token usage"],
    ["/export", "Export conversation"]
  ];
  function renderSettingsPanel() {
    if (document.activeElement && settingsPanelEl.contains(document.activeElement))
      return;
    settingsPanelEl.innerHTML = "";
    const modelSection = makeSection("Model & Mode");
    const modeSelect = makeSelect(
      [["auto", "Auto \u2014 agent acts freely"], ["manual", "Manual \u2014 confirm writes"]],
      state.currentMode,
      "setMode"
    );
    modelSection.appendChild(makeRow("Mode", modeSelect));
    const modelOpt = state.configOptions.find((o) => o.id === "model");
    if (modelOpt) {
      const modelSelect = makeGroupedModelSelect(
        modelOpt.options,
        modelOpt.currentValue,
        "setConfig",
        "model"
      );
      modelSection.appendChild(makeRow("Model", modelSelect));
    }
    settingsPanelEl.appendChild(modelSection);
    const otherOpts = state.configOptions.filter((o) => o.id !== "model");
    if (otherOpts.length > 0) {
      const prefSection = makeSection("Preferences");
      otherOpts.forEach((opt) => {
        const select = makeSelect(opt.options, opt.currentValue, "setConfig", opt.id);
        prefSection.appendChild(makeRow(opt.name, select));
      });
      settingsPanelEl.appendChild(prefSection);
    }
    const apiSection = makeSection("API Key");
    if (state.providersUnavailable) {
      const upgrade = document.createElement("div");
      upgrade.className = "settings-hint settings-upgrade";
      upgrade.innerHTML = "Update the Codeep CLI to use API key UI from VS Code:<br><code>npm install -g codeep@latest</code><br>Until then, run <code>/login &lt;provider&gt;</code> in the chat.";
      apiSection.appendChild(upgrade);
      settingsPanelEl.appendChild(apiSection);
    } else {
      const noKeyProviders = new Set(state.providers.filter((p) => !p.requiresKey).map((p) => p.id));
      const providerEntries = state.providers.length > 0 ? state.providers : [{ id: "", groupLabel: "Loading providers\u2026", requiresKey: true }];
      const currentProvider = (modelOpt?.currentValue ?? "").split("/")[0] || "";
      const providerSelect = document.createElement("select");
      providerSelect.className = "settings-select";
      providerSelect.id = "api-key-provider";
      providerEntries.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.groupLabel;
        if (p.id === currentProvider)
          opt.selected = true;
        providerSelect.appendChild(opt);
      });
      apiSection.appendChild(makeRow("Provider", providerSelect));
      providerSelect.addEventListener("change", () => {
        const keyRow2 = apiSection.querySelector(".api-key-row");
        if (keyRow2) {
          keyRow2.style.display = noKeyProviders.has(providerSelect.value) ? "none" : "flex";
        }
      });
      const keyRow = document.createElement("div");
      keyRow.className = "settings-row api-key-row";
      if (noKeyProviders.has(currentProvider))
        keyRow.style.display = "none";
      const keyLabel = document.createElement("label");
      keyLabel.className = "settings-label";
      keyLabel.textContent = "API Key";
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.className = "settings-input";
      keyInput.placeholder = "Paste key here\u2026";
      keyInput.id = "api-key-input";
      const keyBtn = document.createElement("button");
      keyBtn.className = "settings-btn";
      keyBtn.textContent = "Set";
      keyBtn.dataset.action = "setApiKey";
      const keyWrap = document.createElement("div");
      keyWrap.className = "settings-key-wrap";
      keyWrap.appendChild(keyInput);
      keyWrap.appendChild(keyBtn);
      keyRow.appendChild(keyLabel);
      keyRow.appendChild(keyWrap);
      apiSection.appendChild(keyRow);
      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.id = "provider-hint";
      const updateHint = (pid) => {
        const p = state.providers.find((x) => x.id === pid);
        hint.textContent = p?.hint ?? "";
        hint.style.display = hint.textContent ? "block" : "none";
      };
      updateHint(currentProvider);
      providerSelect.addEventListener("change", () => updateHint(providerSelect.value));
      apiSection.appendChild(hint);
      settingsPanelEl.appendChild(apiSection);
    }
    const helpSection = makeSection("Shortcuts");
    const shortcutGrid = document.createElement("div");
    shortcutGrid.className = "settings-shortcuts";
    SHORTCUTS.forEach(([key, desc]) => {
      const k = document.createElement("kbd");
      k.className = "settings-kbd";
      k.textContent = key;
      const d = document.createElement("span");
      d.className = "settings-kbd-desc";
      d.textContent = desc;
      shortcutGrid.appendChild(k);
      shortcutGrid.appendChild(d);
    });
    helpSection.appendChild(shortcutGrid);
    settingsPanelEl.appendChild(helpSection);
    const cmdSection = makeSection("Commands");
    const cmdGrid = document.createElement("div");
    cmdGrid.className = "settings-commands";
    COMMANDS.forEach(([cmd, desc]) => {
      const c = document.createElement("button");
      c.className = "settings-cmd-chip";
      c.textContent = cmd;
      c.title = desc;
      c.dataset.action = "insertCommand";
      c.dataset.command = cmd;
      cmdGrid.appendChild(c);
    });
    cmdSection.appendChild(cmdGrid);
    settingsPanelEl.appendChild(cmdSection);
  }

  // src/webview/sessions.ts
  function renderSessionsPanel(sessions) {
    sessionsPanelEl.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sessions-empty";
      empty.textContent = "No sessions found";
      sessionsPanelEl.appendChild(empty);
      return;
    }
    sessions.forEach((s) => {
      const name = s.title || (s.sessionId ? s.sessionId.slice(0, 24) : "Session");
      const msgs = s.messageCount ? `${s.messageCount} msgs` : "";
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "";
      const item = document.createElement("div");
      item.className = "session-item";
      item.dataset.sessionId = s.sessionId;
      const nameEl = document.createElement("div");
      nameEl.className = "session-name";
      nameEl.textContent = name;
      const metaEl = document.createElement("div");
      metaEl.className = "session-meta";
      metaEl.textContent = [msgs, date].filter(Boolean).join(" \xB7 ");
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "session-delete";
      deleteBtn.textContent = "\xD7";
      deleteBtn.dataset.sessionId = s.sessionId;
      deleteBtn.dataset.action = "deleteSession";
      const info = document.createElement("div");
      info.className = "session-info";
      info.appendChild(nameEl);
      info.appendChild(metaEl);
      item.appendChild(info);
      item.appendChild(deleteBtn);
      sessionsPanelEl.appendChild(item);
    });
  }

  // src/webview/onboarding.ts
  function appendOnboarding() {
    const div = document.createElement("div");
    div.className = "onboarding";
    const p1 = document.createElement("p");
    p1.textContent = "Codeep CLI is not installed or not found.";
    const p2 = document.createElement("p");
    p2.textContent = "Install it with:";
    const block = document.createElement("div");
    block.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-header";
    header.textContent = "terminal";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => copyCodeBlock(copyBtn));
    header.appendChild(copyBtn);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "npm install -g codeep";
    pre.appendChild(code);
    block.appendChild(header);
    block.appendChild(pre);
    const p3 = document.createElement("p");
    p3.textContent = "Then reload this window.";
    div.appendChild(p1);
    div.appendChild(p2);
    div.appendChild(block);
    div.appendChild(p3);
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  // src/webview/main.ts
  function send() {
    const text = inputEl.value.trim();
    if (!text)
      return;
    if (state.isStreaming) {
      inputEl.value = "";
      inputEl.style.height = "auto";
      settingsPanelEl.style.display = "none";
      sessionsPanelEl.style.display = "none";
      vscode.postMessage({ type: "cancelAndSend", text });
      return;
    }
    inputEl.value = "";
    inputEl.style.height = "auto";
    settingsPanelEl.style.display = "none";
    sessionsPanelEl.style.display = "none";
    vscode.postMessage({ type: "send", text });
  }
  btnSend.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (state.mention && state.mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.mention.selected = (state.mention.selected + 1) % state.mention.items.length;
        renderMentionPopup();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.mention.selected = (state.mention.selected - 1 + state.mention.items.length) % state.mention.items.length;
        renderMentionPopup();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitMention(state.mention.items[state.mention.selected]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionPopup();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("keyup", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape" || e.key === "Tab")
      return;
    updateMentionPopup();
  });
  inputEl.addEventListener("blur", () => {
    setTimeout(closeMentionPopup, 120);
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
    updateMentionPopup();
  });
  mentionPopup.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const target = e.target;
    const row = target.closest(".mention-item");
    if (!row || !state.mention)
      return;
    const i = Number(row.dataset.index);
    commitMention(state.mention.items[i]);
  });
  btnStop.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });
  btnNew.addEventListener("click", () => {
    sessionsPanelEl.style.display = "none";
    vscode.postMessage({ type: "newSession" });
  });
  btnSettings.addEventListener("click", () => {
    if (settingsPanelEl.style.display !== "none") {
      settingsPanelEl.style.display = "none";
      return;
    }
    sessionsPanelEl.style.display = "none";
    renderSettingsPanel();
    settingsPanelEl.style.display = "block";
  });
  btnSessions.addEventListener("click", () => {
    if (sessionsPanelEl.style.display !== "none") {
      sessionsPanelEl.style.display = "none";
      return;
    }
    settingsPanelEl.style.display = "none";
    sessionsPanelEl.innerHTML = '<div class="sessions-loading">Loading...</div>';
    sessionsPanelEl.style.display = "block";
    vscode.postMessage({ type: "listSessions" });
  });
  function enterStreaming(placeholder) {
    state.isStreaming = true;
    btnSend.style.display = "none";
    btnStop.style.display = "flex";
    inputEl.placeholder = placeholder;
  }
  function exitStreaming() {
    state.isStreaming = false;
    btnSend.style.display = "flex";
    btnStop.style.display = "none";
    inputEl.placeholder = "Ask Codeep anything (type @ to attach a file)";
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "userMessage":
        clearAgentStatus();
        appendMessage("user", msg.text);
        state.isStreaming = false;
        resetTurn();
        if (state.currentPlanEl) {
          state.currentPlanEl.remove();
          state.currentPlanEl = null;
        }
        break;
      case "thinking":
        setAgentStatus("Thinking...", true);
        enterStreaming("Working...");
        break;
      case "chunk":
        clearAgentStatus();
        dismissLastError();
        if (!state.currentAssistantEl) {
          state.currentAssistantEl = appendMessage("assistant", "");
        }
        state.currentAssistantEl.dataset.raw = (state.currentAssistantEl.dataset.raw ?? "") + msg.text;
        state.currentAssistantEl.innerHTML = renderMarkdown(state.currentAssistantEl.dataset.raw ?? "");
        scrollToBottom();
        break;
      case "responseEnd":
        clearAgentStatus();
        finalizeToolGroup();
        resetTurn();
        exitStreaming();
        break;
      case "thought":
        dismissLastError();
        appendThought(msg.text);
        break;
      case "plan":
        dismissLastError();
        renderPlan(msg.entries);
        break;
      case "toolCall":
        if (!state.isStreaming)
          enterStreaming("Working...");
        dismissLastError();
        setAgentStatus(msg.text, false);
        appendToolCall(msg.text, msg.toolCallId);
        break;
      case "toolCallUpdate":
        updateToolCall(msg.toolCallId, msg.status);
        break;
      case "permission":
        if (!state.isStreaming)
          enterStreaming("Working...");
        clearAgentStatus();
        appendPermission(msg.requestId, msg.label, msg.detail, msg.toolName, msg.toolInput);
        break;
      case "onboarding":
        appendOnboarding();
        break;
      case "error":
        clearAgentStatus();
        appendMessage("system", `Error: ${msg.text}`);
        exitStreaming();
        break;
      case "status":
        statusEl.textContent = msg.text;
        break;
      case "sessions":
        renderSessionsPanel(msg.sessions);
        break;
      case "configOptions":
        state.configOptions = msg.configOptions || [];
        if (settingsPanelEl.style.display !== "none")
          renderSettingsPanel();
        const modelOpt = state.configOptions.find((o) => o.id === "model");
        if (modelOpt?.currentValue) {
          const modelName = modelOpt.options.find((o) => o.value === modelOpt.currentValue)?.name ?? modelOpt.currentValue.split("/").pop();
          const currentStatus = statusEl.textContent || "";
          const base = currentStatus.split(" \xB7 ")[0];
          statusEl.textContent = base + " \xB7 " + modelName;
        }
        break;
      case "providers":
        state.providers = msg.providers || [];
        state.providersUnavailable = !!msg.unavailable;
        if (settingsPanelEl.style.display !== "none")
          renderSettingsPanel();
        break;
      case "modeChanged":
        state.currentMode = msg.modeId;
        if (settingsPanelEl.style.display !== "none")
          renderSettingsPanel();
        break;
      case "history":
        msg.messages.forEach(
          (m) => appendMessage(m.role === "user" ? "user" : "assistant", m.content)
        );
        scrollToBottom();
        break;
      case "clearChat":
        messagesEl.innerHTML = "";
        messagesEl.appendChild(scrollSentinel);
        resetTurn();
        state.currentPlanEl = null;
        state.lastErrorEl = null;
        state.toolCallItems.clear();
        clearAgentStatus();
        exitStreaming();
        sessionsPanelEl.style.display = "none";
        break;
      case "prefill":
        inputEl.value = msg.text;
        inputEl.focus();
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
        break;
      case "fileSearchResults":
        applyFileSearchResults(msg.queryId, msg.items || []);
        break;
      case "cancelPermissions":
        cancelAllPermissions();
        break;
    }
  });
  messagesEl.addEventListener("click", (e) => {
    const target = e.target;
    const permBtn = target.closest(".permission-actions button");
    if (permBtn) {
      const card = permBtn.closest(".permission-card");
      if (card)
        respondPermission(card, permBtn.dataset.choice ?? "");
      return;
    }
    const copyBtn = target.closest(".copy-btn");
    if (copyBtn && copyBtn.dataset.action === "copy") {
      copyCodeBlock(copyBtn);
      return;
    }
  });
  sessionsPanelEl.addEventListener("click", (e) => {
    const target = e.target;
    const deleteBtn = target.closest('[data-action="deleteSession"]');
    if (deleteBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", sessionId: deleteBtn.dataset.sessionId });
      return;
    }
    const item = target.closest(".session-item");
    if (item && item.dataset.sessionId) {
      sessionsPanelEl.style.display = "none";
      vscode.postMessage({ type: "loadSession", sessionId: item.dataset.sessionId });
    }
  });
  settingsPanelEl.addEventListener("change", (e) => {
    const select = e.target.closest("select");
    if (!select)
      return;
    if (select.dataset.action === "setMode") {
      state.currentMode = select.value;
      vscode.postMessage({ type: "setMode", modeId: select.value });
    } else if (select.dataset.action === "setConfig") {
      vscode.postMessage({ type: "setConfig", configId: select.dataset.configId, value: select.value });
    }
  });
  settingsPanelEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn)
      return;
    if (btn.dataset.action === "setApiKey") {
      const keyInput = settingsPanelEl.querySelector("#api-key-input");
      const providerSelect = settingsPanelEl.querySelector("#api-key-provider");
      const key = keyInput?.value.trim();
      const providerId = providerSelect?.value;
      if (!key || !providerId)
        return;
      vscode.postMessage({ type: "setConfig", configId: "login", value: `${providerId}:${key}` });
      if (keyInput)
        keyInput.value = "";
      btn.textContent = "Saved!";
      setTimeout(() => {
        btn.textContent = "Set";
      }, 2e3);
    }
    if (btn.dataset.action === "insertCommand") {
      settingsPanelEl.style.display = "none";
      inputEl.value = (btn.dataset.command ?? "") + " ";
      inputEl.focus();
    }
  });
  vscode.postMessage({ type: "ready" });
  statusEl.textContent = "Connecting to Codeep CLI...";
})();
