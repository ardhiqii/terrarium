/**
 * Popup: the pokedex. Terrarium companion, item drawer, repo creatures.
 * Loaded as a plain script after common/core.js (see popup.html), sharing
 * the `window.GardenCreatures` namespace the same way the content script
 * does. This file only ever runs inside the extension's own popup page, so
 * it is free to use fetch/DOM APIs without any "don't touch the host page"
 * caveat, unlike content.js.
 */
;(function () {
  'use strict'

  const GC = window.GardenCreatures
  const els = {
    handleForm: document.getElementById('gc-handle-form'),
    handleInput: document.getElementById('gc-handle'),
    status: document.getElementById('gc-status'),
    main: document.getElementById('gc-main'),
    sprite: document.getElementById('gc-sprite'),
    name: document.getElementById('gc-name'),
    blurb: document.getElementById('gc-blurb'),
    xpFill: document.getElementById('gc-xpbar-fill'),
    xpLabel: document.getElementById('gc-xp-label'),
    itemsSection: document.getElementById('gc-items-section'),
    items: document.getElementById('gc-items'),
    reposSection: document.getElementById('gc-repos-section'),
    repos: document.getElementById('gc-repos'),
    settingsForm: document.getElementById('gc-settings-form'),
    apiBaseInput: document.getElementById('gc-api-base'),
    debugInput: document.getElementById('gc-debug'),
    networkCount: document.getElementById('gc-network-count'),
    resetCount: document.getElementById('gc-reset-count'),
  }

  function setStatus(message, isError) {
    if (!message) {
      els.status.hidden = true
      return
    }
    els.status.hidden = false
    els.status.textContent = message
    els.status.classList.toggle('gc-error', Boolean(isError))
  }

  async function refreshNetworkCount() {
    const count = await GC.getNetworkCallCount()
    els.networkCount.textContent = String(count)
  }

  function applyReducedMotion(img) {
    if (!GC.prefersReducedMotion()) return
    img.addEventListener(
      'load',
      () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth || 64
          canvas.height = img.naturalHeight || 64
          canvas.className = img.className
          canvas.id = img.id
          const ctx = canvas.getContext('2d')
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(img, 0, 0)
          img.replaceWith(canvas)
        } catch {
          // Canvas freeze failed; leave the animated sprite as-is rather
          // than losing the creature entirely.
        }
      },
      { once: true }
    )
  }

  function renderMain(state) {
    els.main.hidden = false
    const url = GC.spriteUrl(state.stage && state.stage.id)
    els.sprite.src = url || ''
    applyReducedMotion(els.sprite)
    els.name.textContent = `${state.stage.name} (stage ${state.stage.index})`
    els.blurb.textContent = state.stage.blurb || ''
    const pct = Math.round((state.progress || 0) * 100)
    els.xpFill.style.width = `${pct}%`
    const into = state.xpIntoStage
    const forNext = state.xpForNextStage
    els.xpLabel.textContent =
      forNext === null
        ? `${state.totalXp} XP total (max stage)`
        : `${into} / ${forNext} XP into stage · ${state.totalXp} total`
  }

  function renderItems(items) {
    if (!items || items.length === 0) {
      els.itemsSection.hidden = true
      return
    }
    els.itemsSection.hidden = false
    els.items.innerHTML = ''
    for (const item of items) {
      const card = document.createElement('div')
      card.className = `gc-item${item.unlocked ? '' : ' locked'}`
      const name = document.createElement('div')
      name.className = 'gc-item-name'
      name.textContent = item.def.name
      const req = document.createElement('div')
      req.className = 'gc-item-req'
      req.textContent = item.unlocked
        ? 'Unlocked'
        : `${item.def.requirement} (${Math.round((item.progress || 0) * 100)}%)`
      card.appendChild(name)
      card.appendChild(req)
      els.items.appendChild(card)
    }
  }

  /**
   * Fetches the full repo objects (not just names): `language`, `size`,
   * `created_at`, `pushed_at` are exactly the characteristics
   * `GC.assignSpeciesLine` needs (mirrors `species-assign.ts`) to give each
   * repo its own species line, instead of every repo rendering the same
   * four creatures (the bug T19 exists to fix). Cached in the same
   * chrome.storage.local with the same TTL as creature data, so repeated
   * popup opens for the same handle don't re-list either.
   */
  async function fetchPublicRepos(user) {
    const cacheKey = `gc:cache:repolist:${user.toLowerCase()}`
    try {
      const cached = await new Promise((resolve) => {
        chrome.storage.local.get(cacheKey, (r) => resolve(r[cacheKey]))
      })
      if (cached && Date.now() - cached.fetchedAt < GC.CACHE_TTL_MS) {
        return cached.data
      }
    } catch {
      // fall through to network
    }

    try {
      const res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=10&sort=updated`
      )
      if (!res.ok) return []
      const json = await res.json()
      const repos = Array.isArray(json)
        ? json
            .filter((r) => !r.fork)
            .map((r) => ({
              name: r.name,
              language: r.language || null,
              createdAt: r.created_at || null,
              pushedAt: r.pushed_at || null,
              sizeKb: typeof r.size === 'number' ? r.size : null,
            }))
        : []
      try {
        chrome.storage.local.set({
          [cacheKey]: { data: repos, fetchedAt: Date.now() },
        })
      } catch {
        // best-effort
      }
      return repos
    } catch {
      return []
    }
  }

  async function renderRepos(user) {
    const repos = await fetchPublicRepos(user)
    if (repos.length === 0) {
      els.reposSection.hidden = true
      return
    }
    els.reposSection.hidden = false
    els.repos.innerHTML = ''

    const requests = repos.map((r) => ({ user, repo: r.name }))
    const results = await GC.getCreaturesBatched(requests)
    await refreshNetworkCount()

    for (let i = 0; i < repos.length; i++) {
      const result = results[i]
      if (!result || !result.data) continue
      const state = result.data
      const repo = repos[i]
      // The collection payoff: each repo's own species line, assigned
      // deterministically from its language (and age/size/cadence as a
      // fallback), so this list is not the same creature repeated with a
      // different name next to it. Prefers the server's own assignment
      // (`speciesLineId`, computed in api/creature/route.ts from the exact
      // same repo metadata) when present, and only falls back to computing
      // it locally from the repo list this popup already fetched when
      // talking to an older API that doesn't send the field yet.
      const line = state.speciesLineId
        ? GC.getSpeciesLine(state.speciesLineId)
        : GC.assignSpeciesLine(user, repo)

      const row = document.createElement('div')
      row.className = 'gc-repo-row'

      const url = GC.spriteUrl(state.stage && state.stage.id, line.id)
      const img = document.createElement('img')
      img.className = 'gc-repo-sprite'
      img.alt = ''
      img.src = url || ''
      applyReducedMotion(img)

      const name = document.createElement('span')
      name.className = 'gc-repo-name'
      name.textContent = repo.name

      const stage = document.createElement('span')
      stage.className = 'gc-repo-stage mono'
      stage.title = `${repo.language || 'unlabeled'} · ${line.id}`
      stage.textContent = `L${state.stage.index}`

      row.appendChild(img)
      row.appendChild(name)
      row.appendChild(stage)
      els.repos.appendChild(row)
    }
  }

  async function loadHandle(handle) {
    if (!handle) return
    setStatus('Loading...', false)
    els.main.hidden = true
    els.itemsSection.hidden = true
    els.reposSection.hidden = true

    const result = await GC.getCreature(handle)
    await refreshNetworkCount()

    if (!result.data) {
      setStatus(`Could not load a creature for "${handle}".`, true)
      return
    }
    setStatus('', false)
    renderMain(result.data)
    renderItems(result.data.items)
    renderRepos(handle)
  }

  async function init() {
    if (!GC) {
      setStatus('Extension core failed to load.', true)
      return
    }

    const settings = await GC.getSettings()
    els.apiBaseInput.value = settings.apiBase || GC.DEFAULT_API_BASE
    els.debugInput.checked = Boolean(settings.debug)
    els.handleInput.value = settings.handle || ''
    await refreshNetworkCount()

    els.handleForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const handle = els.handleInput.value.trim()
      await GC.setSettings({ handle })
      loadHandle(handle)
    })

    els.settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const apiBase = els.apiBaseInput.value.trim() || GC.DEFAULT_API_BASE
      const debug = els.debugInput.checked

      // Requesting a custom origin at runtime rather than hardcoding it in
      // the manifest keeps host_permissions minimal by default (see
      // manifest.json / report). Declared under optional_host_permissions
      // as "https://*/*", so this request only ever succeeds for origins
      // that pattern actually covers, and it is a no-op for http://localhost
      // which is already in the static host_permissions list.
      try {
        const url = new URL(apiBase)
        if (url.protocol === 'https:' && chrome.permissions && chrome.permissions.request) {
          await new Promise((resolve) => {
            chrome.permissions.request(
              { origins: [`${url.origin}/*`] },
              () => resolve()
            )
          })
        }
      } catch {
        // Invalid URL or permissions API unavailable; still save the
        // setting, fetches will just fail loudly enough via getCreature's
        // error path if the origin turns out to be wrong.
      }

      await GC.setSettings({ apiBase, debug })
      setStatus('Settings saved.', false)
      setTimeout(() => setStatus('', false), 1500)
    })

    els.resetCount.addEventListener('click', async () => {
      try {
        chrome.storage.local.set({ 'gc:debug:networkCallCount': 0 }, refreshNetworkCount)
      } catch {
        // no-op
      }
    })

    if (settings.handle) loadHandle(settings.handle)
  }

  init()
})()
