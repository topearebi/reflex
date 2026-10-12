/**
 * js/app.js — binds the UI to the store and drill engine.
 */

import { Store, unitKey } from "./state.js";
import { RecallEngine } from "./engine.js";
import { modesForDeck } from "./normalizer.js";
import { parseTSV, readJSONFile, downloadJSON } from "./importer.js";
import { GitHubSync } from "./github-sync.js";

const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps"]);
const LANGS = [
  ["", "Other / mixed"], ["ar", "Arabic"], ["zh", "Chinese"], ["nl", "Dutch"], ["en", "English"],
  ["fr", "French"], ["de", "German"], ["el", "Greek"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["pl", "Polish"], ["pt", "Portuguese"],
  ["ru", "Russian"], ["es", "Spanish"], ["sw", "Swahili"], ["tr", "Turkish"], ["uk", "Ukrainian"],
  ["vi", "Vietnamese"], ["yo", "Yoruba"]
];
const PREVIEW_TOKENS = 10;
const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.store = new Store();
    this.engine = new RecallEngine(this.store);
    this.sync = new GitHubSync(this.store);
    this.missCount = 0;
    this.el = {
      deckName: $("deckName"), deckMeta: $("deckMeta"),
      btnPractice: $("btnPractice"), btnSettings: $("btnSettings"),
      stage: $("stage"), card: $("card"), cardBadge: $("cardBadge"),
      prompt: $("cardPrompt"), hint: $("cardHint"), reveal: $("cardReveal"), answer: $("cardAnswer"),
      input: $("answerInput"), btnReveal: $("btnReveal"), helpLine: $("helpLine"),
      statStreak: $("statStreak"), statAccuracy: $("statAccuracy"), statPool: $("statPool"),
      practice: $("practiceSheet"), settings: $("settingsSheet"),
      deckSelect: $("deckSelect"), modeSelect: $("modeSelect"), unitList: $("unitList"),
      btnAll: $("btnAllUnits"), btnNone: $("btnNoUnits"), btnStart: $("btnStart"), btnDeleteDeck: $("btnDeleteDeck"),
      ghToken: $("ghToken"), ghRepo: $("ghRepo"), ghPath: $("ghPath"), btnSync: $("btnSync"), syncStatus: $("syncStatus"),
      importTarget: $("importTarget"), newDeckFields: $("newDeckFields"), newDeckName: $("newDeckName"),
      newDeckLang: $("newDeckLang"), newDeckPinyin: $("newDeckPinyin"), importText: $("importText"), btnImport: $("btnImport"),
      btnExport: $("btnExport"), importFile: $("importFile"), btnResetProgress: $("btnResetProgress"),
      toast: $("toast")
    };
    this.init();
  }

  async init() {
    this.bindStage();
    this.bindSheets();
    this.bindSettings();
    this.bindEngine();
    await this.store.init();
    this.renderDeck();
    this.engine.next();
    if (this.store.deckIds().length === 0) {
      this.showCardMessage("Couldn't load any decks", "Check your connection and reload.");
    }
  }

  /* ---------------- stage ---------------- */

  bindStage() {
    const { input, stage } = this.el;
    input.addEventListener("input", () => this.engine.input(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.engine.giveUp(input.value);
      }
    });
    this.el.btnReveal.addEventListener("click", () => {
      this.engine.giveUp(input.value);
      input.focus();
    });
    // Tapping the card area brings the keyboard back on phones
    stage.addEventListener("click", (e) => {
      if (!e.target.closest("button, input, a")) input.focus();
    });
  }

  bindEngine() {
    const { el, engine, store } = this;

    engine.addEventListener("card", ({ detail: { card } }) => {
      el.card.className = "card";
      el.cardBadge.textContent = "";
      el.reveal.hidden = true;
      el.input.value = "";
      el.input.classList.remove("is-correcting");
      if (!card) {
        el.input.disabled = el.btnReveal.disabled = true;
        this.showCardMessage("No units selected", "Open the deck menu to choose what to drill.");
        this.updateStats();
        return;
      }
      el.input.disabled = el.btnReveal.disabled = false;
      el.btnReveal.textContent = "Reveal";
      el.input.placeholder = "Type the answer";
      el.prompt.textContent = card.prompt;
      el.prompt.dataset.size = sizeFor(card.prompt);
      el.hint.textContent = card.subtitle || "";
      this.updateStats();
      if (!el.practice.open && !el.settings.open) el.input.focus({ preventScroll: true });
    });

    engine.addEventListener("correct", () => {
      el.card.classList.add("is-correct");
      el.cardBadge.textContent = "✓";
    });

    engine.addEventListener("miss", ({ detail: { answer } }) => {
      el.card.classList.add("is-miss");
      el.cardBadge.textContent = "✕";
      el.answer.textContent = answer;
      el.reveal.hidden = false;
      el.input.value = "";
      el.input.placeholder = "Type it to continue";
      el.input.classList.add("is-correcting");
      el.btnReveal.disabled = true;
      this.missCount++;
      if (this.missCount <= 3) el.helpLine.textContent = "Type the answer shown to move on.";
    });

    engine.addEventListener("corrected", () => {
      el.card.classList.remove("is-miss");
      el.card.classList.add("is-correct");
      el.cardBadge.textContent = "✓";
      if (this.missCount <= 3) el.helpLine.textContent = "Enter or Reveal shows the answer.";
    });

    engine.addEventListener("nudge", () => {
      el.input.classList.remove("nudge");
      void el.input.offsetWidth;
      el.input.classList.add("nudge");
    });

    engine.addEventListener("pool", () => this.updateStats());
    store.addEventListener("stats-changed", () => this.updateStats());
    store.addEventListener("deck-changed", () => this.renderDeck());
    store.addEventListener("deck-updated", () => this.renderDeck());
    store.addEventListener("units-changed", () => this.renderDeckButton());
    store.addEventListener("save-failed", () => this.toast("Storage is full or blocked — progress may not be saved.", true));
  }

  showCardMessage(title, hint) {
    this.el.prompt.textContent = title;
    this.el.prompt.dataset.size = "message";
    this.el.hint.textContent = hint;
  }

  updateStats() {
    const { correct, attempts, streak } = this.store.session;
    this.el.statStreak.textContent = streak;
    this.el.statAccuracy.textContent = attempts ? `${Math.round((correct / attempts) * 100)}%` : "–";
    this.el.statPool.textContent = this.store.pool().length;
  }

  /** Applies the deck's language/direction to prompt and input. */
  applyLanguage(deck) {
    const lang = deck?.lang || "";
    const dir = deck?.dir || (RTL.has(lang.split("-")[0]) ? "rtl" : "auto");
    setAttr(this.el.prompt, "lang", lang);
    this.el.prompt.dir = dir;
    const answerLang = deck?.romanization === "pinyin" ? "zh-Latn-pinyin" : deck?.answerLang || "";
    setAttr(this.el.input, "lang", answerLang);
    setAttr(this.el.answer, "lang", answerLang);
    this.el.input.dir = "auto";
  }

  renderDeck() {
    const deck = this.store.currentDeck;
    this.applyLanguage(deck);
    this.renderDeckButton();
    if (this.el.practice.open) this.renderPractice();
  }

  renderDeckButton() {
    const deck = this.store.currentDeck;
    this.el.deckName.textContent = deck?.name || "No deck";
    const total = this.store.allUnitKeys().length;
    const sel = this.store.selectedUnits.size;
    this.el.deckMeta.textContent = deck ? `${sel} of ${total} unit${total === 1 ? "" : "s"}` : "";
    this.updateStats();
  }

  /* ---------------- sheets ---------------- */

  bindSheets() {
    const { el } = this;
    const open = (dlg, render) => {
      render();
      dlg.showModal();
    };
    el.btnPractice.addEventListener("click", () => open(el.practice, () => this.renderPractice()));
    el.btnSettings.addEventListener("click", () => open(el.settings, () => this.renderSettings()));

    for (const dlg of [el.practice, el.settings]) {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
      });
      dlg.addEventListener("close", () => el.input.focus({ preventScroll: true }));
    }

    el.deckSelect.addEventListener("change", () => {
      this.store.setDeck(el.deckSelect.value);
      this.renderPractice();
    });
    el.modeSelect.addEventListener("change", () => this.store.setMode(el.modeSelect.value));
    el.btnAll.addEventListener("click", () => {
      this.store.setUnits(this.store.allUnitKeys());
      this.renderUnits();
    });
    el.btnNone.addEventListener("click", () => {
      this.store.setUnits([]);
      this.renderUnits();
    });
    el.btnDeleteDeck.addEventListener("click", () => {
      const btn = el.btnDeleteDeck;
      if (!confirmTap(btn, "Tap again to delete")) return;
      const name = this.store.currentDeck?.name;
      this.store.deleteDeck(this.store.currentDeckId);
      this.renderPractice();
      this.toast(`Deleted “${name}”.`);
    });
  }

  renderPractice() {
    const { el, store } = this;
    el.deckSelect.replaceChildren(
      ...store.deckIds().map((id) => new Option(store.getDeck(id).name, id, false, id === store.currentDeckId))
    );
    const deck = store.currentDeck;
    el.modeSelect.replaceChildren(
      ...modesForDeck(deck).map((m) => new Option(m.label, m.value, false, m.value === store.mode))
    );
    el.btnDeleteDeck.hidden = !deck || deck.builtIn;
    this.renderUnits();
  }

  renderUnits() {
    const { el, store } = this;
    const selected = store.selectedUnits;
    const deck = store.currentDeck;
    const frag = document.createDocumentFragment();

    for (const [group, units] of Object.entries(store.hierarchy())) {
      const keys = Object.values(units).map((cards) => unitKey(cards[0]));
      const allOn = keys.every((k) => selected.has(k));

      const section = document.createElement("section");
      section.className = "unit-group";
      const head = document.createElement("div");
      head.className = "unit-group__head";
      const title = document.createElement("h4");
      title.textContent = group;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "chip";
      toggle.textContent = allOn ? "None" : "All";
      toggle.setAttribute("aria-label", `${allOn ? "Deselect" : "Select"} all in ${group}`);
      toggle.addEventListener("click", () => {
        store.toggleUnits(keys, !allOn);
        this.renderUnits();
      });
      head.append(title, toggle);

      const grid = document.createElement("div");
      grid.className = "unit-grid";
      for (const [unit, cards] of Object.entries(units)) {
        const key = unitKey(cards[0]);
        const on = selected.has(key);
        const mastery = store.unitMastery(cards);
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "unit";
        tile.setAttribute("aria-pressed", String(on));
        tile.style.setProperty("--mastery", mastery.toFixed(2));

        const name = document.createElement("span");
        name.className = "unit__name";
        name.textContent = unit;
        const count = document.createElement("span");
        count.className = "unit__count";
        count.textContent = `${cards.length} · ${Math.round(mastery * 100)}% known`;
        const preview = document.createElement("span");
        preview.className = "unit__preview";
        setAttr(preview, "lang", deck?.lang || "");
        const shown = cards.slice(0, PREVIEW_TOKENS).map((c) => c.prompt);
        preview.textContent = shown.join(" ") + (cards.length > PREVIEW_TOKENS ? " …" : "");
        const bar = document.createElement("span");
        bar.className = "unit__bar";
        bar.setAttribute("aria-hidden", "true");

        tile.append(name, count, preview, bar);
        tile.addEventListener("click", () => {
          const now = tile.getAttribute("aria-pressed") !== "true";
          tile.setAttribute("aria-pressed", String(now));
          store.toggleUnits([key], now);
          const groupOn = keys.every((k) => store.selectedUnits.has(k));
          toggle.textContent = groupOn ? "None" : "All";
          this.updateStartButton();
        });
        grid.append(tile);
      }
      section.append(head, grid);
      frag.append(section);
    }
    el.unitList.replaceChildren(frag);
    this.updateStartButton();
  }

  updateStartButton() {
    const n = this.store.pool().length;
    this.el.btnStart.textContent = n ? `Start · ${n} card${n === 1 ? "" : "s"}` : "Choose at least one unit";
    this.el.btnStart.disabled = n === 0;
  }

  /* ---------------- settings ---------------- */

  renderSettings() {
    const { el, sync, store } = this;
    el.ghToken.value = sync.config.token || "";
    el.ghRepo.value = sync.config.repo || "";
    el.ghPath.value = sync.config.filePath || "speedrecall-data.json";
    const last = store.state.sync.lastSynced;
    el.syncStatus.textContent = last ? `Last synced ${timeAgo(last)}` : "";
    el.syncStatus.className = "status";
    el.importTarget.options[0].textContent = `Current deck (${store.currentDeck?.name || "none"})`;
  }

  bindSettings() {
    const { el } = this;
    el.newDeckLang.replaceChildren(...LANGS.map(([v, l]) => new Option(l, v)));

    const saveSync = () =>
      this.sync.saveConfig({
        token: el.ghToken.value.trim(),
        repo: el.ghRepo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""),
        filePath: el.ghPath.value.trim() || "speedrecall-data.json"
      });
    for (const f of [el.ghToken, el.ghRepo, el.ghPath]) f.addEventListener("change", saveSync);

    el.btnSync.addEventListener("click", async () => {
      saveSync();
      el.btnSync.disabled = true;
      el.syncStatus.className = "status";
      el.syncStatus.textContent = "Syncing…";
      try {
        await this.sync.sync();
        el.syncStatus.className = "status ok";
        el.syncStatus.textContent = "Synced just now";
        this.engine.next();
      } catch (err) {
        el.syncStatus.className = "status error";
        el.syncStatus.textContent = err.message;
      } finally {
        el.btnSync.disabled = false;
      }
    });

    el.importTarget.addEventListener("change", () => {
      el.newDeckFields.hidden = el.importTarget.value !== "new";
    });
    el.newDeckLang.addEventListener("change", () => {
      el.newDeckPinyin.checked = el.newDeckLang.value === "zh";
    });

    el.btnImport.addEventListener("click", () => {
      const { cards, errors } = parseTSV(el.importText.value);
      if (!cards.length) {
        this.toast(errors[0] || "Paste some cards first.", true);
        return;
      }
      if (el.importTarget.value === "new") {
        const name = el.newDeckName.value.trim();
        if (!name) {
          this.toast("Give the new deck a name.", true);
          el.newDeckName.focus();
          return;
        }
        const lang = el.newDeckLang.value;
        this.store.createDeck(
          { name, lang, romanization: el.newDeckPinyin.checked ? "pinyin" : "" },
          cards
        );
        el.newDeckName.value = "";
        el.importTarget.value = "current";
        el.newDeckFields.hidden = true;
      } else {
        this.store.addCards(this.store.currentDeckId, cards);
      }
      el.importText.value = "";
      const skipped = errors.length ? ` Skipped ${errors.length} line${errors.length === 1 ? "" : "s"} (${errors[0]})` : "";
      this.toast(`Added ${cards.length} card${cards.length === 1 ? "" : "s"}.${skipped}`, Boolean(errors.length));
      this.renderSettings();
    });

    el.btnExport.addEventListener("click", () => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJSON(this.store.exportData(), `speedrecall-backup-${date}.json`);
    });

    el.importFile.addEventListener("change", async () => {
      const file = el.importFile.files[0];
      el.importFile.value = "";
      if (!file) return;
      try {
        this.store.mergeData(await readJSONFile(file));
        this.toast("Backup restored and merged.");
      } catch (err) {
        this.toast(err.message, true);
      }
    });

    el.btnResetProgress.addEventListener("click", () => {
      if (!confirmTap(el.btnResetProgress, "Tap again to erase all progress")) return;
      this.store.resetProgress();
      this.toast("Progress reset.");
    });
  }

  toast(message, isError = false) {
    const t = this.el.toast;
    t.textContent = message;
    t.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.className = "toast"), isError ? 6000 : 3000);
    // Show above an open modal
    const host = this.el.practice.open ? this.el.practice : this.el.settings.open ? this.el.settings : document.body;
    if (t.parentElement !== host) host.append(t);
  }
}

/* ---------------- helpers ---------------- */

function setAttr(el, name, value) {
  if (value) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

/** Size bucket so single characters are huge and phrases still fit. */
function sizeFor(text) {
  const len = [...text].length;
  if (len <= 2) return "xl";
  if (len <= 5) return "lg";
  if (len <= 12) return "md";
  if (len <= 24) return "sm";
  return "xs";
}

/** Two-tap confirmation for destructive buttons. Returns true on the 2nd tap. */
function confirmTap(btn, prompt) {
  if (btn.dataset.armed) {
    clearTimeout(Number(btn.dataset.armed));
    delete btn.dataset.armed;
    btn.textContent = btn.dataset.label;
    return true;
  }
  btn.dataset.label = btn.textContent;
  btn.textContent = prompt;
  btn.dataset.armed = String(
    setTimeout(() => {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
    }, 4000)
  );
  return false;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

new App();
