(function (global) {
  const DEFAULT_ICONS = ["icons/pooh.svg", "icons/piglet.svg", "icons/eeyore.svg", "favicon.svg"];

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function slugify(text) {
    return String(text || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function isImageIconValue(icon) {
    const value = String(icon || "").trim();
    if (!value) return true;
    return /[./\\]/.test(value) || /^(https?:|data:|blob:)/i.test(value);
  }

  function getAutoSlug(label, index) {
    return slugify(label) || `hive-${index + 1}`;
  }

  function getEmojiEntryHint() {
    try {
      const nav = global.navigator || {};
      const ua = String(nav.userAgent || "").toLowerCase();
      const platform = String(nav.platform || "").toLowerCase();
      const isMobile = /iphone|ipad|android|mobile/.test(ua);
      if (isMobile) return "Use your emoji keyboard";
      if (platform.indexOf("mac") >= 0) return "Ctrl+Cmd+Space";
      if (platform.indexOf("win") >= 0) return "Win + .";
      if (platform.indexOf("linux") >= 0 || ua.indexOf("linux") >= 0) return "Use your system emoji picker";
      return "Use your emoji keyboard";
    } catch (err) {
      return "Use your emoji keyboard";
    }
  }

  function splitGraphemes(text) {
    const value = String(text || "");
    if (!value) return [];
    try {
      if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        return Array.from(seg.segment(value), part => part.segment);
      }
    } catch (err) {
      // Fallback below.
    }
    return Array.from(value);
  }

  function hasEmojiCodepoint(text) {
    const value = String(text || "");
    if (!value) return false;

    try {
      return /\p{Emoji}/u.test(value);
    } catch (err) {
      return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/u.test(value);
    }
  }

  function normalizeSingleEmoji(text) {
    const graphemes = splitGraphemes(text);
    for (const g of graphemes) {
      if (hasEmojiCodepoint(g)) return g;
    }
    return "";
  }

  function parseRows(listEl) {
    const rows = Array.from(listEl.querySelectorAll(".hive-config-row"));
    return rows.map((row, idx) => {
      const idInput = row.querySelector('[data-field="id"]');
      const labelInput = row.querySelector('[data-field="label"]');
      const deviceInput = row.querySelector('[data-field="device_id"]');
      const iconEmojiInput = row.querySelector('[data-field="icon_emoji"]');
      const iconFileInput = row.querySelector('[data-field="icon_file"]');
      const locationInput = row.querySelector('[data-field="location"]');
      const activeInput = row.querySelector('[data-field="active"]');

      const label = String(labelInput.value || "").trim();
      const id = String(idInput.value || "").trim() || getAutoSlug(label, idx);
      const iconMode = row.getAttribute("data-icon-mode") === "emoji" ? "emoji" : "file";
      const iconEmoji = normalizeSingleEmoji(iconEmojiInput && iconEmojiInput.value || "");
      const iconFile = String(iconFileInput && iconFileInput.value || "").trim();

      return {
        id,
        label,
        device_id: String(deviceInput.value || "").trim() || null,
        icon_mode: iconMode,
        icon: iconMode === "emoji"
          ? (iconEmoji || "🐝")
          : (iconFile || "favicon.svg"),
        location: String(locationInput.value || "").trim(),
        active: Boolean(activeInput.checked),
      };
    });
  }

  function validateRows(rows) {
    if (!rows.length) {
      return "At least one hive is required.";
    }

    const seenIds = new Set();
    const seenDevices = new Set();

    for (const row of rows) {
      if (!row.label) return "Each hive needs a name.";
      if (!/^[a-z0-9-]+$/.test(row.id)) {
        return `Hive id '${row.id}' is invalid. Use lowercase letters, numbers, and dashes only.`;
      }
      if (seenIds.has(row.id)) return `Duplicate hive id '${row.id}'.`;
      seenIds.add(row.id);

      if (row.active && !row.device_id) {
        return `Hive '${row.label}' is active but missing a device id.`;
      }

      if (row.icon_mode === "emoji" && !normalizeSingleEmoji(row.icon)) {
        return `Hive '${row.label}' needs a single emoji icon.`;
      }

      if (row.icon_mode === "file" && !String(row.icon || "").trim()) {
        return `Hive '${row.label}' needs an image path icon.`;
      }

      if (row.device_id) {
        if (seenDevices.has(row.device_id)) {
          return `Duplicate device id '${row.device_id}'.`;
        }
        seenDevices.add(row.device_id);
      }
    }

    return null;
  }

  function renderRows(listEl, hives, iconOptions) {
    const emojiHint = getEmojiEntryHint();
    listEl.innerHTML = hives
      .map((hive, index) => {
        const number = index + 1;
        const iconValue = String(hive.icon || "").trim();
        const iconMode = isImageIconValue(iconValue) ? "file" : "emoji";
        const iconFileValue = iconMode === "file" ? iconValue : "";
        const iconEmojiValue = iconMode === "emoji" ? iconValue : "";
        const slugManual = hive.id && hive.id !== getAutoSlug(hive.label, index);
        return `
          <div class="hive-config-row" data-index="${index}" data-slug-manual="${slugManual ? "true" : "false"}" data-icon-mode="${iconMode}">
            <div class="hive-config-row-header">
              <h3>Hive ${number}</h3>
              <button type="button" class="config-btn config-btn--ghost" data-action="remove">Remove</button>
            </div>
            <div class="hive-config-grid">
              <label class="config-field">
                <span>Name</span>
                <input data-field="label" type="text" value="${escapeHtml(hive.label)}" placeholder="Pooh" />
              </label>
              <label class="config-field">
                <span>Slug ID</span>
                <input data-field="id" type="text" value="${escapeHtml(hive.id)}" placeholder="pooh" />
              </label>
              <div class="config-field config-field--wide config-icon-section">
                <span>Icon</span>
                <div class="config-icon-mode-options">
                  <label>
                    <input type="radio" data-field="icon_mode" name="icon-mode-${index}" value="emoji" ${iconMode === "emoji" ? "checked" : ""} /> Emoji
                  </label>
                  <label>
                    <input type="radio" data-field="icon_mode" name="icon-mode-${index}" value="file" ${iconMode === "file" ? "checked" : ""} /> Image Path
                  </label>
                </div>
                <div class="config-icon-choice-grid">
                  <label class="config-field config-icon-option ${iconMode === "emoji" ? "" : "config-icon-option--inactive"}">
                    <span>Emoji</span>
                    <input data-field="icon_emoji" type="text" value="${escapeHtml(iconEmojiValue)}" placeholder="${escapeHtml(emojiHint)}" ${iconMode === "emoji" ? "" : "disabled"} />
                  </label>
                  <label class="config-field config-icon-option ${iconMode === "file" ? "" : "config-icon-option--inactive"}">
                    <span>Image Path</span>
                    <input data-field="icon_file" list="hive-icon-options" type="text" value="${escapeHtml(iconFileValue)}" placeholder="icons/pooh.svg" ${iconMode === "file" ? "" : "disabled"} />
                  </label>
                </div>
              </div>
              <label class="config-field config-field--wide">
                <span>Device ID</span>
                <input data-field="device_id" type="text" value="${escapeHtml(hive.device_id || "")}" placeholder="uuid from telemetry" />
              </label>
              <label class="config-field config-field--wide">
                <span>Location / Notes</span>
                <input data-field="location" type="text" value="${escapeHtml(hive.location || "")}" placeholder="North apiary" />
              </label>
              <label class="config-field config-field--check">
                <input data-field="active" type="checkbox" ${hive.active ? "checked" : ""} />
                <span>Active hive</span>
              </label>
            </div>
          </div>
        `;
      })
      .join("");

    const datalist = document.getElementById("hive-icon-options");
    if (datalist) {
      datalist.innerHTML = iconOptions.map(icon => `<option value="${escapeHtml(icon)}"></option>`).join("");
    }
  }

  function initHiveConfigEditor(options) {
    const opts = options || {};
    const panel = document.getElementById(opts.panelId || "hive-config-panel");
    const toggleBtn = document.getElementById(opts.toggleButtonId || "edit-hives-btn");
    const listEl = document.getElementById(opts.listId || "hive-config-list");
    const errorEl = document.getElementById(opts.errorId || "hive-config-error");
    const addBtn = document.getElementById(opts.addButtonId || "add-hive-btn");
    const saveBtn = document.getElementById(opts.saveButtonId || "save-hive-config-btn");
    const cancelBtn = document.getElementById(opts.cancelButtonId || "cancel-hive-config-btn");
    const resetBtn = document.getElementById(opts.resetButtonId || "reset-hive-config-btn");

    if (!panel || !toggleBtn || !listEl) return null;
    if (typeof global.getConfiguredHives !== "function" || typeof global.saveConfiguredHives !== "function") return null;

    const iconOptions = Array.isArray(global.HIVE_ICON_OPTIONS) && global.HIVE_ICON_OPTIONS.length
      ? global.HIVE_ICON_OPTIONS
      : DEFAULT_ICONS;

    let open = false;
    let draft = global.getConfiguredHives();
    let busy = false;
    let statusTimer = null;
    let statusEl = panel.querySelector(".config-status");

    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "config-status hidden";
      statusEl.setAttribute("aria-live", "polite");
      const header = panel.querySelector(".config-panel-header");
      if (header && header.nextSibling) {
        panel.insertBefore(statusEl, header.nextSibling);
      } else {
        panel.insertBefore(statusEl, panel.firstChild);
      }
    }

    function showStatus(message, tone, persist) {
      if (!statusEl) return;
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      if (!message) {
        statusEl.textContent = "";
        statusEl.className = "config-status hidden";
        return;
      }

      statusEl.textContent = message;
      statusEl.className = `config-status config-status--${tone || "info"}`;

      if (!persist) {
        statusTimer = setTimeout(() => {
          statusEl.textContent = "";
          statusEl.className = "config-status hidden";
          statusTimer = null;
        }, 2500);
      }
    }

    function setBusy(nextBusy, label) {
      busy = Boolean(nextBusy);
      const controls = [toggleBtn, addBtn, saveBtn, cancelBtn, resetBtn].filter(Boolean);
      controls.forEach(control => {
        control.disabled = busy;
      });

      if (saveBtn) {
        saveBtn.textContent = busy && label ? label : "Save";
      }
      if (resetBtn) {
        resetBtn.textContent = busy && label === "Resetting..." ? "Resetting..." : "Reset Defaults";
      }
    }

    function showError(message) {
      if (!errorEl) return;
      if (!message) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
        return;
      }
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    }

    async function refreshFromStore(forceReload) {
      if (typeof global.loadConfiguredHives === "function") {
        try {
          if (forceReload) {
            showStatus("Loading hive settings...", "info", true);
          }
          await global.loadConfiguredHives(Boolean(forceReload));
        } catch (err) {
          showStatus("", "info", true);
          showError(`Config load failed: ${err.message || err}`);
        }
      }
      draft = global.getConfiguredHives();
      renderRows(listEl, draft, iconOptions);
      if (forceReload) {
        showStatus("", "info", true);
      }
    }

    function setOpen(nextOpen) {
      open = Boolean(nextOpen);
      panel.classList.toggle("hidden", !open);
      toggleBtn.textContent = open ? "Done Editing" : "Edit Hives";
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) refreshFromStore(true);
      if (!open) {
        showError("");
        showStatus("", "info", true);
      }
    }

    toggleBtn.addEventListener("click", () => {
      setOpen(!open);
    });

    listEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.getAttribute("data-action") !== "remove") return;

      const row = target.closest(".hive-config-row");
      if (!row) return;

      const index = Number(row.getAttribute("data-index"));
      if (!Number.isFinite(index)) return;

      const parsed = parseRows(listEl);
      parsed.splice(index, 1);
      if (!parsed.length) {
        showError("At least one hive is required.");
        return;
      }
      draft = parsed;
      renderRows(listEl, draft, iconOptions);
      showError("");
    });

    listEl.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;

      const row = target.closest(".hive-config-row");
      if (!row) return;

      const index = Number(row.getAttribute("data-index"));
      const labelInput = row.querySelector('[data-field="label"]');
      const idInput = row.querySelector('[data-field="id"]');
      if (!(labelInput instanceof HTMLInputElement) || !(idInput instanceof HTMLInputElement)) return;

      const autoSlug = getAutoSlug(labelInput.value, Number.isFinite(index) ? index : 0);
      const field = target.getAttribute("data-field");

      if (field === "label") {
        if (row.getAttribute("data-slug-manual") !== "true") {
          idInput.value = autoSlug;
        }
        return;
      }

      if (field === "id") {
        const slugValue = String(idInput.value || "").trim();
        row.setAttribute("data-slug-manual", slugValue && slugValue !== autoSlug ? "true" : "false");
        return;
      }

      if (field === "icon_emoji") {
        row.setAttribute("data-icon-mode", "emoji");
        const normalized = normalizeSingleEmoji(target.value || "");
        if (target.value !== normalized) target.value = normalized;
        const emojiBox = row.querySelector('[data-field="icon_emoji"]');
        const fileBox = row.querySelector('[data-field="icon_file"]');
        const emojiWrap = emojiBox && emojiBox.closest(".config-icon-option");
        const fileWrap = fileBox && fileBox.closest(".config-icon-option");
        if (emojiBox instanceof HTMLInputElement) emojiBox.disabled = false;
        if (fileBox instanceof HTMLInputElement) fileBox.disabled = true;
        if (emojiWrap) emojiWrap.classList.remove("config-icon-option--inactive");
        if (fileWrap) fileWrap.classList.add("config-icon-option--inactive");
        return;
      }

      if (field === "icon_file") {
        row.setAttribute("data-icon-mode", "file");
        const emojiBox = row.querySelector('[data-field="icon_emoji"]');
        const fileBox = row.querySelector('[data-field="icon_file"]');
        const emojiWrap = emojiBox && emojiBox.closest(".config-icon-option");
        const fileWrap = fileBox && fileBox.closest(".config-icon-option");
        if (emojiBox instanceof HTMLInputElement) emojiBox.disabled = true;
        if (fileBox instanceof HTMLInputElement) fileBox.disabled = false;
        if (emojiWrap) emojiWrap.classList.add("config-icon-option--inactive");
        if (fileWrap) fileWrap.classList.remove("config-icon-option--inactive");
      }
    });

    listEl.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute("data-field") !== "icon_mode") return;

      const row = target.closest(".hive-config-row");
      if (!row) return;

      const mode = target.value === "emoji" ? "emoji" : "file";
      row.setAttribute("data-icon-mode", mode);

      const iconEmojiInput = row.querySelector('[data-field="icon_emoji"]');
      const iconFileInput = row.querySelector('[data-field="icon_file"]');

      if (iconEmojiInput instanceof HTMLInputElement) {
        iconEmojiInput.disabled = mode !== "emoji";
      }
      if (iconFileInput instanceof HTMLInputElement) {
        iconFileInput.disabled = mode !== "file";
      }

      const emojiWrap = iconEmojiInput && iconEmojiInput.closest(".config-icon-option");
      const fileWrap = iconFileInput && iconFileInput.closest(".config-icon-option");
      if (emojiWrap) emojiWrap.classList.toggle("config-icon-option--inactive", mode !== "emoji");
      if (fileWrap) fileWrap.classList.toggle("config-icon-option--inactive", mode !== "file");
    });

    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const parsed = parseRows(listEl);
        const nextIndex = parsed.length + 1;
        parsed.push({
          id: `hive-${nextIndex}`,
          label: `Hive ${nextIndex}`,
          device_id: null,
          icon: iconOptions[nextIndex % iconOptions.length],
          location: "",
          active: false,
        });
        draft = parsed;
        renderRows(listEl, draft, iconOptions);
        showError("");
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        if (busy) return;
        const parsed = parseRows(listEl);
        const error = validateRows(parsed);
        if (error) {
          showError(error);
          return;
        }

        try {
          setBusy(true, "Saving...");
          showStatus("Saving hive settings...", "info", true);
          const saved = await global.saveConfiguredHives(parsed);
          draft = saved;
          renderRows(listEl, draft, iconOptions);
          showError("");
          showStatus("Hive settings saved.", "success", false);

          if (typeof opts.onSave === "function") {
            opts.onSave(saved);
          }
        } catch (err) {
          showStatus("", "info", true);
          showError(`Save failed: ${err.message || err}`);
        } finally {
          setBusy(false);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        setOpen(false);
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        if (busy) return;
        const approved = global.confirm("Reset hive settings to defaults?");
        if (!approved) return;

        try {
          setBusy(true, "Resetting...");
          showStatus("Resetting hive settings...", "info", true);
          const defaults = await global.resetConfiguredHives();
          draft = defaults;
          renderRows(listEl, draft, iconOptions);
          showError("");
          showStatus("Hive settings reset to defaults.", "success", false);

          if (typeof opts.onSave === "function") {
            opts.onSave(defaults);
          }
        } catch (err) {
          showStatus("", "info", true);
          showError(`Reset failed: ${err.message || err}`);
        } finally {
          setBusy(false);
        }
      });
    }

    refreshFromStore(true);
    setOpen(false);

    return {
      open: () => setOpen(true),
      close: () => setOpen(false),
      reload: refreshFromStore,
    };
  }

  global.initHiveConfigEditor = initHiveConfigEditor;
})(window);
