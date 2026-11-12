import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVG_KMH,
  ROAD_DETOUR,
  WEIGHTS,
  convexHull,
  dbscan,
  haversineKm,
  planRoute,
  ringCounts,
  scoreLead,
  splitInto,
  territoryShape,
} from '../web/geo.js';

const sf = { id: 'sf', lat: 37.79, lng: -122.39 };
const oakland = { id: 'oak', lat: 37.8, lng: -122.27 };
const chicago = { id: 'chi', lat: 41.88, lng: -87.63 };

test('distance, clusters, hulls, and routes are deterministic', () => {
  assert.ok(haversineKm(sf, chicago) > 2900 && haversineKm(sf, chicago) < 3100);
  assert.equal(haversineKm(sf, null), 0);
  const grouped = dbscan([chicago, sf, oakland], { epsKm: 25, minPts: 2 });
  assert.equal(grouped.clusters[0].points.length, 2);
  assert.equal(grouped.clusters[1].label, 'Outlier');
  assert.equal(grouped.clusters[1].points[0].id, 'chi');
  const again = dbscan([oakland, chicago, sf], { epsKm: 25, minPts: 2 });
  assert.deepEqual(again.clusters.map((cluster) => cluster.points.map((point) => point.id)), grouped.clusters.map((cluster) => cluster.points.map((point) => point.id)));
  const square = convexHull([
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
    { lat: 1, lng: 0 },
    { lat: 0.5, lng: 0.5 },
  ]);
  assert.equal(square.length, 4);
  assert.equal(territoryShape([sf]).kind, 'circle');
  assert.equal(territoryShape([sf, oakland, chicago]).kind, 'polygon');
  const days = splitInto([sf, oakland, chicago], 2);
  assert.equal(days.length, 2);
  const route = planRoute(sf, [chicago, oakland]);
  assert.equal(route.order[0].id, 'oak');
  assert.ok(route.totalKm > haversineKm(sf, oakland) * ROAD_DETOUR);
  assert.equal(route.minutes, (route.totalKm / AVG_KMH) * 60);
  const same = planRoute(sf, [chicago, oakland]);
  assert.deepEqual(same.order.map((stop) => stop.id), route.order.map((stop) => stop.id));
});

test('scores explain themselves and missing fields only lower the number', () => {
  const weights = Object.values(WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(weights, 100);
  const full = scoreLead({
    id: 'a',
    priority: 'High',
    hook: 'A hiring spike',
    pain: 'Manual dispatch',
    source: 'https://example.com/a',
    email: 'a@example.com',
    contact: 'Ada',
    title: 'Ops',
    lat: 37.79,
    lng: -122.39,
    geo: { confidence: 1, precision: 'rooftop' },
  }, { start: sf, leads: [sf, oakland] });
  const thin = scoreLead({ id: 'b', priority: 'Low' }, {});
  assert.ok(full.score > thin.score);
  assert.ok(full.score <= 100);
  assert.equal(thin.parts.proximity, 0);
  assert.ok(thin.reasons.some((reason) => reason.includes('proximity')));
  assert.equal(scoreLead(null, null).score >= 0, true);
  const rings = ringCounts(sf, [sf, oakland, chicago]);
  assert.equal(rings[0].km, 10);
  assert.equal(rings[0].count, 1);
  assert.equal(rings[2].count, 2);
});
