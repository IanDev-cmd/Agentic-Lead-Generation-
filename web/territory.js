/* Territory map. Leaflet is loaded the first time the drawer opens. */
const MAP_ENDPOINTS = {
  street: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  labels: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  osrm: "https://router.project-osrm.org/route/v1/driving/",
};
const STREET_ATTRIBUTION = "© OpenStreetMap contributors";
const SATELLITE_ATTRIBUTION = "Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community";

let leafletPromise = null;
let active = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/vendor/leaflet/leaflet.css";
      document.head.appendChild(link);
      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletPromise = null;
        reject(new Error("Map library could not load."));
      };
      document.head.appendChild(script);
    });
  }
  return leafletPromise;
}

function hasHq(lead) {
  const hq = String(lead.hq || "").trim();
  return Boolean(hq) && !/^(unknown|n\/a|none|-)$/i.test(hq);
}

function pointOf(lead) {
  if (lead && lead.lat != null && lead.lat !== "" && lead.lng != null && lead.lng !== "") {
    const lat = Number(lead.lat);
    const lng = Number(lead.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  const match = String(lead && lead.coords || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const parsedLat = Number(match[1]);
  const parsedLng = Number(match[2]);
  if (Math.abs(parsedLat) > 90 || Math.abs(parsedLng) > 180) return null;
  return { lat: parsedLat, lng: parsedLng };
}

function approximate(lead) {
  const precision = lead.geo && lead.geo.precision;
  return precision === "area" || precision === "region";
}

function pinSvg(lead) {
  if (approximate(lead)) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="9" fill="none" stroke="#1a73e8" stroke-width="2" stroke-dasharray="3 2"/></svg>';
  }
  if (lead.priority === "High" && !lead.negative) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path fill="#1a73e8" d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.3 21.7 0 14 0z"/><polygon fill="#fff" points="14,6.5 15.8,11.2 20.8,11.5 16.9,14.6 18.1,19.4 14,16.8 9.9,19.4 11.1,14.6 7.2,11.5 12.2,11.2"/></svg>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path fill="#fff" stroke="#80868b" stroke-width="2" d="M14 1.5C7 1.5 1.5 7 1.5 14c0 9.2 12.5 20 12.5 20S26.5 23.2 26.5 14C26.5 7 21 1.5 14 1.5z"/></svg>';
}

function button(label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return node;
}

function say(state, text) {
  state.live.textContent = text;
  if (state.api.setLive) state.api.setLive(text);
}

function paintRoute(state) {
  const from = state.route.from ? state.route.from.label : "not set";
  const to = state.route.to ? state.route.to.label : "not set";
  state.ends.textContent = "From: " + from + ". To: " + to + ".";
  const stops = state.route.day.map((stop) => stop.label);
  if (!state.dayHolding) state.day.textContent = stops.length ? "Day route: " + stops.join(", ") + "." : "";
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function badgeIcon(L, text) {
  return L.divIcon({
    className: "pin-icon",
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12" fill="#1a73e8"/><text x="14" y="18" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#ffffff">' + text + "</text></svg>",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function clearBucket(state, bucket) {
  const list = state.layers && state.layers[bucket];
  if (!list || !state.map) {
    if (state.layers) state.layers[bucket] = [];
    return;
  }
  for (const layer of list) state.map.removeLayer(layer);
  state.layers[bucket] = [];
}

function drawSpiders(state) {
  clearBucket(state, "spider");
  if (!state.map || !window.L || !state.api.getSelected) return;
  const selected = state.api.getSelected();
  const origin = selected && pointOf(selected);
  if (!origin) return;
  const L = window.L;
  for (const lead of state.api.getLeads()) {
    if (lead.id === selected.id) continue;
    const point = hasHq(lead) ? pointOf(lead) : null;
    if (!point || haversineKm(origin, point) > 15) continue;
    state.layers.spider.push(L.polyline([[origin.lat, origin.lng], [point.lat, point.lng]], {
      color: "#1a73e8",
      weight: 1,
      opacity: 0.55,
      dashArray: "2 6",
    }).addTo(state.map));
  }
}

async function drawRoad(state, stops, bucket, letters, describe) {
  if (!state.map || !window.L || stops.length < 2) return;
  if (state.routeAbort) state.routeAbort.abort();
  const controller = new AbortController();
  state.routeAbort = controller;
  const timer = setTimeout(() => controller.abort(), 8000);
  clearBucket(state, bucket);
  const L = window.L;
  stops.forEach((stop, index) => {
    const text = letters ? (index === 0 ? "A" : "B") : String(index + 1);
    state.layers[bucket].push(L.marker([stop.lat, stop.lng], {
      icon: badgeIcon(L, text),
      keyboard: false,
      title: stop.label,
    }).addTo(state.map));
  });
  try {
    const coordPath = stops.map((stop) => stop.lng + "," + stop.lat).join(";");
    const response = await fetch(MAP_ENDPOINTS.osrm + coordPath + "?overview=full&geometries=geojson", { signal: controller.signal });
    if (!response.ok) throw new Error("route");
    const body = await response.json();
    const route = body.routes && body.routes[0];
    if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) throw new Error("route");
    if (active !== state || state.routeAbort !== controller) return;
    const line = route.geometry.coordinates.map((pair) => [pair[1], pair[0]]);
    state.layers[bucket].push(L.polyline(line, { color: "#ffffff", weight: 8, opacity: 0.95 }).addTo(state.map));
    state.layers[bucket].push(L.polyline(line, { color: "#1a73e8", weight: 4, opacity: 0.95 }).addTo(state.map));
    describe(false, (Number(route.distance) / 1000).toFixed(1), Math.max(1, Math.round(Number(route.duration) / 60)));
  } catch (error) {
    if (active !== state || state.routeAbort !== controller) return;
    const line = stops.map((stop) => [stop.lat, stop.lng]);
    state.layers[bucket].push(L.polyline(line, { color: "#1a73e8", weight: 3, opacity: 0.8, dashArray: "8 8" }).addTo(state.map));
    let total = 0;
    for (let index = 1; index < stops.length; index += 1) total += haversineKm(stops[index - 1], stops[index]);
    describe(true, total.toFixed(1), 0);
  } finally {
    clearTimeout(timer);
  }
}

function describeEnds(state, straight, km, minutes) {
  state.card.textContent = straight
    ? km + " km. Straight-line distance, not a road route."
    : km + " km, " + minutes + " min.";
  say(state, state.card.textContent);
}

function drawDay(state) {
  const stops = state.route.day.slice(0, 10);
  if (stops.length < 2) {
    clearBucket(state, "day");
    state.dayHolding = false;
    paintRoute(state);
    return;
  }
  state.dayHolding = true;
  drawRoad(state, stops, "day", false, (straight, km, minutes) => {
    const names = stops.map((stop) => stop.label).join(", ");
    state.day.textContent = straight
      ? "Day route: " + names + ". " + km + " km. Straight-line distance, not a road route."
      : "Day route: " + names + ". " + km + " km, " + minutes + " min.";
    say(state, state.day.textContent);
  });
}

function matchingLead(state, typed) {
  const query = typed.toLowerCase();
  return state.api.getLeads().find((lead) => lead.company.toLowerCase() === query || String(lead.hq || "").toLowerCase() === query) || null;
}

function fillSuggestions(state, input, list) {
  const query = input.value.trim().toLowerCase();
  list.replaceChildren();
  input.removeAttribute("aria-activedescendant");
  if (!query) {
    list.hidden = true;
    return;
  }
  const matches = state.api.getLeads().filter((lead) => (lead.company + " " + (lead.hq || "")).toLowerCase().includes(query)).slice(0, 6);
  list.hidden = matches.length === 0;
  matches.forEach((lead, index) => {
    const option = document.createElement("li");
    option.setAttribute("role", "option");
    option.id = input.id + "-opt-" + index;
    option.tabIndex = -1;
    option.textContent = lead.hq ? lead.company + " — " + lead.hq : lead.company;
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseTypedLead(state, input, list, lead);
    });
    list.append(option);
  });
}

function chooseTypedLead(state, input, list, lead) {
  const point = pointOf(lead);
  list.hidden = true;
  input.value = lead.company;
  if (!point) {
    say(state, "No pin for " + lead.company + ". The headquarters is not on the map yet.");
    return;
  }
  remember(state, input.dataset.end, lead, point);
}

async function resolveField(state, field) {
  const input = field.input;
  const typed = input.value.trim();
  const kind = input.dataset.end;
  if (!typed) {
    state.route[kind] = null;
    paintRoute(state);
    return;
  }
  if (state.route[kind] && typed === state.route[kind].label) return;
  if (/^my location$/i.test(typed)) {
    if (!state.here) {
      say(state, "Locate me first. This position stays in the browser until you route from it.");
      return;
    }
    state.route[kind] = { label: "My location", lat: state.here.lat, lng: state.here.lng };
    input.value = "My location";
    field.list.hidden = true;
    paintRoute(state);
    return;
  }
  const local = matchingLead(state, typed);
  if (local) {
    chooseTypedLead(state, input, field.list, local);
    return;
  }
  field.list.hidden = true;
  say(state, "Looking up " + typed + ".");
  try {
    const response = await fetch("/api/geocode/search?q=" + encodeURIComponent(typed.slice(0, 200)), { credentials: "same-origin" });
    if (active !== state) return;
    if (response.status === 429) {
      say(state, "The geocoder is busy. Nothing was searched.");
      return;
    }
    const body = await response.json();
    const candidate = body.candidates && body.candidates[0];
    if (!response.ok || !candidate) {
      say(state, "That place could not be found.");
      return;
    }
    state.route[kind] = { label: candidate.displayName || typed, lat: candidate.lat, lng: candidate.lng };
    input.value = state.route[kind].label;
    paintRoute(state);
    say(state, (kind === "from" ? "From is " : "To is ") + state.route[kind].label + ".");
  } catch {
    if (active === state) say(state, "That place could not be found.");
  }
}

function routeField(state, kind) {
  const wrap = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = kind;
  const input = document.createElement("input");
  input.type = "text";
  input.id = "territory-" + kind.toLowerCase();
  input.dataset.end = kind.toLowerCase();
  input.autocomplete = "off";
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", input.id + "-list");
  const list = document.createElement("ul");
  list.className = "territory-suggest";
  list.id = input.id + "-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", kind + " matches");
  list.hidden = true;
  let activeIndex = -1;
  input.addEventListener("input", () => {
    activeIndex = -1;
    fillSuggestions(state, input, list);
  });
  input.addEventListener("keydown", (event) => {
    const options = [...list.querySelectorAll("[role=option]")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      activeIndex = event.key === "ArrowDown" ? Math.min(options.length - 1, activeIndex + 1) : Math.max(0, activeIndex - 1);
      options.forEach((option, index) => option.setAttribute("aria-selected", index === activeIndex ? "true" : "false"));
      input.setAttribute("aria-activedescendant", options[activeIndex].id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) options[activeIndex].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      else resolveField(state, { input, list });
      return;
    }
    if (event.key === "Escape") list.hidden = true;
  });
  wrap.append(caption, input, list);
  return { wrap, input, list };
}

async function goRoute(state) {
  if (!state.fromInput || !state.toInput) return;
  await resolveField(state, state.fromInput);
  await resolveField(state, state.toInput);
  if (active !== state) return;
  if (!state.route.from || !state.route.to) {
    say(state, "Choose a From and a To before drawing a route.");
    return;
  }
  drawRoad(state, [state.route.from, state.route.to], "road", true, (straight, km, minutes) => describeEnds(state, straight, km, minutes));
}

function swapEnds(state) {
  const from = state.route.from;
  state.route.from = state.route.to;
  state.route.to = from;
  const fromValue = state.fromInput.input.value;
  state.fromInput.input.value = state.toInput.input.value;
  state.toInput.input.value = fromValue;
  paintRoute(state);
}

function useHere(state) {
  if (!state.here) {
    say(state, "Locate me first. This position stays in the browser until you route from it.");
    return;
  }
  state.route.from = { label: "My location", lat: state.here.lat, lng: state.here.lng };
  state.fromInput.input.value = "My location";
  paintRoute(state);
  say(state, "From is My location.");
}

function remember(state, kind, lead, point) {
  const place = { label: lead.company, lat: point.lat, lng: point.lng, id: lead.id };
  if (kind === "day") {
    if (state.route.day.some((stop) => stop.id === lead.id)) return;
    if (state.route.day.length >= 10) {
      say(state, "The day route already has 10 stops.");
      return;
    }
    state.route.day.push(place);
    say(state, lead.company + " was added to the day route.");
    paintRoute(state);
    drawDay(state);
    return;
  }
  state.route[kind] = place;
  if (kind === "from" && state.fromInput) state.fromInput.input.value = lead.company;
  if (kind === "to" && state.toInput) state.toInput.input.value = lead.company;
  say(state, (kind === "from" ? "From is " : "To is ") + lead.company + ".");
  paintRoute(state);
}

function popupCard(state, lead, point) {
  const card = document.createElement("div");
  card.className = "pin-card";
  const title = document.createElement("strong");
  title.textContent = lead.company;
  const tag = document.createElement("span");
  tag.className = "tag " + (lead.negative ? "neg" : "high");
  tag.textContent = approximate(lead) ? "Approximate location" : (lead.priority || "Low");
  const hq = document.createElement("p");
  hq.textContent = lead.hq || "";
  const pain = document.createElement("p");
  pain.textContent = lead.pain || "";
  const hook = document.createElement("p");
  hook.textContent = lead.hook || "No public hook.";
  card.append(title, tag, hq, pain, hook);
  const source = state.api.safeUrl(lead.source);
  if (source) {
    const link = document.createElement("a");
    link.href = new URL(String(lead.source)).href;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = "Source";
    card.append(link);
  }
  const maps = document.createElement("a");
  maps.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(point.lat + "," + point.lng);
  maps.rel = "noopener noreferrer";
  maps.target = "_blank";
  maps.textContent = "Open in Google Maps";
  const actions = document.createElement("div");
  actions.className = "pin-actions";
  actions.append(
    button("Route from here", () => remember(state, "from", lead, point)),
    button("Route to here", () => remember(state, "to", lead, point)),
    button("Add to day route", () => remember(state, "day", lead, point)),
    button("Open lead", () => state.api.openLead(lead)),
  );
  const scored = state.analytics && state.analytics.scores ? leadScore(state, { ...lead, lat: point.lat, lng: point.lng }) : null;
  if (scored) {
    const why = document.createElement("p");
    why.textContent = "Why this score: " + scored.score + ". " + scored.reasons.join(" ");
    card.append(why);
  }
  card.append(maps, actions);
  return card;
}

function addMarker(state, L, lead, point) {
  const scored = state.analytics && state.analytics.scores ? leadScore(state, { ...lead, lat: point.lat, lng: point.lng }) : null;
  const scale = scored ? 0.75 + (scored.score / 100) * 0.55 : 1;
  const height = (approximate(lead) ? 28 : 36) * scale;
  const width = 28 * scale;
  const icon = L.divIcon({
    className: "pin-icon",
    html: pinSvg(lead),
    iconSize: [width, height],
    iconAnchor: [width / 2, approximate(lead) ? height / 2 : height],
    popupAnchor: [0, approximate(lead) ? -12 : -32],
  });
  const marker = L.marker([point.lat, point.lng], {
    icon,
    title: scored ? lead.company + ", score " + scored.score : lead.company,
    keyboard: true,
  });
  const popup = L.popup({
    maxWidth: 280,
    autoPan: true,
    autoPanPaddingTopLeft: [16, 72],
    autoPanPaddingBottomRight: [16, 16],
  }).setContent(popupCard(state, lead, point));
  marker.bindPopup(popup);
  marker.on("add", () => {
    const el = marker.getElement();
    if (!el) return;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.setAttribute("aria-label", lead.company);
  });
  marker.on("popupopen", () => {
    const node = marker.getPopup().getElement();
    const focusable = node && node.querySelector("button, a");
    if (focusable) focusable.focus();
  });
  marker.addTo(state.map);
  state.markers.set(lead.id, marker);
  return marker;
}

const CLUSTER_COLORS = ["#1a73e8", "#188038", "#e37400", "#9334e6", "#d93025", "#007b83"];

function placedLeads(state) {
  return state.api.getLeads().filter((lead) => hasHq(lead) && pointOf(lead)).map((lead) => {
    const point = pointOf(lead);
    return { ...lead, lat: point.lat, lng: point.lng };
  });
}

function leadScore(state, lead) {
  if (!window.Geo || !lead) return null;
  const start = state.route.from || state.here || null;
  return window.Geo.scoreLead(lead, { start, leads: placedLeads(state), epsKm: 25 });
}

function visibleLeads(state) {
  let leads = state.api.getLeads();
  if (state.analytics && state.analytics.clusterIds) {
    leads = leads.filter((lead) => state.analytics.clusterIds.has(lead.id) || !pointOf(lead));
  }
  if (state.analytics && state.analytics.highOnly) {
    leads = leads.filter((lead) => lead.priority === "High" && !lead.negative);
  }
  if (state.analytics && state.analytics.scores && window.Geo) {
    leads = leads.filter((lead) => {
      if (!pointOf(lead)) return true;
      const scored = leadScore(state, { ...lead, ...pointOf(lead) });
      return !scored || scored.score >= state.analytics.minScore;
    });
    leads = [...leads].sort((left, right) => {
      const leftScore = pointOf(left) ? (leadScore(state, { ...left, ...pointOf(left) }) || {}).score || 0 : -1;
      const rightScore = pointOf(right) ? (leadScore(state, { ...right, ...pointOf(right) }) || {}).score || 0 : -1;
      return rightScore - leftScore;
    });
  }
  return leads;
}

function drawTerritories(state) {
  clearBucket(state, "territory");
  if (!state.analytics || !state.analytics.territories || !window.Geo || !state.map) return;
  const grouped = window.Geo.dbscan(placedLeads(state), { epsKm: 25, minPts: 2 });
  grouped.clusters.forEach((cluster, index) => {
    const color = CLUSTER_COLORS[index % CLUSTER_COLORS.length];
    const shape = window.Geo.territoryShape(cluster.points);
    const total = cluster.points.reduce((sum, lead) => sum + ((leadScore(state, lead) || {}).score || 0), 0);
    const label = cluster.label + ": " + cluster.points.length + ", score " + total;
    const layer = shape.kind === "circle"
      ? window.L.circle([shape.center.lat, shape.center.lng], { radius: Math.max(shape.radiusKm, 0.5) * 1000, color, weight: 2, fillColor: color, fillOpacity: 0.12 })
      : window.L.polygon(shape.points.map((point) => [point.lat, point.lng]), { color, weight: 2, fillColor: color, fillOpacity: 0.12 });
    layer.bindTooltip(label, { permanent: true, direction: "center" });
    layer.on("click", () => {
      state.analytics.clusterIds = new Set(cluster.points.map((point) => point.id));
      const bounds = cluster.points.map((point) => [point.lat, point.lng]);
      if (bounds.length === 1) state.map.setView(bounds[0], 12);
      else if (bounds.length) state.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 12 });
      renderList(state);
      say(state, label);
    });
    layer.addTo(state.map);
    state.layers.territory.push(layer);
  });
}

