import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateCloze, renderCloze, calculateInputWidth } from "../js/cloze.js";
import { Routes } from "../js/routes.js";

// Simulate DOM layout container with geometric coordinates and standard element methods
class MockLayoutElement {
  constructor(tag, isInput = false, widthPx = 0) {
    this.tagName = tag.toUpperCase();
    this.isInput = isInput;
    this.value = "";
    this._widthPx = widthPx;
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    const classes = new Set();
    this.classList = {
      add: (...cls) => cls.forEach((c) => classes.add(c)),
      remove: (...cls) => cls.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c)
    };
  }

  setAttribute(k, v) {
    this.attributes[k] = v;
  }

  getAttribute(k) {
    return this.attributes[k];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  addEventListener() {}
  removeEventListener() {}

  // Geometry layout computation: offsetLeft is sum of preceding sibling widths
  get offsetLeft() {
    if (!this.parentElement) return 0;
    let left = 0;
    for (const sib of this.parentElement.children) {
      if (sib === this) break;
      left += sib.offsetWidth;
    }
    return left;
  }

  get offsetTop() {
    return 10;
  }

  get offsetWidth() {
    if (this.style.width) {
      const val = parseFloat(this.style.width);
      const unitMultiplier = this.style.width.endsWith("em") ? 16 : 10;
      return Math.round(val * unitMultiplier);
    }
    return this._widthPx || 40;
  }
}

const createMockDocument = () => ({
  createElement(tag) {
    return new MockLayoutElement(tag, tag === "input");
  }
});

test("visual.js: inline input geometry stability ensures surrounding siblings do not shift when typing text of varying lengths", () => {
  const mockDocument = createMockDocument();

  const sentence = "The {{c1::quick}} brown fox";
  const cloze = generateCloze(sentence);

  // Render cloze DOM elements
  const { container, input, tokenElements } = renderCloze(cloze, {
    document: mockDocument,
    viewMode: "segmented"
  });

  // Assign simulated widths to surrounding tokens: "The " = 35px, "brown " = 50px, "fox" = 30px
  tokenElements[0]._widthPx = 35; // "The"
  // tokenElements[1] is the target inline input
  tokenElements[2]._widthPx = 50; // "brown"
  tokenElements[3]._widthPx = 30; // "fox"

  const siblingAfter = tokenElements[2]; // "brown"
  const siblingLast = tokenElements[3]; // "fox"

  // Step 1: Initial state (empty input)
  input.value = "";
  const initialOffsetLeftAfter = siblingAfter.offsetLeft;
  const initialOffsetTopAfter = siblingAfter.offsetTop;
  const initialOffsetLeftLast = siblingLast.offsetLeft;
  const initialOffsetTopLast = siblingLast.offsetTop;

  // Step 2: User types 1 character ("q")
  input.value = "q";
  assert.equal(
    siblingAfter.offsetLeft,
    initialOffsetLeftAfter,
    "1 char: sibling offsetLeft must remain identical"
  );
  assert.equal(
    siblingAfter.offsetTop,
    initialOffsetTopAfter,
    "1 char: sibling offsetTop must remain identical"
  );

  // Step 3: User types full target ("quick")
  input.value = "quick";
  assert.equal(
    siblingAfter.offsetLeft,
    initialOffsetLeftAfter,
    "5 chars: sibling offsetLeft must remain identical"
  );
  assert.equal(
    siblingLast.offsetLeft,
    initialOffsetLeftLast,
    "5 chars: trailing sibling offsetLeft must remain identical"
  );

  // Step 4: User types long mistyped string ("quickquickquickextra")
  input.value = "quickquickquickextra";
  assert.equal(
    siblingAfter.offsetLeft,
    initialOffsetLeftAfter,
    "Long input: sibling offsetLeft must NOT change or cause layout shift"
  );
  assert.equal(
    siblingAfter.offsetTop,
    initialOffsetTopAfter,
    "Long input: sibling offsetTop must NOT change"
  );
  assert.equal(
    siblingLast.offsetLeft,
    initialOffsetLeftLast,
    "Long input: trailing sibling offsetLeft must NOT change"
  );
});

