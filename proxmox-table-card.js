/*
 * Proxmox Table Card voor Home Assistant
 * Voor de integratie https://github.com/dougiteixeira/proxmoxve
 *
 * Vindt automatisch alle VM's (qemu_*) en containers (lxc_*) en toont ze
 * als tabel (desktop) of compacte blokken (telefoon), met start/stop-knoppen.
 * Ondersteunt ook entiteiten met een prefix, bv. sensor.pve_lxc_naam_105_status.
 *
 * Installatie:
 *   1. Kopieer dit bestand naar /config/www/proxmox-table-card.js
 *   2. Instellingen > Dashboards > ⋮ > Resources > Toevoegen
 *      URL: /local/proxmox-table-card.js   Type: JavaScript-module
 *   3. Kaart toevoegen:   type: custom:proxmox-table-card
 *
 * Opties (allemaal optioneel):
 *   title: Proxmox          # false = geen titelregel
 *   sort: name              # name | id | node | status (status = actieve bovenaan)
 *   hide_stopped: false
 *   show_ip: false          # IP-adres in de tweede regel
 *   include: [bookstack, 105]   # alleen deze (naam, id of entity-prefix)
 *   exclude: [remotepc]         # deze niet tonen
 *   confirm: true           # bevestiging vragen bij afsluiten/herstart/stop
 *   style: table            # table | bubble  (afgeronde bubble-look)
 */

const CARD_VERSION = "1.2.0";

const STATUS = {
  running: ["Actief", "ok"],
  stopped: ["Gestopt", "err"],
  paused: ["Gepauzeerd", "warn"],
  suspended: ["Slaapstand", "warn"],
  prelaunch: ["Opstarten", "info"],
  shutdown: ["Afsluiten", "warn"],
  "internal-error": ["Fout", "err"],
  "io-error": ["I/O-fout", "err"],
  "guest-panicked": ["Crash", "err"],
  watchdog: ["Watchdog", "err"],
  inmigrate: ["Migreren", "info"],
  postmigrate: ["Gemigreerd", "info"],
  finishmigrate: ["Migreren", "info"],
  "restore-vm": ["Herstellen", "info"],
  "save-vm": ["Opslaan", "info"],
  debug: ["Debug", "warn"],
  colo: ["COLO", "info"],
  online: ["Online", "ok"],
  offline: ["Offline", "err"],
  unavailable: ["Offline", "off"],
  unknown: ["Onbekend", "off"],
};

