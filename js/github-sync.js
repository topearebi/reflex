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
}