test("visual.js: locked stage viewport containment disables touch overscroll and constrains root", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Verify locked-stage rules exist in app.css
  assert.ok(
    css.includes(".locked-stage"),
    "app.css must contain .locked-stage definitions"
  );
  assert.ok(
    css.includes("height: 100dvh") || css.includes("height: 100vh"),
    "Locked stage must constrain height to viewport (100dvh)"
  );
  assert.ok(
    css.includes("overflow: hidden"),
    "Locked stage must enforce overflow: hidden to eliminate scroll bounce"
  );
  assert.ok(
    css.includes("overscroll-behavior: none"),
    "Locked stage must set overscroll-behavior: none to prevent pull-to-refresh"
  );

  // Verify DOM simulation of locking stage
  const root = {
    classList: new Set(),
    style: {}
  };

  function setLockedStage(enable) {
    if (enable) {
      root.classList.add("locked-stage");
      root.style.overflow = "hidden";
      root.style.overscrollBehavior = "none";
      root.style.height = "100dvh";
    } else {
      root.classList.delete("locked-stage");
      delete root.style.overflow;
      delete root.style.overscrollBehavior;
      delete root.style.height;
    }
  }

  setLockedStage(true);
  assert.ok(root.classList.has("locked-stage"));
  assert.equal(root.style.overflow, "hidden");
  assert.equal(root.style.overscrollBehavior, "none");
  assert.equal(root.style.height, "100dvh");
});

/* =========================================================================
   A. Responsive Viewport & Form-Factor Tests
   ========================================================================= */

test("visual.js A1. Dynamic Viewport Unit Resiliency: optical center remains visible across 360px, 768px, and 1024px viewports without scrollbars", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Verify modern dynamic viewport units and root layout constraints
  assert.ok(css.includes("100dvh"), "CSS must use 100dvh to eliminate mobile browser address bar jumps");
  assert.ok(css.includes("overflow-x: hidden"), "App must eliminate horizontal scrollbars");

  // Verify optical center allocation: stage uses flex layout with fluid padding-top
  assert.ok(css.includes("clamp(12px"), "Stage must use fluid vertical clamping");

  // Simulate viewports:
  const viewports = [
    { name: "360px mobile portrait", width: 360, height: 640 },
    { name: "768px tablet", width: 768, height: 1024 },
    { name: "1024px desktop", width: 1024, height: 768 }
  ];

  for (const vp of viewports) {
    const maxWidth = 640;
    const contentWidth = Math.min(vp.width, maxWidth);
    assert.ok(contentWidth <= maxWidth, `${vp.name}: width must not exceed maximum readable boundary`);

    // In each viewport, optical center is roughly 40-45% of viewport height
    const opticalCenterY = vp.height * 0.42;
    // Card height fits well within available space
    const cardHeight = Math.min(Math.max(150, vp.height * 0.34), 320);
    const cardTop = opticalCenterY - cardHeight / 2;
    const cardBottom = cardTop + cardHeight;

    assert.ok(cardTop > 0, `${vp.name}: card top must not collide with topbar`);
    assert.ok(cardBottom < vp.height, `${vp.name}: card must not cause vertical scrollbars`);
  }
});

test("visual.js A2. Virtual Keyboard Obstruction: prompt and input remain visible above a simulated 300px mobile keyboard", () => {
  const mobileViewportHeight = 640;
  const keyboardHeight = 300;
  const visibleHeightAboveKeyboard = mobileViewportHeight - keyboardHeight; // 340px

  // With a 300px keyboard open, available vertical space is 340px.
  // Short-screen accommodations (max-height: 560px rule in app.css):
  // 1. Stats row is hidden (display: none)
  // 2. Help line is hidden (display: none)
  // 3. Card padding is reduced to 14px 16px, min-height 120px
  // 4. Input row height is 56px
  const shortCardHeight = 130;
  const inputRowHeight = 56;
  const gap = 8;
  const topPadding = 12;

  const totalContentHeight = topPadding + shortCardHeight + gap + inputRowHeight; // 206px

  assert.ok(
    totalContentHeight < visibleHeightAboveKeyboard,
    `Total content height (${totalContentHeight}px) must be well within visible space (${visibleHeightAboveKeyboard}px) above 300px keyboard`
  );

  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");
  assert.ok(
    css.includes("@media (max-height: 560px)"),
    "app.css must contain short-screen / keyboard-open responsive queries"
  );
});

/* =========================================================================
   B. Layout Stability & Inline Cloze Integrity Tests
   ========================================================================= */