// Knoppen: [actie, icoon, kleurklasse, label, bevestigen?]
const ACTIONS = {
  start: ["mdi:play", "ok", "Starten", false],
  resume: ["mdi:play-pause", "ok", "Hervatten", false],
  shutdown: ["mdi:power", "warn", "Afsluiten?", true],
  reboot: ["mdi:restart", "info", "Herstarten?", true],
  stop: ["mdi:stop", "err", "Stoppen?", true],
  // node-acties
  start_all: ["mdi:play", "ok", "Alles starten?", true],
  stop_all: ["mdi:stop", "err", "Alles stoppen?", true],
  wake_on_lan: ["mdi:lan-pending", "ok", "Wake-on-LAN", false],
  wol: ["mdi:power", "ok", "Aanzetten", false],
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const num = (st) => {
  if (!st) return NaN;
  const v = parseFloat(st.state);
  return Number.isFinite(v) ? v : NaN;
};

const fmtDuration = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}u` : h ? `${h}u ${m}m` : `${m}m`;
};

class ProxmoxTableCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._sig = "";
    this._confirm = null; // { prefix, action, until }
    this._pending = {}; // prefix -> { action, from, until }
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
  }

  static getStubConfig() {
    return { title: "Proxmox", sort: "name" };
  }

  setConfig(config) {
    this._config = {
      title: "Proxmox",
      sort: "name",
      hide_stopped: false,
      show_ip: false,
      confirm: true,
      include: [],
      exclude: [],
      ...(config || {}),
    };
    this._sig = "";
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  connectedCallback() {
    // uptime en bevestigingen ververst zonder state-wijziging
    this._timer = setInterval(() => this._update(), 30000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    return 1 + (this._guests ? this._guests.length : 3);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 4 };
  }

  /* ---------------------------------------------------------- data */

  _discover() {
    const hass = this._hass;
    // Optionele prefix (bv. "pve_") vóór lxc_/qemu_ wordt in de entity-prefix meegenomen
    const re = /^sensor\.((?:.+?_)?(lxc|qemu)_.+?_(\d+))_status$/;
    const out = [];
    for (const id of Object.keys(hass.states)) {
      const m = id.match(re);
      if (!m) continue;
      const [, p, type, vmid] = m;
      const e = (s) => `sensor.${p}_${s}`;
      const g = {
        prefix: p,
        type, // lxc | qemu
        vmid,
        status: id,
        cpu: e("cpu_used"),
        mem: e("memory_used_percentage"),
        memUsed: e("memory_used"),
        disk: e("disk_used_percentage"),
        boot: e("last_boot"),
        node: e("node"),
        ip: e("ip_address"),
        locked: `binary_sensor.${p}_locked`,
        btn: {},
      };
      for (const a of Object.keys(ACTIONS)) {
        const b = `button.${p}_${a}`;
        if (hass.states[b]) g.btn[a] = b;
      }
      g.name = this._name(g);
      out.push(g);
    }
    return out;
  }

  _name(g) {
    const hass = this._hass;
    const reg = hass.entities && hass.entities[g.status];
    const dev = reg && reg.device_id && hass.devices ? hass.devices[reg.device_id] : null;
    let n = dev ? dev.name_by_user || dev.name : null;
    if (!n) {
      const st = hass.states[g.status];
      n = (st && st.attributes.friendly_name) || g.prefix;
      n = n.replace(/\s+status$/i, "");
    }
    n = n.replace(/^(lxc|qemu|vm|ct)\s*:?\s*/i, "").replace(/\s*\(\d+\)\s*$/, "");
    return n || g.prefix;
  }

  _filter(list) {
    const c = this._config;
    const match = (g, arr) =>
      arr.some((x) => {
        const s = String(x).toLowerCase();
        return g.name.toLowerCase().includes(s) || g.vmid === s || g.prefix === s;
      });
    let l = list;
    if (c.include && c.include.length) l = l.filter((g) => match(g, c.include));
    if (c.exclude && c.exclude.length) l = l.filter((g) => !match(g, c.exclude));
    if (c.hide_stopped) l = l.filter((g) => this._isOn(g));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      id: (a, b) => Number(a.vmid) - Number(b.vmid),
      node: (a, b) => this._nodeName(a).localeCompare(this._nodeName(b)) || a.name.localeCompare(b.name),
      status: (a, b) =>
        (this._isOn(a) ? 0 : 1) - (this._isOn(b) ? 0 : 1) || a.name.localeCompare(b.name),
    };
    return l.sort(by[c.sort] || by.name);
  }

  _isOn(g) {
    return this._state(g) === "running";
  }

  _sigIds() {
    return [];
  }

  _state(g) {
    const st = this._hass.states[g.status];
    return st ? st.state : "unavailable";
  }

  _nodeName(g) {
    const st = this._hass.states[g.node];
    return st && !["unknown", "unavailable"].includes(st.state) ? st.state : "";
  }

  _uptime(g) {
    if (!this._isOn(g)) return null;
    const st = this._hass.states[g.boot];
    if (!st) return null;
    const t = Date.parse(st.state);
    return Number.isNaN(t) ? null : fmtDuration((Date.now() - t) / 1000);
  }

  /* ------------------------------------------------------- update */

  _update() {
    if (!this._hass || !this._config) return;
    const now = Date.now();
    if (this._confirm && this._confirm.until < now) this._confirm = null;

    const all = this._discover();
    // pending opruimen zodra status verandert of na timeout
    for (const [p, pend] of Object.entries(this._pending)) {
      const g = all.find((x) => x.prefix === p);
      if (!g || pend.until < now || this._state(g) !== pend.from) delete this._pending[p];
    }
    this._guests = this._filter(all);

    const s = this._hass.states;
    const ids = [];
    for (const g of this._guests) ids.push(g.status, g.cpu, g.mem, g.disk, g.boot, g.node, g.ip, g.locked, ...(g.extra || []), ...Object.values(g.btn));
    ids.push(...this._sigIds());
    const sig = [
      JSON.stringify(this._config),
      Math.floor(now / 60000),
      JSON.stringify(this._confirm),
      Object.keys(this._pending).join(","),
      ids.map((i) => (s[i] ? s[i].state : "-")).join("|"),
    ].join("#");
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  /* ------------------------------------------------------- render */

  _metric(id, warn, alert, icon, running = true) {
    const v = running ? num(this._hass.states[id]) : NaN;
    const ic = `<ha-icon icon="${icon}"></ha-icon>`;
    if (Number.isNaN(v)) return `<div class="m dim" data-more="${esc(id)}">${ic}<span>–</span></div>`;
    const cls = v > alert ? "err" : v > warn ? "warn" : "ok";
    return `<div class="m" data-more="${esc(id)}" title="${esc(this._title(id))}">
        ${ic}<span>${v < 10 ? v.toFixed(1) : Math.round(v)}%</span>
        <div class="bar"><div class="${cls}" style="width:${Math.min(Math.max(v, 0), 100)}%"></div></div>
      </div>`;
  }

  _title(id) {
    const st = this._hass.states[id];
    return st ? st.attributes.friendly_name || id : id;
  }

  _buttons(g, acts, pend) {
    if (pend) return `<span class="busy"><ha-icon icon="mdi:loading"></ha-icon></span>`;
    return acts
          .filter((a) => !(this._confirm && this._confirm.prefix === g.prefix && this._confirm.action !== a))
          .map((a) => {
            const [icon, c, lbl] = ACTIONS[a];
            const conf = this._confirm && this._confirm.prefix === g.prefix && this._confirm.action === a;
            return `<button class="b ${c}${conf ? " confirm" : ""}" data-action="${a}" data-prefix="${esc(g.prefix)}"
                      title="${esc(lbl.replace("?", ""))}" aria-label="${esc(lbl.replace("?", ""))}">
                      <ha-icon icon="${icon}"></ha-icon>${conf ? `<span>${esc(lbl)}</span>` : ""}
                    </button>`;
          })
          .join("");
  }

  _row(g) {
    const s = this._hass.states;
    const state = this._state(g);
    const [label, cls] = STATUS[state] || [state, "off"];
    const running = state === "running";
    const node = this._nodeName(g);
    const up = this._uptime(g);
    const ipSt = s[g.ip];
    const ip = this._config.show_ip && ipSt && !["unknown", "unavailable"].includes(ipSt.state) ? ipSt.state : "";
    const locked = s[g.locked] && s[g.locked].state === "on";
    const pend = this._pending[g.prefix];

    // welke knoppen
    let acts = [];
    if (running) acts = ["shutdown", "reboot", "stop"];
    else if (["paused", "suspended"].includes(state)) acts = ["resume", "stop"];
    else acts = ["start"];
    acts = acts.filter((a) => g.btn[a]);

    const btns = this._buttons(g, acts, pend);

    const subParts = [];
    if (node) subParts.push(`<span><ha-icon icon="mdi:server"></ha-icon>${esc(node)}</span>`);
    subParts.push(`<span>${g.type === "lxc" ? "LXC" : "VM"} ${esc(g.vmid)}</span>`);

    return `
      <div class="row${running ? " on" : ""}" data-more="${esc(g.status)}">
        <div class="ic"><ha-icon icon="${g.type === "lxc" ? "mdi:package-variant-closed" : "mdi:monitor"}"></ha-icon></div>
        <div class="nm">${esc(g.name)}${locked ? ' <ha-icon class="lock" icon="mdi:lock" title="Vergrendeld"></ha-icon>' : ""}</div>
        <div class="sub"><b class="stt ${pend ? "info" : cls}">${pend ? "Bezig…" : esc(label)}</b>${subParts.join('<i class="dot"></i>')}${ip ? `<span class="ipx"><i class="dot"></i>${esc(ip)}</span>` : ""}${up ? `<span class="mob"><i class="dot"></i><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(up)}</span>` : ""}</div>
        <div class="st"><span class="pill ${pend ? "info" : cls}"><i></i>${pend ? "Bezig…" : esc(label)}</span></div>
        <div class="up" data-more="${esc(g.boot)}">${up ? esc(up) : '<span class="dim">–</span>'}</div>
        <div class="metrics">
          ${this._metric(g.cpu, 60, 85, "mdi:cpu-64-bit", running)}
          ${this._metric(g.mem, 60, 85, "mdi:memory", running)}
          ${this._metric(g.disk, 75, 90, "mdi:harddisk")}
        </div>
        <div class="acts">${btns}</div>
      </div>`;
  }

  _render() {
    const c = this._config;
    const list = this._guests;
    const nRun = list.filter((g) => this._isOn(g)).length;
    const title =
      c.title === false
        ? ""
        : `<div class="title"><span>${esc(c.title)}</span>
             <span class="count"><b class="ok"></b>${nRun} actief<b class="err"></b>${list.length - nRun} uit</span></div>`;

    const body = list.length
      ? `<div class="hdr"><span></span><span>Naam</span><span>Status</span><span>Uptime</span>
           <span>CPU</span><span>RAM</span><span>Disk</span><span class="r">Acties</span></div>
         ${list.map((g) => this._row(g)).join("")}`
      : `<div class="empty">Geen Proxmox VM's of containers gevonden.<br>
           <small>Verwacht entiteiten als <code>sensor.lxc_naam_105_status</code>.</small></div>`;

    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card class="${c.style === "bubble" ? "bubble" : ""}">${title}<div class="list">${body}</div></ha-card>`;
  }

  /* ------------------------------------------------------ events */

  _onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      e.stopPropagation();
      this._press(btn.dataset.prefix, btn.dataset.action);
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      this.dispatchEvent(
        new CustomEvent("hass-more-info", { detail: { entityId: more.dataset.more }, bubbles: true, composed: true })
      );
    }
  }

  _press(prefix, action) {
    const g = (this._guests || []).find((x) => x.prefix === prefix);
    if (!g || !g.btn[action]) return;
    const needsConfirm = this._config.confirm !== false && ACTIONS[action][3];
    const c = this._confirm;
    if (needsConfirm && !(c && c.prefix === prefix && c.action === action && c.until > Date.now())) {
      this._confirm = { prefix, action, until: Date.now() + 4000 };
      this._sig = "";
      this._update();
      clearTimeout(this._confirmTimer);
      this._confirmTimer = setTimeout(() => this._update(), 4100);
      return;
    }
    this._confirm = null;
    const short = ["start_all", "stop_all", "wake_on_lan", "wol"].includes(action);
    this._pending[prefix] = { action, from: this._state(g), until: Date.now() + (short ? 5000 : 60000) };
    if (short) setTimeout(() => this._update(), 5100);
    const ent = g.btn[action];
    const dom = ent.split(".")[0];
    if (dom === "button" || dom === "input_button") this._hass.callService(dom, "press", { entity_id: ent });
    else this._hass.callService(dom === "script" || dom === "switch" ? dom : "homeassistant", "turn_on", { entity_id: ent });
    this._sig = "";
    this._update();
  }
}