function drawRings(state) {
  clearBucket(state, "rings");
  if (!state.analytics || !state.analytics.rings || !window.Geo || !state.map) return;
  const start = state.route.from || state.here;
  if (!start) {
    if (state.legendStats) state.legendStats.textContent = "Choose a start, or use Locate me, before drawing service rings.";
    return;
  }
  const counts = window.Geo.ringCounts(start, placedLeads(state));
  ["#1a73e8", "#188038", "#e37400"].forEach((color, index) => {
    const ring = counts[index];
    if (!ring) return;
    state.layers.rings.push(window.L.circle([start.lat, start.lng], {
      radius: ring.km * 1000,
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.04,
    }).addTo(state.map));
  });
  if (state.legendStats) state.legendStats.textContent = counts.map((ring) => ring.km + " km: " + ring.count).join(". ") + ".";
}

function planHigh(state) {
  if (!window.Geo) return;
  const start = state.here || state.route.from;
  if (!start) {
    say(state, "Choose a start, or use Locate me, before planning the day.");
    return;
  }
  const highs = placedLeads(state).filter((lead) => lead.priority === "High" && !lead.negative);
  const plan = window.Geo.planRoute(start, highs, { max: 10 });
  state.route.day = plan.order.map((stop) => ({ label: stop.company || stop.id, lat: stop.lat, lng: stop.lng, id: stop.id }));
  state.dayHolding = true;
  const sentence = "Day route estimate: " + plan.totalKm.toFixed(1) + " km, " + Math.round(plan.minutes) + " min.";
  state.day.textContent = sentence;
  say(state, sentence);
  if (state.route.day.length >= 2) {
    drawRoad(state, state.route.day, "day", false, () => {
      state.day.textContent = sentence;
    });
  }
}