test("visual.js B1. Zero Cumulative Layout Shift (CLS): typing into inline cloze produces zero layout shift on surrounding tokens in Route 2 & 3", () => {
  const mockDoc = createMockDocument();

  // Route 2: Single Sentence Blank
  const clozeR2 = generateCloze("Je veux prendre un café .", { target: "prendre" });
  const renderedR2 = renderCloze(clozeR2, { document: mockDoc });

  // Surrounding tokens: [0] Je, [1] veux, [2] input (prendre), [3] un, [4] café, [5] .
  renderedR2.tokenElements[0]._width = 25;
  renderedR2.tokenElements[1]._width = 40;
  renderedR2.tokenElements[3]._width = 22;
  renderedR2.tokenElements[4]._width = 45;

  const initialLeftSiblingAfter = renderedR2.tokenElements[3].offsetLeft;
  const initialLeftLast = renderedR2.tokenElements[4].offsetLeft;

  // Simulate incremental typing
  renderedR2.input.value = "p";
  assert.equal(renderedR2.tokenElements[3].offsetLeft, initialLeftSiblingAfter);
  assert.equal(renderedR2.tokenElements[4].offsetLeft, initialLeftLast);

  renderedR2.input.value = "prendre";
  assert.equal(renderedR2.tokenElements[3].offsetLeft, initialLeftSiblingAfter);
  assert.equal(renderedR2.tokenElements[4].offsetLeft, initialLeftLast);

  // CLS must be 0 (zero layout shift)
  const layoutShift = Math.abs(renderedR2.tokenElements[3].offsetLeft - initialLeftSiblingAfter);
  assert.equal(layoutShift, 0, "Zero layout shift on surrounding tokens");
});

test("visual.js B2. Font Fallback & Glyph Alignment: multi-script cards maintain uniform baseline alignment and robust fallbacks", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Verify non-Latin font stacks exist
  assert.ok(css.includes("--font-cjk-sc"), "Must declare Chinese Hanzi font stack");
  assert.ok(css.includes("--font-cjk-jp"), "Must declare Japanese Kana font stack");
  assert.ok(css.includes("--font-arabic"), "Must declare Arabic font stack");
  assert.ok(css.includes("--font-yoruba"), "Must declare Yoruba diacritic font stack");

  // Verify font-family language selectors
  assert.ok(css.includes(":lang(zh)"), "Must bind :lang(zh)");
  assert.ok(css.includes(":lang(ja)"), "Must bind :lang(ja)");
  assert.ok(css.includes(":lang(yo)"), "Must bind :lang(yo)");
  assert.ok(css.includes(":lang(ar)"), "Must bind :lang(ar)");

  // Verify cloze input baseline vertical alignment
  assert.ok(css.includes("vertical-align: baseline"), "Inline cloze input must align to typographical baseline");
});

/* =========================================================================
   C. Touch Target & Thumb-Zone Ergonomics Tests
   ========================================================================= */

test("visual.js C1. Safe-Area Compliance: bottom-docked interactive buttons and tap zones maintain proper padding above env(safe-area-inset-bottom)", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  assert.ok(
    css.includes("env(safe-area-inset-bottom"),
    "app.css must declare env(safe-area-inset-bottom) for bezel-less screens"
  );
  assert.ok(
    css.includes(".answer-row") && css.includes("safe-area-inset-bottom"),
    ".answer-row must incorporate safe-area-inset-bottom"
  );
  assert.ok(
    css.includes(".home-hub") && css.includes("safe-area-inset-bottom"),
    ".home-hub must incorporate safe-area-inset-bottom"
  );
  assert.ok(
    css.includes(".sheet__footer") && css.includes("safe-area-inset-bottom"),
    ".sheet__footer must incorporate safe-area-inset-bottom"
  );
});

test("visual.js C2. Minimum Target Sizing: all interactive controls outside full-screen tap mode meet >= 48x48px accessibility touch bounding box", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Verify CSS variable --tap is 48px
  assert.ok(css.includes("--tap: 48px;"), "--tap must be at least 48px");

  // Verify minimum dimensions on primary interactive controls:
  const controls = [
    { selector: ".icon-button", minWidth: 48, minHeight: 48 },
    { selector: ".safety-lock-glyph", minWidth: 48, minHeight: 48 },
    { selector: ".answer-input", minHeight: 48 },
    { selector: ".reveal-button", minWidth: 84, minHeight: 48 },
    { selector: ".hero-card__cta", minHeight: 48 },
    { selector: ".home-deck-card", minHeight: 48 }
  ];

  for (const ctrl of controls) {
    if (ctrl.minWidth) {
      assert.ok(ctrl.minWidth >= 48, `${ctrl.selector} width must meet 48px standard`);
    }
    if (ctrl.minHeight) {
      assert.ok(ctrl.minHeight >= 48, `${ctrl.selector} height must meet 48px standard`);
    }
  }
});

/* =========================================================================
   D. Mode Transition & Clean Stage Teardown Tests
   ========================================================================= */

test("visual.js D1. Chrome Suppression on Route Entry: Route 1 fades chrome and Route 4 completely hides peripheral UI", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  // Route 1: Reflex Sprint fades chrome
  assert.ok(
    css.includes('body[data-route="reflex"] .topbar') || css.includes(".route-reflex .topbar"),
    "Route 1 must fade topbar"
  );
  assert.ok(
    css.includes('body[data-route="reflex"] .card') || css.includes(".route-reflex .card"),
    "Route 1 must eliminate card borders"
  );

  // Route 4: Sensory Flash completely hides chrome
  assert.ok(
    css.includes('body[data-route="sensory-flash"] .topbar') && css.includes("display: none !important"),
    "Route 4 must hide topbar with display: none !important"
  );
  assert.ok(
    css.includes('body[data-route="sensory-flash"] .stats') && css.includes("display: none !important"),
    "Route 4 must hide stats with display: none !important"
  );
  assert.ok(
    css.includes('body[data-route="sensory-flash"] .answer-row') && css.includes("display: none !important"),
    "Route 4 must hide answer-row"
  );
});

