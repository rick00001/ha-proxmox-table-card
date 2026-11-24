# Proxmox Table Card

A set of zero-config Lovelace cards for Home Assistant that show your homelab at a glance:

| Card | Type | Shows |
| --- | --- | --- |
| **Proxmox Table Card** | `custom:proxmox-table-card` | All Proxmox VMs and LXC containers with status, uptime, CPU / RAM / disk and start / stop buttons |
| **Proxmox Node Card** | `custom:proxmox-node-card` | All Proxmox nodes with guest counts, pending updates, usage, node actions and an optional cluster summary |
| **Synology NAS Card** | `custom:synology-nas-card` | Synology NAS status, volumes, drives, USB disks, temperature, network and reboot / shutdown buttons |

All three cards **discover their entities automatically** — no entity lists to maintain. They render as a table on wide screens and switch to compact blocks on phones / narrow columns. A rounded `bubble` style is available that matches [Bubble Card](https://github.com/Clooos/Bubble-Card) dashboards.

> **Note:** the card UI text is in Dutch (e.g. *Actief*, *Gestopt*, *Herstarten?*).

<!-- Add a screenshot: ![Screenshot](images/screenshot.png) -->

---

## Requirements

- Home Assistant 2023.x or newer
- For the Proxmox cards: the [Proxmox VE custom integration](https://github.com/dougiteixeira/proxmoxve) by dougiteixeira
- For the NAS card: the built-in [Synology DSM integration](https://www.home-assistant.io/integrations/synology_dsm/)

> The Proxmox VE integration disables some entities by default (for example disk usage, IP address, last boot, node buttons). Enable the ones you want to see under **Settings → Devices & services → Proxmox VE → Entities**. Missing entities simply show `–` or hide their button.

> **Entity prefix:** newer versions of the Proxmox VE integration prefix entity IDs with `pve_` (for example `sensor.pve_lxc_bookstack_105_status`). Both the prefixed and the unprefixed naming are supported automatically.

---

## Installation

### HACS (custom repository)

1. Open **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/rick00001/ha-proxmox-table-card` with category **Dashboard**.
3. Search for **Proxmox Table Card**, install it, and reload the browser.

### Manual

1. Download `proxmox-table-card.js` from the latest release.
2. Copy it to `/config/www/proxmox-table-card.js`.
3. Go to **Settings → Dashboards → ⋮ → Resources → Add resource**
   - URL: `/local/proxmox-table-card.js`
   - Type: **JavaScript module**
4. Hard-refresh your browser.

One file registers all three cards.

---

## Proxmox Table Card (VMs & containers)

```yaml
type: custom:proxmox-table-card
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | string / `false` | `Proxmox` | Card title. `false` hides the title row (and the running / stopped counter). |
| `sort` | string | `name` | `name`, `id` (VMID), `node`, or `status` (running guests first). |
| `hide_stopped` | boolean | `false` | Only show running guests. |
| `show_ip` | boolean | `false` | Show the IP address in the second line (wide layout only). |
| `include` | list | `[]` | Only show these guests. Matches a part of the name, the exact VMID, or the entity prefix (including `pve_` if present, e.g. `pve_lxc_bookstack_105`). |
| `exclude` | list | `[]` | Hide these guests (same matching as `include`). |
| `confirm` | boolean | `true` | Ask for a second tap before shutdown, reboot and stop. |
| `style` | string | `table` | `table` or `bubble`. |

### Example

```yaml
type: custom:proxmox-table-card
title: Servers
sort: status
show_ip: true
exclude:
  - remotepc
  - 9000        # templates
style: bubble
```

### Buttons

Buttons depend on the guest state and only appear when the matching `button.*` entity exists:

| State | Buttons |
| --- | --- |
| running | shutdown, reboot, stop |
| paused / suspended | resume, stop |
| anything else | start |

With `confirm: true` the first tap turns the button into a labelled confirm button for 4 seconds; tap again to execute. While an action runs, a spinner is shown until the status changes (or 60 s pass).

### Discovered entities

Guests are found from `sensor.[<prefix>_]<type>_<name>_<vmid>_status` where `<type>` is `lxc` or `qemu` and the optional leading prefix is, for example, `pve`. For each guest the card then uses (if present), where `<prefix>` below is everything between `sensor.` and `_status` (so it includes `pve_` when present):

| Entity | Used for |
| --- | --- |
| `sensor.<prefix>_status` | Status pill, row click |
| `sensor.<prefix>_cpu_used` | CPU bar |
| `sensor.<prefix>_memory_used_percentage` | RAM bar |
| `sensor.<prefix>_disk_used_percentage` | Disk bar |
| `sensor.<prefix>_last_boot` | Uptime |
| `sensor.<prefix>_node` | Node name / `sort: node` |
| `sensor.<prefix>_ip_address` | `show_ip` |
| `binary_sensor.<prefix>_locked` | Lock icon |
| `button.<prefix>_start` / `_shutdown` / `_reboot` / `_stop` / `_resume` | Action buttons |

The display name comes from the device name (your rename wins), with prefixes like `LXC`, `QEMU`, `VM` and a trailing `(105)` stripped.

---

## Proxmox Node Card

```yaml
type: custom:proxmox-node-card
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | string / `false` | `Proxmox nodes` | Card title. `false` hides it. |
| `sort` | string | `name` | `name` or `status` (online nodes first). |
| `hide_stopped` | boolean | `false` | Hide offline nodes. |
| `include` / `exclude` | list | `[]` | Filter nodes by (part of) name or entity prefix. The summary tiles follow this filter (see below). |
| `confirm` | boolean | `true` | Confirm reboot / start all / stop all / shutdown. |
| `show_shutdown` | boolean | `false` | Add a button to shut down the node itself. |
| `show_summary` | boolean | `true` | Show the summary tiles (needs a detected cluster, or an `include` / `exclude` filter). |
| `update_entities` | map | – | Override which `update.*` entity opens when you tap the update count (see below). |
| `style` | string | `table` | `table` or `bubble`. |

### Example

```yaml
type: custom:proxmox-node-card
sort: status
show_shutdown: true
style: bubble
```

Only show two of your nodes, with a summary for just those:

```yaml
type: custom:proxmox-node-card
include:
  - pve
  - pve2
```

### What it shows

- **Status, uptime, CPU, RAM, disk** per node
- **Running LXC / VM count** — tap to open the sensor
- **Pending updates** — shows the number from `sensor.<node>_total_updates`; tapping it opens the node's **update entity** (with the package list), not the count sensor
- **Buttons**: start all, reboot, stop all (and shutdown with `show_shutdown`) when online; Wake-on-LAN when offline
- **Summary tiles**: nodes online, LXC running, VMs running, CPU and RAM (see below)

### Summary and filtering

Without `include` / `exclude`, the summary shows the **cluster totals** from the cluster entities (`sensor.<cluster>_nodes_online` etc.).

As soon as `include` or `exclude` is set, the summary is calculated from **only the nodes shown on the card**:

| Tile | With a filter |
| --- | --- |
| Nodes | Online nodes out of the shown nodes |
| LXC / VM running | Sum of the shown nodes' running counts (the `/total` appears when the node entities expose `lxc_total` / `qemu_total`) |
| CPU / RAM | Plain **average** of the online shown nodes. Not weighted by node size, because the per-node entities don't expose totals. |

Notes:

- With `hide_stopped: true` the node total also shrinks, because it counts only the shown nodes.
- When exactly one node is shown, tapping a tile opens that node's sensor. With several nodes the tiles are not tappable (there is no single entity behind the combined value).
- Set `show_summary: false` to hide the tiles entirely.

### Update entity lookup

When you tap the update count the card opens, in order of preference:

1. The entity configured in `update_entities` for that node
2. An `update.*` entity on the same device as the count sensor
3. `update.<prefix>_updates_packages`
4. The count sensor itself (fallback)

Normally step 2 finds it automatically. If not, map it manually — the key is the node prefix with or without `node_`:

```yaml
type: custom:proxmox-node-card
update_entities:
  pve: update.node_pve_updates_packages
  pve2: update.node_pve2_updates_packages
```

### Discovered entities

Nodes are found from `sensor.<prefix>_containers_running`. A prefix that also has `sensor.<prefix>_nodes_online` is treated as the cluster. Any entity prefix (including `pve_`) works.

| Entity | Used for |
| --- | --- |
| `sensor.<prefix>_status` or `binary_sensor.<prefix>_status` | Online / offline |
| `sensor.<prefix>_cpu_used`, `_memory_used_percentage`, `_disk_used_percentage` | Usage bars |
| `sensor.<prefix>_last_boot` | Uptime |
| `sensor.<prefix>_containers_running`, `_virtual_machines_running` | Guest counts |
| `sensor.<prefix>_total_updates` | Update count |
| `update.*` (same device) | Opened when tapping the update count |
| `button.<prefix>_start_all` / `_stop_all` / `_reboot` / `_shutdown` / `_wake_on_lan` | Action buttons |

---

## Synology NAS Card

```yaml
type: custom:synology-nas-card
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `layout` | string | `row` | `row` = one compact row per NAS. `full` = header, tiles and a storage table. |
| `device` | string | – | Only show the NAS whose name contains this text. |
| `wol` | entity | – | Button / switch / script used to power the NAS on when it is offline. |
| `show_usb` | boolean | `true` | Show USB disks and partitions (`full` layout). |
| `show_header` | boolean | `true` | Show the column header (`row` layout). |
| `title` | string / `false` | `false` | Optional title row. |
| `confirm` | boolean | `true` | Confirm reboot / shutdown. |
| `style` | string | `table` | `table` or `bubble`. |

### Examples

```yaml
type: custom:synology-nas-card
```

```yaml
type: custom:synology-nas-card
layout: full
device: DS920
wol: button.nas_wake_on_lan
style: bubble
```

### What it shows

- **Row layout:** status, uptime, CPU, RAM, first volume usage, security status, DSM update, temperature, network, reboot / shutdown buttons. Volumes with a problem are always highlighted.
- **Full layout:** a header with status / uptime / security / DSM update, tiles for CPU, RAM, up to two volumes, temperature and network, and a table of every volume, drive and USB disk with status, SMART, temperature and usage.

Entities are matched by translation key, device class and unit, so it works regardless of the Home Assistant language.

---

## Tap behaviour

Every part of a row opens the relevant **more-info** dialog:

| Tap on | Opens |
| --- | --- |
| Row | Status entity |
| CPU / RAM / disk bar | That sensor (history graph) |
| Uptime | Last boot sensor |
| LXC / VM count (nodes) | Running count sensor |
| Update count (nodes) | Node update entity |
| Summary tile | Cluster / NAS sensor (or the node's sensor when a filter leaves one node) |

Action buttons never open a dialog.

---

## Styling

The cards use standard Home Assistant theme variables (`--primary-color`, `--success-color`, `--warning-color`, `--error-color`, `--info-color`, `--divider-color`, …), so they follow your theme.

With `style: bubble` they also honour Bubble Card variables:

- `--bubble-main-background-color` / `--bubble-button-main-background-color`
- `--bubble-border-radius` / `--bubble-button-border-radius`

Layout switches to the compact phone view when the card is narrower than 680 px (container query, so it also applies to narrow dashboard columns).

---

## Troubleshooting

- **"Geen Proxmox VM's of containers gevonden"** — no `sensor.[pve_]lxc_*_status` / `sensor.[pve_]qemu_*_status` entities exist. Check the Proxmox VE integration and that status sensors are enabled.
- **An `include` / `exclude` entry with an entity prefix stopped matching after an update** — the prefix now includes `pve_` (e.g. `pve_lxc_bookstack_105`). Use the guest name or VMID instead to be independent of the prefix.
- **A column shows `–`** — the matching entity is disabled or missing; enable it in the integration.
- **A button is missing** — the corresponding `button.*` entity is disabled.
- **Node summary shows unexpected CPU / RAM** — with `include` / `exclude` set these are simple averages of the shown online nodes, not cluster values.
- **Card not found after installing** — check the resource URL and hard-refresh (Ctrl + F5). The browser console logs `PROXMOX-TABLE-CARD vX.Y.Z` when the file is loaded.

---

## Changelog

### 1.2.0
- Support for entity IDs with a prefix such as `pve_` (e.g. `sensor.pve_lxc_bookstack_105_status`), as used by newer versions of the Proxmox VE integration.
- Node card: the summary tiles now respect `include` / `exclude` and are calculated from the shown nodes only.

### 1.1.0
- Node card: tapping the update count now opens the node's `update.*` entity instead of the count sensor.
- Node card: new `update_entities` option to override the update entity.

### 1.0.0
- Initial release: Proxmox table card, Proxmox node card, Synology NAS card.

---

## License

[MIT](LICENSE)