function rebuildMarkers(state) {
  if (!state.map || !window.L) return;
  for (const marker of state.markers.values()) state.map.removeLayer(marker);
  state.markers.clear();
  for (const lead of placedLeads(state)) {
    if (state.analytics.clusterIds && !state.analytics.clusterIds.has(lead.id)) continue;
    if (state.analytics.highOnly && (lead.priority !== "High" || lead.negative)) continue;
    addMarker(state, window.L, lead, { lat: lead.lat, lng: lead.lng });
  }
}

function refreshAnalytics(state) {
  drawTerritories(state);
  drawRings(state);
  rebuildMarkers(state);
  renderList(state);
}

function renderList(state) {
  state.list.replaceChildren();
  const leads = visibleLeads(state);
  const placed = [];
  const waiting = [];
  const missing = [];
  for (const lead of leads) {
    if (!hasHq(lead)) missing.push(lead);
    else if (pointOf(lead)) placed.push(lead);
    else waiting.push(lead);
  }
  const addHeading = (text) => {
    const heading = document.createElement("h3");
    heading.textContent = text;
    state.list.append(heading);
  };
  const addRow = (lead, note, onClick) => {
    const row = document.createElement("button");
    row.type = "button";
    const name = document.createElement("span");
    name.textContent = lead.company;
    const detail = document.createElement("small");
    detail.textContent = note;
    row.append(name, detail);
    row.addEventListener("click", onClick);
    state.list.append(row);
  };
  if (placed.length) addHeading("On the map");
  for (const lead of placed) {
    const scored = state.analytics && state.analytics.scores ? leadScore(state, { ...lead, ...pointOf(lead) }) : null;
    const note = scored ? lead.hq + ". Score " + scored.score + "." : lead.hq;
    addRow(lead, note, () => {
      const marker = state.markers.get(lead.id);
      const point = pointOf(lead);
      if (!marker || !point || !state.map) return;
      state.map.setView([point.lat, point.lng], Math.max(state.map.getZoom(), 12));
      marker.openPopup();
      say(state, lead.company + " is on the map.");
    });
  }
  if (waiting.length) addHeading("Headquarters not placed yet");
  for (const lead of waiting) {
    const missed = lead.geo && lead.geo.status === "not_found";
    addRow(lead, missed ? "No public match for this address." : lead.hq + ". Not placed on the map yet.", () => {
      say(state, missed
        ? "No public match for " + lead.company + "."
        : "No pin for " + lead.company + ". The headquarters is not on the map yet.");
    });
  }
  if (missing.length) addHeading("No public headquarters address");
  for (const lead of missing) {
    addRow(lead, "No public headquarters address.", () => {
      say(state, lead.company + " has no public headquarters address.");
    });
  }
}