const STYLE = `
:host { display: block; }
ha-card { container-type: inline-size; padding: 12px; overflow: hidden; }
.title { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding: 2px 4px 10px; font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
.count { font-size: 12px; font-weight: 400; color: var(--secondary-text-color); display:flex; align-items:center; gap:6px; }
.count b { width:7px; height:7px; border-radius:50%; display:inline-block; margin-left:6px; }
.count b.ok { background: var(--success-color, #43a047); }
.count b.err { background: var(--error-color, #e53935); }

.hdr, .row {
  display: grid;
  grid-template-columns: 36px minmax(0,1fr) 92px 64px 68px 68px 68px 128px;
  grid-template-areas: "i n st up cpu mem disk a" "i sub st up cpu mem disk a";
  column-gap: 8px; align-items: center;
}
.hdr { grid-template-areas: ". n st up cpu mem disk a"; padding: 0 10px 6px;
  font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--secondary-text-color); }
.hdr span:nth-child(2){grid-area:n} .hdr span:nth-child(3){grid-area:st} .hdr span:nth-child(4){grid-area:up}
.hdr span:nth-child(5){grid-area:cpu;padding-left:6px} .hdr span:nth-child(6){grid-area:mem;padding-left:6px}
.hdr span:nth-child(7){grid-area:disk;padding-left:6px} .hdr .r{grid-area:a;text-align:right}

.row { padding: 8px 10px; margin-bottom: 6px; border-radius: 12px; cursor: pointer;
  background: rgba(127,127,127,.07); border: 1px solid var(--divider-color, rgba(127,127,127,.15));
  transition: background .15s; }
.row:last-child { margin-bottom: 0; }
.row:hover { background: rgba(127,127,127,.12); }

.ic { grid-area: i; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background: rgba(127,127,127,.12); color: var(--disabled-color, #9e9e9e); }
.row.on .ic { color: var(--success-color, #43a047); }
.ic ha-icon { --mdc-icon-size: 20px; }
.nm { grid-area: n; align-self: end; font-size: 14px; font-weight: 500; color: var(--primary-text-color);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm .lock { --mdc-icon-size: 14px; color: var(--warning-color, #fb8c00); }
.sub { grid-area: sub; align-self: start; font-size: 12px; color: var(--secondary-text-color);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub ha-icon, .m ha-icon { --mdc-icon-size: 13px; margin-right: 2px; vertical-align: -2px; }
.dot { display:inline-block; width:3px; height:3px; border-radius:50%; background: currentColor; opacity:.5; margin: 0 6px; vertical-align: 3px; }
.mob { display: none; }

.st { grid-area: st; }
.pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:2px 9px; border-radius:999px;
  white-space:nowrap; background: color-mix(in srgb, var(--c) 16%, transparent); color: var(--c); }
.pill i { width:7px; height:7px; border-radius:50%; background: var(--c); }
.ok   { --c: var(--success-color, #43a047); }
.err  { --c: var(--error-color, #e53935); }
.warn { --c: var(--warning-color, #fb8c00); }
.info { --c: var(--info-color, #039be5); }
.off  { --c: var(--disabled-color, #9e9e9e); }

.up { grid-area: up; font-size: 13px; color: var(--primary-text-color); padding: 4px 0; }
.metrics { display: contents; }
.m { font-size: 13px; color: var(--primary-text-color); padding: 4px 6px; border-radius: 8px; white-space: nowrap; }
.m:hover, .up:hover { background: rgba(127,127,127,.15); }
.m:nth-child(1){grid-area:cpu} .m:nth-child(2){grid-area:mem} .m:nth-child(3){grid-area:disk}
.m ha-icon { display: none; color: var(--secondary-text-color); }
.bar { height:4px; border-radius:2px; margin-top:3px; background: rgba(127,127,127,.22); overflow:hidden; }
.bar > div { height:100%; border-radius:2px; background: var(--c); transition: width .4s; }
.bar > div.ok { --c: var(--primary-color, #03a9f4); }
.dim { color: var(--secondary-text-color); }
.sub [data-more] { cursor: pointer; }
.sub [data-more]:hover { color: var(--primary-text-color); }
.upd { color: var(--info-color, #039be5); }

.summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-bottom: 14px; }
.sum { padding: 8px 10px; border-radius: 12px; cursor: pointer; background: rgba(127,127,127,.07);
  border: 1px solid var(--divider-color, rgba(127,127,127,.15)); transition: background .15s; min-width: 0; }
.sum:hover { background: rgba(127,127,127,.12); }
.sl { font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl ha-icon { --mdc-icon-size: 13px; margin-right: 3px; vertical-align: -2px; }
.sv { font-size: 20px; font-weight: 500; color: var(--primary-text-color); line-height: 1.3; }
.sv small { font-size: 12px; font-weight: 400; color: var(--secondary-text-color); margin-left: 1px; }
.sv.warnv { color: var(--warning-color, #fb8c00); }
.sum .bar { margin-top: 4px; }

.acts { grid-area: a; display:flex; justify-content:flex-end; align-items:center; gap:4px; min-width:0; }
.b { all: unset; box-sizing: border-box; height:32px; min-width:32px; border-radius:16px; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:4px; padding: 0 7px;
  color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); transition: background .15s, padding .15s; }
.b:hover { background: color-mix(in srgb, var(--c) 28%, transparent); }
.b:focus-visible { outline: 2px solid var(--c); outline-offset: 1px; }
.b ha-icon { --mdc-icon-size: 18px; }
.b.confirm { background: var(--c); color: #fff; padding: 0 12px 0 9px; font-size: 12px; font-weight: 500;
  white-space: nowrap; line-height: 1; flex-shrink: 0; }
.busy { height:32px; width:32px; display:inline-flex; align-items:center; justify-content:center; color: var(--info-color, #039be5); }
.busy ha-icon { animation: spin 1s linear infinite; --mdc-icon-size: 18px; }
@keyframes spin { to { transform: rotate(360deg); } }

.empty { padding: 16px; text-align:center; color: var(--secondary-text-color); }
.empty code { font-size: 12px; }

/* ---------- Telefoon / smalle kolom ---------- */
@container (max-width: 680px) {
  .hdr { display: none; }
  .row {
    grid-template-columns: 36px minmax(0,1fr) auto;
    grid-template-areas: "i n st" "i sub sub" "mx mx a";
    row-gap: 2px; padding: 10px 12px;
  }
  .up { display: none; }
  .mob { display: inline; }
  .ipx { display: none; }
  .metrics { display: flex; grid-area: mx; gap: 6px; margin: 6px 0 0 -6px; min-width: 0; }
  .metrics .m { flex: 1; min-width: 0; font-size: 12px; }
  .m ha-icon { display: inline-block; }
  .acts { margin-top: 6px; align-self: end; }
  .summary { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .sum { grid-column: span 2; }
  .sum:nth-child(n+4) { grid-column: span 3; }
  .sv { font-size: 17px; }
}

/* =================== Bubble-stijl (style: bubble) =================== */
.stt { display: none; font-weight: 500; color: var(--c); }
.bubble .stt { display: inline; }
.bubble .stt::after { content: ""; display:inline-block; width:3px; height:3px; border-radius:50%;
  background: var(--secondary-text-color); opacity:.5; margin: 0 6px; vertical-align: 3px; }
.bubble .hdr, .bubble .st, .bubble .up { display: none; }
.bubble .mob { display: inline; }
.bubble .title { padding-left: 8px; }
.bubble .row {
  grid-template-columns: 38px minmax(0,1fr) 78px 78px 78px 128px;
  grid-template-areas: "i n cpu mem disk a" "i sub cpu mem disk a";
  border-radius: 32px; padding: 9px 8px 9px 9px; margin-bottom: 8px;
  border: none; background: rgba(127,127,127,.09);
}
.bubble .row:hover { background: rgba(127,127,127,.14); }
.bubble .ic { width: 38px; height: 38px; }
.bubble .row.on .ic { background: color-mix(in srgb, var(--success-color, #43a047) 20%, transparent); }
.bubble .m { position: relative; overflow: hidden; height: 36px; border-radius: 18px; padding: 0 8px;
  display: flex; align-items: center; justify-content: center; gap: 2px; font-size: 12px;
  background: rgba(127,127,127,.13); }
.bubble .m:hover { background: rgba(127,127,127,.22); }
.bubble .m ha-icon { display: inline-block; position: relative; z-index: 1; }
.bubble .m span { position: relative; z-index: 1; }
.bubble .m .bar { position: absolute; inset: 0; height: auto; margin: 0; border-radius: 0; background: none; z-index: 0; }
.bubble .m .bar > div { border-radius: 0; opacity: .3; }
.bubble .b, .bubble .busy { height: 36px; min-width: 36px; border-radius: 18px; }
.bubble .b.confirm { padding: 0 12px 0 9px; }
.bubble .sum { position: relative; overflow: hidden; border-radius: 32px; padding: 9px 18px; border: none;
  background: rgba(127,127,127,.09); }
.bubble .sum:hover { background: rgba(127,127,127,.14); }
.bubble .sum .bar { position: absolute; inset: 0; margin: 0; height: auto; border-radius: 0; background: none; z-index: 0; }
.bubble .sum .bar > div { border-radius: 0; opacity: .25; }
.bubble .sl, .bubble .sv { position: relative; z-index: 1; }

@container (max-width: 680px) {
  .bubble .row {
    grid-template-columns: 38px minmax(0,1fr) auto;
    grid-template-areas: "i n a" "i sub sub" "mx mx mx";
    border-radius: 28px; padding: 9px 9px 9px 9px;
  }
  .bubble .nm { align-self: center; }
  .bubble .acts { margin-top: 0; align-self: center; }
  .bubble .metrics { margin: 8px 0 0 0; gap: 6px; }
  .bubble .metrics .m { flex: 1; }
  .bubble .sum { padding: 8px 12px; border-radius: 26px; }
}
/* --- Bubble Card-achtergrond: altijd de hoofdkleur, onafhankelijk van de status --- */
.bubble .row, .bubble .sum, .bubble .ntop {
  position: relative; overflow: hidden; border: none;
  background: var(--bubble-button-main-background-color, var(--bubble-main-background-color,
              var(--background-color-2, var(--secondary-background-color, rgba(127,127,127,.12)))));
  border-radius: var(--bubble-button-border-radius, var(--bubble-border-radius, 32px));
}
/* hover-highlight */
.bubble .row::after, .bubble .sum::after, .bubble .ntop::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: var(--primary-text-color, #fff); opacity: 0; transition: opacity .15s ease;
}
.bubble .row:hover, .bubble .sum:hover, .bubble .ntop:hover {
  background: var(--bubble-button-main-background-color, var(--bubble-main-background-color,
              var(--background-color-2, var(--secondary-background-color, rgba(127,127,127,.12)))));
}
.bubble .row:hover::after, .bubble .sum:hover::after, .bubble .ntop:hover::after { opacity: .06; }
.bubble .row:active::after, .bubble .sum:active::after, .bubble .ntop:active::after { opacity: .12; }
.bubble .row > *, .bubble .ntop > * { position: relative; }
.bubble .metrics { position: static; }
@container (max-width: 680px) {
  .bubble .row, .bubble .ntop { border-radius: var(--bubble-button-border-radius, var(--bubble-border-radius, 28px)); }
  .bubble .sum { border-radius: var(--bubble-button-border-radius, var(--bubble-border-radius, 26px)); }
}
`;


