/**
 * js/github-sync.js — one-button sync through a file in your own GitHub repo.
 *
 * Sync = pull the remote file (if any) → merge into local → push the merged
 * result. Merging never deletes cards; for progress the most recent wins.
 * Uses the repo's default branch.
 */

const CONFIG_KEY = "speedrecall_github_sync_cfg_v1";

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubSync {
  constructor(store) {
    this.store = store;
    this.config = { token: "", repo: "", filePath: "speedrecall-data.json" };
    try {
      Object.assign(this.config, JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"));
    } catch {
      /* ignore */
    }
  }

  saveConfig(cfg) {
    Object.assign(this.config, cfg);
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    } catch {
      /* ignore */
    }
  }

  get configured() {
    return Boolean(this.config.token && /^[\w.-]+\/[\w.-]+$/.test(this.config.repo) && this.config.filePath);
  }

  #url() {
    const path = this.config.filePath.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${this.config.repo}/contents/${path}`;
  }

  #headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.config.token.trim()}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  async #explain(res) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return "GitHub rejected the token. Check it hasn't expired.";
    if (res.status === 403) return "The token can't access this repo. It needs Contents: read and write.";
    if (res.status === 404) return "Repo not found. Check the owner/repo name and that the token can see it.";
    return body.message || `GitHub error ${res.status}`;
  }

  async testConnection(customToken, customRepo) {
    const token = (customToken || this.config.token || "").trim();
    const repo = (customRepo || this.config.repo || "").trim();
    if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error("Provide a valid token and repository in 'owner/repo' format.");
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("You're offline.");

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(await this.#explain(res));
    const info = await res.json();
    return {
      repo: info.full_name,
      private: Boolean(info.private),
      branch: info.default_branch || "main",
      description: info.description || ""
    };
  }

  async sync(attempt = 0) {
    if (!this.configured) throw new Error("Add a token and repo (owner/repo) first.");
    if (!navigator.onLine) throw new Error("You're offline.");

    // 1. Pull
    const getRes = await fetch(this.#url(), { headers: this.#headers(), cache: "no-store" });
    let sha;
    if (getRes.ok) {
      const file = await getRes.json();
      sha = file.sha;
      const remote = JSON.parse(decodeBase64(file.content));
      const firstSyncHere = !this.store.state.sync.lastSynced;
      this.store.mergeData(remote, { adoptPrefs: firstSyncHere });
    } else if (getRes.status !== 404) {
      throw new Error(await this.#explain(getRes));
    } else {
      // 404 is either "file not created yet" or "repo not visible" — check which
      const repoRes = await fetch(`https://api.github.com/repos/${this.config.repo}`, { headers: this.#headers() });
      if (!repoRes.ok) throw new Error(await this.#explain(repoRes));
    }

    // 2. Push merged state
    const body = {
      message: `SpeedRecall sync ${new Date().toISOString()}`,
      content: encodeBase64(JSON.stringify(this.store.exportData()))
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(this.#url(), {
      method: "PUT",
      headers: { ...this.#headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if ((putRes.status === 409 || putRes.status === 422) && attempt === 0) {
      // Someone else pushed in between — pull and merge again
      return this.sync(1);
    }
    if (!putRes.ok) throw new Error(await this.#explain(putRes));

    this.store.state.sync.lastSynced = Date.now();
    this.store.save();
    return this.store.state.sync.lastSynced;
  }

  /**
   * Publishes a deck as data/<deckId>.json and registers it in data/manifest.json
   * on the specified GitHub repository.
   */
  async publishDeckToRepo(deck, customToken, customRepo) {
    const token = (customToken || this.config.token || "").trim();
    const repo = (customRepo || this.config.repo || "").trim();
    if (!token || !repo) throw new Error("A GitHub token with Contents write access and repo (owner/repo) are required.");
    if (!navigator.onLine) throw new Error("You're offline.");

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const filename = `${deck.id}.json`;
    const deckUrl = `https://api.github.com/repos/${repo}/contents/data/${filename}`;
    const manifestUrl = `https://api.github.com/repos/${repo}/contents/data/manifest.json`;

    // 1. Get current deck file sha if it exists
    let deckSha;
    const deckGet = await fetch(deckUrl, { headers, cache: "no-store" });
    if (deckGet.ok) {
      const file = await deckGet.json();
      deckSha = file.sha;
    }

    // 2. Prepare clean deck JSON without runtime-only fields
    const rawCards = deck.rawCards || deck.cards || [];
    const cleanDeck = {
      name: deck.name,
      lang: deck.lang || "",
      answerLang: deck.answerLang || "",
      romanization: deck.romanization || "",
      defaultMode: deck.defaultMode || "standard",
      cards: rawCards.map((c) => ({
        id: c.id,
        group: c.group || "General",
        unit: c.unit || "General",
        prompt: c.prompt,
        subtitle: c.subtitle || "",
        answer: c.answers?.[0] || c.answer || ""
      }))
    };

    // 3. PUT deck file
    const deckBody = {
      message: `Publish deck ${deck.name} (${deck.id}) via SpeedRecall`,
      content: encodeBase64(JSON.stringify(cleanDeck, null, 2))
    };
    if (deckSha) deckBody.sha = deckSha;

    const deckPut = await fetch(deckUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(deckBody)
    });
    if (!deckPut.ok) throw new Error(`Could not publish deck file: ${await this.#explain(deckPut)}`);

    // 4. Update manifest.json
    const manifestGet = await fetch(manifestUrl, { headers, cache: "no-store" });
    if (!manifestGet.ok) throw new Error(`Could not fetch data/manifest.json: ${await this.#explain(manifestGet)}`);
    const manifestFile = await manifestGet.json();
    const manifestSha = manifestFile.sha;
    const manifestData = JSON.parse(decodeBase64(manifestFile.content));

    const existingIndex = (manifestData.decks || []).findIndex((d) => d.id === deck.id);
    const manifestEntry = { id: deck.id, file: `./data/${filename}` };
    if (existingIndex >= 0) {
      manifestData.decks[existingIndex] = manifestEntry;
    } else {
      (manifestData.decks ||= []).push(manifestEntry);
    }

    const manifestBody = {
      message: `Add ${deck.name} to manifest.json via SpeedRecall`,
      content: encodeBase64(JSON.stringify(manifestData, null, 2)),
      sha: manifestSha
    };

    const manifestPut = await fetch(manifestUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(manifestBody)
    });
    if (!manifestPut.ok) throw new Error(`Could not update manifest.json: ${await this.#explain(manifestPut)}`);

    return true;
  }
}