function locate(state, L) {
  if (!navigator.geolocation) {
    say(state, "Location is unavailable on this browser.");
    return;
  }
  const token = state.token;
  say(state, "Finding this browser.");
  navigator.geolocation.getCurrentPosition((position) => {
    if (token !== state.token || !state.map) return;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = Number(position.coords.accuracy) || 40;
    if (state.youCircle) state.map.removeLayer(state.youCircle);
    if (state.youMarker) state.map.removeLayer(state.youMarker);
    state.youCircle = L.circle([lat, lng], {
      radius: accuracy,
      color: "#1a73e8",
      weight: 1,
      fillColor: "#1a73e8",
      fillOpacity: 0.15,
    }).addTo(state.map);
    state.youMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "you-dot", iconSize: [16, 16], iconAnchor: [8, 8] }),
      keyboard: false,
      title: "You are here",
    }).addTo(state.map);
    state.here = { lat, lng, label: "My location" };
    state.map.setView([lat, lng], Math.max(state.map.getZoom(), 13));
    say(state, "You are here. This position stays in the browser until you route from it.");
  }, () => {
    if (token !== state.token) return;
    say(state, "Location was denied or timed out. The map was not moved.");
  }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
}

function leaveExpanded(state) {
  if (!state || !state.host || !state.host.classList.contains("is-expanded")) return false;
  if (state.placeholder && state.placeholder.parentNode) {
    state.placeholder.parentNode.insertBefore(state.host, state.placeholder);
    state.placeholder.remove();
  }
  state.placeholder = null;
  state.host.classList.remove("is-expanded");
  if (state.exit) state.exit.hidden = true;
  if (state.map) state.map.invalidateSize();
  return true;
}

