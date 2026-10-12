/**
 * js/app.js — binds the UI to the store and drill engine.
 */

import { Store, unitKey, getDeckFieldOptions } from "./state.js";
import { RecallEngine } from "./engine.js";
import { modesForDeck } from "./normalizer.js";
import { parseTSV, parseRowsForEditor, readJSONFile, downloadJSON } from "./importer.js";
import { GitHubSync } from "./github-sync.js";
import { hasCloze, autoExtractCloze, chunkCardsIntoUnits } from "./cloze.js";

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

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class App {
  constructor() {
    this.store = new Store();
    this.engine = new RecallEngine(this.store);
    this.sync = new GitHubSync(this.store);
    this.missCount = 0;
    this.isComposing = false;
    this.currentClozeSlot = null;
    this.currentClozeInner = null;
    this.editingDeckId = null;

    this.sitePublishConfig = {
      token: localStorage.getItem("speedrecall_site_token") || "",
      repo: localStorage.getItem("speedrecall_site_repo") || ""
    };

    this.el = {
      deckName: $("deckName"), deckMeta: $("deckMeta"),
      btnPractice: $("btnPractice"), btnToggleHint: $("btnToggleHint"), btnSwapTop: $("btnSwapTop"), btnSettings: $("btnSettings"),
      stage: $("stage"), card: $("card"), cardBadge: $("cardBadge"),
      prompt: $("cardPrompt"), hint: $("cardHint"), reveal: $("cardReveal"), answer: $("cardAnswer"),
      input: $("answerInput"), btnReveal: $("btnReveal"), helpLine: $("helpLine"),
      statStreak: $("statStreak"), statAccuracy: $("statAccuracy"), statPool: $("statPool"),
      practice: $("practiceSheet"), settings: $("settingsSheet"),
      deckSelect: $("deckSelect"), modeSelect: $("modeSelect"),
      frontFieldSelect: $("frontFieldSelect"), backFieldSelect: $("backFieldSelect"), btnSwapFields: $("btnSwapFields"),
      checkShowHints: $("checkShowHints"),
      btnEditDeck: $("btnEditDeck"), btnNewDeck: $("btnNewDeck"), btnRevertDeck: $("btnRevertDeck"),
      unitList: $("unitList"), btnAll: $("btnAllUnits"), btnNone: $("btnNoUnits"), btnStart: $("btnStart"),
      btnDeleteDeck: $("btnDeleteDeck"),
      // Settings tab elements
      tabBtnDecks: $("tabBtnDecks"), tabBtnStorage: $("tabBtnStorage"), tabBtnGitHub: $("tabBtnGitHub"), tabBtnOptions: $("tabBtnOptions"),
      panelDecks: $("panelDecks"), panelStorage: $("panelStorage"), panelGitHub: $("panelGitHub"), panelOptions: $("panelOptions"),
      settingsDeckSelect: $("settingsDeckSelect"), btnExportSelectedDeck: $("btnExportSelectedDeck"),
      btnSettingsEditDeck: $("btnSettingsEditDeck"), btnSettingsNewDeck: $("btnSettingsNewDeck"),
      selectedDeckInfo: $("selectedDeckInfo"), storageSummaryBox: $("storageSummaryBox"),
      btnExportProgressOnly: $("btnExportProgressOnly"), btnTestGitHub: $("btnTestGitHub"),
      prefDefaultHints: $("prefDefaultHints"),
      ghToken: $("ghToken"), ghRepo: $("ghRepo"), ghPath: $("ghPath"), btnSync: $("btnSync"), syncStatus: $("syncStatus"),
      ghSiteRepo: $("ghSiteRepo"), ghSiteToken: $("ghSiteToken"), btnSavePublisher: $("btnSavePublisher"), publisherStatus: $("publisherStatus"),
      importText: $("importText"), btnImport: $("btnImport"),
      btnExport: $("btnExport"), importFile: $("importFile"), btnResetProgress: $("btnResetProgress"),
      // Editor elements
      editor: $("editorSheet"), editorTitle: $("editorTitle"), editorDeckName: $("editorDeckName"),
      editorDeckLang: $("editorDeckLang"), editorPinyin: $("editorPinyin"),
      btnEditorAddRow: $("btnEditorAddRow"), btnEditorChunkUnits: $("btnEditorChunkUnits"),
      btnEditorPaste: $("btnEditorPaste"), btnEditorPublish: $("btnEditorPublish"),
      editorStats: $("editorStats"), editorRows: $("editorRows"),
      btnEditorSave: $("btnEditorSave"), btnEditorCancel: $("btnEditorCancel"),
      // Paste modal
      paste: $("pasteSheet"), pasteText: $("pasteText"),
      btnPasteCancel: $("btnPasteCancel"), btnPasteApply: $("btnPasteApply"),
      toast: $("toast")
    };
    this.init();
  }

  async init() {
    this.bindStage();
    this.bindSheets();
    this.bindSettings();
    this.bindEditor();
    this.bindEngine();
    await this.store.init();
    this.renderDeck();
    this.renderHintButton();
    this.engine.next();
    if (this.store.deckIds().length === 0) {
      this.showCardMessage("Couldn't load any decks", "Check your connection and reload.");
    }
  }

  /* ---------------- stage ---------------- */

  bindStage() {
    const { input, stage } = this.el;

    input.addEventListener("compositionstart", () => {
      this.isComposing = true;
    });

    input.addEventListener("compositionend", () => {
      this.isComposing = false;
      this.engine.input(input.value, false);
    });

    input.addEventListener("input", () => {
      this.engine.input(input.value, this.isComposing);
    });

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

    // Quick hint toggle in topbar
    this.el.btnToggleHint.addEventListener("click", () => {
      this.handleToggleHint();
      if (this.engine.card && !this.el.practice.open && !this.el.settings.open && !this.el.editor.open && !this.el.paste.open) {
        this.el.input.focus({ preventScroll: true });
      }
    });

    // Quick swap in topbar
    this.el.btnSwapTop.addEventListener("click", () => {
      this.handleSwapFields();
    });

    // Global keyboard shortcut: H toggles hint/subtitle
    window.addEventListener("keydown", (e) => {
      if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        const isEditing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
        if (!isEditing) {
          e.preventDefault();
          this.handleToggleHint();
        }
      }
    });

    // Tapping the card area brings the keyboard back on phones
    stage.addEventListener("click", (e) => {
      if (!e.target.closest("button, input, a")) input.focus();
    });
  }

  handleToggleHint() {
    const show = this.store.toggleHints();
    this.renderHintButton();
    this.toast(show ? "Hints enabled" : "Hints hidden");
  }

  renderHintButton() {
    const show = this.store.showHints;
    this.el.btnToggleHint.setAttribute("aria-pressed", String(show));
    this.el.btnToggleHint.title = show ? "Hints & notes visible (H to toggle)" : "Hints hidden (H to toggle)";
    if (this.el.checkShowHints) {
      this.el.checkShowHints.checked = show;
    }
    // Update card hint visibility without modifying input or card prompt/answer roles
    if (this.engine.card) {
      const canonical = this.engine.card.canonicalHint !== undefined
        ? this.engine.card.canonicalHint
        : (this.engine.card.sourceSubtitle !== undefined ? this.engine.card.sourceSubtitle : (this.engine.card.subtitle || ""));
      this.el.hint.textContent = (show ? canonical : "") || "";
    }
  }

  handleSwapFields() {
    const deck = this.store.currentDeck;
    if (deck?.cards?.every((c) => c.isCloze)) {
      this.toast("Cloze sentences always test the missing blank in-slot.");
      return;
    }
    const { front, back } = this.store.swapDeckFields();
    const options = getDeckFieldOptions(deck);
    const fLabel = options.find((o) => o.value === front)?.label || front;
    const bLabel = options.find((o) => o.value === back)?.label || back;
    this.toast(`Swapped: ${fLabel} ⇄ ${bLabel}`);
    this.renderDeck();
  }

  bindEngine() {
    const { el, engine, store } = this;

    engine.addEventListener("card", ({ detail: { card } }) => {
      el.card.className = "card";
      el.cardBadge.textContent = "";
      el.reveal.hidden = true;
      el.input.value = "";
      el.input.classList.remove("is-correcting");
      this.currentClozeSlot = null;
      this.currentClozeInner = null;

      if (!card) {
        el.input.disabled = el.btnReveal.disabled = true;
        this.showCardMessage("No units selected", "Open the deck menu to choose what to drill.");
        this.updateStats();
        return;
      }

      el.input.disabled = el.btnReveal.disabled = false;
      el.btnReveal.textContent = "Reveal";
      el.input.placeholder = this.getInputPlaceholder(card, store.currentDeck);

      // Handle Cloze Sentence presentation
      if (card.isCloze && card.clozeData) {
        el.prompt.innerHTML = `
          <span class="cloze-sentence">
            <span class="cloze-text">${escapeHtml(card.clozeData.prefix)}</span>
            <span class="cloze-slot" id="cardClozeSlot"><span class="cloze-slot__inner" id="cardClozeSlotInner"></span></span>
            <span class="cloze-text">${escapeHtml(card.clozeData.suffix)}</span>
          </span>
        `;
        el.prompt.dataset.size = "sm";
        this.currentClozeSlot = $("cardClozeSlot");
        this.currentClozeInner = $("cardClozeSlotInner");
      } else {
        el.prompt.textContent = card.prompt;
        el.prompt.dataset.size = sizeFor(card.prompt);
      }

      el.hint.textContent = (store.showHints ? card.subtitle : "") || "";
      this.updateStats();
      if (!el.practice.open && !el.settings.open && !el.editor.open && !el.paste.open) {
        el.input.focus({ preventScroll: true });
      }
    });

    engine.addEventListener("input", ({ detail: { value } }) => {
      if (this.currentClozeInner) {
        this.currentClozeInner.textContent = value || "";
      }
    });

    engine.addEventListener("correct", () => {
      el.card.classList.add("is-correct");
      el.cardBadge.textContent = "✓";
      if (this.currentClozeSlot) {
        this.currentClozeSlot.classList.remove("is-miss");
        this.currentClozeSlot.classList.add("is-correct");
      }
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
      if (this.currentClozeSlot) {
        this.currentClozeSlot.classList.remove("is-correct");
        this.currentClozeSlot.classList.add("is-miss");
        if (this.currentClozeInner) this.currentClozeInner.textContent = answer;
      }
      this.missCount++;
      if (this.missCount <= 3) el.helpLine.textContent = "Type the answer shown to move on.";
    });

    engine.addEventListener("corrected", () => {
      el.card.classList.remove("is-miss");
      el.card.classList.add("is-correct");
      el.cardBadge.textContent = "✓";
      if (this.currentClozeSlot) {
        this.currentClozeSlot.classList.remove("is-miss");
        this.currentClozeSlot.classList.add("is-correct");
      }
      if (this.missCount <= 3) el.helpLine.textContent = "Enter or Reveal shows the answer.";
    });

    engine.addEventListener("nudge", () => {
      el.input.classList.remove("nudge");
      void el.input.offsetWidth;
      el.input.classList.add("nudge");
    });

    engine.addEventListener("pool", () => this.updateStats());
    engine.addEventListener("hint", () => this.renderHintButton());
    store.addEventListener("stats-changed", () => this.updateStats());
    store.addEventListener("deck-changed", () => this.renderDeck());
    store.addEventListener("deck-updated", () => this.renderDeck());
    store.addEventListener("units-changed", () => this.renderDeckButton());
    store.addEventListener("hints-changed", () => this.renderHintButton());
    store.addEventListener("fields-changed", () => {
      this.renderDeck();
      if (this.el.practice.open) this.renderPractice();
    });
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

  getInputPlaceholder(card, deck) {
    if (card?.isCloze) return "Fill in the blank";
    const back = this.store.backField;
    if (deck?.romanization === "pinyin") {
      if (back === "prompt") return "Type Chinese characters";
      if (back === "answer") return "Type pinyin (e.g. ni3hao3)";
      if (back === "subtitle") return "Type English meaning";
    }
    if (back === "prompt") return `Type in ${deck?.lang || "target language"}`;
    if (back === "answer") return "Type the answer";
    if (back === "subtitle") return "Type the hint / meaning";
    return "Type the answer";
  }

  /** Applies the deck's language/direction to prompt and input based on active front and back fields. */
  applyLanguage(deck) {
    if (!deck) return;
    const front = this.store.frontField;
    const back = this.store.backField;

    let promptLang = deck.lang || "";
    let inputLang = deck.answerLang || "";

    if (deck.romanization === "pinyin") {
      if (front === "prompt") promptLang = "zh-CN";
      else if (front === "answer") promptLang = "zh-Latn-pinyin";
      else if (front === "subtitle") promptLang = "en";

      if (back === "prompt") inputLang = "zh-CN";
      else if (back === "answer") inputLang = "zh-Latn-pinyin";
      else if (back === "subtitle") inputLang = "en";
    } else {
      if (front === "prompt") promptLang = deck.lang || "";
      else if (front === "answer") promptLang = deck.answerLang || "en";
      else if (front === "subtitle") promptLang = deck.answerLang || "en";

      if (back === "prompt") inputLang = deck.lang || "";
      else if (back === "answer") inputLang = deck.answerLang || "en";
      else if (back === "subtitle") inputLang = deck.answerLang || "en";
    }

    const dir = RTL.has(promptLang.split("-")[0]) ? "rtl" : "auto";
    setAttr(this.el.prompt, "lang", promptLang);
    this.el.prompt.dir = dir;

    setAttr(this.el.input, "lang", inputLang);
    setAttr(this.el.answer, "lang", inputLang);
    this.el.input.dir = RTL.has(inputLang.split("-")[0]) ? "rtl" : "auto";
  }

  renderDeck() {
    const deck = this.store.currentDeck;
    this.applyLanguage(deck);
    this.renderDeckButton();
    if (this.el.practice.open) this.renderPractice();
  }

  renderDeckButton() {
    const deck = this.store.currentDeck;
    let name = deck?.name || "No deck";
    if (deck?.isOverride) name += " (edited)";
    this.el.deckName.textContent = name;
    const total = this.store.allUnitKeys().length;
    const sel = this.store.selectedUnits.size;

    const metaParts = [];
    if (deck && !deck.cards?.every((c) => c.isCloze)) {
      const opts = getDeckFieldOptions(deck);
      const fLabel = opts.find((o) => o.value === this.store.frontField)?.label.split(" ")[0] || this.store.frontField;
      const bLabel = opts.find((o) => o.value === this.store.backField)?.label.split(" ")[0] || this.store.backField;
      metaParts.push(`${fLabel} → ${bLabel}`);
    }
    metaParts.push(`${sel} of ${total} unit${total === 1 ? "" : "s"}`);
    this.el.deckMeta.textContent = deck ? metaParts.join(" · ") : "";
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

    for (const dlg of [el.practice, el.settings, el.editor, el.paste]) {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
      });
      dlg.addEventListener("close", () => {
        if (!el.practice.open && !el.settings.open && !el.editor.open && !el.paste.open) {
          el.input.focus({ preventScroll: true });
        }
      });
    }

    el.deckSelect.addEventListener("change", () => {
      this.store.setDeck(el.deckSelect.value);
      this.renderPractice();
    });

    el.modeSelect.addEventListener("change", () => this.store.setMode(el.modeSelect.value));

    el.frontFieldSelect.addEventListener("change", () => {
      let front = el.frontFieldSelect.value;
      let back = el.backFieldSelect.value;
      if (front === back) {
        const deck = this.store.currentDeck;
        const opts = getDeckFieldOptions(deck).map((o) => o.value);
        back = opts.find((o) => o !== front) || back;
        el.backFieldSelect.value = back;
      }
      this.store.setDeckFields(front, back);
    });

    el.backFieldSelect.addEventListener("change", () => {
      let front = el.frontFieldSelect.value;
      let back = el.backFieldSelect.value;
      if (front === back) {
        const deck = this.store.currentDeck;
        const opts = getDeckFieldOptions(deck).map((o) => o.value);
        front = opts.find((o) => o !== back) || front;
        el.frontFieldSelect.value = front;
      }
      this.store.setDeckFields(front, back);
    });

    el.btnSwapFields.addEventListener("click", () => {
      this.handleSwapFields();
    });

    el.checkShowHints?.addEventListener("change", () => {
      this.store.setShowHints(el.checkShowHints.checked);
      this.renderHintButton();
    });

    el.btnEditDeck.addEventListener("click", () => {
      el.practice.close();
      this.openDeckEditor(this.store.currentDeckId);
    });

    el.btnNewDeck.addEventListener("click", () => {
      el.practice.close();
      this.openDeckEditor(null);
    });

    el.btnRevertDeck.addEventListener("click", () => {
      const deck = this.store.currentDeck;
      if (!confirmTap(el.btnRevertDeck, "Tap again to revert")) return;
      this.store.revertBuiltInDeck(this.store.currentDeckId);
      this.renderPractice();
      this.toast(`Reverted “${deck?.name}” back to original built-in cards.`);
    });

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
      ...store.deckIds().map((id) => {
        const d = store.getDeck(id);
        const label = d.isOverride ? `${d.name} (edited)` : d.name;
        return new Option(label, id, false, id === store.currentDeckId);
      })
    );
    const deck = store.currentDeck;
    el.modeSelect.replaceChildren(
      ...modesForDeck(deck).map((m) => new Option(m.label, m.value, false, m.value === store.mode))
    );

    const isAllCloze = Boolean(deck?.cards?.length && deck.cards.every((c) => c.isCloze));
    const fieldOpts = isAllCloze
      ? [
          { value: "prompt", label: "Sentence (Cloze)" },
          { value: "answer", label: "Missing Blank" }
        ]
      : getDeckFieldOptions(deck);

    el.frontFieldSelect.replaceChildren(
      ...fieldOpts.map((o) => new Option(o.label, o.value, false, o.value === store.frontField))
    );
    el.backFieldSelect.replaceChildren(
      ...fieldOpts.map((o) => new Option(o.label, o.value, false, o.value === store.backField))
    );
    el.frontFieldSelect.disabled = isAllCloze;
    el.backFieldSelect.disabled = isAllCloze;
    el.btnSwapFields.disabled = isAllCloze;
    if (el.checkShowHints) {
      el.checkShowHints.checked = store.showHints;
    }

    el.btnDeleteDeck.hidden = !deck || deck.builtIn;
    el.btnRevertDeck.hidden = !deck?.isOverride;
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

  /* ---------------- settings & publisher ---------------- */

  /* ---------------- settings & publisher ---------------- */

  renderSettings() {
    const { el, sync, store } = this;

    // 1. Decks Tab
    const deckIds = store.deckIds();
    el.settingsDeckSelect.replaceChildren(
      ...deckIds.map((id) => {
        const d = store.getDeck(id);
        const opt = new Option(d ? d.name : id, id);
        opt.selected = id === store.currentDeckId;
        return opt;
      })
    );
    this.updateSelectedDeckInfo();

    // 2. Storage Tab
    const customCount = Object.keys(store.state.customDecks).length;
    let totalCards = 0;
    for (const id of deckIds) {
      const d = store.getDeck(id);
      totalCards += (d?.rawCards || d?.cards || []).length;
    }
    const practicedCount = Object.keys(store.state.progress).length;
    el.storageSummaryBox.innerHTML = `
      <div><b>Library:</b> ${deckIds.length} deck${deckIds.length === 1 ? "" : "s"} (${customCount} custom) · <b>${totalCards}</b> total cards</div>
      <div><b>Study History:</b> <b>${practicedCount}</b> practiced cards with spaced-repetition weights</div>
    `;

    // 3. GitHub Tab
    el.ghToken.value = sync.config.token || "";
    el.ghRepo.value = sync.config.repo || "";
    el.ghPath.value = sync.config.filePath || "speedrecall-data.json";
    const last = store.state.sync.lastSynced;
    el.syncStatus.textContent = last ? `Last synced ${timeAgo(last)}` : "";
    el.syncStatus.className = "status";

    el.ghSiteRepo.value = this.sitePublishConfig.repo || "";
    el.ghSiteToken.value = this.sitePublishConfig.token || "";

    // 4. Options Tab
    if (el.prefDefaultHints) {
      el.prefDefaultHints.checked = Boolean(store.showHints);
    }
  }

  updateSelectedDeckInfo() {
    const { el, store } = this;
    const selectedId = el.settingsDeckSelect.value || store.currentDeckId;
    const deck = store.getDeck(selectedId);
    if (!deck) {
      el.selectedDeckInfo.innerHTML = "<span>No deck selected.</span>";
      return;
    }
    const cards = deck.rawCards || deck.cards || [];
    const units = deck.units || [...new Set(cards.map(unitKey))];
    const avgMastery = Math.round(store.unitMastery(deck.cards || []) * 100);
    const typeLabel = deck.builtIn ? "Built-in deck" : "Custom deck";

    el.selectedDeckInfo.innerHTML = `
      <div><b>${escapeHtml(deck.name)}</b> · <span class="note">${typeLabel}</span></div>
      <div><b>${cards.length}</b> card${cards.length === 1 ? "" : "s"} · <b>${units.length}</b> unit${units.length === 1 ? "" : "s"} · <b>${avgMastery}%</b> mastered</div>
    `;
  }

  bindSettings() {
    const { el, sync, store } = this;

    // Segmented tab switching
    const tabs = [
      { btn: el.tabBtnDecks, panel: el.panelDecks },
      { btn: el.tabBtnStorage, panel: el.panelStorage },
      { btn: el.tabBtnGitHub, panel: el.panelGitHub },
      { btn: el.tabBtnOptions, panel: el.panelOptions }
    ];

    tabs.forEach(({ btn, panel }) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        tabs.forEach((t) => {
          const active = t.btn === btn;
          t.btn.classList.toggle("active", active);
          t.btn.setAttribute("aria-selected", String(active));
          if (t.panel) t.panel.hidden = !active;
        });
      });
    });

    // Deck picker in settings
    el.settingsDeckSelect.addEventListener("change", () => {
      this.updateSelectedDeckInfo();
    });

    // Export single deck
    el.btnExportSelectedDeck.addEventListener("click", () => {
      const selectedId = el.settingsDeckSelect.value || store.currentDeckId;
      try {
        const deckData = store.exportDeck(selectedId);
        downloadJSON(deckData, `${selectedId}.json`);
        this.toast(`Exported "${deckData.name}" as JSON.`);
      } catch (err) {
        this.toast(err.message, true);
      }
    });

    // Edit deck from settings
    el.btnSettingsEditDeck.addEventListener("click", () => {
      const selectedId = el.settingsDeckSelect.value || store.currentDeckId;
      el.settings.close();
      this.openDeckEditor(selectedId);
    });

    // New deck from settings
    el.btnSettingsNewDeck.addEventListener("click", () => {
      el.settings.close();
      this.openDeckEditor(null);
    });

    // Add cards to selected deck
    el.btnImport.addEventListener("click", () => {
      const selectedId = el.settingsDeckSelect.value || store.currentDeckId;
      const { cards, errors } = parseTSV(el.importText.value);
      if (!cards.length) {
        this.toast(errors[0] || "Paste some cards first.", true);
        return;
      }
      store.addCards(selectedId, cards);
      el.importText.value = "";
      const skipped = errors.length ? ` Skipped ${errors.length} line${errors.length === 1 ? "" : "s"} (${errors[0]})` : "";
      this.toast(`Added ${cards.length} card${cards.length === 1 ? "" : "s"}.${skipped}`, Boolean(errors.length));
      this.renderSettings();
      this.renderDeck();
    });

    // Local Storage actions
    el.btnExport.addEventListener("click", () => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJSON(store.exportData(), `speedrecall-backup-${date}.json`);
      this.toast("Full backup downloaded.");
    });

    el.btnExportProgressOnly.addEventListener("click", () => {
      const date = new Date().toISOString().slice(0, 10);
      downloadJSON(store.exportProgress(), `speedrecall-progress-${date}.json`);
      this.toast("Study progress exported.");
    });

    el.importFile.addEventListener("change", async () => {
      const file = el.importFile.files[0];
      el.importFile.value = "";
      if (!file) return;
      try {
        const data = await readJSONFile(file);
        store.mergeData(data);
        this.renderSettings();
        this.renderDeck();
        this.toast("Imported successfully.");
      } catch (err) {
        this.toast(err.message, true);
      }
    });

    el.btnResetProgress.addEventListener("click", () => {
      if (!confirmTap(el.btnResetProgress, "Tap again to erase all progress")) return;
      store.resetProgress();
      this.renderSettings();
      this.toast("Progress reset.");
    });

    // GitHub Sync actions
    const saveSync = () =>
      sync.saveConfig({
        token: el.ghToken.value.trim(),
        repo: el.ghRepo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""),
        filePath: el.ghPath.value.trim() || "speedrecall-data.json"
      });
    for (const f of [el.ghToken, el.ghRepo, el.ghPath]) f.addEventListener("change", saveSync);

    el.btnTestGitHub.addEventListener("click", async () => {
      saveSync();
      el.btnTestGitHub.disabled = true;
      el.syncStatus.className = "status";
      el.syncStatus.textContent = "Testing connection…";
      try {
        const info = await sync.testConnection(el.ghToken.value, el.ghRepo.value);
        el.syncStatus.className = "status ok";
        el.syncStatus.textContent = `✓ Connected to ${info.repo} (${info.branch})`;
      } catch (err) {
        el.syncStatus.className = "status error";
        el.syncStatus.textContent = err.message;
      } finally {
        el.btnTestGitHub.disabled = false;
      }
    });

    el.btnSync.addEventListener("click", async () => {
      saveSync();
      el.btnSync.disabled = true;
      el.syncStatus.className = "status";
      el.syncStatus.textContent = "Syncing…";
      try {
        await sync.sync();
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

    el.btnSavePublisher.addEventListener("click", () => {
      const repo = el.ghSiteRepo.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
      const token = el.ghSiteToken.value.trim();
      this.sitePublishConfig = { repo, token };
      localStorage.setItem("speedrecall_site_repo", repo);
      localStorage.setItem("speedrecall_site_token", token);
      el.publisherStatus.className = "status ok";
      el.publisherStatus.textContent = "Saved! Publishing enabled.";
      this.toast("Publisher settings saved.");
    });

    // Preferences Tab
    if (el.prefDefaultHints) {
      el.prefDefaultHints.addEventListener("change", () => {
        store.showHints = el.prefDefaultHints.checked;
        this.renderHintButton();
        this.toast(`Default hints: ${store.showHints ? "ON" : "OFF"}`);
      });
    }
  }

  /* ---------------- deck editor ---------------- */

  bindEditor() {
    const { el } = this;
    el.editorDeckLang.replaceChildren(...LANGS.map(([v, l]) => new Option(l, v)));

    el.btnEditorAddRow.addEventListener("click", () => {
      this.addEditorRow();
      this.updateEditorStats();
    });

    el.btnEditorChunkUnits.addEventListener("click", () => {
      const rows = this.getEditorCardData();
      if (!rows.length) return;
      const chunked = chunkCardsIntoUnits(rows, 10);
      this.populateEditorRows(chunked);
      this.toast(`Grouped ${rows.length} cards into units of 10.`);
    });

    el.btnEditorPaste.addEventListener("click", () => {
      el.pasteText.value = "";
      el.paste.showModal();
    });

    el.btnPasteApply.addEventListener("click", () => {
      const rows = parseRowsForEditor(el.pasteText.value);
      if (!rows.length) {
        this.toast("No valid card rows found in pasted text.", true);
        return;
      }
      this.appendEditorRows(rows);
      el.paste.close();
      this.toast(`Imported ${rows.length} cards from clipboard.`);
    });

    el.btnEditorSave.addEventListener("click", () => {
      this.saveEditorDeck();
    });

    el.btnEditorPublish.addEventListener("click", async () => {
      await this.publishCurrentDeckToRepo();
    });
  }

  openDeckEditor(deckId = null) {
    const { el, store } = this;
    this.editingDeckId = deckId;
    el.editorRows.replaceChildren();

    if (deckId) {
      const deck = store.getDeck(deckId);
      el.editorTitle.textContent = `Edit “${deck.name}”`;
      el.editorDeckName.value = deck.name;
      el.editorDeckLang.value = deck.lang || "";
      el.editorPinyin.checked = deck.romanization === "pinyin";
      const cards = deck.rawCards || deck.cards || [];
      this.populateEditorRows(cards);
    } else {
      el.editorTitle.textContent = "New deck";
      el.editorDeckName.value = "";
      el.editorDeckLang.value = "";
      el.editorPinyin.checked = false;
      // Provide 3 clean starter rows
      for (let i = 0; i < 3; i++) this.addEditorRow({ unit: "1" });
    }

    // Show publish button if repo credentials exist
    const hasPublisherCreds = Boolean(this.sitePublishConfig.token && this.sitePublishConfig.repo);
    el.btnEditorPublish.hidden = !hasPublisherCreds || !deckId;

    this.updateEditorStats();
    el.editor.showModal();
  }

  populateEditorRows(cards) {
    this.el.editorRows.replaceChildren();
    for (const c of cards) {
      this.addEditorRow({
        id: c.id,
        prompt: c.prompt || "",
        answer: c.answers?.[0] || c.answer || "",
        hint: c.subtitle || "",
        unit: c.unit || "1"
      });
    }
    this.updateEditorStats();
  }

  appendEditorRows(rows) {
    for (const r of rows) {
      this.addEditorRow(r);
    }
    this.updateEditorStats();
  }

  addEditorRow(data = {}) {
    const tr = document.createElement("tr");
    tr.dataset.cardId = data.id || `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Prompt column
    const tdPrompt = document.createElement("td");
    const inPrompt = document.createElement("input");
    inPrompt.className = "editor-input editor-input--prompt";
    inPrompt.placeholder = "bonjour or Je {{suis}} fatigué";
    inPrompt.value = data.prompt || "";
    tdPrompt.appendChild(inPrompt);

    // Answer column
    const tdAnswer = document.createElement("td");
    const inAnswer = document.createElement("input");
    inAnswer.className = "editor-input editor-input--answer";
    inAnswer.placeholder = "hello";
    inAnswer.value = data.answer || "";
    tdAnswer.appendChild(inAnswer);

    // Hint column
    const tdHint = document.createElement("td");
    const inHint = document.createElement("input");
    inHint.className = "editor-input editor-input--hint";
    inHint.placeholder = "optional hint";
    inHint.value = data.hint || "";
    tdHint.appendChild(inHint);

    // Unit column
    const tdUnit = document.createElement("td");
    const inUnit = document.createElement("input");
    inUnit.className = "editor-input editor-input--unit";
    inUnit.placeholder = "1";
    inUnit.value = data.unit || "1";
    tdUnit.appendChild(inUnit);

    // Delete column
    const tdDel = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "editor-del-btn";
    btnDel.title = "Delete card";
    btnDel.textContent = "✕";
    btnDel.addEventListener("click", () => {
      tr.remove();
      this.updateEditorStats();
    });
    tdDel.appendChild(btnDel);

    // Auto-detect cloze on prompt typing
    inPrompt.addEventListener("input", () => {
      const val = inPrompt.value;
      if (hasCloze(val)) {
        const cloze = autoExtractCloze(val);
        if (cloze) {
          if (!inAnswer.value) inAnswer.value = cloze.primaryAnswer;
          if (!inHint.value && cloze.primaryHint) inHint.value = cloze.primaryHint;
        }
      }
    });

    // Fast-entry keyboard shortcuts:
    // Enter adds next row, Tab from Unit moves to next row Prompt
    inPrompt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const nextRow = this.addEditorRow({ unit: inUnit.value });
        tr.after(nextRow);
        nextRow.querySelector(".editor-input--prompt")?.focus();
        this.updateEditorStats();
      }
    });

    inAnswer.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const nextRow = this.addEditorRow({ unit: inUnit.value });
        tr.after(nextRow);
        nextRow.querySelector(".editor-input--prompt")?.focus();
        this.updateEditorStats();
      }
    });

    inUnit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && tr === this.el.editorRows.lastElementChild)) {
        e.preventDefault();
        const nextRow = this.addEditorRow({ unit: inUnit.value });
        this.el.editorRows.appendChild(nextRow);
        nextRow.querySelector(".editor-input--prompt")?.focus();
        this.updateEditorStats();
      }
    });

    tr.append(tdPrompt, tdAnswer, tdHint, tdUnit, tdDel);
    this.el.editorRows.appendChild(tr);
    return tr;
  }

  getEditorCardData() {
    const cards = [];
    const rows = this.el.editorRows.querySelectorAll("tr");
    rows.forEach((tr, i) => {
      const prompt = tr.querySelector(".editor-input--prompt")?.value.trim() || "";
      let answer = tr.querySelector(".editor-input--answer")?.value.trim() || "";
      let hint = tr.querySelector(".editor-input--hint")?.value.trim() || "";
      const unit = tr.querySelector(".editor-input--unit")?.value.trim() || "1";
      const id = tr.dataset.cardId || `card-${i + 1}`;

      // If prompt has cloze and answer is empty, extract it
      if (hasCloze(prompt)) {
        const cloze = autoExtractCloze(prompt);
        if (cloze) {
          if (!answer) answer = cloze.primaryAnswer;
          if (!hint && cloze.primaryHint) hint = cloze.primaryHint;
        }
      }

      if (prompt && answer) {
        cards.push({ id, group: "General", unit, prompt, subtitle: hint, answer });
      }
    });
    return cards;
  }

  updateEditorStats() {
    const count = this.getEditorCardData().length;
    this.el.editorStats.textContent = `${count} card${count === 1 ? "" : "s"}`;
  }

  saveEditorDeck() {
    const { el, store } = this;
    const name = el.editorDeckName.value.trim();
    if (!name) {
      this.toast("Please enter a deck name.", true);
      el.editorDeckName.focus();
      return;
    }

    const cards = this.getEditorCardData();
    if (!cards.length) {
      this.toast("Deck needs at least one card with a prompt and an answer.", true);
      return;
    }

    const meta = {
      name,
      lang: el.editorDeckLang.value,
      romanization: el.editorPinyin.checked ? "pinyin" : ""
    };

    if (this.editingDeckId) {
      const existing = store.getDeck(this.editingDeckId);
      if (existing.builtIn) {
        store.overrideBuiltInDeck(this.editingDeckId, meta, cards);
        this.toast(`Saved local edits for built-in deck “${name}”.`);
      } else {
        store.updateDeck(this.editingDeckId, meta, cards);
        this.toast(`Updated deck “${name}”.`);
      }
    } else {
      const newId = store.createDeck(meta, cards);
      this.toast(`Created deck “${name}”.`);
    }

    el.editor.close();
    this.renderDeck();
    this.engine.next();
  }

  async publishCurrentDeckToRepo() {
    const { store } = this;
    const deckId = this.editingDeckId;
    if (!deckId) return;

    const deck = store.getDeck(deckId);
    if (!this.sitePublishConfig.token || !this.sitePublishConfig.repo) {
      this.toast("Configure site repo & write token in Settings first.", true);
      return;
    }

    this.toast(`Publishing “${deck.name}” to GitHub Pages…`);
    try {
      await this.sync.publishDeckToRepo(deck, this.sitePublishConfig.token, this.sitePublishConfig.repo);
      this.toast(`Published “${deck.name}” to ${this.sitePublishConfig.repo}! GitHub Pages updates in ~1 min.`);
    } catch (err) {
      this.toast(`Publish failed: ${err.message}`, true);
    }
  }

  toast(message, isError = false) {
    const t = this.el.toast;
    t.textContent = message;
    t.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.className = "toast"), isError ? 6000 : 3000);
    // Show above an open modal
    const host = this.el.editor.open
      ? this.el.editor
      : this.el.practice.open
      ? this.el.practice
      : this.el.settings.open
      ? this.el.settings
      : document.body;
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
