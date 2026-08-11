/* WalkLoop — timed circular pedestrian routes using Valhalla + OpenStreetMap. */
(() => {
  'use strict';

  const VALHALLA_ROUTE_URL = 'https://valhalla1.openstreetmap.de/route';
  const MAX_FIT_ATTEMPTS = 3;

  const durationInput = document.getElementById('duration');
  const durationRange = document.getElementById('durationRange');
  const paceSelect = document.getElementById('pace');
  const locateBtn = document.getElementById('locateBtn');
  const generateBtn = document.getElementById('generateBtn');
  const alternateBtn = document.getElementById('alternateBtn');
  const gpxBtn = document.getElementById('gpxBtn');
  const locationText = document.getElementById('locationText');
  const mapMessage = document.getElementById('mapMessage');
  const serviceStatus = document.getElementById('serviceStatus');
  const results = document.getElementById('results');
  const actualTime = document.getElementById('actualTime');
  const timeDifference = document.getElementById('timeDifference');
  const actualDistance = document.getElementById('actualDistance');
  const directionsList = document.getElementById('directionsList');

  let startPoint = null;
  let startMarker = null;
  let routeLayer = null;
  let waypointLayer = null;
  let currentRoute = null;
  let routeSeed = Math.random() * 360;

  const map = L.map('map', { zoomControl: true }).setView([51.505, -0.09], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  function setStatus(message, state = '') {
    serviceStatus.textContent = message;
    serviceStatus.className = `status-pill ${state}`.trim();
  }

  function setMapMessage(message) {
    mapMessage.textContent = message;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function targetMinutes() {
    const raw = Number(durationInput.value);
    return clamp(Number.isFinite(raw) ? raw : 45, 10, 240);
  }

  function walkingSpeed() {
    return Number(paceSelect.value) || 4.8;
  }

  function syncDuration(value) {
    const v = clamp(Math.round(Number(value) / 5) * 5, 10, 240);
    durationInput.value = String(v);
    durationRange.value = String(v);
  }

  function setStart(lat, lon, label = 'Selected starting point') {
    startPoint = { lat, lon };
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker([lat, lon], { title: 'Start / finish' }).addTo(map);
    startMarker.bindPopup('<strong>Start / finish</strong>');
    locationText.textContent = `${label} · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    generateBtn.disabled = false;
    setMapMessage('Start set. Choose a time and generate your loop.');
    results.hidden = true;
    clearRoute();
  }

  function clearRoute() {
    if (routeLayer) map.removeLayer(routeLayer);
    if (waypointLayer) map.removeLayer(waypointLayer);
    routeLayer = null;
    waypointLayer = null;
    currentRoute = null;
  }

  function destinationPoint(origin, bearingDeg, distanceKm) {
    const R = 6371.0088;
    const delta = distanceKm / R;
    const theta = bearingDeg * Math.PI / 180;
    const phi1 = origin.lat * Math.PI / 180;
    const lambda1 = origin.lon * Math.PI / 180;

    const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const phi2 = Math.asin(sinPhi2);
    const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
    const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
    const lambda2 = lambda1 + Math.atan2(y, x);

    return {
      lat: phi2 * 180 / Math.PI,
      lon: ((lambda2 * 180 / Math.PI + 540) % 360) - 180
    };
  }

  function makeLoopWaypoints(start, radiusKm, seedDeg) {
    const centre = destinationPoint(start, seedDeg, radiusKm);
    const startBearingFromCentre = (seedDeg + 180) % 360;
    const points = [start];

    [90, 180, 270].forEach(offset => {
      points.push(destinationPoint(centre, startBearingFromCentre + offset, radiusKm));
    });

    points.push(start);
    return points;
  }

  async function fetchValhallaRoute(points, speedKmh) {
    const locations = points.map((p, i) => ({
      lat: p.lat,
      lon: p.lon,
      type: (i === 0 || i === points.length - 1) ? 'break' : 'through'
    }));

    const payload = {
      locations,
      costing: 'pedestrian',
      costing_options: {
        pedestrian: {
          walking_speed: speedKmh,
          use_ferry: 0.1,
          use_living_streets: 0.8,
          use_tracks: 0.55
        }
      },
      units: 'kilometers',
      language: 'en-GB',
      directions_type: 'instructions'
    };

    const url = `${VALHALLA_ROUTE_URL}?json=${encodeURIComponent(JSON.stringify(payload))}`;
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });

    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data.error || data.error_code || data.status_message || '';
      } catch (_) { }
      throw new Error(`Routing service returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    if (!data.trip || !data.trip.summary || !Array.isArray(data.trip.legs)) {
      throw new Error('Routing service returned an unexpected response.');
    }
    return data;
  }

  function decodePolyline6(encoded) {
    const coordinates = [];
    let index = 0;
    let lat = 0;
    let lon = 0;
    const factor = 1e6;

    while (index < encoded.length) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dLat;

      result = 0;
      shift = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dLon = (result & 1) ? ~(result >> 1) : (result >> 1);
      lon += dLon;

      coordinates.push([lat / factor, lon / factor]);
    }
    return coordinates;
  }

  function routeCoordinates(data) {
    const coords = [];
    data.trip.legs.forEach((leg, legIndex) => {
      const legCoords = decodePolyline6(leg.shape);
      if (legIndex > 0 && legCoords.length) legCoords.shift();
      coords.push(...legCoords);
    });
    return coords;
  }

  function routeManeuvers(data) {
    const maneuvers = [];
    data.trip.legs.forEach(leg => {
      (leg.maneuvers || []).forEach(m => maneuvers.push(m));
    });
    return maneuvers;
  }

  async function fitRouteToDuration(seedDeg) {
    const desiredMinutes = targetMinutes();
    const speed = walkingSpeed();
    const targetDistanceKm = speed * desiredMinutes / 60;
    let radiusKm = clamp(targetDistanceKm / (2 * Math.PI), 0.12, 7);
    let best = null;

    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt++) {
      setStatus(`Fitting route ${attempt + 1}/${MAX_FIT_ATTEMPTS}`, 'busy');
      setMapMessage(`Finding a walk close to ${desiredMinutes} minutes…`);

      const points = makeLoopWaypoints(startPoint, radiusKm, seedDeg);
      const data = await fetchValhallaRoute(points, speed);
      const actualMinutes = data.trip.summary.time / 60;
      const error = Math.abs(actualMinutes - desiredMinutes);

      if (!best || error < best.error) {
        best = { data, points, actualMinutes, error, radiusKm };
      }

      if (error <= Math.max(2, desiredMinutes * 0.06)) break;

      const ratio = clamp(desiredMinutes / Math.max(actualMinutes, 1), 0.68, 1.38);
      radiusKm = clamp(radiusKm * ratio, 0.10, 8);
    }

    if (!best) throw new Error('Could not generate a suitable route.');
    return best;
  }

  function renderRoute(best) {
    clearRoute();
    const data = best.data;
    const coords = routeCoordinates(data);
    const latLngs = coords.map(([lat, lon]) => [lat, lon]);

    routeLayer = L.polyline(latLngs, {
      color: '#166534',
      weight: 6,
      opacity: 0.92,
      lineJoin: 'round'
    }).addTo(map);

    waypointLayer = L.layerGroup(
      best.points.slice(1, -1).map((p, i) =>
        L.circleMarker([p.lat, p.lon], {
          radius: 5,
          color: '#14532d',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 2
        }).bindTooltip(`Loop guide ${i + 1}`)
      )
    ).addTo(map);

    const group = L.featureGroup([routeLayer, startMarker]);
    map.fitBounds(group.getBounds().pad(0.12));

    const mins = data.trip.summary.time / 60;
    const km = data.trip.summary.length;
    const desired = targetMinutes();
    const delta = Math.round(mins - desired);

    actualTime.textContent = `${Math.round(mins)} min`;
    timeDifference.textContent = Math.abs(delta) <= 1 ? 'On target' : `${Math.abs(delta)} min ${delta > 0 ? 'over' : 'under'} target`;
    actualDistance.textContent = `${km.toFixed(1)} km`;

    const maneuvers = routeManeuvers(data);
    directionsList.innerHTML = '';
    maneuvers.forEach(m => {
      const li = document.createElement('li');
      const instruction = document.createElement('span');
      instruction.textContent = m.instruction || 'Continue';
      const dist = document.createElement('span');
      dist.className = 'maneuver-distance';
      dist.textContent = m.length >= 1 ? `${m.length.toFixed(1)} km` : `${Math.round(m.length * 1000)} m`;
      li.append(instruction, dist);
      directionsList.appendChild(li);
    });

    currentRoute = { data, coords };
    results.hidden = false;
    setMapMessage(`Generated ${Math.round(mins)}-minute loop · ${km.toFixed(1)} km`);
    setStatus('Route ready');
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function generateRoute(isAlternate = false) {
    if (!startPoint) return;
    syncDuration(durationInput.value);
    generateBtn.disabled = true;
    alternateBtn.disabled = true;
    gpxBtn.disabled = true;

    if (isAlternate) routeSeed = (routeSeed + 73 + Math.random() * 41) % 360;

    try {
      const best = await fitRouteToDuration(routeSeed);
      renderRoute(best);
    } catch (error) {
      console.error(error);
      setStatus('Route failed', 'error');
      setMapMessage('Could not generate this loop. Try another starting point or duration.');
      alert(`WalkLoop could not generate a route.\n\n${error.message}`);
    } finally {
      generateBtn.disabled = !startPoint;
      alternateBtn.disabled = false;
      gpxBtn.disabled = !currentRoute;
    }
  }

  function escapeXml(value) {
    return String(value).replace(/[<>&'\"]/g, char => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    }[char]));
  }

  function downloadGpx() {
    if (!currentRoute) return;
    const name = `WalkLoop ${targetMinutes()} min`;
    const trkpts = currentRoute.coords
      .map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`)
      .join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WalkLoop" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${escapeXml(name)}</name></metadata>\n  <trk><name>${escapeXml(name)}</name><trkseg>\n${trkpts}\n  </trkseg></trk>\n</gpx>`;
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `walkloop-${targetMinutes()}min.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  durationRange.addEventListener('input', () => syncDuration(durationRange.value));
  durationInput.addEventListener('change', () => syncDuration(durationInput.value));
  durationInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && startPoint) generateRoute(false);
  });

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setStatus('Location unavailable', 'error');
      setMapMessage('Your browser does not support location. Click the map to set your start.');
      return;
    }

    setStatus('Getting location…', 'busy');
    navigator.geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude } = position.coords;
        setStart(latitude, longitude, 'Your location');
        map.setView([latitude, longitude], 15);
        setStatus('Location set');
      },
      error => {
        console.warn(error);
        setStatus('Location not granted', 'error');
        setMapMessage('Location was not available. Click the map to choose your start.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });

  generateBtn.addEventListener('click', () => generateRoute(false));
  alternateBtn.addEventListener('click', () => generateRoute(true));
  gpxBtn.addEventListener('click', downloadGpx);

  map.on('click', event => {
    setStart(event.latlng.lat, event.latlng.lng, 'Map selection');
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