function enterExpanded(state) {
  state.placeholder = document.createElement("div");
  state.placeholder.className = "territory-map-holder";
  state.host.parentNode.insertBefore(state.placeholder, state.host);
  document.body.appendChild(state.host);
  state.host.classList.add("is-expanded");
  state.exit.hidden = false;
  state.map.invalidateSize();
}

function toggleFullscreen(state) {
  const node = state.host;
  const native = node.requestFullscreen || node.webkitRequestFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  if (state.host.classList.contains("is-expanded")) {
    leaveExpanded(state);
    return;
  }
  if (native) {
    state.exit.hidden = false;
    Promise.resolve(native.call(node)).catch(() => enterExpanded(state));
    return;
  }
  enterExpanded(state);
}

function watchTiles(state, layer) {
  layer.on("tileerror", () => {
    state.tileErrors += 1;
    if (state.tileErrors >= 3 && state.note.hidden) {
      state.note.hidden = false;
      state.note.textContent = "Map tiles could not load.";
      say(state, "Map tiles could not load.");
    }
  });
}

function refreshPins(state) {
  renderList(state);
  if (!state.map || !state.L) return;
  const points = [];
  const seen = new Set();
  for (const lead of state.api.getLeads()) {
    const point = hasHq(lead) ? pointOf(lead) : null;
    if (!point) continue;
    seen.add(lead.id);
    points.push([point.lat, point.lng]);
    if (!state.markers.has(lead.id)) addMarker(state, state.L, lead, point);
  }
  for (const [id, marker] of state.markers) {
    if (seen.has(id)) continue;
    state.map.removeLayer(marker);
    state.markers.delete(id);
  }
  if (points.length > state.fittedCount) {
    state.map.fitBounds(points, { padding: [28, 28], maxZoom: 12 });
    state.fittedCount = points.length;
  }
  drawSpiders(state);
  drawTerritories(state);
  drawRings(state);
}