/* =================================================================
 *  Node-kaart:  type: custom:proxmox-node-card
 *  Opties: title, sort (name|status), include, exclude, confirm,
 *          show_shutdown: true  (extra knop om de node zelf uit te zetten)
 *          show_summary: false  (cluster-samenvatting verbergen)
 *          update_entities: { pve: update.node_pve_updates_packages }  (optioneel)
 *
 *  De samenvatting toont de clustertotalen, tenzij include/exclude is
 *  ingesteld: dan wordt alleen over de getoonde nodes gerekend.
 * ================================================================= */
class ProxmoxNodeCard extends ProxmoxTableCard {
  static getStubConfig() {
    return { title: "Proxmox nodes" };
  }

  setConfig(config) {
    super.setConfig({ title: "Proxmox nodes", show_shutdown: false, ...(config || {}) });
  }

  _discover() {
    const hass = this._hass;
    const re = /^sensor\.(.+)_containers_running$/;
    const out = [];
    this._cluster = null;
    for (const id of Object.keys(hass.states)) {
      const m = id.match(re);
      if (!m) continue;
      const p = m[1];
      const e = (x) => `sensor.${p}_${x}`;
      if (hass.states[e("nodes_online")]) {
        this._cluster = {
          nodes: e("nodes_online"),
          ct: id,
          vm: e("virtual_machines_running"),
          cpu: e("cpu_used"),
          mem: e("memory_used_percentage"),
        };
        continue;
      }
      const g = {
        prefix: p,
        vmid: "",
        status: hass.states[e("status")] ? e("status") : `binary_sensor.${p}_status`,
        cpu: e("cpu_used"),
        mem: e("memory_used_percentage"),
        disk: e("disk_used_percentage"),
        boot: e("last_boot"),
        ct: id,
        vm: e("virtual_machines_running"),
        upd: e("total_updates"),
        btn: {},
      };
      g.updEntity = this._updateEntity(g);
      g.extra = [g.ct, g.vm, g.upd];
      for (const a of ["start_all", "stop_all", "reboot", "shutdown", "wake_on_lan"]) {
        const b = `button.${p}_${a}`;
        if (hass.states[b]) g.btn[a] = b;
      }
      g.name = this._nodeLabel(g);
      out.push(g);
    }
    return out;
  }

  // Het update-entity van de node (voor more-info bij klikken op de update-teller).
  // 1) config `update_entities: { <node>: update.xxx }`, 2) update.* op hetzelfde device,
  // 3) update.<prefix>_updates_packages, 4) terugvallen op de teller zelf.
  _updateEntity(g) {
    const hass = this._hass;
    const map = this._config.update_entities || {};
    const manual = map[g.prefix] || map[g.prefix.replace(/^node_/, "")];
    if (manual && hass.states[manual]) return manual;
    const E = hass.entities || {};
    const dev = (E[g.upd] && E[g.upd].device_id) || (E[g.ct] && E[g.ct].device_id);
    if (dev) {
      const hit = Object.keys(E).find((id) => id.startsWith("update.") && E[id].device_id === dev && hass.states[id]);
      if (hit) return hit;
    }
    for (const id of [`update.${g.prefix}_updates_packages`, `update.${g.prefix}_updates`, `update.${g.prefix}`]) {
      if (hass.states[id]) return id;
    }
    return g.upd;
  }

  _nodeLabel(g) {
    const hass = this._hass;
    const reg = hass.entities && hass.entities[g.ct];
    const dev = reg && reg.device_id && hass.devices ? hass.devices[reg.device_id] : null;
    let n = dev ? dev.name_by_user || dev.name : null;
    if (!n) {
      const st = hass.states[g.ct];
      n = ((st && st.attributes.friendly_name) || g.prefix).replace(/\s+containers running$/i, "");
    }
    n = n.replace(/^node\s*:?\s*/i, "").replace(/^\(\d+\)\s*/, "").replace(/\s*\(\d+\)\s*$/, "");
    return n || g.prefix;
  }

  _sigIds() {
    const c = this._cluster;
    return c ? Object.values(c) : [];
  }

