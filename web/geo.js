/** Straight-line kilometres times this factor estimate a road. */
export const ROAD_DETOUR = 1.3;

/** Average speed, in kilometres per hour, used to turn that estimate into minutes. */
export const AVG_KMH = 40;

export const WEIGHTS = {
  fit: 30,
  evidence: 20,
  reachability: 15,
  proximity: 15,
  density: 10,
  confidence: 10,
};

function coord(point, key) {
  if (!point || point[key] == null || point[key] === '') return NaN;
  return Number(point[key]);
}

export function haversineKm(a, b) {
  const lat1 = coord(a, 'lat');
  const lng1 = coord(a, 'lng');
  const lat2 = coord(b, 'lat');
  const lng2 = coord(b, 'lng');
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return 0;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function sortPoints(points) {
  return [...(points || [])].sort((left, right) => {
    const byId = String(left.id || '').localeCompare(String(right.id || ''));
    if (byId) return byId;
    if (Number(left.lat) !== Number(right.lat)) return Number(left.lat) - Number(right.lat);
    return Number(left.lng) - Number(right.lng);
  });
}

export function centroid(points) {
  const list = points || [];
  if (!list.length) return { lat: 0, lng: 0 };
  const lat = list.reduce((sum, point) => sum + Number(point.lat || 0), 0) / list.length;
  const lng = list.reduce((sum, point) => sum + Number(point.lng || 0), 0) / list.length;
  return { lat, lng };
}

function cross(origin, a, b) {
  return (a.lng - origin.lng) * (b.lat - origin.lat) - (a.lat - origin.lat) * (b.lng - origin.lng);
}

export function convexHull(points) {
  const seen = new Set();
  const unique = [];
  for (const point of points || []) {
    const key = `${Number(point.lat)},${Number(point.lng)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  unique.sort((left, right) => Number(left.lng) - Number(right.lng) || Number(left.lat) - Number(right.lat));
  if (unique.length <= 2) return unique;
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function territoryShape(points) {
  const list = points || [];
  if (list.length <= 2) {
    const center = centroid(list);
    const radiusKm = list.length === 2 ? Math.max(haversineKm(list[0], list[1]) / 2, 0.5) : (list.length === 1 ? 1 : 0);
    return { kind: 'circle', center, radiusKm };
  }
  return { kind: 'polygon', points: convexHull(list) };
}

export function dbscan(points, options = {}) {
  const epsKm = options.epsKm ?? 25;
  const minPts = options.minPts ?? 2;
  const ordered = sortPoints(points);
  const seen = new Set();
  const clusters = [];
  const neighbors = (point) => ordered.filter((other) => haversineKm(point, other) <= epsKm);
  for (const point of ordered) {
    if (seen.has(point)) continue;
    const near = neighbors(point);
    if (near.length < minPts) continue;
    const cluster = [];
    const queue = [...near];
    for (const member of queue) {
      if (seen.has(member)) continue;
      seen.add(member);
      cluster.push(member);
      const more = neighbors(member);
      if (more.length >= minPts) {
        for (const extra of more) {
          if (!queue.includes(extra)) queue.push(extra);
        }
      }
    }
    clusters.push({ label: `Territory ${clusters.length + 1}`, points: sortPoints(cluster) });
  }
  const noise = ordered.filter((point) => !seen.has(point));
  const outliers = noise.map((point) => ({ label: 'Outlier', points: [point] }));
  return { clusters: [...clusters, ...outliers], noise };
}

export function splitInto(points, k) {
  const ordered = sortPoints(points);
  if (!ordered.length) return [];
  const count = Math.max(1, Math.min(Math.floor(Number(k) || 1), ordered.length));
  let centers = [];
  for (let index = 0; index < count; index += 1) {
    const seed = ordered[Math.floor((index * ordered.length) / count)];
    centers.push({ lat: Number(seed.lat), lng: Number(seed.lng) });
  }
  let groups = centers.map(() => []);
  for (let round = 0; round < 25; round += 1) {
    groups = centers.map(() => []);
    for (const point of ordered) {
      let best = 0;
      let bestDist = Infinity;
      centers.forEach((center, index) => {
        const dist = haversineKm(point, center);
        if (dist < bestDist) {
          best = index;
          bestDist = dist;
        }
      });
      groups[best].push(point);
    }
    const next = groups.map((group, index) => (group.length ? centroid(group) : centers[index]));
    const stable = next.every((center, index) => center.lat === centers[index].lat && center.lng === centers[index].lng);
    centers = next;
    if (stable) break;
  }
  return groups.filter((group) => group.length).map((group, index) => ({
    label: `Day ${index + 1}`,
    points: group,
  }));
}

function pathKm(start, order) {
  let total = 0;
  let cursor = start;
  for (const stop of order) {
    total += haversineKm(cursor, stop);
    cursor = stop;
  }
  return total;
}

export function planRoute(start, stops, options = {}) {
  const max = options.max ?? 12;
  const pool = sortPoints(stops).slice(0, max);
  if (!start || !pool.length) return { order: [], totalKm: 0, minutes: 0 };
  const remaining = [...pool];
  const order = [];
  let cursor = start;
  while (remaining.length) {
    let best = 0;
    let bestDist = Infinity;
    remaining.forEach((stop, index) => {
      const dist = haversineKm(cursor, stop);
      const tie = dist === bestDist && String(stop.id || '').localeCompare(String(remaining[best].id || '')) < 0;
      if (dist < bestDist || tie) {
        best = index;
        bestDist = dist;
      }
    });
    order.push(remaining.splice(best, 1)[0]);
    cursor = order[order.length - 1];
  }
  let improved = true;
  let guard = 0;
  while (improved && guard < 30) {
    improved = false;
    guard += 1;
    for (let startIndex = 0; startIndex < order.length - 1; startIndex += 1) {
      for (let endIndex = startIndex + 1; endIndex < order.length; endIndex += 1) {
        const candidate = order.slice(0, startIndex)
          .concat(order.slice(startIndex, endIndex + 1).reverse(), order.slice(endIndex + 1));
        if (pathKm(start, candidate) + 1e-6 < pathKm(start, order)) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  const totalKm = pathKm(start, order) * ROAD_DETOUR;
  const minutes = (totalKm / AVG_KMH) * 60;
  return { order, totalKm, minutes };
}

function safeSource(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function scaledWeights(weights, hasStart) {
  const source = { ...WEIGHTS, ...(weights || {}) };
  if (hasStart) return source;
  const rest = 100 - Number(source.proximity || 0);
  if (rest <= 0) return source;
  const scale = 100 / rest;
  const next = { ...source, proximity: 0 };
  for (const key of Object.keys(next)) {
    if (key !== 'proximity') next[key] = Number(source[key] || 0) * scale;
  }
  return next;
}

export function scoreLead(lead, ctx = {}, weights = WEIGHTS) {
  const item = lead && typeof lead === 'object' ? lead : {};
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const active = scaledWeights(weights, Boolean(context.start));
  const parts = { fit: 0, evidence: 0, reachability: 0, proximity: 0, density: 0, confidence: 0 };
  const reasons = [];
  const high = item.priority === 'High' && !item.negative;
  parts.fit = high ? active.fit : active.fit * 0.25;
  reasons.push(high ? 'Priority is High.' : 'Priority is not High, so fit is lower.');
  const hook = String(item.hook || '').trim();
  const pain = String(item.pain || '').trim();
  const realPain = Boolean(pain) && !/no public pain point/i.test(pain);
  if (hook) {
    parts.evidence += active.evidence * 0.4;
    reasons.push('A hook is on the lead.');
  } else reasons.push('No hook is on the lead.');
  if (safeSource(item.source)) {
    parts.evidence += active.evidence * 0.3;
    reasons.push('The source URL is public.');
  } else reasons.push('No public source URL.');
  if (realPain) {
    parts.evidence += active.evidence * 0.3;
    reasons.push('A pain point is on the lead.');
  } else reasons.push('No public pain point.');
  if (String(item.email || '').includes('@')) {
    parts.reachability += active.reachability * 0.4;
    reasons.push('An email is on the lead.');
  }
  if (String(item.contact || '').trim()) {
    parts.reachability += active.reachability * 0.3;
    reasons.push('A contact name is on the lead.');
  }
  if (String(item.title || '').trim()) {
    parts.reachability += active.reachability * 0.3;
    reasons.push('A contact title is on the lead.');
  }
  if (!item.email && !item.contact && !item.title) reasons.push('No public contact is on the lead.');
  const point = item.lat != null && item.lat !== '' && item.lng != null && item.lng !== ''
    && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng))
    ? { lat: Number(item.lat), lng: Number(item.lng) }
    : null;
  if (!context.start) reasons.push('No start point, so proximity was left out.');
  else if (!point) reasons.push('No coordinates, so proximity is unknown.');
  else {
    const distance = haversineKm(context.start, point);
    parts.proximity = active.proximity * Math.exp(-distance / 25);
    reasons.push(`${distance.toFixed(1)} km from the start.`);
  }
  const epsKm = context.epsKm ?? 25;
  const nearby = (context.leads || []).filter((other) => {
    if (!other || other === item || other.id === item.id || !point) return false;
    if (other.lat == null || other.lng == null) return false;
    if (!Number.isFinite(Number(other.lat)) || !Number.isFinite(Number(other.lng))) return false;
    return haversineKm(point, other) <= epsKm;
  }).length;
  parts.density = active.density * Math.min(nearby, 4) / 4;
  reasons.push(nearby ? `${nearby} other leads are within ${epsKm} km.` : `No other leads are within ${epsKm} km.`);
  const confidence = Number(item.geo && item.geo.confidence);
  parts.confidence = active.confidence * (Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0);
  if (!Number.isFinite(confidence)) reasons.push('Location confidence is unknown.');
  else if (item.geo && (item.geo.precision === 'area' || item.geo.precision === 'region')) reasons.push('Approximate location.');
  else reasons.push('Location confidence is included.');
  const score = Math.max(0, Math.min(100, Math.round(Object.values(parts).reduce((sum, value) => sum + value, 0))));
  return { score, parts, reasons };
}

export function ringCounts(start, leads, radii = [10, 25, 50]) {
  const rings = Array.isArray(radii) && radii.length ? radii : [10, 25, 50];
  return rings.map((km) => ({
    km,
    count: (leads || []).filter((lead) => {
      if (!start || !lead || lead.lat == null || lead.lng == null) return false;
      if (!Number.isFinite(Number(lead.lat)) || !Number.isFinite(Number(lead.lng))) return false;
      return haversineKm(start, { lat: Number(lead.lat), lng: Number(lead.lng) }) <= km;
    }).length,
  }));
}