function pendingLeads(state) {
  return state.api.getLeads().filter((lead) => hasHq(lead) && !pointOf(lead) && !(lead.geo && lead.geo.status === "not_found"));
}

async function placePending(state) {
  const controller = new AbortController();
  state.placeAbort = controller;
  if (!pendingLeads(state).length) return;
  state.placing = true;
  let guard = 0;
  try {
    while (guard < 40) {
      if (controller.signal.aborted || active !== state) return;
      const pending = pendingLeads(state);
      if (!pending.length) break;
      const leads = state.api.getLeads();
      const total = leads.filter(hasHq).length;
      const placed = leads.filter((lead) => hasHq(lead) && pointOf(lead)).length;
      say(state, "Placing pins " + placed + " of " + total + ".");
      let response;
      try {
        response = await fetch("/api/geocode", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: pending.slice(0, 6).map((lead) => lead.id) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name === "AbortError") return;
        say(state, "Pins could not be placed. The list below is still usable.");
        return;
      }
      if (response.status === 429) {
        const busy = await response.json().catch(() => ({}));
        if (active === state && state.api.applyLeads) state.api.applyLeads(busy.leads);
        if (active === state) refreshPins(state);
        say(state, "The geocoder is busy. Pins that are already placed stay on the map.");
        return;
      }
      if (!response.ok) {
        say(state, "Pins could not be placed. The list below is still usable.");
        return;
      }
      const body = await response.json();
      if (active !== state) return;
      if (state.api.applyLeads) state.api.applyLeads(body.leads);
      refreshPins(state);
      if (Array.isArray(body.failed) && body.failed.length) {
        say(state, "Pins could not be placed. The list below is still usable.");
        return;
      }
      if (!body.remaining) break;
      guard += 1;
    }
  } finally {
    state.placing = false;
  }
  if (active === state && !controller.signal.aborted) say(state, "Territory map is open.");
}