  _summary() {
    const cfg = this._config;
    if (cfg.show_summary === false) return "";
    const filtered = (cfg.include && cfg.include.length) || (cfg.exclude && cfg.exclude.length);
    if (filtered) return this._summaryFiltered();

    const c = this._cluster;
    if (!c) return "";
    const s = this._hass.states;
    const frac = (id, totalAttr, icon, label) => {
      const st = s[id];
      const v = num(st);
      const tot = st ? parseFloat(st.attributes[totalAttr]) : NaN;
      const val = Number.isNaN(v) ? "–" : Math.round(v);
      const of = Number.isFinite(tot) ? `<small>/${Math.round(tot)}</small>` : "";
      const warn = totalAttr === "nodes_total" && Number.isFinite(tot) && v < tot ? " warnv" : "";
      return `<div class="sum" data-more="${esc(id)}">
          <div class="sl"><ha-icon icon="${icon}"></ha-icon>${label}</div>
          <div class="sv${warn}">${val}${of}</div>
        </div>`;
    };
    const pct = (id, icon, label, warn, alert) => {
      const v = num(s[id]);
      const cls = v > alert ? "err" : v > warn ? "warn" : "ok";
      return `<div class="sum" data-more="${esc(id)}">
          <div class="sl"><ha-icon icon="${icon}"></ha-icon>${label}</div>
          <div class="sv">${Number.isNaN(v) ? "–" : `${Math.round(v)}<small>%</small>`}</div>
          ${Number.isNaN(v) ? "" : `<div class="bar"><div class="${cls}" style="width:${Math.min(Math.max(v, 0), 100)}%"></div></div>`}
        </div>`;
    };
    return `<div class="summary">
        ${frac(c.nodes, "nodes_total", "mdi:server-network", "Nodes")}
        ${frac(c.ct, "lxc_total", "mdi:package-variant-closed", "LXC actief")}
        ${frac(c.vm, "qemu_total", "mdi:monitor", "VM actief")}
        ${pct(c.cpu, "mdi:cpu-64-bit", "CPU", 60, 85)}
        ${pct(c.mem, "mdi:memory", "RAM", 70, 90)}
      </div>`;
  }

  // Samenvatting alleen over de getoonde nodes (include/exclude)
  _summaryFiltered() {
    const s = this._hass.states;
    const list = this._guests || [];
    if (!list.length) return "";
    const on = list.filter((g) => this._isOn(g));
    const single = list.length === 1 ? list[0] : null;
    const more = (id) => (id ? ` data-more="${esc(id)}"` : "");

    const total = (key, attr) => {
      let v = 0, t = 0, hv = false, ht = false;
      for (const g of on) {
        const n = num(s[g[key]]);
        if (!Number.isNaN(n)) { v += n; hv = true; }
      }
      for (const g of list) {
        const st = s[g[key]];
        const n = st ? parseFloat(st.attributes[attr]) : NaN;
        if (Number.isFinite(n)) { t += n; ht = true; }
      }
      return { v: hv ? v : NaN, t: ht ? t : NaN };
    };
    const avg = (key) => {
      const a = on.map((g) => num(s[g[key]])).filter(Number.isFinite);
      return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
    };
    const frac = (id, icon, label, v, t, warn) => {
      const val = Number.isNaN(v) ? "–" : Math.round(v);
      const of = Number.isFinite(t) ? `<small>/${Math.round(t)}</small>` : "";
      return `<div class="sum"${more(id)}>
          <div class="sl"><ha-icon icon="${icon}"></ha-icon>${label}</div>
          <div class="sv${warn ? " warnv" : ""}">${val}${of}</div>
        </div>`;
    };
    const pct = (key, icon, label, warn, alert) => {
      const v = avg(key);
      const cls = v > alert ? "err" : v > warn ? "warn" : "ok";
      return `<div class="sum"${more(single && single[key])}>
          <div class="sl"><ha-icon icon="${icon}"></ha-icon>${label}</div>
          <div class="sv">${Number.isNaN(v) ? "–" : `${Math.round(v)}<small>%</small>`}</div>
          ${Number.isNaN(v) ? "" : `<div class="bar"><div class="${cls}" style="width:${Math.min(Math.max(v, 0), 100)}%"></div></div>`}
        </div>`;
    };

    const ct = total("ct", "lxc_total");
    const vm = total("vm", "qemu_total");
    return `<div class="summary">
        ${frac(single && single.status, "mdi:server-network", "Nodes", on.length, list.length, on.length < list.length)}
        ${frac(single && single.ct, "mdi:package-variant-closed", "LXC actief", ct.v, ct.t)}
        ${frac(single && single.vm, "mdi:monitor", "VM actief", vm.v, vm.t)}
        ${pct("cpu", "mdi:cpu-64-bit", "CPU", 60, 85)}
        ${pct("mem", "mdi:memory", "RAM", 70, 90)}
      </div>`;
  }

  _isOn(g) {
    const s = this._state(g);
    return s === "online" || s === "on" || s === "running";
  }

  _count(id) {
    const v = num(this._hass.states[id]);
    return Number.isNaN(v) ? "–" : Math.round(v);
  }

  _row(g) {
    const on = this._isOn(g);
    const state = this._state(g);
    const [label, cls] =
      state === "on" ? STATUS.online : state === "off" ? STATUS.offline : STATUS[state] || [state, "off"];
    const up = this._uptime(g);
    const pend = this._pending[g.prefix];

    let acts = on ? ["start_all", "reboot", "stop_all"] : ["wake_on_lan"];
    if (on && this._config.show_shutdown) acts.push("shutdown");
    acts = acts.filter((a) => g.btn[a]);
    const btns = this._buttons(g, acts, pend);

    let sub;
    if (on) {
      const nUpd = num(this._hass.states[g.upd]);
      const upd = Number.isNaN(nUpd)
        ? ""
        : nUpd > 0
          ? `<span class="upd" data-more="${esc(g.updEntity)}"><ha-icon icon="mdi:download"></ha-icon>${Math.round(nUpd)}<span class="ipx"> update${nUpd === 1 ? "" : "s"}</span></span>`
          : `<span data-more="${esc(g.updEntity)}"><ha-icon icon="mdi:check"></ha-icon><span class="ipx">up-to-date</span></span>`;
      const parts = [
        `<span data-more="${esc(g.ct)}"><ha-icon icon="mdi:package-variant-closed"></ha-icon>${this._count(g.ct)} LXC</span>`,
        `<span data-more="${esc(g.vm)}"><ha-icon icon="mdi:monitor"></ha-icon>${this._count(g.vm)} VM</span>`,
      ];
      if (upd) parts.push(upd);
      sub =
        parts.join('<i class="dot"></i>') +
        (up ? `<span class="mob"><i class="dot"></i><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(up)}</span>` : "");
    } else {
      sub = `<span>geen verbinding</span>`;
    }

    return `
      <div class="row${on ? " on" : ""}" data-more="${esc(g.status)}">
        <div class="ic"><ha-icon icon="mdi:server"></ha-icon></div>
        <div class="nm">${esc(g.name)}</div>
        <div class="sub"><b class="stt ${pend ? "info" : cls}">${pend ? "Bezig…" : esc(label)}</b>${sub}</div>
        <div class="st"><span class="pill ${pend ? "info" : cls}"><i></i>${pend ? "Bezig…" : esc(label)}</span></div>
        <div class="up" data-more="${esc(g.boot)}">${up ? esc(up) : '<span class="dim">–</span>'}</div>
        <div class="metrics">
          ${this._metric(g.cpu, 60, 85, "mdi:cpu-64-bit", on)}
          ${this._metric(g.mem, 70, 90, "mdi:memory", on)}
          ${this._metric(g.disk, 75, 90, "mdi:harddisk", on)}
        </div>
        <div class="acts">${btns}</div>
      </div>`;
  }