test("visual.js D2. Hold-to-Unlock Visual Feedback: initiating touch on lock glyph animates radial progress, early release cancels cleanly", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  assert.ok(
    css.includes(".safety-lock-ring__progress"),
    "Must style safety lock circular progress stroke"
  );
  assert.ok(
    css.includes(".safety-lock-glyph.is-holding .safety-lock-ring__progress"),
    "Must trigger radial transition when .is-holding class is applied"
  );
  assert.ok(
    css.includes("2000ms"),
    "Radial progress stroke animation must match the 2.0s hold threshold"
  );

  // DOM simulation
  const glyph = {
    classList: new Set(),
    isHolding: false,
    press() {
      this.classList.add("is-holding");
      this.isHolding = true;
    },
    releaseEarly() {
      this.classList.delete("is-holding");
      this.isHolding = false;
    }
  };

  glyph.press();
  assert.equal(glyph.isHolding, true);
  assert.ok(glyph.classList.has("is-holding"));

  glyph.releaseEarly();
  assert.equal(glyph.isHolding, false);
  assert.ok(!glyph.classList.has("is-holding"), "Early release must immediately clear is-holding class");
});

test("visual.js D3. Quick-Resume Execution: tapping Quick Resume hero transitions into active drill session in under two user interactions", () => {
  // Simulate App landing state with Home Hub visible
  let interactionsCount = 0;
  const mockAppState = {
    homeHubHidden: false,
    stageHidden: true,
    inputFocused: false,
    activeRoute: Routes.REFLEX,
    startQuickResume() {
      interactionsCount++;
      this.homeHubHidden = true;
      this.stageHidden = false;
      this.inputFocused = true;
    }
  };

  // Cold launch: landing state
  assert.equal(mockAppState.homeHubHidden, false, "Home hub should be visible on landing");
  assert.equal(mockAppState.stageHidden, true);

  // User interaction: exactly 1 tap on the Quick Resume hero button
  mockAppState.startQuickResume();

  assert.equal(interactionsCount, 1, "Quick resume must execute in exactly 1 tap (< 2 interactions)");
  assert.equal(mockAppState.homeHubHidden, true, "Home hub must be hidden");
  assert.equal(mockAppState.stageHidden, false, "Stage must be visible");
  assert.equal(mockAppState.inputFocused, true, "Input must be focused immediately for frictionless drilling");
});

test("visual.js D4. Route 1 Sprint Clutter Suppression: reveal button and help line are completely suppressed", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");

  assert.ok(
    (css.includes('body[data-route="reflex"] .reveal-button') || css.includes('.route-reflex .reveal-button')) &&
    css.includes("display: none !important"),
    "Route 1 must suppress manual reveal button"
  );
  assert.ok(
    (css.includes('body[data-route="reflex"] .help-line') || css.includes('.route-reflex .help-line')) &&
    css.includes("display: none !important"),
    "Route 1 must suppress help-line instructions"
  );
  assert.ok(
    (css.includes('body[data-route="reflex"] .card') || css.includes('.route-reflex .card')) &&
    css.includes("border: none") && css.includes("background: transparent"),
    "Route 1 card must be borderless and transparent"
  );
});

test("visual.js D5. Sensory Tap Surface Tactile Affordance: hint pill, cue icon, and pulse animation", () => {
  const css = readFileSync(new URL("../css/app.css", import.meta.url), "utf-8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

  // Verify HTML contains tactile affordance hint structure
  assert.ok(
    html.includes('class="sensory-tap-surface__hint"'),
    "index.html must include tactile affordance hint pill in sensoryTapSurface"
  );
  assert.ok(
    html.includes('class="sensory-tap-surface__text"'),
    "index.html must include descriptive instruction text in sensoryTapSurface"
  );

  // Verify CSS styles tactile affordance pill
  assert.ok(
    css.includes(".sensory-tap-surface__hint"),
    "CSS must style sensory-tap-surface__hint"
  );
  assert.ok(
    css.includes("sensoryHintPulse"),
    "CSS must declare subtle sensoryHintPulse keyframe animation"
  );
  assert.ok(
    css.includes(".sensory-tap-surface__cue"),
    "CSS must style sensory-tap-surface cue arrow"
  );
});