function mountMap(state, L) {
  const street = L.tileLayer(MAP_ENDPOINTS.street, { attribution: STREET_ATTRIBUTION, maxZoom: 19 });
  const satellite = L.tileLayer(MAP_ENDPOINTS.satellite, { attribution: SATELLITE_ATTRIBUTION, maxZoom: 19 });
  const labels = L.tileLayer(MAP_ENDPOINTS.labels, { attribution: SATELLITE_ATTRIBUTION, maxZoom: 19 });
  watchTiles(state, street);
  watchTiles(state, satellite);
  state.map = L.map(state.host, { zoomControl: true, attributionControl: true }).setView([20, 0], 2);
  street.addTo(state.map);
  const territoryLayer = L.layerGroup();
  const scoreLayer = L.layerGroup();
  const ringLayer = L.layerGroup();
  L.control.layers(
    { Street: street, Satellite: satellite },
    { "Place names": labels, Territories: territoryLayer, Scores: scoreLayer, "Service rings": ringLayer },
  ).addTo(state.map);
  state.map.on("overlayadd", (event) => {
    if (event.name === "Territories") state.analytics.territories = true;
    if (event.name === "Scores") state.analytics.scores = true;
    if (event.name === "Service rings") state.analytics.rings = true;
    refreshAnalytics(state);
  });
  state.map.on("overlayremove", (event) => {
    if (event.name === "Territories") {
      state.analytics.territories = false;
      state.analytics.clusterIds = null;
    }
    if (event.name === "Scores") state.analytics.scores = false;
    if (event.name === "Service rings") state.analytics.rings = false;
    refreshAnalytics(state);
  });
  state.map.on("baselayerchange", (event) => {
    if (event.name === "Satellite" && !state.map.hasLayer(labels)) labels.addTo(state.map);
    if (event.name === "Street" && state.map.hasLayer(labels)) state.map.removeLayer(labels);
  });
  const points = [];
  for (const lead of state.api.getLeads()) {
    const point = hasHq(lead) ? pointOf(lead) : null;
    if (!point) continue;
    addMarker(state, L, lead, point);
    points.push([point.lat, point.lng]);
  }
  if (points.length) state.map.fitBounds(points, { padding: [28, 28], maxZoom: 12 });
  state.fittedCount = points.length;
  drawSpiders(state);
  const drawer = document.getElementById("studioDrawer");
  state.onTransition = (event) => {
    if (event.propertyName === "transform" && state.map) state.map.invalidateSize();
  };
  if (drawer) drawer.addEventListener("transitionend", state.onTransition);
  if (window.ResizeObserver) {
    state.observer = new ResizeObserver(() => {
      if (state.map) state.map.invalidateSize();
    });
    state.observer.observe(state.host);
  }
  state.onFullscreen = () => {
    if (!state.map) return;
    const open = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    state.exit.hidden = !open && !state.host.classList.contains("is-expanded");
    state.map.invalidateSize();
  };
  document.addEventListener("fullscreenchange", state.onFullscreen);
  document.addEventListener("webkitfullscreenchange", state.onFullscreen);
  requestAnimationFrame(() => {
    if (state.map) state.map.invalidateSize();
  });
}