  _render() {
    const c = this._config;
    const list = this._guests;
    const nOn = list.filter((g) => this._isOn(g)).length;
    const off = list.length - nOn;
    const title =
      c.title === false
        ? ""
        : `<div class="title"><span>${esc(c.title)}</span>
             <span class="count"><b class="ok"></b>${nOn} online${off ? `<b class="err"></b>${off} offline` : ""}</span></div>`;
    const body = list.length
      ? `<div class="hdr"><span></span><span>Node</span><span>Status</span><span>Uptime</span>
           <span>CPU</span><span>RAM</span><span>Disk</span><span class="r">Acties</span></div>
         ${list.map((g) => this._row(g)).join("")}`
      : `<div class="empty">Geen Proxmox nodes gevonden.<br>
           <small>Verwacht entiteiten als <code>sensor.node_naam_containers_running</code>.</small></div>`;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card class="${c.style === "bubble" ? "bubble" : ""}">${title}${this._summary()}<div class="list">${body}</div></ha-card>`;
  }
}


/* =================================================================
 *  Synology NAS-kaart:  type: custom:synology-nas-card
 *  Werkt met de standaard Synology DSM-integratie. Vindt zelf de NAS,
 *  volumes, schijven en USB-schijven (taalonafhankelijk).
 *  Opties:
 *    device: Synology     # alleen deze NAS (deel van de naam)
 *    wol: button.nas_wol  # optioneel: knop/switch/script om de NAS aan te zetten
 *    layout: row          # row = één rij per NAS (standaard) | full = met tegels en opslagtabel
 *    show_usb: true       # (alleen layout: full)
 *    title: false         # optionele titelregel boven alles
 *    style: table | bubble
 *    confirm: true
 * ================================================================= */
const DISK_STATUS = {
  normal: ["Normaal", "ok"],
  initialized: ["Normaal", "ok"],
  not_initialized: ["Niet geïnit.", "warn"],
  degraded: ["Verminderd", "warn"],
  attention: ["Let op", "warn"],
  warning: ["Waarschuwing", "warn"],
  crashed: ["Defect", "err"],
  failing: ["Faalt", "err"],
  system_partition_failed: ["Systeemfout", "err"],
  unavailable: ["Offline", "off"],
  unknown: ["Onbekend", "off"],
};

class SynologyNasCard extends ProxmoxTableCard {
  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    super.setConfig({ title: false, show_usb: true, layout: "row", ...(config || {}) });
  }

  getCardSize() {
    return 3 + (this._subCount || 4);
  }

  /* ---------- data ---------- */
  _discover() {
    const hass = this._hass;
    const E = hass.entities || {};
    const D = hass.devices || {};
    const byDev = {};
    for (const [id, e] of Object.entries(E)) {
      if (e.platform !== "synology_dsm" || !e.device_id || !hass.states[id]) continue;
      (byDev[e.device_id] = byDev[e.device_id] || []).push({ id, tk: e.translation_key || "", st: hass.states[id] });
    }
    const devs = Object.keys(byDev).map((id) => ({ id, ...(D[id] || {}), name: (D[id] && (D[id].name_by_user || D[id].name)) || id }));
    const label = (d) => {
      const m = d.name.match(/\(([^)]+)\)\s*$/);
      return m ? m[1] : null;
    };
    const mains = devs.filter((d) => !label(d));
    const out = [];
    this._subCount = 0;
    for (const main of mains) {
      if (this._config.device && !main.name.toLowerCase().includes(String(this._config.device).toLowerCase())) continue;
      const l = byDev[main.id];
      const subs = devs.filter((d) => d !== main && label(d) && (d.via_device_id === main.id || d.name.startsWith(main.name + " (")));
      const g = {
        prefix: main.id,
        vmid: "",
        name: main.name,
        cpu: this._pick(l, ["cpu_total_load"], (x) => this._u(x) === "%" && this._has(x, "cpu") && this._has(x, "total", "totaal")),
        mem: this._pick(l, ["memory_real_usage"], (x) => this._u(x) === "%" && this._has(x, "memory", "geheugen")),
        temp: this._pick(l, ["temperature"], (x) => this._dc(x) === "temperature"),
        boot: this._pick(l, ["uptime"], (x) => this._dc(x) === "timestamp"),
        up: this._pick(l, ["network_up"], (x) => this._has(x, "upload")),
        down: this._pick(l, ["network_down"], (x) => this._has(x, "download")),
        sec: this._pick(l, [], (x) => this._dom(x) === "binary_sensor" && (x.tk === "status" || this._dc(x) === "safety")),
        upd: this._pick(l, [], (x) => this._dom(x) === "update"),
        btn: {},
        subs: [],
      };
      g.status = g.cpu || g.mem;
      const rb = this._pick(l, ["reboot"], (x) => this._dom(x) === "button" && this._has(x, "reboot", "herstart"));
      const sd = this._pick(l, ["shutdown"], (x) => this._dom(x) === "button" && this._has(x, "shutdown", "afsluit", "uitschakel"));
      if (rb) g.btn.reboot = rb;
      if (sd) g.btn.shutdown = sd;
      if (this._config.wol && hass.states[this._config.wol]) g.btn.wol = this._config.wol;

      const parts = [];
      for (const d of subs) {
        const sl = byDev[d.id];
        const lab = label(d);
        const kind = /partition/i.test(lab) ? "part" : /volume/i.test(lab) ? "volume" : /usb/i.test(lab) ? "usb" : "drive";
        if ((kind === "usb" || kind === "part") && this._config.show_usb === false) continue;
        const temps = sl.filter((x) => this._dom(x) === "sensor" && this._dc(x) === "temperature");
        const s = {
          kind,
          label: lab,
          status: this._pick(sl, ["volume_status", "disk_status", "device_status", "partition_status"], (x) =>
            this._dom(x) === "sensor" && x.id.endsWith("_status") && !this._has(x, "smart")),
          smart: this._pick(sl, ["disk_smart_status"], (x) => this._has(x, "smart")),
          temp: (temps.find((x) => ["volume_disk_temp_avg", "disk_temp"].includes(x.tk)) ||
            temps.find((x) => this._has(x, "gemiddeld", "avg", "average")) || temps[0] || {}).id,
          pct: this._pick(sl, ["volume_percentage_used", "partition_percentage_used"], (x) => this._dom(x) === "sensor" && this._u(x) === "%"),
          used: this._pick(sl, ["volume_size_used", "partition_used_space"], (x) =>
            this._dc(x) === "data_size" && this._has(x, "used", "gebruikt")),
          total: this._pick(sl, ["volume_size_total", "partition_size"], (x) =>
            this._dc(x) === "data_size" && this._has(x, "total", "totaal", "size", "grootte")),
          ids: sl.map((x) => x.id),
        };
        (kind === "part" ? parts : g.subs).push(s);
      }
      // partities samenvoegen met hun USB-schijf (of los tonen)
      for (const p of parts) {
        const host = g.subs.find((s) => s.kind === "usb" && p.label.toLowerCase().startsWith(s.label.toLowerCase()));
        const n = parts.filter((x) => host && x.label.toLowerCase().startsWith(host.label.toLowerCase())).length;
        if (host && n === 1 && !host.pct) {
          Object.assign(host, { pct: p.pct, used: p.used, total: p.total, partLabel: p.label.slice(host.label.length).trim() });
          host.ids = host.ids.concat(p.ids);
        } else g.subs.push({ ...p, kind: "usb" });
      }
      const order = { volume: 0, drive: 1, usb: 2 };
      g.subs.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label, undefined, { numeric: true }));
      this._subCount += g.subs.length;
      g.extra = [g.mem, g.temp, g.up, g.down, g.sec, g.upd, ...g.subs.flatMap((s) => s.ids)].filter(Boolean);
      out.push(g);
    }
    return out;
  }

  _pick(list, tks, test) {
    const x = list.find((e) => tks.includes(e.tk)) || (test && list.find(test));
    return x ? x.id : undefined;
  }
  _u(x) { return x.st.attributes.unit_of_measurement; }
  _dc(x) { return x.st.attributes.device_class; }
  _dom(x) { return x.id.split(".")[0]; }
  _has(x, ...w) {
    const s = x.id.toLowerCase();
    return w.some((k) => s.includes(k));
  }

  _filter(list) {
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  _isOn(g) {
    const st = this._hass.states[g.status];
    return !!st && !["unavailable", "unknown"].includes(st.state);
  }

  /* ---------- helpers ---------- */
  _val(id, digits = 1) {
    const st = this._hass.states[id];
    const v = num(st);
    if (Number.isNaN(v)) return null;
    const u = st.attributes.unit_of_measurement || "";
    return `${v < 10 && digits ? v.toFixed(digits) : Math.round(v)}${u === "%" || u === "°C" ? "" : " "}${esc(u)}`;
  }

  _tile(id, icon, label, pctWarn, pctAlert) {
    const st = this._hass.states[id];
    const v = num(st);
    const u = st ? st.attributes.unit_of_measurement || "" : "";
    const isPct = u === "%";
    const cls = v > pctAlert ? "err" : v > pctWarn ? "warn" : "ok";
    return `<div class="sum" data-more="${esc(id || "")}">
        <div class="sl"><ha-icon icon="${icon}"></ha-icon>${esc(label)}</div>
        <div class="sv">${Number.isNaN(v) ? "–" : `${Math.round(v)}<small>${esc(u)}</small>`}</div>
        ${isPct && !Number.isNaN(v) ? `<div class="bar"><div class="${cls}" style="width:${Math.min(Math.max(v, 0), 100)}%"></div></div>` : ""}
      </div>`;
  }

  _netTile(g) {
    const up = this._val(g.up), down = this._val(g.down);
    return `<div class="sum" data-more="${esc(g.up || "")}">
        <div class="sl"><ha-icon icon="mdi:swap-vertical"></ha-icon>Netwerk</div>
        <div class="net"><ha-icon icon="mdi:arrow-up"></ha-icon>${up || "–"}<br><ha-icon icon="mdi:arrow-down"></ha-icon>${down || "–"}</div>
      </div>`;
  }

  _subRow(s) {
    const st = this._hass.states[s.status];
    const raw = st ? st.state : "unknown";
    const [label, cls] = DISK_STATUS[raw] || [raw.replace(/_/g, " "), "warn"];
    const ok = cls === "ok";
    const tv = num(this._hass.states[s.temp]);
    const tcls = tv > 60 ? "err" : tv > 50 ? "warn" : "";
    const temp = Number.isNaN(tv) ? null : `${Math.round(tv)}°C`;
    const icon = s.kind === "volume" ? "mdi:database" : s.kind === "usb" ? "mdi:usb-flash-drive" : "mdi:harddisk";

    const subParts = [];
    if (s.kind === "volume") {
      const used = this._val(s.used), tot = this._val(s.total);
      if (used) subParts.push(`<span>${used}${tot ? ` / ${tot}` : ""} gebruikt</span>`);
      else subParts.push(`<span>Volume</span>`);
    } else if (s.kind === "usb") {
      if (s.partLabel) subParts.push(`<span>${esc(s.partLabel)}</span>`);
      const used = this._val(s.used), tot = this._val(s.total);
      if (used || tot) subParts.push(`<span>${used || "–"}${tot ? ` / ${tot}` : ""}</span>`);
      if (!subParts.length) subParts.push(`<span>USB</span>`);
    } else {
      const sm = this._hass.states[s.smart];
      subParts.push(sm && !["unknown", "unavailable"].includes(sm.state)
        ? `<span data-more="${esc(s.smart)}">SMART ${esc((DISK_STATUS[sm.state] || [sm.state])[0].toLowerCase())}</span>`
        : `<span>Schijf</span>`);
    }

    let usage;
    if (s.pct) usage = this._metric(s.pct, 75, 90, "mdi:chart-pie", true).replace('class="m', 'class="m nu');
    else usage = `<div class="m nu none dim"><span>–</span></div>`;

    return `
      <div class="row nrow${ok ? " on" : ""}" data-more="${esc(s.status || s.ids[0])}">
        <div class="ic"><ha-icon icon="${icon}"></ha-icon></div>
        <div class="nm">${esc(s.label)}</div>
        <div class="sub"><b class="stt ${cls}">${esc(label)}</b>${subParts.join('<i class="dot"></i>')}${temp ? `<span class="mob tmp ${tcls}" data-more="${esc(s.temp)}"><i class="dot"></i><ha-icon icon="mdi:thermometer"></ha-icon>${temp}</span>` : ""}</div>
        <div class="st"><span class="pill ${cls}"><i></i>${esc(label)}</span></div>
        <div class="m nt ${tcls}${temp ? "" : " dim"}" ${s.temp ? `data-more="${esc(s.temp)}"` : ""}>
          <ha-icon icon="mdi:thermometer"></ha-icon><span>${temp || "–"}</span></div>
        ${usage}
      </div>`;
  }

  _nas(g) {
    const hass = this._hass;
    const on = this._isOn(g);
    const pend = this._pending[g.prefix];
    const up = on ? this._uptime(g) : null;

    const ts = [`<b class="tc ${pend ? "info" : on ? "ok" : "err"}">${pend ? "Bezig…" : on ? "Online" : "Offline"}</b>`];
    if (up) ts.push(`<span data-more="${esc(g.boot)}"><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(up)}</span>`);
    const sec = hass.states[g.sec];
    if (on && sec) {
      const bad = sec.state === "on";
      ts.push(`<span class="tc ${bad ? "warn" : "ok"}" data-more="${esc(g.sec)}"><ha-icon icon="${bad ? "mdi:shield-alert-outline" : "mdi:shield-check-outline"}"></ha-icon><span class="ipx">${bad ? "Beveiliging: onveilig" : "Veilig"}</span></span>`);
    }
    const upd = hass.states[g.upd];
    if (on && upd) {
      const avail = upd.state === "on";
      ts.push(`<span class="${avail ? "upd" : ""}" data-more="${esc(g.upd)}"><ha-icon icon="${avail ? "mdi:download" : "mdi:check"}"></ha-icon><span class="ipx">${avail ? "DSM-update beschikbaar" : "DSM up-to-date"}</span></span>`);
    }

    const acts = (on ? ["reboot", "shutdown"] : ["wol"]).filter((a) => g.btn[a]);
    const btns = this._buttons(g, acts, pend);

    const vols = g.subs.filter((s) => s.kind === "volume" && s.pct);
    const tiles = [
      this._tile(g.cpu, "mdi:cpu-64-bit", "CPU", 60, 85),
      this._tile(g.mem, "mdi:memory", "RAM", 70, 90),
      ...vols.slice(0, 2).map((v) => this._tile(v.pct, "mdi:chart-pie", v.label, 75, 90)),
      this._tile(g.temp, "mdi:thermometer", "Temperatuur", 999, 999),
      this._netTile(g),
    ];

    const rows = g.subs.length
      ? `<div class="hdr nhdr"><span></span><span>Opslag</span><span>Status</span><span>Temp</span><span>Gebruik</span></div>
         ${g.subs.map((s) => this._subRow(s)).join("")}`
      : "";

    return `<div class="nas">
        <div class="ntop${on ? " on" : ""}" data-more="${esc(g.status || "")}">
          <div class="ic"><ha-icon icon="mdi:nas"></ha-icon></div>
          <div class="ntxt"><div class="tn">${esc(g.name)}</div><div class="ts">${ts.join('<i class="dot"></i>')}</div></div>
          <div class="acts">${btns}</div>
        </div>
        <div class="summary nsum${on ? "" : " off"}">${tiles.join("")}</div>
        ${rows}
      </div>`;
  }

  /* ---------- compacte weergave: één rij per NAS ---------- */
  _nasRow(g) {
    const hass = this._hass;
    const on = this._isOn(g);
    const pend = this._pending[g.prefix];
    const up = on ? this._uptime(g) : null;
    const [label, cls] = pend ? ["Bezig…", "info"] : on ? ["Online", "ok"] : ["Offline", "err"];
    const vol = g.subs.find((x) => x.kind === "volume" && x.pct) || {};

    const sub = [];
    if (on) {
      // volumes met een probleem altijd tonen
      for (const v of g.subs.filter((x) => x.kind === "volume")) {
        const st = hass.states[v.status];
        if (st && !["normal", "unknown", "unavailable"].includes(st.state)) {
          const [l, c] = DISK_STATUS[st.state] || [st.state, "warn"];
          sub.push(`<span class="tc ${c}" data-more="${esc(v.status)}"><ha-icon icon="mdi:alert-outline"></ha-icon>${esc(v.label)}: ${esc(l.toLowerCase())}</span>`);
        }
      }
      const sec = hass.states[g.sec];
      if (sec) {
        const bad = sec.state === "on";
        sub.push(`<span class="tc ${bad ? "warn" : "ok"}" data-more="${esc(g.sec)}" title="${bad ? "Beveiliging: onveilig" : "Veilig"}"><ha-icon icon="${bad ? "mdi:shield-alert-outline" : "mdi:shield-check-outline"}"></ha-icon><span class="ipx">${bad ? "onveilig" : "veilig"}</span></span>`);
      }
      const upd = hass.states[g.upd];
      if (upd) {
        const avail = upd.state === "on";
        sub.push(`<span class="${avail ? "upd" : ""}" data-more="${esc(g.upd)}" title="${avail ? "DSM-update beschikbaar" : "DSM up-to-date"}"><ha-icon icon="${avail ? "mdi:download" : "mdi:check"}"></ha-icon><span class="ipx">${avail ? "update" : "up-to-date"}</span></span>`);
      }
      const tv = num(hass.states[g.temp]);
      if (!Number.isNaN(tv)) {
        const tc = tv > 60 ? "tc err" : tv > 50 ? "tc warn" : "";
        sub.push(`<span class="${tc}" data-more="${esc(g.temp)}"><ha-icon icon="mdi:thermometer"></ha-icon>${Math.round(tv)}°C</span>`);
      }
      const u = this._val(g.up), d = this._val(g.down);
      if (u || d) sub.push(`<span class="ipx" data-more="${esc(g.up || g.down)}"><ha-icon icon="mdi:swap-vertical"></ha-icon>↑${u || "–"} ↓${d || "–"}</span>`);
    } else {
      sub.push(`<span>geen verbinding</span>`);
    }

    const acts = (on ? ["reboot", "shutdown"] : ["wol"]).filter((a) => g.btn[a]);
    const btns = this._buttons(g, acts, pend);
    const volCell = vol.pct
      ? this._metric(vol.pct, 75, 90, "mdi:chart-pie", on)
      : `<div class="m dim"><ha-icon icon="mdi:chart-pie"></ha-icon><span>–</span></div>`;

    return `
      <div class="row${on ? " on" : ""}" data-more="${esc(g.status || "")}">
        <div class="ic"><ha-icon icon="mdi:nas"></ha-icon></div>
        <div class="nm">${esc(g.name)}</div>
        <div class="sub"><b class="stt ${cls}">${esc(label)}</b>${sub.join('<i class="dot"></i>')}${up ? `<span class="mob"><i class="dot"></i><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(up)}</span>` : ""}</div>
        <div class="st"><span class="pill ${cls}"><i></i>${esc(label)}</span></div>
        <div class="up" data-more="${esc(g.boot || "")}">${up ? esc(up) : '<span class="dim">–</span>'}</div>
        <div class="metrics">
          ${this._metric(g.cpu, 60, 85, "mdi:cpu-64-bit", on)}
          ${this._metric(g.mem, 70, 90, "mdi:memory", on)}
          ${volCell}
        </div>
        <div class="acts">${btns}</div>
      </div>`;
  }

  _render() {
    const c = this._config;
    const list = this._guests;
    const title = c.title ? `<div class="title"><span>${esc(c.title)}</span></div>` : "";
    if (c.layout !== "full") {
      const rows = list.length
        ? `${c.show_header === false ? "" : `<div class="hdr"><span></span><span>NAS</span><span>Status</span><span>Uptime</span>
             <span>CPU</span><span>RAM</span><span>Volume</span><span class="r">Acties</span></div>`}
           ${list.map((g) => this._nasRow(g)).join("")}`
        : `<div class="empty">Geen Synology NAS gevonden.<br><small>Vereist de Synology DSM-integratie.</small></div>`;
      this.shadowRoot.innerHTML = `<style>${STYLE}${NAS_STYLE}</style><ha-card class="${c.style === "bubble" ? "bubble" : ""}">${title}${rows}</ha-card>`;
      return;
    }
    const body = list.length
      ? list.map((g) => this._nas(g)).join("")
      : `<div class="empty">Geen Synology NAS gevonden.<br><small>Vereist de Synology DSM-integratie.</small></div>`;
    this.shadowRoot.innerHTML = `<style>${STYLE}${NAS_STYLE}</style><ha-card class="${c.style === "bubble" ? "bubble" : ""}">${title}${body}</ha-card>`;
  }
}

const NAS_STYLE = `
/* =================== Synology NAS-kaart =================== */
.nas + .nas { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--divider-color, rgba(127,127,127,.15)); }
.ntop { display:flex; align-items:center; gap:10px; padding: 2px 4px 12px; cursor:pointer; }
.ntop .ic { width:42px; height:42px; }
.ntop .ic ha-icon { --mdc-icon-size: 24px; }
.ntop.on .ic { color: var(--success-color, #43a047); }
.ntxt { min-width:0; flex:1; }
.tn { font-size:16px; font-weight:500; color: var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ts { font-size:12px; color: var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ts ha-icon, .net ha-icon { --mdc-icon-size: 13px; margin-right: 2px; vertical-align: -2px; }
.ts [data-more] { cursor:pointer; }
.tc { color: var(--c); font-weight: 500; }
.ts span.tc { font-weight: 400; }
.ntop .acts { flex-shrink: 0; }
.nsum { grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); }
.nsum.off { opacity: .55; }
.net { font-size:13px; line-height:1.35; color: var(--primary-text-color); white-space:nowrap; }
.net ha-icon { color: var(--secondary-text-color); }
.row.nrow, .hdr.nhdr {
  grid-template-columns: 36px minmax(0,1fr) 92px 72px 150px;
  grid-template-areas: "i n st t u" "i sub st t u";
}
.hdr.nhdr { grid-template-areas: ". n st t u"; }
.hdr.nhdr span:nth-child(4) { grid-area: t; padding-left: 6px; }
.hdr.nhdr span:nth-child(5) { grid-area: u; padding-left: 6px; }
.nrow .m.nt { grid-area: t; }
.nrow .m.nu { grid-area: u; }
.nrow .m.nt.warn, .nrow .m.nt.err, .sub .tmp.warn, .sub .tmp.err { color: var(--c); }
.bubble .ntop { padding: 8px; margin-bottom: 10px; }
.bubble .row.nrow {
  grid-template-columns: 38px minmax(0,1fr) 78px 150px;
  grid-template-areas: "i n t u" "i sub t u";
}
.bubble .nrow .mob.tmp { display: none; }

@container (max-width: 680px) {
  .row.nrow {
    grid-template-columns: 36px minmax(0,1fr) auto;
    grid-template-areas: "i n st" "i sub sub" "u u u";
  }
  .nrow .m.nt, .nrow .m.none { display: none; }
  .nrow .m.nu { margin: 6px 0 0 -6px; }
  .nsum { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .nsum .sum, .nsum .sum:nth-child(n+4) { grid-column: auto; }
  .bubble .row.nrow { grid-template-areas: "i n t" "i sub sub" "u u u"; grid-template-columns: 38px minmax(0,1fr) auto; }
  .bubble .nrow .m.nt { display: flex; min-width: 72px; }
  .bubble .nrow .m.nt.dim { display: none; }
  .bubble .nrow .m.nu { margin: 8px 0 0 0; }
}
`;

customElements.define("proxmox-table-card", ProxmoxTableCard);
customElements.define("synology-nas-card", SynologyNasCard);
customElements.define("proxmox-node-card", ProxmoxNodeCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "proxmox-table-card",
  name: "Proxmox Table Card",
  description: "Tabel met alle Proxmox VM's en containers, met start/stop-knoppen.",
  preview: false,
});
window.customCards.push({
  type: "synology-nas-card",
  name: "Synology NAS Card",
  description: "Synology NAS met volumes, schijven, gebruik en herstart/afsluit-knoppen.",
  preview: false,
});
window.customCards.push({
  type: "proxmox-node-card",
  name: "Proxmox Node Card",
  description: "Tabel met alle Proxmox nodes: gebruik, guests, updates en knoppen.",
  preview: false,
});

console.info(`%c PROXMOX-TABLE-CARD %c v${CARD_VERSION} `, "background:#e57000;color:#fff;font-weight:600", "background:#333;color:#fff");
