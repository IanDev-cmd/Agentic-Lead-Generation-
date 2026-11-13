/* 2D buyer map. Leaflet loads the first time Maps opens. Tiles follow the Oceana desk map. */
const MAP_TILES = {
  imagery: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  street: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  topo: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
};

let leafletPromise = null;
let active = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/vendor/leaflet/leaflet.css";
      document.head.append(link);
      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletPromise = null;
        reject(new Error("Map library could not load."));
      };
      document.head.append(script);
    });
  }
  return leafletPromise;
}

function popupNode(feature, openLead, leads) {
  const box = document.createElement("div");
  const heading = document.createElement("b");
  heading.textContent = feature.properties.name || "Market";
  const copy = document.createElement("p");
  copy.textContent = feature.properties.note || "";
  box.append(heading, copy);
  if (feature.properties.leadId && openLead) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Open lead";
    button.onclick = () => {
      const lead = leads.find((item) => item.id === feature.properties.leadId);
      if (lead) openLead(lead);
    };
    box.append(button);
  }
  return box;
}

function leadPoint(lead) {
  const lat = Number(lead.lat);
  const lng = Number(lead.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      name: lead.company || "Lead",
      band: "Lead",
      note: [lead.hq, lead.pain].filter(Boolean).join(". "),
      leadId: lead.id || "",
    },
  };
}

function mount(host, api) {
  if (active && active.host === host) {
    active.api = api;
    active.refresh();
    return;
  }
  destroy();
  host.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "maps-bar";
  const mapNode = document.createElement("div");
  mapNode.className = "desk-map";
  host.append(bar, mapNode);
  const state = { host, api, map: null, layers: {}, base: null, group: null };
  active = state;
  const buttons = [
    ["imagery", "Imagery"],
    ["street", "Street"],
    ["topo", "Topo"],
  ];
  buttons.forEach(([key, label], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (index === 0) button.className = "on";
    button.onclick = () => {
      if (!state.map || !state.layers[key]) return;
      if (state.base) state.map.removeLayer(state.base);
      state.base = state.layers[key];
      state.base.addTo(state.map);
      bar.querySelectorAll("button").forEach((item) => item.classList.toggle("on", item === button));
    };
    bar.append(button);
  });
  loadLeaflet().then((L) => {
    if (active !== state) return;
    const tiles = { maxZoom: 19, keepBuffer: 4, updateWhenZooming: false };
    state.layers.imagery = L.tileLayer(MAP_TILES.imagery, { ...tiles, attribution: "Tiles © Esri" });
    state.layers.street = L.tileLayer(MAP_TILES.street, { ...tiles, subdomains: "abc", attribution: "© OpenStreetMap" });
    state.layers.topo = L.tileLayer(MAP_TILES.topo, { ...tiles, attribution: "Tiles © Esri" });
    state.map = L.map(mapNode, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 2,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
    }).setView([0.2, 37.9], 6);
    state.base = state.layers.imagery.addTo(state.map);
    state.group = L.featureGroup().addTo(state.map);
    state.refresh = () => paint(state);
    paint(state);
    setTimeout(() => state.map && state.map.invalidateSize(), 60);
  }).catch(() => {
    const note = document.createElement("p");
    note.textContent = "The map did not load.";
    host.append(note);
  });
  state.refresh = () => {};
}

function paint(state) {
  const L = window.L;
  if (!state.map || !L) return;
  state.group.clearLayers();
  const leads = state.api && state.api.getLeads ? state.api.getLeads() : [];
  const features = leads.map(leadPoint).filter(Boolean);
  const draw = (collection, color) => {
    L.geoJSON(collection, {
      pointToLayer(feature, latlng) {
        return L.circleMarker(latlng, {
          radius: feature.properties.band === "Lead" ? 9 : 7,
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.85,
        });
      },
      onEachFeature(feature, layer) {
        layer.bindPopup(popupNode(feature, state.api && state.api.openLead, leads));
      },
    }).addTo(state.group);
  };
  fetch("/maps/buyers.geojson").then((response) => response.json()).then((markets) => {
    if (active !== state) return;
    draw(markets, "#1a73e8");
    if (features.length) draw({ type: "FeatureCollection", features }, "#1e8e3e");
    const bounds = state.group.getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 });
  }).catch(() => {
    if (features.length) {
      draw({ type: "FeatureCollection", features }, "#1e8e3e");
      const bounds = state.group.getBounds();
      if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 });
    }
  });
}

function destroy() {
  if (!active) return;
  if (active.map) active.map.remove();
  if (active.host) active.host.replaceChildren();
  active = null;
}

window.DeskMap = { mount, destroy };
