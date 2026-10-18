/**
 * js/app.js — binds the UI to the store and drill engine.
 */

import { Store, unitKey } from "./state.js";
import { RecallEngine } from "./engine.js";
import { modesForDeck } from "./normalizer.js";
import { parseTSV, readJSONFile, downloadJSON } from "./importer.js";
import { GitHubSync } from "./github-sync.js";
import { AudioController } from "./audio.js";
import { renderCloze } from "./cloze.js";
import { Routes, RouteController, ROUTE_LABELS, isNativeTypingCompatible, routesForDeck } from "./routes.js";



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
    this.audio = new AudioController();
    this.missCount = 0;

    this.el = {
      deckName: $("deckName"), deckMeta: $("deckMeta"),
      btnPractice: $("btnPractice"), btnSettings: $("btnSettings"),
      btnHintToggle: $("btnHintToggle"), btnRoleFlip: $("btnRoleFlip"),
      stage: $("stage"), card: $("card"), cardBadge: $("cardBadge"),
      prompt: $("cardPrompt"), hint: $("cardHint"), reveal: $("cardReveal"), answer: $("cardAnswer"),
      input: $("answerInput"), btnReveal: $("btnReveal"), helpLine: $("helpLine"),
      statStreak: $("statStreak"), statAccuracy: $("statAccuracy"), statPool: $("statPool"),
      practice: $("practiceModal") || $("practiceSheet"),
      settings: $("settingsModal") || $("settingsSheet"),
      newDeckModal: $("newDeckModal"),
      newDeckTitle: $("newDeckTitle"),
      deckSelect: $("deckSelect"), modeSelect: $("modeSelect"), routeSelect: $("routeSelect"), unitList: $("unitList"),
      roleFrontSelect: $("roleFrontSelect"), roleBackSelect: $("roleBackSelect"), btnRoleSwapModal: $("btnRoleSwapModal"),
      sessionShowHints: $("sessionShowHints"),
      sensoryTapSurface: $("sensoryTapSurface"), safetyLockGlyph: $("safetyLockGlyph"), pacingBar: $("pacingBar"),
      sensoryHud: $("sensoryHud"), sensoryHudText: $("sensoryHudText"),
      btnAll: $("btnAllUnits"), btnNone: $("btnNoUnits"), btnStart: $("btnStart"), btnDeleteDeck: $("btnDeleteDeck"),

      // Settings Hub
      tabDecks: $("tabDecks"), tabBackup: $("tabBackup"), tabSync: $("tabSync"), tabOptions: $("tabOptions"),
      panelDecks: $("panelDecks"), panelBackup: $("panelBackup"), panelSync: $("panelSync"), panelOptions: $("panelOptions"),
      settingsDeckSelect: $("settingsDeckSelect"), deckSummaryCard: $("deckSummaryCard"),
      deckSummaryName: $("deckSummaryName"), deckSummaryOrigin: $("deckSummaryOrigin"), deckSummaryMetrics: $("deckSummaryMetrics"),
      btnNewDeckModal: $("btnNewDeckModal"), btnExportDeck: $("btnExportDeck"), btnEditCards: $("btnEditCards"),
      importText: $("importText"), btnImport: $("btnImport"),
      backupDeckCount: $("backupDeckCount"), backupDeckBreakdown: $("backupDeckBreakdown"),
      backupTotalCards: $("backupTotalCards"), backupPracticedCount: $("backupPracticedCount"),
      btnExportFull: $("btnExportFull") || $("btnExport"), btnExportProgress: $("btnExportProgress"),
      btnExport: $("btnExportFull") || $("btnExport"), importFile: $("importFile"), btnResetProgress: $("btnResetProgress"),
      ghToken: $("ghToken"), ghRepo: $("ghRepo"), ghPath: $("ghPath"), btnTestSync: $("btnTestSync"),
      btnSync: $("btnSync"), syncStatus: $("syncStatus"), btnPublishDeck: $("btnPublishDeck"), publishStatus: $("publishStatus"),
      optDefaultHints: $("optDefaultHints"), optDefaultStrictness: $("optDefaultStrictness"),

      // Tabular Deck Builder
      tabularDeckName: $("tabularDeckName"), tabularDeckLang: $("tabularDeckLang"), tabularDeckPinyin: $("tabularDeckPinyin"),
      btnGridAddCard: $("btnGridAddCard"), btnGridSplitUnits: $("btnGridSplitUnits"), btnGridPasteTSV: $("btnGridPasteTSV"),
      gridPasteArea: $("gridPasteArea"), gridPasteText: $("gridPasteText"), btnGridApplyPaste: $("btnGridApplyPaste"),
      btnGridCancelPaste: $("btnGridCancelPaste"), deckGridTbody: $("deckGridTbody"),
      btnGridCancel: $("btnGridCancel"), btnGridSave: $("btnGridSave"),

      btnHome: $("btnHome"), homeHub: $("homeHub"), quickResumeHero: $("quickResumeHero"),
      heroTitle: $("heroTitle"), heroMeta: $("heroMeta"), btnQuickResume: $("btnQuickResume"),
      homeDeckGrid: $("homeDeckGrid"), btnOpenPractice: $("btnOpenPractice"),
      imeCommitIndicator: $("imeCommitIndicator"),
      milestoneModal: $("milestoneModal"), milestoneCards: $("milestoneCards"),
      milestonePace: $("milestonePace"), milestoneStreak: $("milestoneStreak"), btnNextSet: $("btnNextSet"),
      toast: $("toast")
    };

    this.sessionStartTime = Date.now();
    this.sessionCardsCleared = 0;
    this.activeClozeInput = null;
    this.sessionShowHints = true;
    this._editingDeckId = null;

    this.routeController = new RouteController({
      store: this.store,
      audio: this.audio,
      defaultRoute: Routes.REFLEX,
      elements: { ghostInput: this.el.input, nativeInput: this.el.input }
    });

    this.init();
  }


  async init() {
    this.bindStage();
    this.bindHomeHub();
    this.bindSheets();
    this.bindSettings();
    this.bindTabularDeckBuilder();
    this.bindEngine();
    this.bindServiceWorker();
    await this.store.init();
    this.renderDeck();
    this.renderHomeHub();
    this.showHomeHub();
    this.engine.next();
    if (this.store.deckIds().length === 0) {
      this.showCardMessage("Couldn't load any decks", "Check your connection and reload.");
    }
  }

  /* ---------------- stage ---------------- */

  bindStage() {
    const { input, stage } = this.el;

    // IME composition listeners for Route 5 / strict production
    input.addEventListener("compositionstart", (e) => this.routeController.handleCompositionStart(e));
    input.addEventListener("compositionupdate", (e) => this.routeController.handleCompositionUpdate(e));
    input.addEventListener("compositionend", (e) => this.routeController.handleCompositionEnd(e));

    input.addEventListener("input", () => {
      this.routeController.handleInput(input.value);
      this.engine.input(input.value);
    });

    input.addEventListener("keydown", (e) => {
      this.routeController.handleKeyDown(e);
      if (e.key === "Enter" && !e.isComposing && this.routeController.activeRoute !== Routes.STRICT_PRODUCTION) {
        e.preventDefault();
        this.engine.giveUp(input.value);
      }
    });

    this.el.btnReveal.addEventListener("click", () => {
      this.engine.giveUp(input.value);
      input.focus();
    });

    // Sensory tap surface (Route 4)
    if (this.el.sensoryTapSurface) {
      this.el.sensoryTapSurface.addEventListener("click", () => {
        this.routeController.handleTapSurface();
      });
    }

    // Safety lock hold-to-unlock (Route 4)
    if (this.el.safetyLockGlyph) {
      this.el.safetyLockGlyph.addEventListener("pointerdown", () => {
        this.el.safetyLockGlyph.classList.add("is-holding");
        this.routeController.startSafetyHold();
      });
      const cancelHold = () => {
        this.el.safetyLockGlyph.classList.remove("is-holding");
        this.routeController.cancelSafetyHold();
      };
      this.el.safetyLockGlyph.addEventListener("pointerup", cancelHold);
      this.el.safetyLockGlyph.addEventListener("pointerleave", cancelHold);
      this.el.safetyLockGlyph.addEventListener("pointercancel", cancelHold);
      this.el.safetyLockGlyph.addEventListener("click", () => {
        this.toast("Hold 2 seconds to unlock");
      });
    }

    // Route-changed handler for DOM chrome toggling
    this.routeController.addEventListener("route-changed", ({ detail: { route } }) => {
      document.body.dataset.route = route;
      const isSensory = route === Routes.SENSORY_FLASH;
      if (this.el.sensoryTapSurface) this.el.sensoryTapSurface.hidden = !isSensory;
      if (this.el.safetyLockGlyph) this.el.safetyLockGlyph.hidden = !isSensory;
      if (this.el.pacingBar) this.el.pacingBar.hidden = !isSensory;
      if (this.el.sensoryHud) this.el.sensoryHud.hidden = !isSensory;
      document.body.classList.toggle("route-sensory-flash", isSensory);
      document.body.classList.toggle("locked-stage", isSensory);

      // DOM Isolation & Accessibility: inert background chrome
      const topbar = document.querySelector(".topbar");
      if (topbar) {
        topbar.inert = isSensory;
        if (isSensory) topbar.setAttribute("aria-hidden", "true");
        else topbar.removeAttribute("aria-hidden");
      }
      const stats = document.querySelector(".stats");
      if (stats) {
        stats.inert = isSensory;
        if (isSensory) stats.setAttribute("aria-hidden", "true");
        else stats.removeAttribute("aria-hidden");
      }
      if (this.el.imeCommitIndicator) {
        this.el.imeCommitIndicator.hidden = route !== Routes.STRICT_PRODUCTION;
      }
      document.body.classList.toggle("route-reflex", route === Routes.REFLEX);
      document.body.classList.toggle("route-strict-production", route === Routes.STRICT_PRODUCTION);
      document.body.classList.toggle("route-contextual-cloze", route === Routes.CONTEXT_CLOZE);
      document.body.classList.toggle("route-variable-cloze", route === Routes.VARIABLE_CLOZE);
      const isCloze = route === Routes.CONTEXT_CLOZE || route === Routes.VARIABLE_CLOZE || Boolean(this.engine.card?.cloze);
      document.body.classList.toggle("has-cloze", isCloze);

      if (this.el.input) {
        if (isSensory) {
          this.el.input.disabled = true;
          this.el.input.blur();
        } else {
          this.el.input.disabled = false;
        }
      }
    });

    this.routeController.addEventListener("card-mounted", ({ detail: { route } }) => {
      if (route === Routes.SENSORY_FLASH) {
        if (this.el.pacingBar) {
          const fill = this.el.pacingBar.querySelector(".pacing-countdown-bar__fill");
          if (fill) {
            fill.style.animation = "none";
            fill.style.transform = "";
            void fill.offsetWidth; // force DOM reflow
            fill.style.animation = "";
          }
        }
        const hintText = this.el.sensoryTapSurface?.querySelector(".sensory-tap-surface__text");
        if (hintText) hintText.textContent = "Tap anywhere to reveal / advance";
      }
    });

    this.routeController.addEventListener("safety-unlocked", () => {
      if (this.el.safetyLockGlyph) {
        this.el.safetyLockGlyph.classList.remove("is-holding");
      }
      this.toast("Stage unlocked.");
    });

    this.routeController.addEventListener("safety-cancelled", () => {
      if (this.el.safetyLockGlyph) {
        this.el.safetyLockGlyph.classList.remove("is-holding");
      }
    });

    this.routeController.addEventListener("card-revealed", ({ detail: { card } }) => {
      this.el.answer.textContent = card.answer || card.script || "";
      this.el.reveal.hidden = false;
      if (this.routeController.activeRoute === Routes.SENSORY_FLASH) {
        const fill = this.el.pacingBar?.querySelector(".pacing-countdown-bar__fill");
        if (fill) {
          fill.style.animation = "none";
          fill.style.transform = "scaleX(0)";
        }
        const hintText = this.el.sensoryTapSurface?.querySelector(".sensory-tap-surface__text");
        if (hintText) hintText.textContent = "Tap anywhere to advance";
      }
    });

    // Tapping the card area brings the keyboard back on phones unless in Sensory mode
    stage.addEventListener("click", (e) => {
      if (this.routeController.activeRoute === Routes.SENSORY_FLASH) {
        if (!e.target.closest("#sensoryTapSurface") && !e.target.closest("#safetyLockGlyph")) {
          this.toast("Hold lock icon 2s to unlock");
        }
        return;
      }
      if (!e.target.closest("button, input, a")) {
        if (this.activeClozeInput && document.body.contains(this.activeClozeInput)) {
          this.activeClozeInput.focus();
        } else {
          input.focus();
        }
      }
    });
  }

  /* ---------------- home hub & quick resume ---------------- */

  bindHomeHub() {
    const { el } = this;
    if (el.btnHome) {
      el.btnHome.addEventListener("click", () => {
        if (!el.homeHub || el.homeHub.hidden) this.showHomeHub();
        else this.hideHomeHub();
      });
    }

    if (el.btnQuickResume) {
      el.btnQuickResume.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startQuickResume();
      });
    }

    if (el.quickResumeHero) {
      el.quickResumeHero.addEventListener("click", () => {
        this.startQuickResume();
      });
    }

    if (el.btnOpenPractice) {
      el.btnOpenPractice.addEventListener("click", () => {
        this.renderPractice();
        el.practice.showModal();
      });
    }

    if (el.btnNextSet) {
      el.btnNextSet.addEventListener("click", () => {
        if (el.milestoneModal && typeof el.milestoneModal.close === "function") {
          el.milestoneModal.close();
        }
        this.sessionStartTime = Date.now();
        this.engine.next();
        if (el.input && !el.input.disabled) el.input.focus({ preventScroll: true });
      });
    }
  }

  showHomeHub() {
    this.renderHomeHub();
    if (this.el.homeHub) this.el.homeHub.hidden = false;
    if (this.el.stage) this.el.stage.hidden = true;
  }

  hideHomeHub() {
    if (this.el.homeHub) this.el.homeHub.hidden = true;
    if (this.el.stage) this.el.stage.hidden = false;
  }

  startQuickResume() {
    this.hideHomeHub();
    this.engine.next();
    if (this.activeClozeInput && document.body.contains(this.activeClozeInput)) {
      this.activeClozeInput.focus({ preventScroll: true });
    } else if (this.el.input && !this.el.input.disabled) {
      this.el.input.focus({ preventScroll: true });
    }
  }

  renderHomeHub() {
    const { el, store } = this;
    const deck = store.currentDeck;
    const route = this.routeController?.activeRoute || Routes.REFLEX;
    const routeLabel = ROUTE_LABELS[route] || "Speed Sprint";

    if (el.heroTitle) {
      el.heroTitle.textContent = `Resume ${deck?.name || "Drill"}: ${routeLabel}`;
    }
    const pool = store.pool();
    const streak = store.session.streak;
    if (el.heroMeta) {
      el.heroMeta.textContent = `${pool.length} card${pool.length === 1 ? "" : "s"} in queue · ${streak} streak`;
    }
    if (el.btnQuickResume) {
      el.btnQuickResume.textContent = `Resume ${routeLabel}`;
    }

    // Render deck cards in secondary browse grid
    if (el.homeDeckGrid) {
      const frag = document.createDocumentFragment();
      for (const id of store.deckIds()) {
        const d = store.getDeck(id);
        const card = document.createElement("div");
        card.className = "home-deck-card";
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-label", `Switch to ${d.name}`);
        const name = document.createElement("span");
        name.className = "home-deck-card__name";
        name.textContent = d.name;
        const meta = document.createElement("span");
        meta.className = "home-deck-card__meta";
        meta.textContent = `${d.cards.length} cards · ${d.lang || "general"}`;
        card.append(name, meta);
        card.addEventListener("click", () => {
          store.setDeck(id);
          const newDeck = store.currentDeck;
          if (!isNativeTypingCompatible(newDeck) && this.routeController.activeRoute === Routes.STRICT_PRODUCTION) {
            this.routeController.switchRoute(Routes.REFLEX);
          }
          this.startQuickResume();
        });
        frag.append(card);
      }
      el.homeDeckGrid.replaceChildren(frag);
    }
  }

  showMilestoneModal() {
    const elapsedSec = Math.max(1, (Date.now() - this.sessionStartTime) / 1000);
    const pace = (elapsedSec / Math.max(1, this.sessionCardsCleared)).toFixed(1);
    if (this.el.milestoneCards) this.el.milestoneCards.textContent = String(this.sessionCardsCleared);
    if (this.el.milestonePace) this.el.milestonePace.textContent = `${pace}s`;
    if (this.el.milestoneStreak) this.el.milestoneStreak.textContent = String(this.store.session.streak);
    if (this.el.milestoneModal && typeof this.el.milestoneModal.showModal === "function") {
      this.el.milestoneModal.showModal();
    }
  }

  bindServiceWorker() {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // Register service worker with cache-busting query parameter
    navigator.serviceWorker.register("./sw.js?v=3").catch(() => {});

    // Listen for controllerchange when a new service worker claims the client
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      // Notify the UI that an update has applied
      this.toast("SpeedRecall updated to latest version.");
      // Silently refresh active data references
      if (this.store) {
        this.store.init().then(() => {
          this.renderDeck();
          this.renderHomeHub();
        }).catch(() => {});
      }
    });
  }

  bindEngine() {
    const { el, engine, store } = this;

    engine.addEventListener("card", ({ detail: { card } }) => {
      this.audio.stopAll();
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

      // Lookahead queue buffering and audio playback
      const pool = store.pool();
      const currentIdx = pool.findIndex((c) => c.id === card.id);
      if (currentIdx !== -1) {
        this.audio.preloadQueue(pool, currentIdx, { stumbleQueue: this.store.stumbleQueue });
      }
      this.audio.playCurrent(card);

      // Dynamic cloze rendering vs standard prompt
      if (card.cloze) {
        document.body.classList.add("has-cloze");
        const { container, input: inlineInput } = renderCloze(card.cloze, {
          onInput: (_e, val) => {
            el.input.value = val;
            this.routeController.handleInput(val);
            engine.input(val);
          }
        });
        this.activeClozeInput = inlineInput;
        el.prompt.replaceChildren(container);
        el.prompt.dataset.size = "cloze";
        if (inlineInput) {
          inlineInput.addEventListener("compositionstart", (e) => this.routeController.handleCompositionStart(e));
          inlineInput.addEventListener("compositionupdate", (e) => this.routeController.handleCompositionUpdate(e));
          inlineInput.addEventListener("compositionend", (e) => this.routeController.handleCompositionEnd(e));
          inlineInput.addEventListener("keydown", (e) => {
            this.routeController.handleKeyDown(e);
            if (e.key === "Enter" && !e.isComposing && this.routeController.activeRoute !== Routes.STRICT_PRODUCTION) {
              e.preventDefault();
              engine.giveUp(inlineInput.value);
            }
          });
          if (!el.practice.open && !el.settings.open) inlineInput.focus({ preventScroll: true });
        }
      } else {
        const isClozeRoute = this.routeController.activeRoute === Routes.CONTEXT_CLOZE || this.routeController.activeRoute === Routes.VARIABLE_CLOZE;
        if (!isClozeRoute) {
          document.body.classList.remove("has-cloze");
        }
        this.activeClozeInput = null;
        el.prompt.textContent = card.prompt;
        el.prompt.dataset.size = sizeFor(card.prompt);
      }

      el.hint.textContent = card.subtitle || "";
      const defaultHintsOn = this.store.state.prefs.defaultShowHints !== false;
      const sessionHintsOn = this.sessionShowHints && defaultHintsOn;
      el.hint.hidden = !sessionHintsOn || !card.subtitle;
      this.updateStats();
      if (!card.cloze && !el.practice.open && !el.settings.open) el.input.focus({ preventScroll: true });
    });

    engine.addEventListener("visual-reinforcement", ({ detail: { canonical, duration = 220 } }) => {
      if (canonical && el.card) {
        el.card.classList.add("is-accent-flash");
        setTimeout(() => el.card.classList.remove("is-accent-flash"), duration);
      }
    });

    this.routeController.addEventListener("visual-reinforcement", ({ detail: { canonical, duration = 220 } }) => {
      if (canonical && el.card) {
        el.card.classList.add("is-accent-flash");
        setTimeout(() => el.card.classList.remove("is-accent-flash"), duration);
      }
    });

    engine.addEventListener("correct", ({ detail }) => {
      this.audio.stopAll();
      const currentCard = engine.card || detail?.card;
      if (currentCard) {
        this.audio.clearStumbled(currentCard);
      }
      if (this.activeClozeInput && document.body.contains(this.activeClozeInput)) {
        this.activeClozeInput.classList.remove("is-correcting");
      }
      el.card.classList.add("is-correct", "is-accent-flash");
      el.cardBadge.textContent = "✓";
      setTimeout(() => el.card.classList.remove("is-accent-flash"), 220);

      this.sessionCardsCleared++;
      if (this.sessionCardsCleared > 0 && this.sessionCardsCleared % 15 === 0) {
        this.showMilestoneModal();
      }
    });

    engine.addEventListener("miss", ({ detail }) => {
      this.audio.stopAll();
      const failedCard = engine.card || detail?.card;
      if (failedCard) {
        this.audio.retainStumbled(failedCard);
      }
      el.card.classList.add("is-miss");
      el.cardBadge.textContent = "✕";
      el.answer.textContent = detail?.answer || "";
      el.reveal.hidden = false;
      el.input.value = "";
      el.input.placeholder = "Type it to continue";
      el.input.classList.add("is-correcting");
      el.btnReveal.disabled = true;
      if (this.activeClozeInput && document.body.contains(this.activeClozeInput)) {
        this.activeClozeInput.value = "";
        this.activeClozeInput.classList.add("is-correcting");
        this.activeClozeInput.placeholder = "";
        this.activeClozeInput.focus({ preventScroll: true });
      }
      this.missCount++;
      if (this.missCount <= 3) el.helpLine.textContent = "Type the answer shown to move on.";
    });


    engine.addEventListener("corrected", () => {
      if (engine.card) {
        this.audio.clearStumbled(engine.card);
      }
      el.card.classList.remove("is-miss");
      el.card.classList.add("is-correct");
      el.cardBadge.textContent = "✓";
      if (this.activeClozeInput && document.body.contains(this.activeClozeInput)) {
        this.activeClozeInput.classList.remove("is-correcting");
      }
      if (this.missCount <= 3) el.helpLine.textContent = "Enter or Reveal shows the answer.";
    });

    engine.addEventListener("nudge", () => {
      const activeInput = (this.activeClozeInput && document.body.contains(this.activeClozeInput))
        ? this.activeClozeInput
        : el.input;
      activeInput.classList.remove("nudge");
      void activeInput.offsetWidth;
      activeInput.classList.add("nudge");
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
    if (this.el.sensoryHudText) {
      this.el.sensoryHudText.textContent = `${streak} streak · ${this.store.pool().length} cards`;
    }
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

  /* ---------------- sheets & modals ---------------- */

  bindSheets() {
    const { el, engine } = this;
    const open = (dlg, render) => {
      if (!dlg) return;
      if (typeof render === "function") render();
      if (typeof dlg.showModal === "function") dlg.showModal();
    };

    el.btnPractice?.addEventListener("click", () => open(el.practice, () => this.renderPractice()));
    el.btnSettings?.addEventListener("click", () => open(el.settings, () => this.renderSettings()));

    for (const dlg of [el.practice, el.settings, el.newDeckModal]) {
      if (!dlg) continue;
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
      });
      dlg.addEventListener("close", () => el.input?.focus({ preventScroll: true }));
    }

    el.deckSelect?.addEventListener("change", () => {
      this.store.setDeck(el.deckSelect.value);
      const deck = this.store.currentDeck;
      if (!isNativeTypingCompatible(deck) && this.routeController.activeRoute === Routes.STRICT_PRODUCTION) {
        this.routeController.switchRoute(Routes.REFLEX);
      }
      this.renderPractice();
    });

    el.modeSelect?.addEventListener("change", () => this.store.setMode(el.modeSelect.value));

    if (el.routeSelect) {
      el.routeSelect.addEventListener("change", () => this.routeController.switchRoute(el.routeSelect.value));
    }

    // Module 2: Bidirectional Role Matrix
    if (el.roleFrontSelect && el.roleBackSelect) {
      el.roleFrontSelect.addEventListener("change", () => {
        this.engine.setRoles(el.roleFrontSelect.value, el.roleBackSelect.value);
      });
      el.roleBackSelect.addEventListener("change", () => {
        this.engine.setRoles(el.roleFrontSelect.value, el.roleBackSelect.value);
      });
      el.btnRoleSwapModal?.addEventListener("click", () => {
        const temp = el.roleFrontSelect.value;
        el.roleFrontSelect.value = el.roleBackSelect.value;
        el.roleBackSelect.value = temp;
        this.engine.setRoles(el.roleFrontSelect.value, el.roleBackSelect.value);
      });
    }

    // Module 2: Session Hint Control
    if (el.sessionShowHints) {
      el.sessionShowHints.addEventListener("change", () => {
        this.sessionShowHints = el.sessionShowHints.checked;
        if (el.hint && this.engine.card) {
          el.hint.hidden = !this.sessionShowHints || !this.engine.card.subtitle;
        }
      });
    }

    // Module 3: Active Drill Staging & In-Drill Header Toggles
    if (el.btnHintToggle) {
      el.btnHintToggle.addEventListener("click", () => {
        if (!this.engine.card) return;
        el.hint.hidden = !el.hint.hidden;
      });
    }

    if (el.btnRoleFlip) {
      el.btnRoleFlip.addEventListener("click", () => {
        this.engine.flipRoles();
        if (el.roleFrontSelect && el.roleBackSelect) {
          el.roleFrontSelect.value = this.engine.activePromptRole;
          el.roleBackSelect.value = this.engine.activeTargetRole;
        }
        this.toast("Flipped Front ⇄ Back");
      });
    }

    // Desktop Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      if (el.stage.hidden) return;
      if (e.key === "Tab") {
        e.preventDefault();
        this.engine.flipRoles();
        if (el.roleFrontSelect && el.roleBackSelect) {
          el.roleFrontSelect.value = this.engine.activePromptRole;
          el.roleBackSelect.value = this.engine.activeTargetRole;
        }
        this.toast("Flipped Front ⇄ Back");
      } else if (
        (e.key === "h" || e.key === "H") &&
        (e.altKey || (document.activeElement !== el.input && document.activeElement !== this.activeClozeInput))
      ) {
        if (this.engine.card) {
          e.preventDefault();
          el.hint.hidden = !el.hint.hidden;
        }
      }
    });

    el.btnAll?.addEventListener("click", () => {
      this.store.setUnits(this.store.allUnitKeys());
      this.renderUnits();
    });

    el.btnNone?.addEventListener("click", () => {
      this.store.setUnits([]);
      this.renderUnits();
    });

    el.btnDeleteDeck?.addEventListener("click", () => {
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
    if (!el.deckSelect) return;
    el.deckSelect.replaceChildren(
      ...store.deckIds().map((id) => new Option(store.getDeck(id).name, id, false, id === store.currentDeckId))
    );
    const deck = store.currentDeck;
    if (el.modeSelect) {
      el.modeSelect.replaceChildren(
        ...modesForDeck(deck).map((m) => new Option(m.label, m.value, false, m.value === store.mode))
      );
    }
    if (el.routeSelect) {
      const allowedRoutes = routesForDeck(deck);
      const isAllowed = allowedRoutes.some((r) => r.value === this.routeController.activeRoute);
      if (!isAllowed) {
        this.routeController.switchRoute(Routes.REFLEX);
      }
      el.routeSelect.replaceChildren(
        ...allowedRoutes.map((r) => new Option(r.label, r.value, false, r.value === this.routeController.activeRoute))
      );
    }

    if (el.roleFrontSelect && el.roleBackSelect) {
      el.roleFrontSelect.value = this.engine.activePromptRole || "script";
      el.roleBackSelect.value = this.engine.activeTargetRole || "phonetic";
    }

    if (el.sessionShowHints) {
      el.sessionShowHints.checked = this.sessionShowHints;
    }

    if (el.btnDeleteDeck) {
      el.btnDeleteDeck.hidden = !deck || deck.builtIn;
    }
    this.renderUnits();
  }

  renderUnits() {
    const { el, store } = this;
    if (!el.unitList) return;
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
    if (!this.el.btnStart) return;
    const n = this.store.pool().length;
    this.el.btnStart.textContent = n ? `Start · ${n} card${n === 1 ? "" : "s"}` : "Choose at least one unit";
    this.el.btnStart.disabled = n === 0;
  }

  /* ---------------- Module 1: The 4-Tab Settings Hub ---------------- */

  switchSettingsTab(tabId) {
    const tabs = [
      { btn: this.el.tabDecks, panel: this.el.panelDecks, id: "tabDecks" },
      { btn: this.el.tabBackup, panel: this.el.panelBackup, id: "tabBackup" },
      { btn: this.el.tabSync, panel: this.el.panelSync, id: "tabSync" },
      { btn: this.el.tabOptions, panel: this.el.panelOptions, id: "tabOptions" }
    ];

    for (const t of tabs) {
      if (!t.btn || !t.panel) continue;
      const isActive = t.id === tabId;
      t.btn.setAttribute("aria-selected", String(isActive));
      t.btn.classList.toggle("is-active", isActive);
      t.panel.hidden = !isActive;
    }

    if (tabId === "tabDecks") this.renderSettingsDecks();
    if (tabId === "tabBackup") this.renderSettingsBackup();
  }

  renderSettings() {
    this.renderSettingsDecks();
    this.renderSettingsBackup();

    const { el, sync, store } = this;
    if (el.ghToken) el.ghToken.value = sync.config.token || "";
    if (el.ghRepo) el.ghRepo.value = sync.config.repo || "";
    if (el.ghPath) el.ghPath.value = sync.config.filePath || "reflex-data.json";
    const last = store.state.sync.lastSynced;
    if (el.syncStatus) {
      el.syncStatus.textContent = last ? `Last synced ${timeAgo(last)}` : "";
      el.syncStatus.className = "status";
    }

    if (el.optDefaultHints) {
      el.optDefaultHints.checked = store.state.prefs.defaultShowHints !== false;
    }
    if (el.optDefaultStrictness) {
      el.optDefaultStrictness.value = store.state.prefs.defaultStrictness || "standard";
    }
  }

  renderSettingsDecks() {
    const { el, store } = this;
    if (!el.settingsDeckSelect) return;

    el.settingsDeckSelect.replaceChildren(
      ...store.deckIds().map((id) => new Option(store.getDeck(id).name, id, false, id === store.currentDeckId))
    );

    const deck = store.currentDeck;
    if (el.deckSummaryName) el.deckSummaryName.textContent = deck?.name || "No deck selected";
    if (el.deckSummaryOrigin) {
      el.deckSummaryOrigin.textContent = deck?.builtIn ? "Built-in deck" : "Custom deck";
      el.deckSummaryOrigin.className = deck?.builtIn ? "badge" : "badge badge--custom";
    }
    if (el.deckSummaryMetrics) {
      const cards = deck?.cards || [];
      const units = new Set(cards.map(unitKey)).size;
      const mastery = Math.round(store.unitMastery(cards) * 100);
      el.deckSummaryMetrics.textContent = `${cards.length} cards · ${units} unit${units === 1 ? "" : "s"} · ${mastery}% mastered`;
    }
  }

  renderSettingsBackup() {
    const { el, store } = this;
    const totalDecks = store.deckIds().length;
    const builtInCount = store.builtInOrder.length;
    const customCount = Object.keys(store.state.customDecks).length;
    let totalCards = 0;
    for (const id of store.deckIds()) {
      totalCards += (store.getDeck(id)?.cards || []).length;
    }
    const practicedCount = Object.keys(store.state.progress).length;

    if (el.backupDeckCount) el.backupDeckCount.textContent = String(totalDecks);
    if (el.backupDeckBreakdown) el.backupDeckBreakdown.textContent = `${builtInCount} built-in · ${customCount} custom`;
    if (el.backupTotalCards) el.backupTotalCards.textContent = String(totalCards);
    if (el.backupPracticedCount) el.backupPracticedCount.textContent = String(practicedCount);
  }

  bindSettings() {
    const { el } = this;

    // Tabs
    el.tabDecks?.addEventListener("click", () => this.switchSettingsTab("tabDecks"));
    el.tabBackup?.addEventListener("click", () => this.switchSettingsTab("tabBackup"));
    el.tabSync?.addEventListener("click", () => this.switchSettingsTab("tabSync"));
    el.tabOptions?.addEventListener("click", () => this.switchSettingsTab("tabOptions"));

    // Panel A: Decks
    el.settingsDeckSelect?.addEventListener("change", () => {
      this.store.setDeck(el.settingsDeckSelect.value);
      this.renderSettingsDecks();
      this.renderPractice();
    });

    el.btnNewDeckModal?.addEventListener("click", () => this.openTabularDeckBuilder(null));

    el.btnExportDeck?.addEventListener("click", () => {
      const deck = this.store.currentDeck;
      if (!deck) return;
      const slug = (deck.name || "deck").toLowerCase().replace(/\s+/g, "-");
      downloadJSON(deck, `${slug}.json`);
    });

    el.btnEditCards?.addEventListener("click", () => {
      const deck = this.store.currentDeck;
      if (!deck) return;
      this.openTabularDeckBuilder(deck);
    });

    el.btnImport?.addEventListener("click", () => {
      const { cards, errors } = parseTSV(el.importText.value);
      if (!cards.length) {
        this.toast(errors[0] || "Paste some cards first.", true);
        return;
      }
      this.store.addCards(this.store.currentDeckId, cards);
      el.importText.value = "";
      const skipped = errors.length ? ` Skipped ${errors.length} line${errors.length === 1 ? "" : "s"} (${errors[0]})` : "";
      this.toast(`Added ${cards.length} card${cards.length === 1 ? "" : "s"}.${skipped}`, Boolean(errors.length));
      this.renderSettingsDecks();
      this.renderPractice();
    });

    // Panel B: Local Backup
    const date = () => new Date().toISOString().slice(0, 10);
    el.btnExportFull?.addEventListener("click", () => {
      downloadJSON(this.store.exportData(), `reflex-backup-${date()}.json`);
    });

    el.btnExportProgress?.addEventListener("click", () => {
      const data = {
        progress: this.store.state.progress,
        session: this.store.session,
        lastSynced: this.store.state.sync.lastSynced
      };
      downloadJSON(data, `reflex-progress-${date()}.json`);
    });

    el.importFile?.addEventListener("change", async () => {
      const file = el.importFile.files[0];
      el.importFile.value = "";
      if (!file) return;
      try {
        this.store.mergeData(await readJSONFile(file));
        this.toast("Backup restored and merged.");
        this.renderSettings();
        this.renderPractice();
      } catch (err) {
        this.toast(err.message, true);
      }
    });

    el.btnResetProgress?.addEventListener("click", () => {
      if (!confirmTap(el.btnResetProgress, "Tap again to erase all progress")) return;
      this.store.resetProgress();
      this.renderSettingsBackup();
      this.toast("Progress reset.");
    });

    // Panel C: GitHub Sync
    const saveSync = () =>
      this.sync.saveConfig({
        token: el.ghToken?.value.trim() || "",
        repo: el.ghRepo?.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "") || "",
        filePath: el.ghPath?.value.trim() || "reflex-data.json"
      });

    for (const f of [el.ghToken, el.ghRepo, el.ghPath]) f?.addEventListener("change", saveSync);

    el.btnTestSync?.addEventListener("click", async () => {
      saveSync();
      el.btnTestSync.disabled = true;
      el.syncStatus.className = "status";
      el.syncStatus.textContent = "Testing…";
      try {
        const info = await this.sync.testConnection();
        el.syncStatus.className = "status ok";
        el.syncStatus.textContent = `Connected: ${info.repo} (${info.branch})`;
      } catch (err) {
        el.syncStatus.className = "status error";
        el.syncStatus.textContent = err.message;
      } finally {
        el.btnTestSync.disabled = false;
      }
    });

    el.btnSync?.addEventListener("click", async () => {
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

    el.btnPublishDeck?.addEventListener("click", async () => {
      saveSync();
      el.btnPublishDeck.disabled = true;
      el.publishStatus.className = "status";
      el.publishStatus.textContent = "Publishing…";
      try {
        await this.sync.publishDeck(this.store.currentDeckId);
        el.publishStatus.className = "status ok";
        el.publishStatus.textContent = "Deck published to GitHub!";
      } catch (err) {
        el.publishStatus.className = "status error";
        el.publishStatus.textContent = err.message;
      } finally {
        el.btnPublishDeck.disabled = false;
      }
    });

    // Panel D: Options
    el.optDefaultHints?.addEventListener("change", () => {
      this.store.state.prefs.defaultShowHints = el.optDefaultHints.checked;
      this.store.save();
    });

    el.optDefaultStrictness?.addEventListener("change", () => {
      this.store.state.prefs.defaultStrictness = el.optDefaultStrictness.value;
      this.store.save();
    });
  }

  /* ---------------- Module 4: Tabular Deck Creator & Editor ---------------- */

  openTabularDeckBuilder(deckToEdit = null) {
    const { el } = this;
    if (!el.newDeckModal) return;

    if (deckToEdit) {
      this._editingDeckId = deckToEdit.id;
      if (el.newDeckTitle) el.newDeckTitle.textContent = `Edit Deck · ${deckToEdit.name}`;
      if (el.tabularDeckName) el.tabularDeckName.value = deckToEdit.name;
      if (el.tabularDeckLang) el.tabularDeckLang.value = deckToEdit.lang || "";
      if (el.tabularDeckPinyin) el.tabularDeckPinyin.checked = deckToEdit.romanization === "pinyin";
      this.renderGridRows(deckToEdit.cards || []);
    } else {
      this._editingDeckId = null;
      if (el.newDeckTitle) el.newDeckTitle.textContent = "Tabular Deck Builder";
      if (el.tabularDeckName) el.tabularDeckName.value = "";
      if (el.tabularDeckLang) el.tabularDeckLang.value = "";
      if (el.tabularDeckPinyin) el.tabularDeckPinyin.checked = false;
      this.renderGridRows([{ prompt: "", answer: "", subtitle: "", unit: "1" }]);
    }

    if (el.gridPasteArea) el.gridPasteArea.hidden = true;
    el.newDeckModal.showModal();
  }

  renderGridRows(cards = []) {
    const { el } = this;
    if (!el.deckGridTbody) return;
    el.deckGridTbody.replaceChildren();
    for (const card of cards) {
      this.addGridRow(card);
    }
  }

  addGridRow(card = { prompt: "", answer: "", subtitle: "", unit: "1" }) {
    const { el } = this;
    if (!el.deckGridTbody) return;

    const tr = document.createElement("tr");

    // 1. Prompt cell with auto-cloze detection
    const tdPrompt = document.createElement("td");
    const inputPrompt = document.createElement("input");
    inputPrompt.type = "text";
    inputPrompt.className = "grid-input grid-input--prompt";
    inputPrompt.value = card.prompt || "";
    inputPrompt.placeholder = "Prompt or cloze sentence";
    tdPrompt.appendChild(inputPrompt);

    // 2. Answer cell
    const tdAnswer = document.createElement("td");
    const inputAnswer = document.createElement("input");
    inputAnswer.type = "text";
    inputAnswer.className = "grid-input grid-input--answer";
    inputAnswer.value = card.answer || (card.answers ? card.answers[0] : "") || "";
    inputAnswer.placeholder = "Answer";
    tdAnswer.appendChild(inputAnswer);

    // Auto-Cloze extraction on typing
    inputPrompt.addEventListener("input", () => {
      const val = inputPrompt.value;
      const match = val.match(/\{\{([^}]+)\}\}/);
      if (match && !inputAnswer.value.trim()) {
        inputAnswer.value = match[1].trim();
      }
    });

    // 3. Hint cell
    const tdHint = document.createElement("td");
    const inputHint = document.createElement("input");
    inputHint.type = "text";
    inputHint.className = "grid-input grid-input--hint";
    inputHint.value = card.subtitle || "";
    inputHint.placeholder = "Hint";
    tdHint.appendChild(inputHint);

    // 4. Unit cell
    const tdUnit = document.createElement("td");
    const inputUnit = document.createElement("input");
    inputUnit.type = "text";
    inputUnit.className = "grid-input grid-input--unit";
    inputUnit.value = card.unit || "1";
    inputUnit.placeholder = "Unit";
    tdUnit.appendChild(inputUnit);

    // 5. Delete action
    const tdAction = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-delete-row";
    btnDel.textContent = "✕";
    btnDel.setAttribute("aria-label", "Delete row");
    btnDel.addEventListener("click", () => tr.remove());
    tdAction.appendChild(btnDel);

    tr.append(tdPrompt, tdAnswer, tdHint, tdUnit, tdAction);
    el.deckGridTbody.appendChild(tr);
  }

  bindTabularDeckBuilder() {
    const { el } = this;
    if (el.tabularDeckLang) {
      el.tabularDeckLang.replaceChildren(...LANGS.map(([v, l]) => new Option(l, v)));
      el.tabularDeckLang.addEventListener("change", () => {
        if (el.tabularDeckPinyin) el.tabularDeckPinyin.checked = el.tabularDeckLang.value === "zh";
      });
    }

    el.btnGridAddCard?.addEventListener("click", () => {
      const lastRow = el.deckGridTbody?.lastElementChild;
      const lastUnit = lastRow?.querySelector(".grid-input--unit")?.value || "1";
      this.addGridRow({ prompt: "", answer: "", subtitle: "", unit: lastUnit });
    });

    el.btnGridSplitUnits?.addEventListener("click", () => {
      const rows = el.deckGridTbody?.querySelectorAll("tr") || [];
      rows.forEach((row, idx) => {
        const unitInput = row.querySelector(".grid-input--unit");
        if (unitInput) {
          unitInput.value = `Unit ${Math.floor(idx / 10) + 1}`;
        }
      });
      this.toast(`Split ${rows.length} rows into batches of 10.`);
    });

    el.btnGridPasteTSV?.addEventListener("click", () => {
      if (el.gridPasteArea) el.gridPasteArea.hidden = !el.gridPasteArea.hidden;
      if (el.gridPasteText && !el.gridPasteArea.hidden) el.gridPasteText.focus();
    });

    el.btnGridCancelPaste?.addEventListener("click", () => {
      if (el.gridPasteArea) el.gridPasteArea.hidden = true;
    });

    el.btnGridApplyPaste?.addEventListener("click", () => {
      const text = el.gridPasteText?.value.trim() || "";
      if (!text) return;
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const cols = line.split("\t");
        let prompt = "", answer = "", hint = "", unit = "1";
        if (cols.length === 2) {
          [prompt, answer] = cols;
        } else if (cols.length === 3) {
          [prompt, answer, hint] = cols;
        } else if (cols.length === 4) {
          [prompt, answer, hint, unit] = cols;
        } else if (cols.length >= 5) {
          [, unit, prompt, hint, answer] = cols;
        }
        this.addGridRow({ prompt: prompt.trim(), answer: answer.trim(), subtitle: hint.trim(), unit: unit.trim() });
      }
      if (el.gridPasteText) el.gridPasteText.value = "";
      if (el.gridPasteArea) el.gridPasteArea.hidden = true;
    });

    el.btnGridSave?.addEventListener("click", () => {
      const name = el.tabularDeckName?.value.trim() || "";
      if (!name) {
        this.toast("Give the deck a name.", true);
        el.tabularDeckName?.focus();
        return;
      }

      const rows = el.deckGridTbody?.querySelectorAll("tr") || [];
      const cards = [];
      rows.forEach((row, i) => {
        const p = row.querySelector(".grid-input--prompt")?.value.trim() || "";
        const a = row.querySelector(".grid-input--answer")?.value.trim() || "";
        const h = row.querySelector(".grid-input--hint")?.value.trim() || "";
        const u = row.querySelector(".grid-input--unit")?.value.trim() || "1";
        if (p && a) {
          cards.push({
            id: `card-${i + 1}`,
            group: "General",
            unit: u,
            prompt: p,
            answer: a,
            answers: [a],
            subtitle: h,
            isCloze: p.includes("{{")
          });
        }
      });

      if (cards.length === 0) {
        this.toast("Add at least one card with a prompt and answer.", true);
        return;
      }

      const lang = el.tabularDeckLang?.value || "";
      const romanization = el.tabularDeckPinyin?.checked ? "pinyin" : "";

      if (this._editingDeckId && this.store.state.customDecks[this._editingDeckId]) {
        this.store.state.customDecks[this._editingDeckId].name = name;
        this.store.state.customDecks[this._editingDeckId].lang = lang;
        this.store.state.customDecks[this._editingDeckId].romanization = romanization;
        this.store.state.customDecks[this._editingDeckId].cards = cards;
        this.store.save();
        this.store.dispatchEvent(new CustomEvent("deck-updated"));
      } else {
        const deckId = this.store.createDeck({ name, lang, romanization }, cards);
        this.store.setDeck(deckId);
      }

      el.newDeckModal.close();
      this.toast(`Saved “${name}” with ${cards.length} cards.`);
      this.renderDeck();
      this.renderHomeHub();
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