window.MAP_ENDPOINTS = MAP_ENDPOINTS;
window.Territory = {
  mount(root, api) {
    this.destroy();
    if (!root) return;
    const leads = api.getLeads();
    if (!leads.some(hasHq)) {
      const empty = document.createElement("p");
      empty.textContent = "No headquarters address is on the desk yet. Run research to add pins.";
      root.append(empty);
      if (api.setLive) api.setLive(empty.textContent);
      return;
    }
    const state = {
      token: 1,
      api,
      root,
      map: null,
      markers: new Map(),
      host: null,
      note: null,
      live: null,
      ends: null,
      day: null,
      exit: null,
      placeholder: null,
      youCircle: null,
      youMarker: null,
      here: null,
      observer: null,
      onTransition: null,
      onFullscreen: null,
      tileErrors: 0,
      fittedCount: 0,
      placing: false,
      placeAbort: null,
      routeAbort: null,
      L: null,
      fromInput: null,
      toInput: null,
      card: null,
      dayHolding: false,
      layers: { road: [], day: [], spider: [], territory: [], rings: [] },
      analytics: { territories: false, scores: false, rings: false, highOnly: false, minScore: 0, clusterIds: null },
      legendStats: null,
      route: { from: null, to: null, day: [] },
    };
    active = state;
    state.live = document.createElement("p");
    state.live.className = "territory-live";
    state.live.setAttribute("aria-live", "polite");
    const tools = document.createElement("div");
    tools.className = "territory-tools";
    tools.append(
      button("Locate me", () => {
        if (!state.map || !window.L) return;
        locate(state, window.L);
      }),
      button("Full screen", () => {
        if (state.host) toggleFullscreen(state);
      }),
    );
    state.note = document.createElement("p");
    state.note.className = "territory-note";
    state.note.hidden = true;
    state.host = document.createElement("div");
    state.host.className = "territory-map";
    state.exit = button("Exit", () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      leaveExpanded(state);
    });
    state.exit.classList.add("territory-exit");
    state.exit.hidden = true;
    state.host.append(state.exit);
    const form = document.createElement("form");
    form.className = "territory-route";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      goRoute(state);
    });
    const disclosure = document.createElement("p");
    disclosure.textContent = "Routes are drawn by the public OSRM server.";
    state.fromInput = routeField(state, "From");
    state.toInput = routeField(state, "To");
    const swap = button("Swap", () => swapEnds(state));
    const mine = button("My location", () => useHere(state));
    const go = button("Go", () => goRoute(state));
    state.ends = document.createElement("p");
    state.day = document.createElement("p");
    state.card = document.createElement("p");
    const legend = document.createElement("div");
    legend.className = "territory-legend";
    const highOnly = document.createElement("label");
    const highBox = document.createElement("input");
    highBox.type = "checkbox";
    highOnly.append(highBox, document.createTextNode(" High only"));
    highBox.addEventListener("change", () => {
      state.analytics.highOnly = highBox.checked;
      refreshAnalytics(state);
    });
    const minLabel = document.createElement("label");
    minLabel.append(document.createTextNode("Score at least "));
    const minScore = document.createElement("input");
    minScore.type = "number";
    minScore.min = "0";
    minScore.max = "100";
    minScore.value = "0";
    minScore.addEventListener("change", () => {
      const value = Number(minScore.value);
      state.analytics.minScore = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      state.analytics.scores = true;
      refreshAnalytics(state);
    });
    minLabel.append(minScore);
    state.legendStats = document.createElement("p");
    const plan = button("Plan best visit order for High leads", () => planHigh(state));
    legend.append(highOnly, minLabel, plan, state.legendStats);
    form.append(disclosure, state.fromInput.wrap, swap, state.toInput.wrap, mine, go, state.ends, state.day, state.card, legend);
    paintRoute(state);
    state.list = document.createElement("div");
    state.list.className = "territory-list";
    root.append(state.live, tools, state.note, state.host, form, state.list);
    renderList(state);
    say(state, "Opening the territory map.");
    loadLeaflet().then((L) => {
      if (active !== state) return;
      state.L = L;
      mountMap(state, L);
      if (!state.placing) say(state, "Territory map is open.");
    }).catch(() => {
      if (active !== state) return;
      state.note.hidden = false;
      state.note.textContent = "Map library could not load.";
      say(state, state.note.textContent);
    });
    placePending(state);
  },
  destroy() {
    const state = active;
    active = null;
    if (!state) return;
    state.token += 1;
    if (state.placeAbort) state.placeAbort.abort();
    if (state.routeAbort) state.routeAbort.abort();
    const drawer = document.getElementById("studioDrawer");
    if (state.onTransition && drawer) drawer.removeEventListener("transitionend", state.onTransition);
    if (state.onFullscreen) {
      document.removeEventListener("fullscreenchange", state.onFullscreen);
      document.removeEventListener("webkitfullscreenchange", state.onFullscreen);
    }
    if (state.observer) state.observer.disconnect();
    leaveExpanded(state);
    if (state.map) {
      state.map.remove();
      state.map = null;
    }
  },
  consumeEscape() {
    const state = active;
    if (!state) return false;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return true;
    }
    return leaveExpanded(state);
  },
  sync() {
    if (active) drawSpiders(active);
  },
};
